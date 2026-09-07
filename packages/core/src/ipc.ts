/**
 * The renderer <-> main contract.
 *
 * This file is the audit surface for the security boundary. Everything the
 * sandboxed renderer can reach is listed here; if it is not in `AxonBridge`,
 * the renderer cannot do it.
 *
 * Design rules this shape enforces:
 *
 * 1. The renderer *observes*. It receives events; it never asserts state.
 * 2. The renderer *proposes*. `requestState` asks the main-process state
 *    machine to move — main validates the transition and may refuse. The
 *    renderer learns the outcome only through the event stream.
 * 3. The renderer cannot bypass safety. `invokeTool` reaches the dispatcher,
 *    not an executor, so policy and approval apply identically to it and to
 *    the brain.
 * 4. Development affordances are explicitly flagged and refused by the main
 *    process outside development. `devConsoleEnabled` tells the UI whether to
 *    render them; it is not what enforces the restriction.
 */

import type { AxonEvent } from './events.js';
import type { AxonState } from './states.js';
import type { ApprovalDecision, ApprovalRequest } from './approval.js';
import type { JsonValue } from './json.js';
import type { ToolResult, ToolSchema } from './tool-contract.js';
import type { SpeechDelivery, SpeechReport, SpeechStatus } from './speech.js';
import type {
  CaptureCommand,
  CaptureReport,
  ListeningStatus,
  StartListeningResult,
} from './listening.js';
import type { BrowserStatus } from './browsing.js';
import type { SpeechChunk, VoiceAgentStatus, VoiceSessionResult } from './voice-agent.js';
import type {
  AxonProfile,
  AxonSettings,
  MemoryEntry,
  PersistenceStatus,
  SessionRecord,
  SettingsUpdateResult,
} from './persistence.js';

