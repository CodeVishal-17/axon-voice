/**
 * The preload bridge — the complete list of things the renderer can do.
 *
 * AUDIT THIS FILE. It is short on purpose: everything reachable from the
 * sandboxed page passes through here, so its length is the size of the attack
 * surface.
 *
 * What is deliberately absent:
 *   - `ipcRenderer` itself (exposing it would hand the page every channel,
 *     including Electron's internal ones)
 *   - any filesystem, process, or child-process access
 *   - `require`, `process`, `Buffer`, `__dirname`
 *   - any way to name or reach a tool executor
 *   - any setter for Axon's state
 *
 * With `sandbox: true` this script runs in a restricted context where only a
 * subset of Electron's API is available. That subset covers `contextBridge`
 * and `ipcRenderer`, which is all a bridge should ever have needed.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
// Imported from the `/ipc` subpath, not the package root. `ipc.ts` has only
// type-level imports, so this pulls in the channel constants and nothing else —
// notably not Zod and not the event schemas. The preload bundle stays a few
// hundred bytes, which is what makes "audit this file" a realistic instruction.
import { IPC_CHANNELS } from '@axon/core/ipc';
import type {
  ApprovalDecision,
  AxonBridge,
  AxonProfile,
  AxonSettings,
  AxonEvent,
  AxonSnapshot,
  AxonState,
  CaptureCommand,
  CaptureDiagnostics,
  CaptureReport,
  JsonValue,
  MemoryEntry,
  PlaybackDiagnostics,
  SendMessageResult,
  SessionRecord,
  SettingsUpdateResult,
  SpeechChunk,
  SpeechDelivery,
  SpeechReport,
  StartListeningResult,
  StateRequestResult,
  ToolResult,
  ToolSchema,
  VoiceSessionResult,
  OverlayPhase,
  StartupStatus,
} from '@axon/core';

const bridge: AxonBridge = {
  getSnapshot(): Promise<AxonSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT) as Promise<AxonSnapshot>;
  },

  onEvent(listener: (event: AxonEvent) => void): () => void {
    // The IpcRendererEvent is not forwarded. It carries a `sender` handle, and
    // handing that to page code would give the page a way to talk to channels
    // this bridge does not list.
    const handler = (_event: IpcRendererEvent, payload: AxonEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT, handler);
    };
  },

  async resolveApproval(callId: string, decision: ApprovalDecision, fingerprint?: string): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_DECISION, { callId, decision, fingerprint });
  },

  listTools(): Promise<readonly ToolSchema[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.TOOLS_LIST) as Promise<readonly ToolSchema[]>;
  },

  invokeTool(tool: string, input: JsonValue): Promise<ToolResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.TOOL_INVOKE, { tool, input }) as Promise<ToolResult>;
  },

  requestState(to: AxonState, reason: string): Promise<StateRequestResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.STATE_REQUEST, { to, reason }) as Promise<StateRequestResult>;
  },

  setAppearance(appearance: 'dark' | 'light'): Promise<void> {
    // Rebuilt as a literal, so nothing but the one word crosses.
    return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_APPEARANCE, {
      appearance: appearance === 'light' ? 'light' : 'dark',
    }) as Promise<void>;
  },

  sendMessage(text: string): Promise<SendMessageResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.BRAIN_SEND, { text }) as Promise<SendMessageResult>;
  },

  onSpeech(listener: (delivery: SpeechDelivery) => void): () => void {
    // As with onEvent, the IpcRendererEvent is dropped rather than forwarded:
    // it carries a `sender` handle that would give page code a route to
    // channels this bridge does not list.
    const handler = (_event: IpcRendererEvent, payload: SpeechDelivery): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.SPEECH_AUDIO, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_AUDIO, handler);
    };
  },

  /**
   * One chunk of streamed agent audio.
   *
   * The same shape as `onSpeech` and the same rule: the raw IpcRendererEvent
   * is never handed to page code, and there is no counterpart that lets the
   * page ask for audio. Bytes arrive because main chose to send them.
   */
  onSpeechChunk(listener: (chunk: SpeechChunk) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: SpeechChunk): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.SPEECH_CHUNK, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_CHUNK, handler);
    };
  },

  onSpeechStop(listener: (speechId: string) => void): () => void {
    const handler = (_event: IpcRendererEvent, speechId: string): void => {
      listener(speechId);
    };
    ipcRenderer.on(IPC_CHANNELS.SPEECH_STOP, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_STOP, handler);
    };
  },

  async reportSpeech(report: SpeechReport): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.SPEECH_REPORT, {
      // Rebuilt field by field rather than forwarded: whatever else a caller
      // attached to the object stays on this side of the boundary.
      speechId: report.speechId,
      status: report.status,
    });
  },

  reportPlaybackDiagnostics(report: PlaybackDiagnostics): void {
    // Rebuilt field by field, a string id, a fixed word, two numbers and a
    // short reason, so nothing else a page attached to the object crosses.
    // `send`: fire and forget, no reply to learn anything from.
    // Literals rather than core's constants: this file imports VALUES only
    // from `@axon/core/ipc`, so the bridge stays the small audited object it
    // is. Main validates the same bounds strictly on arrival.
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
    const events: readonly string[] = ['received', 'started', 'ended', 'failed'];
    ipcRenderer.send(IPC_CHANNELS.SPEECH_PLAYBACK_DIAGNOSTICS, {
      speechId: typeof report.speechId === 'string' ? report.speechId.slice(0, 64) : '',
      event: events.includes(report.event) ? report.event : 'failed',
      chunks: num(report.chunks),
      bytes: num(report.bytes),
      reason: typeof report.reason === 'string' ? report.reason.slice(0, 120) : null,
    });
  },

  async cancelSpeech(): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.SPEECH_CANCEL);
  },

  startVoiceSession(): Promise<VoiceSessionResult> {
    // No arguments. See the handler in `renderer-bridge.ts`.
    return ipcRenderer.invoke(IPC_CHANNELS.VOICE_SESSION_START) as Promise<VoiceSessionResult>;
  },

  stopVoiceSession(): Promise<VoiceSessionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.VOICE_SESSION_STOP) as Promise<VoiceSessionResult>;
  },

  startListening(): Promise<StartListeningResult> {
    // Parameterless. There is no device to name, no duration to request and
    // no format to negotiate — every one of those is fixed in main.
    return ipcRenderer.invoke(IPC_CHANNELS.LISTEN_START) as Promise<StartListeningResult>;
  },

  async stopListening(): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.LISTEN_STOP);
  },

  onCaptureCommand(listener: (command: CaptureCommand) => void): () => void {
    // As with onEvent, the IpcRendererEvent is dropped rather than forwarded:
    // it carries a `sender` handle that would give page code a route to
    // channels this bridge does not list.
    const handler = (_event: IpcRendererEvent, payload: CaptureCommand): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.LISTEN_CAPTURE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.LISTEN_CAPTURE, handler);
    };
  },

  sendAudioFrame(captureId: string, samples: Int16Array): void {
    // `send`, not `invoke`: no reply, so nothing about what main heard — or
    // about whether this capture id is the live one — comes back through here.
    ipcRenderer.send(IPC_CHANNELS.LISTEN_AUDIO, { captureId, samples });
  },

  // --- overlay and startup -------------------------------------------------

  onOverlayPhase(listener: (phase: OverlayPhase) => void): () => void {
    // The event is dropped, as everywhere else, and the payload is narrowed to
    // one of two words before page code sees it.
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload === 'leave' ? 'leave' : 'enter');
    };
    ipcRenderer.on(IPC_CHANNELS.OVERLAY_PHASE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OVERLAY_PHASE, handler);
    };
  },

  setOverlayInteractive(interactive: boolean): void {
    // One boolean, fire and forget.
    ipcRenderer.send(IPC_CHANNELS.OVERLAY_INTERACTIVE, interactive === true);
  },

  getStartup(): Promise<StartupStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.STARTUP_GET) as Promise<StartupStatus>;
  },

  setStartup(enabled: boolean): Promise<StartupStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.STARTUP_SET, { enabled: enabled === true }) as Promise<StartupStatus>;
  },

  // --- persistence --------------------------------------------------------
  // Every one of these is a request, answered by main. None of them names a
  // table, a query, a file or the database, and every payload is validated on
  // the other side before it reaches a row.

  listSessions(): Promise<readonly SessionRecord[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_LIST) as Promise<readonly SessionRecord[]>;
  },

  createSession(): Promise<SessionRecord | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE) as Promise<SessionRecord | null>;
  },

  selectSession(id: string): Promise<SessionRecord | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_SELECT, { id }) as Promise<SessionRecord | null>;
  },

  renameSession(id: string, title: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, { id, title }) as Promise<boolean>;
  },

  deleteSession(id: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, { id }) as Promise<boolean>;
  },

  listMemories(): Promise<readonly MemoryEntry[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST) as Promise<readonly MemoryEntry[]>;
  },

  setMemoryEnabled(id: string, enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SET_ENABLED, { id, enabled }) as Promise<boolean>;
  },

  deleteMemory(id: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, { id }) as Promise<boolean>;
  },

  clearMemories(): Promise<number> {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR) as Promise<number>;
  },

  getSettings(): Promise<AxonSettings> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET) as Promise<AxonSettings>;
  },

  updateSettings(patch: Partial<AxonSettings>): Promise<SettingsUpdateResult> {
    // Rebuilt field by field rather than forwarded: whatever else a caller
    // attached to the object stays on this side of the boundary, and main
    // validates every field again regardless.
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, {
      ...(patch.voiceHotkey !== undefined ? { voiceHotkey: patch.voiceHotkey } : {}),
      ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath } : {}),
      ...(patch.speechEnabled !== undefined ? { speechEnabled: patch.speechEnabled } : {}),
      ...(patch.restoreLastSession !== undefined ? { restoreLastSession: patch.restoreLastSession } : {}),
      ...(patch.memoryEnabled !== undefined ? { memoryEnabled: patch.memoryEnabled } : {}),
    }) as Promise<SettingsUpdateResult>;
  },

  resetSettings(): Promise<SettingsUpdateResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET) as Promise<SettingsUpdateResult>;
  },

  updateProfile(patch: { displayName?: string | null; language?: string | null }): Promise<AxonProfile> {
    return ipcRenderer.invoke(IPC_CHANNELS.PROFILE_UPDATE, {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
    }) as Promise<AxonProfile>;
  },

  reportCaptureDiagnostics(report: CaptureDiagnostics): void {
    // Rebuilt field by field, numbers and booleans only, so nothing else a page
    // attached to the object crosses. `send`: no reply.
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
    ipcRenderer.send(IPC_CHANNELS.LISTEN_DIAGNOSTICS, {
      captureId: typeof report.captureId === 'string' ? report.captureId.slice(0, 64) : '',
      pipeline: report.pipeline === 'track-processor' ? 'track-processor' : 'script-processor',
      targetSampleRate: num(report.targetSampleRate),
      contextSampleRate: num(report.contextSampleRate),
      trackSampleRate: numOrNull(report.trackSampleRate),
      trackChannelCount: numOrNull(report.trackChannelCount),
      echoCancellation: boolOrNull(report.echoCancellation),
      noiseSuppression: boolOrNull(report.noiseSuppression),
      autoGainControl: boolOrNull(report.autoGainControl),
      windowMs: num(report.windowMs),
      callbacks: num(report.callbacks),
      producedMs: num(report.producedMs),
      audioClockMs: num(report.audioClockMs),
      maxCallbackGapMs: num(report.maxCallbackGapMs),
      rms: num(report.rms),
      peak: num(report.peak),
      silentCallbacks: num(report.silentCallbacks),
      clippedSamples: num(report.clippedSamples),
    });
  },

  async reportCapture(report: CaptureReport): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.LISTEN_REPORT, {
      // Rebuilt field by field rather than forwarded: whatever else a caller
      // attached to the object stays on this side of the boundary.
      captureId: report.captureId,
      status: report.status,
      failure: report.failure,
    });
  },
};

contextBridge.exposeInMainWorld('axon', bridge);
