/**
 * The renderer's view of Axon.
 *
 * This hook is the only place the UI learns anything. It holds no opinions:
 * state, timeline and pending approvals are all derived from the AxonEvent
 * stream and the initial snapshot. Nothing in the renderer sets Axon's state,
 * and nothing infers it from a button press — if the main process did not say
 * it happened, the UI does not show it.
 *
 * Startup ordering matters. Subscribing after fetching the snapshot would drop
 * any event emitted in between, so this subscribes first, buffers, then
 * fetches, then merges — de-duplicating on the sequence number the bus
 * assigned.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AxonEvent,
  AxonProfile,
  AxonSettings,
  AxonState,
  BrainStatus,
  BrowserStatus,
  MemoryEntry,
  PersistenceStatus,
  SessionRecord,
  SettingsUpdateResult,
  JsonValue,
  ListeningStatus,
  SendMessageResult,
  StateRequestResult,
  ToolResult,
  ToolSchema,
  VoiceAgentStatus,
  VoiceSessionResult,
} from '@axon/core';

/** How many events the timeline keeps. The JSONL log keeps all of them. */
const MAX_EVENTS = 400;

export interface AxonRuntime {
  readonly ready: boolean;
  readonly connectionError: string | null;
  readonly sessionId: string;
  readonly state: AxonState;
  readonly events: readonly AxonEvent[];
  readonly pendingApproval: ApprovalRequest | null;
  readonly devConsoleEnabled: boolean;
  readonly tools: readonly ToolSchema[];
  readonly brain: BrainStatus;
  /** Whether Axon can listen, and why not when it cannot. */
  readonly listening: ListeningStatus;
  /** Whether Axon can hold a spoken conversation, and whether it is. */
  readonly voiceAgent: VoiceAgentStatus;
  /** What the browser is doing. Derived from main, never asserted here. */
  readonly browser: BrowserStatus;
  /** Whether conversations are being saved, and where. */
  readonly persistence: PersistenceStatus;
  readonly settings: AxonSettings;
  readonly profile: AxonProfile;
  /** The conversation on screen. Main decides; this reflects it. */
  readonly conversationId: string | null;
  updateSettings(patch: Partial<AxonSettings>): Promise<SettingsUpdateResult>;
  resetSettings(): Promise<SettingsUpdateResult>;
  listSessions(): Promise<readonly SessionRecord[]>;
  createSession(): Promise<void>;
  selectSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listMemories(): Promise<readonly MemoryEntry[]>;
  setMemoryEnabled(id: string, enabled: boolean): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;
  /** True while a turn is in flight. The composer disables itself on this. */
  readonly busy: boolean;
  sendMessage(text: string): Promise<SendMessageResult>;
  resolveApproval(callId: string, decision: ApprovalDecision, fingerprint?: string): Promise<void>;
  /** Ask Axon to start or stop a spoken conversation. Main decides. */
  startVoiceSession(): Promise<VoiceSessionResult>;
  stopVoiceSession(): Promise<VoiceSessionResult>;
  invokeTool(tool: string, input: JsonValue): Promise<ToolResult>;
  requestState(to: AxonState, reason: string): Promise<StateRequestResult>;
}

function mergeEvents(existing: readonly AxonEvent[], incoming: readonly AxonEvent[]): AxonEvent[] {
  const bySeq = new Map<number, AxonEvent>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return Array.from(bySeq.values())
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_EVENTS);
}