/** IPC channel names. Namespaced so they cannot collide with Electron's own. */
export const IPC_CHANNELS = {
  /** main -> renderer: one AxonEvent. */
  EVENT: 'axon:event',
  /** renderer -> main: fetch current state + backlog on mount. */
  SNAPSHOT: 'axon:snapshot',
  /** renderer -> main: settle a pending approval. */
  APPROVAL_DECISION: 'axon:approval:decide',
  /** renderer -> main: read the code-free tool surface. */
  TOOLS_LIST: 'axon:tools:list',
  /** renderer -> main: dev console, routed through the dispatcher. */
  TOOL_INVOKE: 'axon:tools:invoke',
  /** renderer -> main: dev console, propose a state transition. */
  STATE_REQUEST: 'axon:state:request',
  /** renderer -> main: send the user's typed message to the brain. */
  BRAIN_SEND: 'axon:brain:send',
  /** main -> renderer: one utterance's audio bytes. Never a path. */
  SPEECH_AUDIO: 'axon:speech:audio',
  /**
   * main -> renderer: one chunk of streamed agent audio.
   *
   * A second audio channel rather than a second meaning for the first. Both
   * are one-way, main to renderer, carrying bytes main chose; neither has a
   * counterpart that lets the page ask for audio. The split exists because a
   * whole utterance and a chunk of one need different framing, not because
   * the renderer gains anything from either.
   */
  SPEECH_CHUNK: 'axon:speech:chunk',
  /** main -> renderer: stop playing the named utterance immediately. */
  SPEECH_STOP: 'axon:speech:stop',
  /** renderer -> main: advisory playback progress. Main is still authoritative. */
  SPEECH_REPORT: 'axon:speech:report',
  /** renderer -> main: stop speaking (the UI's stop button). */
  SPEECH_CANCEL: 'axon:speech:cancel',
  /** renderer -> main: ask to start listening. Main decides. */
  LISTEN_START: 'axon:listen:start',
  /** renderer -> main: ask to stop listening. */
  LISTEN_STOP: 'axon:listen:stop',
  /** main -> renderer: open or close the microphone for a named session. */
  LISTEN_CAPTURE: 'axon:listen:capture',
  /**
   * renderer -> main: one frame of 16-bit PCM.
   *
   * The one channel in Axon that carries raw microphone audio, and the reason
   * it is a channel of its own: frames must be impossible to confuse with an
   * event, and impossible to reach without main having opened a session first.
   */
  LISTEN_AUDIO: 'axon:listen:audio',
  /** renderer -> main: microphone opened, closed, or failed to open. */
  LISTEN_REPORT: 'axon:listen:report',

  /**
   * The voice-agent surface.
   *
   * Two verbs and nothing else. There is deliberately no channel here that
   * names a provider, an endpoint, a session id, a model or a credential —
   * the renderer can ask Axon to start talking and ask it to stop, and
   * everything else about the session is main's business. Status arrives on
   * the snapshot and the event stream like every other piece of state.
   */
  VOICE_SESSION_START: 'axon:voice:start',
  VOICE_SESSION_STOP: 'axon:voice:stop',

  /**
   * The persistence surface.
   *
   * Note what these channels do NOT include: no query, no table name, no SQL,
   * no file path, and no way to name the database. The renderer asks for
   * conversations, memories and settings by their meaning; every payload is
   * schema-validated in main, and every value it can set has a validator and a
   * safe default. There is no channel here that reaches the database directly.
   */
  SESSIONS_LIST: 'axon:sessions:list',
  SESSION_CREATE: 'axon:sessions:create',
  SESSION_SELECT: 'axon:sessions:select',
  SESSION_RENAME: 'axon:sessions:rename',
  SESSION_DELETE: 'axon:sessions:delete',
  MEMORY_LIST: 'axon:memory:list',
  MEMORY_SET_ENABLED: 'axon:memory:enabled',
  MEMORY_DELETE: 'axon:memory:delete',
  MEMORY_CLEAR: 'axon:memory:clear',
  SETTINGS_GET: 'axon:settings:get',
  SETTINGS_UPDATE: 'axon:settings:update',
  SETTINGS_RESET: 'axon:settings:reset',
  PROFILE_UPDATE: 'axon:profile:update',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Whether Axon has a brain attached, and which.
 *
 * Deliberately carries no credential and no configuration — only the name of
 * the brain and whether it is usable. `reason` explains an unavailable brain
 * in terms the user can act on ("no API key configured"), never by echoing
 * anything secret.
 */
export interface BrainStatus {
  readonly available: boolean;
  readonly name: string;
  readonly reason: string | null;
}

/** Everything the UI needs to render correctly on first paint or after reload. */
export interface AxonSnapshot {
  readonly sessionId: string;
  readonly state: AxonState;
  /** Most recent events, oldest first. */
  readonly events: readonly AxonEvent[];
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly devConsoleEnabled: boolean;
  readonly brain: BrainStatus;
  /** True while a turn is in flight; the composer disables itself on this. */
  readonly busy: boolean;
  readonly speech: SpeechStatus;
  readonly listening: ListeningStatus;
  /** Whether Axon can hold a spoken conversation, and whether it is. */
  readonly voiceAgent: VoiceAgentStatus;
  readonly browser: BrowserStatus;
  readonly persistence: PersistenceStatus;
  readonly settings: AxonSettings;
  readonly profile: AxonProfile;
  /** The conversation this window is showing, or null when none is open. */
  readonly conversationId: string | null;
}

/** Outcome of handing a message to the brain. */
export interface SendMessageResult {
  readonly accepted: boolean;
  readonly error: string | null;
}

/** Outcome of a proposed transition. Rejection is a normal, expected answer. */
export interface StateRequestResult {
  readonly accepted: boolean;
  readonly state: AxonState;
  readonly error: string | null;
}

/**
 * The complete API exposed on `window.axon` by the preload script.
 *
 * Deliberately absent: any filesystem access, any child-process access, any
 * `require`, any way to name an executor, and any setter for Axon's state.
 */
export interface AxonBridge {
  getSnapshot(): Promise<AxonSnapshot>;
  /** Subscribe to the event stream. Returns an unsubscribe function. */
  onEvent(listener: (event: AxonEvent) => void): () => void;
  /**
   * Settle a pending approval.
   *
   * `fingerprint` is the binding the dialog displayed. Sending it back turns
   * "Allow was pressed" into "Allow was pressed on THIS act": main refuses an
   * ALLOW whose fingerprint does not match the live request, so a dialog
   * rendered from a stale snapshot cannot authorise the request that replaced
   * it. It is optional in the type only so a caller that has no dialog (the
   * dev console) is not forced to invent one.
   */
  resolveApproval(callId: string, decision: ApprovalDecision, fingerprint?: string): Promise<void>;
  listTools(): Promise<readonly ToolSchema[]>;
  /** Dev console only. Goes through the dispatcher; refused by main in production. */
  invokeTool(tool: string, input: JsonValue): Promise<ToolResult>;
  /** Dev console only. Proposes a transition; main validates and may refuse. */
  requestState(to: AxonState, reason: string): Promise<StateRequestResult>;
  /**
   * Hand a typed message to the brain.
   *
   * Resolves as soon as the turn is *accepted*, not when it finishes. Progress
   * and the reply arrive on the event stream like everything else, so a
   * reload mid-turn loses nothing.
   */
  sendMessage(text: string): Promise<SendMessageResult>;

  /**
   * Receive an utterance to play. Returns an unsubscribe function.
   *
   * The payload carries bytes, not a location. There is deliberately no
   * counterpart that lets the renderer name what should be played: audio only
   * ever flows main -> renderer, chosen by main.
   */
  onSpeech(listener: (delivery: SpeechDelivery) => void): () => void;
  /**
   * Receive one chunk of streamed agent audio. Returns an unsubscribe.
   *
   * Same shape and same direction as `onSpeech`: bytes arrive, chosen by main.
   * The page cannot name what it wants played through either.
   */
  onSpeechChunk(listener: (chunk: SpeechChunk) => void): () => void;
  /** Main asking the renderer to stop an utterance it is playing. */
  onSpeechStop(listener: (speechId: string) => void): () => void;
  /** Tell main how playback is going. Advisory — main runs its own watchdog. */
  reportSpeech(report: SpeechReport): Promise<void>;
  /** Ask main to stop speaking. Main decides and drives the state change. */
  cancelSpeech(): Promise<void>;

  /**
   * Ask Axon to start a spoken conversation.
   *
   * A request, not an instruction: main decides whether a session may open,
   * opens the socket itself, and the renderer learns the outcome from the
   * snapshot and the event stream. There is no argument naming a provider, a
   * prompt, a model or a voice — a compromised renderer can ask Axon to talk,
   * and that is the whole of what it can ask for.
   */
  startVoiceSession(): Promise<VoiceSessionResult>;
  /** Ask Axon to end the spoken conversation. */
  stopVoiceSession(): Promise<VoiceSessionResult>;

  /**
   * Ask Axon to listen.
   *
   * Takes no arguments on purpose. There is no device to nominate, no
   * duration to request and no format to negotiate — every one of those is
   * fixed in main. The renderer can ask for the microphone to open; it cannot
   * describe how.
   *
   * Refusal is a normal answer (Axon is mid-turn, or has no recognizer).
   */
  startListening(): Promise<StartListeningResult>;
  /** Ask Axon to stop listening. Also parameterless. */
  stopListening(): Promise<void>;

  /**
   * Main opening or closing the microphone. Returns an unsubscribe function.
   *
   * This is the only thing that may cause the renderer to call
   * `getUserMedia`. A UI click goes to `startListening` and comes back here,
   * so a microphone that opens is always one main authorised.
   */
  onCaptureCommand(listener: (command: CaptureCommand) => void): () => void;

  /**
   * Send one frame of captured audio.
   *
   * Fire and forget: there is no reply, so a compromised page cannot use the
   * return value to learn anything about what main heard. Frames whose
   * `captureId` is not the open session are dropped in main.
   */
  sendAudioFrame(captureId: string, samples: Int16Array): void;

  /** Tell main how the microphone is doing. */
  reportCapture(report: CaptureReport): Promise<void>;

  /**
   * Conversations.
   *
   * The renderer can list, open, name and delete them. It cannot read a
   * message through these — the transcript is rebuilt from the event stream
   * like everything else — and it cannot name a file.
   */
  listSessions(): Promise<readonly SessionRecord[]>;
  createSession(): Promise<SessionRecord | null>;
  selectSession(id: string): Promise<SessionRecord | null>;
  renameSession(id: string, title: string): Promise<boolean>;
  /** Irreversible, and really deletes the messages too. */
  deleteSession(id: string): Promise<boolean>;

  /**
   * Long-term memory.
   *
   * Inspect, disable, delete, wipe. Deliberately no `create`: a memory is
   * written by the agent through the dispatcher with the user's approval, and
   * a renderer-side create would be a second, ungated path to the same table.
   */
  listMemories(): Promise<readonly MemoryEntry[]>;
  setMemoryEnabled(id: string, enabled: boolean): Promise<boolean>;
  deleteMemory(id: string): Promise<boolean>;
  clearMemories(): Promise<number>;

  /** Settings. Every value is validated in main, whatever arrives here. */
  getSettings(): Promise<AxonSettings>;
  updateSettings(patch: Partial<AxonSettings>): Promise<SettingsUpdateResult>;
  resetSettings(): Promise<SettingsUpdateResult>;
  updateProfile(patch: { displayName?: string | null; language?: string | null }): Promise<AxonProfile>;
}
