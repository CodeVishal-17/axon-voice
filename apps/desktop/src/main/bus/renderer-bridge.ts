/**
 * main <-> renderer plumbing.
 *
 * Two directions, both narrow:
 *
 *   main -> renderer   every AxonEvent, pushed to every open window
 *   renderer -> main   seven request handlers, listed below
 *
 * Every inbound payload is validated. The renderer is sandboxed and holds no
 * secrets, but it is also the surface that will eventually display web content
 * and model output, so its messages are treated as untrusted input rather than
 * as calls from a trusted sibling.
 *
 * The two development affordances (`invokeTool`, `requestState`) are refused
 * here, in the main process, when the dev console is off. The renderer's
 * `devConsoleEnabled` flag only decides whether to *draw* the panel; it is not
 * what enforces anything.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import {
  AXON_STATES,
  APPROVAL_DECISIONS,
  CAPTURE_FAILURES,
  IPC_CHANNELS,
  JsonValueSchema,
  LISTENING_LIMITS,
  PERSISTENCE_LIMITS,
  type AxonProfile,
  type AxonSettings,
  type AxonSnapshot,
  type CaptureCommand,
  type MemoryEntry,
  type SessionRecord,
  type SettingsUpdateResult,
  type SendMessageResult,
  type SpeechChunk,
  type SpeechDelivery,
  type StartListeningResult,
  type StateRequestResult,
  type VoiceSessionResult,
  type ToolResult,
  type ToolSchema,
} from '@axon/core';
import type { EventBus } from './event-bus.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { SpeechSink } from '../voice/speech-transport.js';
import type { CaptureSink } from '../voice/capture-transport.js';
import type { PersistenceService } from '../persistence/persistence-service.js';
import type { SettingsService } from '../settings/settings-service.js';
import { settingsPatchSchema } from '../persistence/settings-schema.js';

const approvalDecisionPayload = z.object({
  callId: z.string().min(1),
  decision: z.enum(APPROVAL_DECISIONS),
  // What the dialog the user acted on described. Bounded and optional: main
  // treats a mismatch as an answer to a question that is no longer on screen
  // and leaves the request pending, so an absent or wrong value can never
  // widen anything — it can only fail to allow.
  fingerprint: z.string().max(128).optional(),
});

const toolInvokePayload = z.object({
  tool: z.string().min(1).max(120),
  input: JsonValueSchema,
});

// Bounded here as well as in the orchestrator. The renderer is treated as
// untrusted input, and a multi-megabyte string should be rejected at the door
// rather than after it has been copied across the IPC boundary.
const brainSendPayload = z.object({
  text: z.string().min(1).max(4000),
});

// The renderer may only report on an utterance MAIN gave it. There is no
// field here for audio, a path, a URL or a duration - nothing it says can
// introduce audio or extend how long Axon believes it is speaking.
const speechReportPayload = z.object({
  speechId: z.string().min(1).max(64),
  status: z.enum(['started', 'ended', 'failed']),
});

const stateRequestPayload = z.object({
  to: z.enum(AXON_STATES),
  reason: z.string().max(200),
});

// The renderer may only report on a capture MAIN opened, and only with one of
// five known failures. There is no free-text field here on purpose: a real
// device error names hardware, drivers and user accounts, and none of that
// should cross the boundary, reach the timeline, or land in the log.
const captureReportPayload = z.object({
  captureId: z.string().min(1).max(64),
  status: z.enum(['started', 'ended', 'failed']),
  failure: z.enum(CAPTURE_FAILURES).nullable(),
});

/**
 * Validation for the one channel that carries microphone audio.
 *
 * Hand-written rather than a Zod schema because the payload is a typed array,
 * and because the checks that matter here are structural: it must be exactly
 * an `Int16Array` (not a plain array, not a `Float32Array`, not an object that
 * merely looks like one), and it must be within the frame ceiling declared in
 * `@axon/core`.
 *
 * A frame that fails is DROPPED, silently, and never reaches the listening
 * service. It is not logged either: a log line per malformed frame is a way to
 * fill a disk from a sandboxed page, and the frame's contents must never
 * appear in a log under any circumstances.
 */
