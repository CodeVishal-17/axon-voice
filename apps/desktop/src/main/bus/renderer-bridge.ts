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

import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import {
  AXON_STATES,
  APPROVAL_DECISIONS,
  CAPTURE_FAILURES,
  IPC_CHANNELS,
  JsonValueSchema,
  LISTENING_LIMITS,
  PLAYBACK_DIAGNOSTICS_LIMITS,
  PLAYBACK_EVENTS,
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
  type StartupStatus,
  type StartListeningResult,
  type StateRequestResult,
  type PlaybackDiagnostics,
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
import { SurfaceRouter } from './surface-router.js';
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
/**
 * Capture diagnostics: bounded numbers and booleans, nothing else. `strict` so
 * a page cannot smuggle an extra field through a channel that is only ever
 * printed to a developer console.
 */
const finite = (max: number): z.ZodNumber => z.number().finite().min(0).max(max);
/**
 * What the window may say about playing reply audio. `.strict()`: an id, one
 * of four words, two bounded counts and a short reason — nothing else crosses.
 */
const playbackDiagnosticsPayload = z
  .object({
    speechId: z.string().min(1).max(PLAYBACK_DIAGNOSTICS_LIMITS.maxSpeechIdCharacters),
    event: z.enum(PLAYBACK_EVENTS),
    chunks: z.number().int().nonnegative().max(1_000_000),
    bytes: z.number().int().nonnegative().max(1_000_000_000),
    reason: z.string().max(PLAYBACK_DIAGNOSTICS_LIMITS.maxReasonCharacters).nullable(),
  })
  .strict();

/**
 * A playback report, or null. Exported so the boundary's rules are tested
 * against the real schema rather than a copy of it.
 */
export function validPlaybackDiagnostics(raw: unknown): PlaybackDiagnostics | null {
  const parsed = playbackDiagnosticsPayload.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const captureDiagnosticsPayload = z
  .object({
    captureId: z.string().max(64),
    pipeline: z.enum(['track-processor', 'script-processor']),
    targetSampleRate: finite(384_000),
    contextSampleRate: finite(384_000),
    trackSampleRate: finite(384_000).nullable(),
    trackChannelCount: finite(64).nullable(),
    echoCancellation: z.boolean().nullable(),
    noiseSuppression: z.boolean().nullable(),
    autoGainControl: z.boolean().nullable(),
    windowMs: finite(3_600_000),
    callbacks: finite(1_000_000),
    producedMs: finite(3_600_000),
    audioClockMs: finite(3_600_000),
    maxCallbackGapMs: finite(3_600_000),
    rms: finite(2),
    peak: finite(100),
    silentCallbacks: finite(1_000_000),
    clippedSamples: finite(1_000_000_000),
  })
  .strict();

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

const appearancePayload = z.object({ appearance: z.enum(['dark', 'light']) }).strict();

const startupPayload = z.object({ enabled: z.boolean() }).strict();

const STARTUP_UNCONFIGURED: StartupStatus = {
  available: false,
  enabled: false,
  reason: 'Starting with Windows is not configured.',
};

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

export interface BridgeDependencies {
  readonly persistence: PersistenceService;
  readonly settings: SettingsService;
  /** Recolour the native frame of the window that asked. Cosmetic only. */
  readonly setAppearance?: (sender: WebContents, appearance: 'dark' | 'light') => void;
  /**
   * The one window that holds the microphone and the speaker: the overlay.
   *
   * When present, capture commands and speech go to it and nowhere else, and
   * microphone frames, capture reports and playback reports are accepted from
   * it and nowhere else. Without it (unit harnesses that open no overlay) every
   * window is addressed, as before. Two windows each opening the microphone
   * would send every frame twice.
   */
  readonly voiceSurface?: () => WebContents | null;
  /** Let the overlay's own window take a click, or pass clicks through. */
  readonly setOverlayInteractive?: (sender: WebContents, interactive: boolean) => void;
  /** Per-user start at sign-in. */
  readonly startup?: { get(): StartupStatus; set(enabled: boolean): StartupStatus };
}

export function installRendererBridge(
  bus: EventBus,
  orchestrator: Orchestrator,
  deps?: BridgeDependencies,
): RendererBridge {
  // Every send to a window and every "is this the voice surface?" goes through
  // one router, which never reads a destroyed window's contents. See
  // `surface-router.ts` for the crash that made this necessary.
  const router = new SurfaceRouter<WebContents>({
    voiceSurface: deps?.voiceSurface,
    windows: () => BrowserWindow.getAllWindows(),
  });

  // --- main -> renderer ---------------------------------------------------
  const unsubscribe = bus.subscribe((event) => {
    router.broadcast(IPC_CHANNELS.EVENT, event);
  });

  /** Audio and capture commands: to the live voice surface, or everywhere when none is configured. */
  // Returns whether a live voice surface took it, which the reply-audio
  // diagnostics count: a chunk sent to no window is a chunk nobody heard.
  const toVoice = (channel: string, payload: unknown): boolean => router.toVoice(channel, payload);
  /** Once there is a voice surface, only it — while it is alive — may speak for the microphone or the speaker. */
  const fromVoice = (sender: WebContents): boolean => router.fromVoice(sender);

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

  ipcMain.handle(IPC_CHANNELS.SPEECH_REPORT, (event, raw: unknown): void => {
    const parsed = speechReportPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.SPEECH_REPORT, parsed.error);
    if (!fromVoice(event.sender)) return;

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

  ipcMain.handle(IPC_CHANNELS.LISTEN_REPORT, (event, raw: unknown): void => {
    const parsed = captureReportPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.LISTEN_REPORT, parsed.error);
    if (!fromVoice(event.sender)) return;

    orchestrator.reportCapture(parsed.data.captureId, parsed.data.status, parsed.data.failure);
  });

  // Numeric PLAYBACK diagnostics: what the window did with the voice agent's
  // reply audio. The same rules as capture diagnostics — the live voice
  // surface only, strictly parsed, fire and forget, and dropped by main
  // unless a development build asked for voice diagnostics.
  ipcMain.on(IPC_CHANNELS.SPEECH_PLAYBACK_DIAGNOSTICS, (event, raw: unknown): void => {
    if (!fromVoice(event.sender)) return;
    const report = validPlaybackDiagnostics(raw);
    if (report) orchestrator.reportPlaybackDiagnostics(report);
  });

  // Numeric capture diagnostics. Fire and forget; dropped unless they come
  // from the live voice surface, parse, and main asked for them.
  ipcMain.on(IPC_CHANNELS.LISTEN_DIAGNOSTICS, (event, raw: unknown): void => {
    if (!fromVoice(event.sender)) return;
    const parsed = captureDiagnosticsPayload.safeParse(raw);
    if (!parsed.success) return;
    orchestrator.reportCaptureDiagnostics(parsed.data);
  });

  // `on`, not `handle`: frames are fire-and-forget. There is no reply, so a
  // compromised page cannot use the return value to learn whether a capture id
  // it guessed was the live one, and no promise is allocated per 64ms of
  // audio.
  ipcMain.on(IPC_CHANNELS.LISTEN_AUDIO, (event, raw: unknown): void => {
    // Frames from any window but the voice surface are dropped unread.
    if (!fromVoice(event.sender)) return;
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
  ipcMain.handle(IPC_CHANNELS.WINDOW_APPEARANCE, (event, raw: unknown): void => {
    const parsed = appearancePayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.WINDOW_APPEARANCE, parsed.error);
    deps?.setAppearance?.(event.sender, parsed.data.appearance);
  });

  // `on`, fire and forget: a boolean from the overlay about its own pointer.
  ipcMain.on(IPC_CHANNELS.OVERLAY_INTERACTIVE, (event, raw: unknown): void => {
    if (typeof raw !== 'boolean') return;
    if (!router.hasVoiceSurface || !router.fromVoice(event.sender)) return;
    deps?.setOverlayInteractive?.(event.sender, raw);
  });

  ipcMain.handle(IPC_CHANNELS.STARTUP_GET, (): StartupStatus => deps?.startup?.get() ?? STARTUP_UNCONFIGURED);

  ipcMain.handle(IPC_CHANNELS.STARTUP_SET, (_event, raw: unknown): StartupStatus => {
    const parsed = startupPayload.safeParse(raw);
    if (!parsed.success) throw invalidPayload(IPC_CHANNELS.STARTUP_SET, parsed.error);
    return deps?.startup?.set(parsed.data.enabled) ?? STARTUP_UNCONFIGURED;
  });

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
      toVoice(IPC_CHANNELS.SPEECH_AUDIO, delivery);
    },

    chunk(chunk: SpeechChunk): boolean {
      return toVoice(IPC_CHANNELS.SPEECH_CHUNK, chunk);
    },

    stop(speechId: string): void {
      toVoice(IPC_CHANNELS.SPEECH_STOP, speechId);
    },

    // --- CaptureSink: main -> renderer -----------------------------------
    command(command: CaptureCommand): void {
      toVoice(IPC_CHANNELS.LISTEN_CAPTURE, command);
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
      ipcMain.removeAllListeners(IPC_CHANNELS.OVERLAY_INTERACTIVE);
    },
  };
}
