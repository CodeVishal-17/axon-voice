/**
 * Runtime assembly.
 *
 * Everything except the window: config, bus, log sink, registry, memory,
 * brain, orchestrator. Extracted from the app entry point so the verification
 * harness (`scripts/verify-tools.cjs`) builds the *same* graph the product
 * runs, rather than a parallel one that could drift out of agreement with it.
 *
 * A harness that constructs its own approximation of the system verifies the
 * approximation.
 *
 * SECURITY: this is the only module that reads ANTHROPIC_API_KEY or
 * ASSEMBLYAI_API_KEY. Both are read into locals, handed to their factories,
 * and never stored on `RuntimeConfig`, on `AxonRuntime`, or in the startup
 * OBSERVATION below. Anything that outlives this function cannot reach either.
 */

import { randomUUID } from 'node:crypto';
import { EventBus } from './bus/event-bus.js';
import { JsonlEventSink } from './bus/jsonl-sink.js';
import { createBrain } from './brain/create-brain.js';
import { createVoiceAgent } from './agent/create-voice-agent.js';
import { WakeWordDetector } from './wake/wake-word.js';
import { PersistenceService } from './persistence/persistence-service.js';
import { PersistentConversationMemory } from './persistence/persistent-memory.js';
import { SettingsService, directoryExists } from './settings/settings-service.js';
import { targetVersion as schemaTarget } from './persistence/migrations.js';
import { resolveRuntimeConfig, type ConfigInputs, type RuntimeConfig } from './config.js';
import { AxonBrowser } from './browser/axon-browser.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { ElectronAppLauncher, ElectronScreenCapturer } from './platform/electron-platform.js';
import { WindowsDesktop } from './platform/windows-desktop.js';
import { createDefaultRegistry } from './tools/registry.js';
import { createTextToSpeech } from './voice/create-tts.js';
import { createSpeechToText } from './voice/create-stt.js';
import { CaptureTransport } from './voice/capture-transport.js';
import { MicGate } from './voice/mic-gate.js';
import { ListeningService } from './voice/listening-service.js';
import { SpeechService } from './voice/speech-service.js';
import { SpeechTransport } from './voice/speech-transport.js';

/**
 * The security hooks, re-exported.
 *
 * `index.ts` installs these before the runtime exists, deliberately — no
 * WebContents may be created against an unhardened session. Re-exporting them
 * here lets `scripts/verify-browser.cjs` apply the SAME hooks, so the harness
 * verifies the configuration the product runs rather than a laxer one. That
 * matters: the browser's navigation policy interacts with these, and a harness
 * that omitted them would have passed while link clicking was broken in the
 * real app.
 */
export { applySessionSecurity, installSecurityHooks } from './security.js';

/**
 * The persistence layer, re-exported for `scripts/verify-persistence.cjs`.
 *
 * That harness runs inside Electron because `node:sqlite` lives there and not
 * in the unit-test runner's Node. Exporting the real classes — rather than
 * having the harness rebuild an approximation — is what makes it a test of the
 * shipping code. `TARGET_SCHEMA_VERSION` is derived from the migration list,
 * so the harness cannot assert a version this build does not actually target.
 */
/**
 * The `.env` loader, re-exported for the verification harnesses.
 *
 * `index.ts` calls this during bootstrap, before anything reads the
 * environment. A harness that wants the product's real configuration has to
 * call the same function rather than parsing the file itself — otherwise it
 * verifies its own idea of how configuration is loaded.
 */
export { envFileCandidates, loadEnvFile } from './env-file.js';
export { PersistenceService } from './persistence/persistence-service.js';
export { openDatabase } from './persistence/sqlite.js';
export { targetVersion as currentTargetVersion } from './persistence/migrations.js';

export interface AxonRuntime {
  readonly config: RuntimeConfig;
  readonly bus: EventBus;
  readonly sink: JsonlEventSink;
  readonly orchestrator: Orchestrator;
  /** The renderer bridge attaches itself here once IPC is up. */
  readonly speechTransport: SpeechTransport;
  /** The inbound twin: the bridge attaches here to carry capture commands. */
  readonly captureTransport: CaptureTransport;
  /** Exposed like the orchestrator, so the verification harness drives the
   *  real service rather than a reconstruction of it. */
  readonly speech: SpeechService;
  readonly listening: ListeningService;
  readonly browser: AxonBrowser;
  readonly persistence: PersistenceService;
  readonly settings: SettingsService;
  /**
   * The local wake word.
   *
   * Exposed so `index.ts` can arm it at startup and disarm it on quit, and so
   * the verification harness drives the real detector rather than a
   * reconstruction. It holds no credential and opens no socket.
   */
  readonly wakeWord: WakeWordDetector;
  /**
   * When page code may obtain a microphone.
   *
   * Consulted by the security hooks in `index.ts`. Exposed so the shipping
   * entry point and the verification harness ask the same object.
   */
  readonly micGate: MicGate;
}