export function validAudioFrame(raw: unknown): { captureId: string; samples: Int16Array } | null {
  if (typeof raw !== 'object' || raw === null) return null;

  try {
    const { captureId, samples } = raw as { captureId?: unknown; samples?: unknown };

    if (typeof captureId !== 'string' || captureId.length === 0 || captureId.length > 64) return null;
    if (!(samples instanceof Int16Array)) return null;
    if (samples.length === 0 || samples.length > LISTENING_LIMITS.maxFrameSamples) return null;

    return { captureId, samples };
  } catch {
    // Defence in depth. Structured clone means what arrives here is a plain
    // deserialized object, so a property that throws when read should not be
    // reachable — but this runs on an `ipcMain.on` listener, where an escaping
    // throw is an uncaught exception in the main process. A frame Axon cannot
    // read is a frame Axon drops, not a reason to take the app down.
    return null;
  }
}

/**
 * Payloads for the persistence surface.
 *
 * An id is a bounded string, a title is a bounded string, and a flag is a
 * boolean. There is no field here through which the renderer could name a
 * table, a column, a file or the database — and every one of these is
 * re-validated in the store regardless.
 */
const idPayload = z.object({ id: z.string().min(1).max(64) });

const renamePayload = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(PERSISTENCE_LIMITS.maxTitleCharacters),
});

const memoryEnabledPayload = z.object({ id: z.string().min(1).max(64), enabled: z.boolean() });

const profilePayload = z
  .object({
    displayName: z.string().max(60).nullable().optional(),
    language: z.string().max(20).nullable().optional(),
  })
  .strict();

/** Reject rather than throw: an IPC rejection surfaces cleanly in the renderer. */
function invalidPayload(channel: string, error: z.ZodError): Error {
  return new Error(`Invalid payload on ${channel}: ${error.issues.map((i) => i.message).join('; ')}`);
}

export interface RendererBridge extends SpeechSink, CaptureSink {
  dispose(): void;
}