export function useAxonRuntime(): AxonRuntime {
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [state, setState] = useState<AxonState>('IDLE');
  const [events, setEvents] = useState<readonly AxonEvent[]>([]);
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [devConsoleEnabled, setDevConsoleEnabled] = useState(false);
  const [tools, setTools] = useState<readonly ToolSchema[]>([]);
  const [brain, setBrain] = useState<BrainStatus>({ available: false, name: 'none', reason: null });
  const [listening, setListening] = useState<ListeningStatus>({
    available: false,
    name: 'none',
    reason: null,
    active: false,
    hotkey: null,
  });
  const [voiceAgent, setVoiceAgent] = useState<VoiceAgentStatus>({
    available: false,
    name: 'none',
    reason: null,
    active: false,
    phase: 'IDLE',
    armed: false,
  });
  const [browser, setBrowser] = useState<BrowserStatus>({
    available: false,
    reason: null,
    open: false,
    url: null,
  });
  const [persistence, setPersistence] = useState<PersistenceStatus>({
    available: false,
    reason: null,
    databasePath: null,
    schemaVersion: 0,
    sessionCount: 0,
    memoryCount: 0,
  });
  const [settings, setSettings] = useState<AxonSettings>({
    voiceHotkey: null,
    workspacePath: null,
    speechEnabled: true,
    restoreLastSession: true,
    memoryEnabled: true,
  });
  const [profile, setProfile] = useState<AxonProfile>({
    displayName: null,
    language: null,
    createdAt: '',
    profileVersion: 1,
  });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bufferRef = useRef<AxonEvent[]>([]);

  /**
   * Re-read the statuses main holds.
   *
   * Most of what the UI shows is derived from the event stream, but a couple
   * of facts about capability are not events: whether the microphone has been
   * refused, in particular, changes only when someone answers a permission
   * prompt. Rather than inventing an event for it, the UI asks main again when
   * a listening session ends — one call per session, and the answer is always
   * main's.
   */
  const refreshStatus = useCallback(async (): Promise<void> => {
    const bridge = window.axon;
    if (!bridge) return;
    try {
      const snapshot = await bridge.getSnapshot();
      setBrain(snapshot.brain);
      setListening(snapshot.listening);
      setVoiceAgent(snapshot.voiceAgent);
      setBrowser(snapshot.browser);
      setPersistence(snapshot.persistence);
      setSettings(snapshot.settings);
      setProfile(snapshot.profile);
      setConversationId(snapshot.conversationId);
    } catch {
      // A failed refresh leaves the last known status in place, which is a
      // better UI than a capability flickering because one call did not land.
    }
  }, []);

  const apply = useCallback((event: AxonEvent) => {
    setEvents((current) => mergeEvents(current, [event]));

    switch (event.type) {
      case 'STATE_CHANGED':
        setState(event.to);
        // `active` is authoritative in main, and the state machine is how main
        // says so. Deriving it here keeps the microphone indicator and the orb
        // reading from the same fact rather than from two.
        setListening((current) => ({ ...current, active: event.to === 'LISTENING' }));
        if (event.from === 'LISTENING') void refreshStatus();
        break;
      case 'APPROVAL_REQUIRED':
        setApprovals((current) => [...current.filter((r) => r.callId !== event.request.callId), event.request]);
        break;
      case 'APPROVAL_RESOLVED':
        setApprovals((current) => current.filter((r) => r.callId !== event.callId));
        break;
      // Busy is derived from the event stream rather than from the click that
      // started the turn. A turn begun in another window, or one already
      // running when this window mounted, has to switch the composer off too.
      case 'USER_MESSAGE':
        setBusy(true);
        break;
      case 'COMPLETED':
      case 'ERROR':
        setBusy(false);
        // The browser may have opened or closed during the turn. Asking main
        // rather than inferring keeps the badge honest.
        void refreshStatus();
        break;
      case 'TOOL_RESULT':
        if (event.tool.startsWith('browser.') || event.tool.startsWith('memory.')) void refreshStatus();
        break;
      // Main is authoritative about which conversation is open and what is
      // saved; the UI follows its events rather than assuming its own writes
      // succeeded.
      // Every voice-session transition changes what the UI must say about the
      // microphone, and that indicator has to be right — it is the user's only
      // view of whether audio is leaving the machine.
      case 'VOICE_SESSION':
      case 'SESSION_CHANGED':
      case 'MEMORY_CHANGED':
      case 'SETTINGS_UPDATED':
      case 'PERSISTENCE_ERROR':
        void refreshStatus();
        break;
      default:
        break;
    }
  }, [refreshStatus]);

  useEffect(() => {
    const bridge = window.axon;
    if (!bridge) {
      // Only reachable if the preload failed to load. Say so plainly rather
      // than rendering a UI that looks alive but is connected to nothing.
      setConnectionError('The Axon bridge is unavailable. The preload script did not load.');
      return;
    }

    let disposed = false;

    const unsubscribe = bridge.onEvent((event) => {
      if (disposed) return;
      if (!ready) bufferRef.current.push(event);
      apply(event);
    });

    void (async (): Promise<void> => {
      try {
        const [snapshot, toolList] = await Promise.all([bridge.getSnapshot(), bridge.listTools()]);
        if (disposed) return;

        setSessionId(snapshot.sessionId);
        setState(snapshot.state);
        setDevConsoleEnabled(snapshot.devConsoleEnabled);
        setApprovals(snapshot.pendingApprovals);
        setBrain(snapshot.brain);
        setListening(snapshot.listening);
        setVoiceAgent(snapshot.voiceAgent);
      setVoiceAgent(snapshot.voiceAgent);
        setBrowser(snapshot.browser);
        setPersistence(snapshot.persistence);
        setSettings(snapshot.settings);
        setProfile(snapshot.profile);
        setConversationId(snapshot.conversationId);
        setBusy(snapshot.busy);
        setTools(toolList);
        setEvents((current) => mergeEvents(mergeEvents(snapshot.events, bufferRef.current), current));
        bufferRef.current = [];
        setReady(true);
      } catch (error) {
        if (disposed) return;
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [apply]);

  const startVoiceSession = useCallback(async (): Promise<VoiceSessionResult> => {
    return (
      (await window.axon?.startVoiceSession()) ?? { accepted: false, error: 'Axon is not connected.' }
    );
  }, []);

  const stopVoiceSession = useCallback(async (): Promise<VoiceSessionResult> => {
    return (
      (await window.axon?.stopVoiceSession()) ?? { accepted: false, error: 'Axon is not connected.' }
    );
  }, []);

  const resolveApproval = useCallback(async (callId: string, decision: ApprovalDecision, fingerprint?: string): Promise<void> => {
    await window.axon?.resolveApproval(callId, decision, fingerprint);
  }, []);

  const sendMessage = useCallback(async (text: string): Promise<SendMessageResult> => {
    const bridge = window.axon;
    if (!bridge) return { accepted: false, error: 'The Axon bridge is unavailable.' };

    // Optimistic, then corrected. Main is authoritative: if it refuses the
    // turn, the composer has to come straight back rather than sit disabled
    // waiting for a COMPLETED that will never arrive.
    setBusy(true);
    try {
      const result = await bridge.sendMessage(text);
      if (!result.accepted) setBusy(false);
      return result;
    } catch (error) {
      setBusy(false);
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const invokeTool = useCallback((tool: string, input: JsonValue): Promise<ToolResult> => {
    const bridge = window.axon;
    if (!bridge) return Promise.reject(new Error('The Axon bridge is unavailable.'));
    return bridge.invokeTool(tool, input);
  }, []);

  const requestState = useCallback((to: AxonState, reason: string): Promise<StateRequestResult> => {
    const bridge = window.axon;
    if (!bridge) return Promise.reject(new Error('The Axon bridge is unavailable.'));
    return bridge.requestState(to, reason);
  }, []);


  /**
   * Persistence actions.
   *
   * Every one is a request to main, and every one refreshes the snapshot
   * afterwards rather than assuming its own write succeeded — the same rule
   * the rest of this hook follows. If main refused, the UI shows what main
   * says is true.
   */
  const withRefresh = useCallback(
    async <T,>(work: (bridge: NonNullable<typeof window.axon>) => Promise<T>, fallback: T): Promise<T> => {
      const bridge = window.axon;
      if (!bridge) return fallback;
      try {
        return await work(bridge);
      } catch {
        return fallback;
      } finally {
        void refreshStatus();
      }
    },
    [refreshStatus],
  );

  const updateSettings = useCallback(
    (patch: Partial<AxonSettings>): Promise<SettingsUpdateResult> =>
      withRefresh((bridge) => bridge.updateSettings(patch), {
        accepted: false,
        settings,
        error: 'Axon could not reach its settings.',
      }),
    [withRefresh, settings],
  );

  const resetSettings = useCallback(
    (): Promise<SettingsUpdateResult> =>
      withRefresh((bridge) => bridge.resetSettings(), {
        accepted: false,
        settings,
        error: 'Axon could not reach its settings.',
      }),
    [withRefresh, settings],
  );

  const listSessions = useCallback(
    (): Promise<readonly SessionRecord[]> => withRefresh((bridge) => bridge.listSessions(), []),
    [withRefresh],
  );

  const createSession = useCallback(
    async (): Promise<void> => {
      await withRefresh((bridge) => bridge.createSession(), null);
    },
    [withRefresh],
  );

  const selectSession = useCallback(
    async (id: string): Promise<void> => {
      await withRefresh((bridge) => bridge.selectSession(id), null);
    },
    [withRefresh],
  );

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      await withRefresh((bridge) => bridge.deleteSession(id), false);
    },
    [withRefresh],
  );

  const listMemories = useCallback(
    (): Promise<readonly MemoryEntry[]> => withRefresh((bridge) => bridge.listMemories(), []),
    [withRefresh],
  );

  const setMemoryEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      await withRefresh((bridge) => bridge.setMemoryEnabled(id, enabled), false);
    },
    [withRefresh],
  );

  const deleteMemory = useCallback(
    async (id: string): Promise<void> => {
      await withRefresh((bridge) => bridge.deleteMemory(id), false);
    },
    [withRefresh],
  );

  const clearMemories = useCallback(
    async (): Promise<void> => {
      await withRefresh((bridge) => bridge.clearMemories(), 0);
    },
    [withRefresh],
  );

  // Only one approval is ever shown; a second would be a modal on top of a
  // modal, and the dispatcher raises them one at a time in any case.
  const pendingApproval = approvals.length > 0 ? (approvals[approvals.length - 1] ?? null) : null;

  return useMemo(
    () => ({
      ready,
      connectionError,
      sessionId,
      state,
      events,
      pendingApproval,
      devConsoleEnabled,
      tools,
      brain,
      listening,
      voiceAgent,
      browser,
      persistence,
      settings,
      profile,
      conversationId,
      busy,
      sendMessage,
      resolveApproval,
      startVoiceSession,
      stopVoiceSession,
      invokeTool,
      requestState,
      updateSettings,
      resetSettings,
      listSessions,
      createSession,
      selectSession,
      deleteSession,
      listMemories,
      setMemoryEnabled,
      deleteMemory,
      clearMemories,
    }),
    [
      ready,
      connectionError,
      sessionId,
      state,
      events,
      pendingApproval,
      devConsoleEnabled,
      tools,
      brain,
      listening,
      voiceAgent,
      browser,
      persistence,
      settings,
      profile,
      conversationId,
      busy,
      sendMessage,
      resolveApproval,
      startVoiceSession,
      stopVoiceSession,
      invokeTool,
      requestState,
      updateSettings,
      resetSettings,
      listSessions,
      createSession,
      selectSession,
      deleteSession,
      listMemories,
      setMemoryEnabled,
      deleteMemory,
      clearMemories,
    ],
  );
}