export interface RuntimeInputs extends ConfigInputs {
  /**
   * The push-to-talk accelerator actually registered, for the UI to display.
   *
   * Passed in rather than registered here: `globalShortcut` needs a ready
   * Electron app, and this same function is called by the verification
   * harness, which has no window and registers no shortcuts.
   */
  readonly hotkey?: string | null;
  /**
   * Re-registers the push-to-talk shortcut when the user changes it.
   *
   * Injected because `globalShortcut` needs a ready Electron app and the
   * verification harness has neither a window nor a keyboard. Returns the
   * accelerator actually in force, or null when none could be taken — which is
   * what the settings service rolls back on.
   */
  readonly applyHotkey?: (accelerator: string | null) => string | null;
}

/** The schema version this build migrates to. Derived, never declared. */
export const TARGET_SCHEMA_VERSION = schemaTarget();

export function createAxonRuntime(inputs: RuntimeInputs): AxonRuntime {
  const config = resolveRuntimeConfig(inputs);

  const bus = new EventBus();
  const sink = new JsonlEventSink(config.eventLogPath);
  bus.addSink(sink);

  // --- persistence ---------------------------------------------------------
  // First, and before anything that might want to read a setting. The database
  // path comes from `config`, which derives it from AXON_HOME and nothing
  // else: no tool takes a path, and the renderer cannot name one.
  //
  // A failure here does not stop the app. `start()` returns false, persistence
  // reports itself unavailable with a reason, and Axon runs from memory for
  // the session — because a damaged database is somebody's history, and
  // deleting it to get a clean start is not a decision to take on their behalf.
  const persistence = new PersistenceService({
    databasePath: config.databasePath,
    onEvent: (notice) => {
      switch (notice.kind) {
        case 'session':
          bus.emit({
            type: 'SESSION_CHANGED',
            action: notice.action,
            conversationId: notice.sessionId,
            title: notice.title,
          });
          return;
        case 'memory':
          bus.emit({
            type: 'MEMORY_CHANGED',
            action: notice.action,
            memoryId: notice.memoryId,
            category: notice.category,
            key: notice.key,
            count: notice.count,
          });
          return;
        case 'settings':
          bus.emit({ type: 'SETTINGS_UPDATED', keys: [...notice.keys] });
          return;
        case 'error':
          bus.emit({ type: 'PERSISTENCE_ERROR', scope: notice.scope, message: notice.message });
          return;
        default:
          return;
      }
    },
  });

  const persistenceAvailable = persistence.start();

  // --- reach ---------------------------------------------------------------
  // The browser is created here and nowhere else. Its notices go straight to
  // the event stream, so what the user sees in the timeline is what the
  // browser actually did rather than what the model said it did.
  const browser = new AxonBrowser({
    onNotice: (summary, detail) => {
      bus.emit({ type: 'OBSERVATION', callId: null, summary, detail });
    },
  });

  // A workspace the user chose, when they chose one. Already normalized and
  // checked by `settings-schema.ts` on the way in and on the way back out of
  // the database, so what lands here is an absolute path or nothing.
  const workspaceRoot = persistence.currentSettings().workspacePath ?? config.workspaceRoot;

  const registry = createDefaultRegistry({
    launcher: new ElectronAppLauncher(),
    capturer: new ElectronScreenCapturer(),
    screenshotDir: config.screenshotDir,
    pathPolicy: {
      workspaceRoot,
      forbiddenRoots: config.forbiddenRoots,
    },
    browser,
    persistence,
    // Window enumeration and focus. Available on Windows; elsewhere the tools
    // are simply not registered and the model is not told about them.
    desktop: new WindowsDesktop({ platform: process.platform }),
  });

  // The upgrade Step 2 predicted, and it really is one line: the same `Memory`
  // contract, now backed by SQLite. `ClaudeBrain` is unchanged and cannot tell
  // that its records outlive the process.
  const memory = new PersistentConversationMemory(persistence);

  const { brain, unavailableReason, model } = createBrain({
    apiKey: inputs.env.ANTHROPIC_API_KEY,
    model: inputs.env.AXON_MODEL,
    memory,
    workspaceRoot,
    platform: process.platform,
    newCallId: () => randomUUID(),
  });

  // --- voice --------------------------------------------------------------
  // The synthesiser is chosen here and nowhere else. Everything above it
  // depends on the TextToSpeech interface, so a different provider is a change
  // to `create-tts.ts` alone.
  const { tts, unavailableReason: speechUnavailableReason } = createTextToSpeech({
    platform: process.platform,
    provider: inputs.env.AXON_TTS_PROVIDER,
  });

  const speechTransport = new SpeechTransport();

  // The service is constructed even with no synthesiser: it is then the thing
  // that can explain, to the UI, why Axon is silent.
  const speech = new SpeechService({
    tts,
    unavailableReason: speechUnavailableReason,
    deliver: (delivery) => speechTransport.deliver(delivery),
    stopPlayback: (speechId) => speechTransport.stop(speechId),
    // Bound late: the orchestrator does not exist yet, and the service must
    // not be the thing that owns Axon's state.
    onStarted: (info) => orchestrator.onSpeechStarted(info),
    onEnded: (speechId, reason) => orchestrator.onSpeechEnded(speechId, reason),
    onFailure: (message) => orchestrator.onSpeechFailure(message),
  });

  // --- voice in -----------------------------------------------------------
  // The recognizer is chosen here and nowhere else, exactly as the synthesiser
  // is. Everything above it depends on the SpeechToText interface.
  const { stt, unavailableReason: listeningUnavailableReason } = createSpeechToText({
    platform: process.platform,
    provider: inputs.env.AXON_STT_PROVIDER,
  });

  // The microphone permission window. Opened by a capture command and closed
  // by the renderer's report — never by "a session is open", which the wake
  // word would hold indefinitely.
  const micGate = new MicGate();
  const captureTransport = new CaptureTransport(micGate);

  // Built even with no recognizer: it is then the thing that can explain, to
  // the UI, why Axon cannot listen.
  const listening = new ListeningService({
    stt,
    unavailableReason: listeningUnavailableReason,
    hotkey: inputs.hotkey ?? null,
    command: (command) => captureTransport.command(command),
    // Bound late, like the speech service's callbacks: the orchestrator does
    // not exist yet, and the listening service must not be the thing that owns
    // Axon's state.
    onStarted: (trigger) => orchestrator.onListeningStarted(trigger),
    onEnded: (reason) => orchestrator.onListeningEnded(reason),
    onTranscript: (text, metrics) => orchestrator.onTranscript(text, metrics),
    onNotice: (message) => orchestrator.onListeningNotice(message),
    onFailure: (message) => orchestrator.onListeningFailure(message),
  });

  // --- voice agent ---------------------------------------------------------
  // The key is read here, into a local, and handed to the factory. It is never
  // placed on the config, on the runtime, or in the OBSERVATION below — the
  // same discipline the model key follows, and for the same reason.
  const { provider: voiceAgent, unavailableReason: voiceAgentUnavailableReason } = createVoiceAgent({
    apiKey: inputs.env.ASSEMBLYAI_API_KEY,
    provider: inputs.env.AXON_VOICE_AGENT_PROVIDER,
    platform: process.platform,
    workspaceRoot,
  });

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: config.approvalTimeoutMs,
    devConsoleEnabled: config.devConsoleEnabled,
    brain,
    brainUnavailableReason: unavailableReason,
    speech,
    listening,
    browser,
    voiceAgent,
    voiceAgentUnavailableReason,
    // Streamed agent audio reaches the window on the same transport the
    // synthesiser's one-shot utterances use.
    speechChunks: speechTransport,
    captureCommand: (command) => captureTransport.command(command),
    micGate,
    // Without this the orchestrator holds no persistence at all: it reports
    // the database as unavailable to the renderer, and — the part that
    // matters — `contextForTurn()` is never called, so no session summary, no
    // memories and no temporal context ever reach the brain. Step 6 built all
    // of that and this line is what connects it.
    persistence,
  });

  // --- wake word ------------------------------------------------------------
  // Reuses the SAME offline recognizer the typed voice path uses. It opens no
  // socket and holds no credential: while it is armed, microphone audio goes
  // to a local process and nowhere else, which is the whole of Axon's
  // "before activation, audio stays local" guarantee.
  const wakeWord = new WakeWordDetector({
    stt,
    onWake: () => {
      // The one thing a wake phrase does: ask for a session. Everything about
      // whether that is allowed is the orchestrator's decision, and the
      // activation is recorded on the event stream.
      orchestrator.startVoiceSession('wake-word');
    },
    onArmedChanged: (armed) => {
      orchestrator.setWakeArmed(armed);
    },
    onNotice: (message) => {
      bus.emit({ type: 'OBSERVATION', callId: null, summary: message, detail: null });
    },
  });

  // Frames now have somewhere to go while Axon is armed. Until this line the
  // detector would have been armed and deaf.
  orchestrator.attachWakeWord(wakeWord);

  // --- settings -------------------------------------------------------------
  // Owns the side effects a settings change has: re-registering the global
  // hotkey, checking a workspace exists, and putting things back when either
  // fails. Validation itself is pure and lives in `settings-schema.ts`.
  const settings = new SettingsService(persistence.currentSettings(), {
    effects: {
      applyHotkey: inputs.applyHotkey ?? ((): string | null => null),
      directoryExists,
    },
    commit: (next, changed) => persistence.commitSettings(next, changed),
    onChanged: (next, changed) => {
      // Two settings take effect immediately rather than at next launch.
      if (changed.includes('speechEnabled')) speech.setEnabled(next.speechEnabled);
    },
  });

  // The conversation to continue. Done after the orchestrator exists so the
  // SESSION_CHANGED event has somewhere to be rendered, and after settings so
  // "restore the last session" is honoured.
  const initialSession = persistence.openInitialSession();
  orchestrator.bindSession(initialSession?.id ?? null);

  bus.emit({
    type: 'OBSERVATION',
    callId: null,
    // Describes the ACTIVE provider. "No brain attached" was accurate when
    // Anthropic was the only one; now it reads as a failure in a runtime that
    // is fully able to hold a conversation.
    summary: ((): string => {
      const voice = orchestrator.voiceAgentStatus();
      if (voice.available) {
        return `Axon runtime ready with ${registry.size} tools and a voice agent (${voice.name})`;
      }
      if (brain) return `Axon runtime ready with ${registry.size} tools and a typed brain`;
      return `Axon runtime ready with ${registry.size} tools and no provider configured`;
    })(),
    detail: {
      tools: [...registry.names()],
      workspace: config.workspaceRoot,
      screenshots: config.screenshotDir,
      eventLog: config.eventLogPath,
      approvalTimeoutMs: config.approvalTimeoutMs,
      devConsole: config.devConsoleEnabled,
      // The model id and a boolean. Never the key.
      brain: brain ? brain.name : 'none',
      model,
      memory: memory.name,
      // A provider name and a boolean. SAPI needs no credential, and if a
      // future provider does, it still would not appear here.
      voice: speech.status().name,
      voiceAvailable: speech.status().available,
      // A provider name and a boolean. The Windows recognizer needs no
      // credential; if a future one does, it still would not appear here.
      ears: listening.status().name,
      earsAvailable: listening.status().available,
      hotkey: inputs.hotkey ?? null,
      // A boolean and a tool count. Never a URL the user has visited, and
      // never anything from the browser's session storage.
      browser: 'electron',
      browserTools: registry.names().filter((name) => name.startsWith('browser.')).length,
      // A boolean, a schema number and two counts. Never the contents of the
      // database, and never the path to anything the user did not choose.
      // A provider name and a boolean. Never the key, never the endpoint.
      voiceAgent: orchestrator.voiceAgentStatus().name,
      voiceAgentAvailable: orchestrator.voiceAgentStatus().available,
      wakeWord: wakeWord.available ? 'local' : 'unavailable',
      persistence: persistenceAvailable ? 'sqlite' : 'unavailable',
      schemaVersion: persistence.status().schemaVersion,
      sessions: persistence.status().sessionCount,
      memories: persistence.status().memoryCount,
    },
  });

  return {
    config,
    bus,
    sink,
    orchestrator,
    speechTransport,
    captureTransport,
    speech,
    listening,
    browser,
    persistence,
    settings,
    wakeWord,
    micGate,
  };
}

/**
 * Entry point for the verification harness.
 *
 * Named separately so the harness's dependency on this module is explicit and
 * greppable, but it is the same function — there is no verification-only code
 * path through the runtime.
 */
export function createVerificationRuntime(inputs: Omit<RuntimeInputs, 'isDev'>): AxonRuntime {
  return createAxonRuntime({ ...inputs, isDev: true });
}