/** Push a payload to every live window. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

export interface BridgeDependencies {
  readonly persistence: PersistenceService;
  readonly settings: SettingsService;
}

export function installRendererBridge(
  bus: EventBus,
  orchestrator: Orchestrator,
  deps?: BridgeDependencies,
): RendererBridge {
  // --- main -> renderer ---------------------------------------------------
  const unsubscribe = bus.subscribe((event) => {
    broadcast(IPC_CHANNELS.EVENT, event);
  });

  // --- renderer -> main ---------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.SNAPSHOT, (): AxonSnapshot => orchestrator.snapshot());

  ipcMain.handle(IPC_CHANNELS.TOOLS_LIST, (): readonly ToolSchema[] => orchestrator.listTools());

  ipcMain.handle(IPC_CHANNELS.APPROVAL_DECISION, (_event, raw: unknown): void => {
    const parsed = approvalDecisionPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.APPROVAL_DECISION, parsed.error);

    const settled = orchestrator.resolveApproval(
      parsed.data.callId,
      parsed.data.decision,
      parsed.data.fingerprint,
    );
    if (!settled) {
      // Expected in normal use: the request may have timed out while the user
      // was deciding. Not an error, but worth seeing in the log.
      console.warn('[bridge] no pending approval for', parsed.data.callId);
    }
  });

  ipcMain.handle(IPC_CHANNELS.TOOL_INVOKE, async (_event, raw: unknown): Promise<ToolResult> => {
    if (!orchestrator.snapshot().devConsoleEnabled) {
      throw new Error('The developer Tool Console is disabled in this build.');
    }
    const parsed = toolInvokePayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.TOOL_INVOKE, parsed.error);

    // Note: straight into the dispatcher. Policy, risk resolution and the
    // approval gate all apply exactly as they will for the brain.
    return orchestrator.invokeTool(parsed.data.tool, parsed.data.input);
  });

  ipcMain.handle(IPC_CHANNELS.BRAIN_SEND, (_event, raw: unknown): SendMessageResult => {
    const parsed = brainSendPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.BRAIN_SEND, parsed.error);

    // Not a dev affordance: this is the product's primary input. It still
    // grants no new authority — the brain reaches tools only through the
    // dispatcher, exactly as the Tool Console does.
    return orchestrator.sendUserMessage(parsed.data.text, 'text');
  });

  ipcMain.handle(IPC_CHANNELS.SPEECH_REPORT, (_event, raw: unknown): void => {
    const parsed = speechReportPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SPEECH_REPORT, parsed.error);

    // Advisory. The service ignores an id that is not the utterance in
    // flight, and main's watchdog bounds the state either way.
    orchestrator.reportSpeech(parsed.data.speechId, parsed.data.status);
  });

  ipcMain.handle(IPC_CHANNELS.SPEECH_CANCEL, (): void => {
    // Takes no argument on purpose: "stop talking" needs no parameters, and a
    // parameterless verb is one that cannot be pointed at something else.
    orchestrator.cancelSpeech();
  });

  // --- listening ----------------------------------------------------------
  // Three inbound channels, all parameterless or tightly shaped. Note what is
  // absent: no device id, no sample rate, no duration, no format, no path.
  // The renderer can ask Axon to listen; it cannot describe how.

  ipcMain.handle(IPC_CHANNELS.LISTEN_START, (): StartListeningResult => {
    // 'manual' because this is the on-screen button. The hotkey path does not
    // come through IPC at all — it is handled entirely in main.
    return orchestrator.startListening('manual');
  });

  ipcMain.handle(IPC_CHANNELS.LISTEN_STOP, (): void => {
    orchestrator.stopListening();
  });

  ipcMain.handle(IPC_CHANNELS.LISTEN_REPORT, (_event, raw: unknown): void => {
    const parsed = captureReportPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.LISTEN_REPORT, parsed.error);

    orchestrator.reportCapture(parsed.data.captureId, parsed.data.status, parsed.data.failure);
  });

  // `on`, not `handle`: frames are fire-and-forget. There is no reply, so a
  // compromised page cannot use the return value to learn whether a capture id
  // it guessed was the live one, and no promise is allocated per 64ms of
  // audio.
  ipcMain.on(IPC_CHANNELS.LISTEN_AUDIO, (_event, raw: unknown): void => {
    const frame = validAudioFrame(raw);
    if (!frame) return;
    orchestrator.pushAudioFrame(frame.captureId, frame.samples);
  });

  // --- persistence ----------------------------------------------------------
  // Registered only when there is a persistence layer. Without one the channels
  // do not exist, and an invoke on a missing channel rejects — which is the
  // right answer: the renderer learns that persistence is unavailable from the
  // snapshot, and a silent success would be worse than an error.
  if (deps) {
    const { persistence, settings } = deps;

    ipcMain.handle(IPC_CHANNELS.SESSIONS_LIST, (): readonly SessionRecord[] => persistence.listSessions());

    ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, (): SessionRecord | null => {
      const created = persistence.createSession();
      // The orchestrator follows the database rather than the other way round:
      // whichever conversation persistence says is current is the one the next
      // turn belongs to.
      if (created) orchestrator.bindSession(created.id);
      return created;
    });

    ipcMain.handle(IPC_CHANNELS.SESSION_SELECT, (_event, raw: unknown): SessionRecord | null => {
      const parsed = idPayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SESSION_SELECT, parsed.error);

      const session = persistence.selectSession(parsed.data.id);
      if (session) orchestrator.bindSession(session.id);
      return session;
    });

    ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, (_event, raw: unknown): boolean => {
      const parsed = renamePayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SESSION_RENAME, parsed.error);
      return persistence.renameSession(parsed.data.id, parsed.data.title);
    });

    ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, (_event, raw: unknown): boolean => {
      const parsed = idPayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SESSION_DELETE, parsed.error);

      const deleted = persistence.deleteSession(parsed.data.id);
      // Deleting the open conversation leaves persistence on a fresh one;
      // follow it so the next turn is not written to something that is gone.
      if (deleted) orchestrator.bindSession(persistence.sessionId);
      return deleted;
    });

    ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, (): readonly MemoryEntry[] => persistence.listMemories());

    ipcMain.handle(IPC_CHANNELS.MEMORY_SET_ENABLED, (_event, raw: unknown): boolean => {
      const parsed = memoryEnabledPayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.MEMORY_SET_ENABLED, parsed.error);
      return persistence.setMemoryEnabled(parsed.data.id, parsed.data.enabled);
    });

    ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, (_event, raw: unknown): boolean => {
      const parsed = idPayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.MEMORY_DELETE, parsed.error);
      return persistence.deleteMemory(parsed.data.id);
    });

    ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR, (): number => persistence.clearMemories());

    ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (): AxonSettings => settings.current());

    ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, (_event, raw: unknown): SettingsUpdateResult => {
      // `.strict()`: an unknown key is refused rather than ignored, so a typo
      // is an error the user sees instead of a setting that silently does
      // nothing. Every known key is then validated again by the service.
      const parsed = settingsPatchSchema.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SETTINGS_UPDATE, parsed.error);
      return settings.update(parsed.data);
    });

    ipcMain.handle(IPC_CHANNELS.SETTINGS_RESET, (): SettingsUpdateResult => settings.reset());

    ipcMain.handle(IPC_CHANNELS.PROFILE_UPDATE, (_event, raw: unknown): AxonProfile => {
      const parsed = profilePayload.safeParse(raw);
      if (!parsed.success) throw invalidPayload(IPC_CHANNELS.PROFILE_UPDATE, parsed.error);
      return persistence.updateProfile(parsed.data);
    });
  }

  /**
   * Start a spoken conversation.
   *
   * Takes NO arguments, deliberately — the same discipline `startListening`
   * follows. The renderer can ask Axon to talk; it cannot name a provider, an
   * endpoint, a model, a voice or a prompt, so there is no version of this
   * request that points Axon's microphone somewhere of the page's choosing.
   *
   * The activation is recorded as 'manual' because that is what a click is.
   * The wake word and the hotkey record themselves differently, in main.
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_SESSION_START, (): VoiceSessionResult => {
    return orchestrator.startVoiceSession('manual');
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_SESSION_STOP, (): VoiceSessionResult => {
    return orchestrator.stopVoiceSession();
  });

  ipcMain.handle(IPC_CHANNELS.STATE_REQUEST, (_event, raw: unknown): StateRequestResult => {
    if (!orchestrator.snapshot().devConsoleEnabled) {
      throw new Error('State requests are disabled in this build.');
    }
    const parsed = stateRequestPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.STATE_REQUEST, parsed.error);

    return orchestrator.requestState(parsed.data.to, parsed.data.reason);
  });

  return {
    // --- SpeechSink: main -> renderer ------------------------------------
    deliver(delivery: SpeechDelivery): void {
      broadcast(IPC_CHANNELS.SPEECH_AUDIO, delivery);
    },

    chunk(chunk: SpeechChunk): void {
      broadcast(IPC_CHANNELS.SPEECH_CHUNK, chunk);
    },

    stop(speechId: string): void {
      broadcast(IPC_CHANNELS.SPEECH_STOP, speechId);
    },

    // --- CaptureSink: main -> renderer -----------------------------------
    command(command: CaptureCommand): void {
      broadcast(IPC_CHANNELS.LISTEN_CAPTURE, command);
    },

    dispose(): void {
      unsubscribe();
      for (const channel of Object.values(IPC_CHANNELS)) {
        ipcMain.removeHandler(channel);
      }
      // `removeHandler` only covers `handle`; the audio channel is an `on`
      // listener and has to be removed separately, or a disposed bridge would
      // keep accepting frames.
      ipcMain.removeAllListeners(IPC_CHANNELS.LISTEN_AUDIO);
    },
  };
}
