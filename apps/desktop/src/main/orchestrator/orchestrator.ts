/**
 * The orchestrator — where the layers are wired together.
 *
 * It owns the authoritative state machine and is the only implementation of
 * `StateController`, so state authority stays in exactly one home. The
 * dispatcher asks it to move; it decides whether the move is legal.
 *
 * From Step 2 it also owns the agent turn: it hands the brain a code-free tool
 * surface, a `dispatch` callback bound to the dispatcher, and a narrow `emit`.
 * Note what it does not hand over — risk resolution, the approval gate and
 * execution all stay behind `dispatch`, so attaching a brain adds reasoning to
 * Axon without adding authority.
 *
 * Everything the renderer can reach goes through the small set of public
 * methods at the bottom of this class. There is no method here that lets a
 * caller set state directly — `requestState` *proposes*, and the machine may
 * refuse.
 */

import { randomUUID } from 'node:crypto';
import {
  isLegalTransition,
  matchesCancellation,
  matchesLifecycleCommand,
  VOICE_AGENT_LIMITS,
  type ApprovalDecision,
  type AxonSnapshot,
  type AxonState,
  type Brain,
  type LifecycleCommand,
  type PlaybackDiagnostics,
  type BrainEventInput,
  type BrainStatus,
  type BrowserStatus,
  type CaptureFailure,
  type JsonValue,
  type ListeningStatus,
  type SendMessageResult,
  type SpeechEndReason,
  type SpeechStatus,
  type StartListeningResult,
  type StateRequestResult,
  type ToolResult,
  type ToolSchema,
  type VoiceActivation,
  type VoiceAgentPhase,
  type VoiceAgentStatus,
  type CaptureDiagnostics,
  type CaptureProcessing,
  type WakeStatus,
  type VoiceSessionResult,
  type WakeTrigger,
  type CaptureCommand,
  LISTENING_LIMITS,
} from '@axon/core';
import type { EventBus } from '../bus/event-bus.js';
import { Dispatcher, newCallId, type StateController } from '../safety/dispatcher.js';
import { ApprovalBroker } from '../safety/approval-broker.js';
import { Policy } from '../safety/policy.js';
import { AxonStateMachine } from './state-machine.js';
import { TurnBudget } from '../safety/turn-budget.js';
import { TaskLedger } from '../agent/task-ledger.js';
import type { ToolRegistry } from '../tools/registry.js';
import { toToolSchemas } from '../tools/schema-view.js';
import { describeModelError, toBrainErrorDetail } from '../brain/brain-errors.js';
import type { SpeechService } from '../voice/speech-service.js';
import type { ListeningMetrics, ListeningEndReason, ListeningService } from '../voice/listening-service.js';
import type { BrowserController } from '../platform/ports.js';
import type { PersistenceService } from '../persistence/persistence-service.js';
import type { VoiceAgentProvider } from '../agent/create-voice-agent.js';
import type { VoiceAgentSession } from '../agent/voice-agent-session.js';
import type { SpeechTransport } from '../voice/speech-transport.js';
import type { ReplyAudioNote, ReplyNote, VoiceDiagnostics } from '../voice/voice-diagnostics.js';
import type { MicGate } from '../voice/mic-gate.js';

/**
 * What the orchestrator needs from the wake word.
 *
 * A frame sink and nothing else. Declared as an interface rather than
 * importing the detector so the orchestrator cannot reach anything else it
 * owns — and so `architecture.test.ts` keeps holding that the agent and wake
 * subsystems stay separable.
 */
export interface WakeAudioSink {
  pushFrame(frame: Int16Array): void;
  /**
   * The detector's health, for the snapshot the renderer and the tray read.
   *
   * Part of the sink rather than a second binding so the orchestrator still
   * holds exactly one reference to the wake subsystem, and so the shape of
   * what it can learn from it stays visible here: a status object with no
   * channel for audio or text.
   */
  getStatus(): WakeStatus;
  /**
   * Stop and start LOCAL listening for the wake phrase.
   *
   * The detector's own existing methods, reached so that "stop listening"
   * can actually stop it — before this, nothing the user said could. They
   * change whether the detector listens, never how it hears: no threshold,
   * model, window or preprocessing is reachable from here. Optional because a
   * sink that cannot be switched off simply is not switched off.
   */
  arm?(): Promise<boolean>;
  disarm?(): void;
}

/** What the orchestrator reports when no detector has been attached. */
const NO_WAKE_DETECTOR: WakeStatus = {
  engine: 'disabled',
  detail: 'no wake-word engine',
  available: false,
  unavailableReason: 'No wake-word detector is attached.',
  restarts: 0,
  starvedOfAudio: false,
};

export interface OrchestratorOptions {
  readonly bus: EventBus;
  /**
   * Numeric audio-path diagnostics (development builds with voice or wake
   * debugging on). Absent means silent, and capture pages are not asked for
   * reports.
   */
  readonly diagnostics?: VoiceDiagnostics | null;
  /**
   * Explicit microphone processing for every capture (development A/B only;
   * `config.ts` never sets it in a packaged build). Null: browser defaults, all on.
   */
  readonly captureProcessing?: CaptureProcessing | null;
  readonly registry: ToolRegistry;
  readonly approvalTimeoutMs: number;
  readonly devConsoleEnabled: boolean;
  /** Absent when no API key is configured; Axon still runs, without a brain. */
  readonly brain?: Brain | null;
  /** Why the brain is unavailable, when it is. Never carries a credential. */
  readonly brainUnavailableReason?: string | null;
  /** Absent when no synthesiser is configured; Axon then runs silently. */
  readonly speech?: SpeechService | null;
  /** Absent when no recognizer is configured; Axon then runs text-only. */
  readonly listening?: ListeningService | null;
  /** Absent when browsing is not configured; Axon then has no web reach. */
  readonly browser?: BrowserController | null;
  /** Absent in tests; Axon then keeps a conversation only for the session. */
  readonly persistence?: PersistenceService | null;
  /** Absent when no ASSEMBLYAI_API_KEY is set; Axon then cannot hold a
   *  spoken conversation and says so. */
  readonly voiceAgent?: VoiceAgentProvider | null;
  /** Why the voice agent is unavailable. Never carries a credential. */
  readonly voiceAgentUnavailableReason?: string | null;
  /** Carries streamed agent audio to the window. */
  readonly speechChunks?: SpeechTransport | null;
  /** Opens and closes the microphone for a voice session. */
  readonly captureCommand?: ((command: CaptureCommand) => void) | null;
  /** The microphone permission window, closed when the renderer reports. */
  readonly micGate?: MicGate | null;
  /**
   * What Axon has looked at, so a quit can forget it.
   *
   * A STRUCTURAL TYPE, not the store's own. The orchestrator has no business
   * knowing how a visual observation is built or what is in one — it needs
   * exactly one verb, and taking only that verb keeps the screen subsystem
   * unreachable from here. `architecture.test.ts` asserts the absence of the
   * import that a concrete type would have required.
   *
   * Cleared on shutdown for the same reason the browser is closed: a quit that
   * leaves a picture of the user's screen in this process's memory is the same
   * class of leak as one that leaves a Chromium running.
   */
  readonly observations?: { clear(): void } | null;
}

/** Shown when there is no persistence layer to ask. Matches its defaults. */
const DEFAULT_SNAPSHOT_SETTINGS = {
  voiceHotkey: null,
  workspacePath: null,
  speechEnabled: true,
  restoreLastSession: true,
  memoryEnabled: true,
} as const;

/** Longest a single user message may be. A bound on the request, not the user. */
const MAX_UTTERANCE_LENGTH = 4_000;

export class Orchestrator implements StateController {
  readonly bus: EventBus;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  /** Forgotten on shutdown. See `OrchestratorOptions.observations`. */
  private readonly observations: { clear(): void } | null;

  /**
   * What Axon is currently doing, and for whom.
   *
   * Owned HERE because cancellation is an orchestrator concern: stopping work
   * means reaching an abort signal, a browser, a microphone and an observation
   * store, and the ledger is the only thing that knows which work was being
   * stopped. Everything else — the voice session, the bridge — reads it.
   */
  readonly tasks: TaskLedger;

  /**
   * The abort signal for work a spoken conversation started.
   *
   * A typed turn has had one since Step 7; a voice session did not, so
   * "cancel" reached the model loop and the voice but never the executor
   * already running. This closes that: every utterance mints one, and
   * cancelling aborts it.
   *
   * Replaced rather than reused after a cancellation. An aborted signal stays
   * aborted, so carrying it forward would make every subsequent action in the
   * conversation fail as cancelled.
   */
  private voiceWork: AbortController | null = null;
  readonly dispatcher: Dispatcher;

  private readonly machine: AxonStateMachine;
  private readonly devConsoleEnabled: boolean;
  private readonly brain: Brain | null;
  private readonly brainUnavailableReason: string | null;
  private readonly speech: SpeechService | null;
  private readonly listeningService: ListeningService | null;
  private readonly browser: BrowserController | null;
  private readonly persistence: PersistenceService | null;
  private readonly voiceProvider: VoiceAgentProvider | null;
  private readonly voiceAgentUnavailableReason: string | null;
  private readonly speechChunks: SpeechTransport | null;
  private readonly captureCommand: ((command: CaptureCommand) => void) | null;
  private readonly micGate: MicGate | null;

  /**
   * The spoken conversation in flight, if any.
   *
   * Null is the resting state and it is a privacy claim, not a nicety: with no
   * session there is no socket, and with no socket no audio can leave the
   * machine however the microphone behaves.
   */
  private voiceSession: VoiceAgentSession | null = null;
  private voicePhase: VoiceAgentPhase = 'IDLE';
  private voiceCaptureId: string | null = null;
  /** True while the local wake word is listening. Display and audit only. */
  private wakeArmed = false;
  /** Numeric audio-path diagnostics, or null. Never audio. */
  private readonly diagnostics: VoiceDiagnostics | null;
  private readonly captureProcessing: CaptureProcessing | null;
  /** The capture the wake word is listening on, or null when it is not. */
  private wakeCaptureId: string | null = null;
  /** Bound after construction: the detector is built after the orchestrator. */
  private wakeWord: WakeAudioSink | null = null;
  /**
   * The user said "stop listening": no microphone at all, not even the local
   * wake word, until they explicitly start Axon again. See
   * `endConversationByCommand`.
   */
  private micOff = false;
  /** An explicit start during mic-off: re-arm the wake word when it ends. */
  private rearmWakeAfterSession = false;

  /**
   * The persisted conversation this window is continuing.
   *
   * Distinct from `bus.sessionId`, which identifies one RUN of the process and
   * is what the JSONL log is grouped by. A conversation outlives a run; a run
   * may span several conversations. Conflating them would mean reopening
   * yesterday's chat wrote today's events under yesterday's id.
   */
  private conversationId: string | null = null;
  private toolSchemas: readonly ToolSchema[] | null = null;

  /**
   * The turn in flight, if any.
   *
   * Doubles as the busy flag and as the handle `shutdown` aborts. One turn at
   * a time is deliberate: two concurrent turns would interleave tool calls
   * from two different intentions through one approval dialog, and the user
   * would have no way to tell which request they were approving.
   */
  private activeTurn: AbortController | null = null;

  /**
   * Resolves the turn's wait for speech to finish.
   *
   * Held here rather than inside `speakReply` because the utterance is ended
   * by whichever of three things happens first - the renderer reporting, the
   * watchdog firing, or a cancellation - and all three arrive on other
   * methods of this class.
   */
  private speechFinished: (() => void) | null = null;

  constructor(options: OrchestratorOptions) {
    this.bus = options.bus;
    this.diagnostics = options.diagnostics ?? null;
    this.captureProcessing = options.captureProcessing ?? null;
    this.registry = options.registry;
    this.devConsoleEnabled = options.devConsoleEnabled;
    this.brain = options.brain ?? null;
    this.brainUnavailableReason = options.brainUnavailableReason ?? null;
    this.speech = options.speech ?? null;
    this.listeningService = options.listening ?? null;
    this.browser = options.browser ?? null;
    this.persistence = options.persistence ?? null;
    this.voiceProvider = options.voiceAgent ?? null;
    this.voiceAgentUnavailableReason = options.voiceAgentUnavailableReason ?? null;
    this.speechChunks = options.speechChunks ?? null;
    this.captureCommand = options.captureCommand ?? null;
    this.micGate = options.micGate ?? null;
    this.observations = options.observations ?? null;
    // Traces go onto the SAME event stream everything else does, as
    // observations carrying counters and ids. A second log would be a second
    // account of what happened, and the point of the stream is that there is
    // one.
    this.tasks = new TaskLedger({
      onTrace: (trace) => {
        this.bus.emit({
          type: 'OBSERVATION',
          callId: null,
          summary: `${trace.tool} ${trace.outcome.toLowerCase().replace(/_/g, ' ')}`,
          detail: {
            task: trace.taskId,
            step: trace.stepId,
            tool: trace.tool,
            outcome: trace.outcome,
            call: trace.callId,
            risk: trace.risk,
            approval: trace.approval,
            verified: trace.verified,
          },
        });
      },
    });

    this.machine = new AxonStateMachine((change) => {
      this.bus.emit({
        type: 'STATE_CHANGED',
        from: change.from,
        to: change.to,
        reason: change.reason,
      });
    });

    this.approvals = new ApprovalBroker();

    this.dispatcher = new Dispatcher({
      registry: this.registry,
      policy: new Policy(),
      approvals: this.approvals,
      bus: this.bus,
      states: this,
      approvalTimeoutMs: options.approvalTimeoutMs,
      // Read at the moment an approval is raised, so the dialog names the
      // page the action would land on. A URL Axon itself navigated to —
      // never anything out of the page's own storage.
      currentPage: () => this.browser?.lastObservation()?.url ?? null,
    });
  }

  get state(): AxonState {
    return this.machine.state;
  }

  /** Point this window at a persisted conversation. */
  bindSession(sessionId: string | null): void {
    this.conversationId = sessionId;
  }

  // --- StateController ----------------------------------------------------

  enterExecuting(reason: string): void {
    this.moveTo('EXECUTING', reason);
  }

  enterAwaitingApproval(reason: string): void {
    this.moveTo('WAITING_FOR_APPROVAL', reason);
  }

  /**
   * A unit of work finished.
   *
   * Where that lands depends on whether a turn is still running. Settling to
   * IDLE after every tool call would drop the orb to "Standing by" between
   * the steps of a single request, which is not what is happening — the brain
   * is still reasoning about the result it just received. With a turn in
   * flight the resting state is THINKING; only outside one is it IDLE.
   */
  settle(reason: string, options?: { readonly listeningEnded?: boolean }): void {
    // LISTENING is not a resting state — it is a live session with an open
    // microphone, owned by the listening service. Settling out of it here
    // would take the UI out of LISTENING while the microphone was still on,
    // which is precisely the disagreement between what Axon shows and what
    // Axon is doing that this architecture exists to prevent.
    //
    // This matters concretely during barge-in: interrupting speech resolves
    // the turn that was waiting on it, and that turn then settles a moment
    // after the machine has already entered LISTENING.
    //
    // `listeningEnded` is the one caller that knows better: the session that
    // owned LISTENING has closed and its microphone with it. Without that
    // exception a voice conversation ending by itself left the machine in
    // LISTENING for ever — the panel sat on "Listening..." with no session
    // behind it, and the orb never moved again. That is the same disagreement
    // in the other direction, and it is the worse one: showing a microphone
    // that is closed as open.
    if (this.machine.state === 'LISTENING' && options?.listeningEnded !== true) return;

    // A LIVE CONVERSATION IS NOT IDLE BETWEEN STEPS.
    //
    // The dispatcher settles after every tool, and the resting state used to
    // be chosen by `activeTurn` alone — a typed-turn concept that is null for
    // the whole of a spoken conversation. So every voice tool call ended in
    // IDLE, and a real multi-step request read:
    //
    //     12:50:10.450  CALL   browser.read
    //     12:50:10.462  STATE  EXECUTING -> IDLE      "Done"
    //     12:50:10.718  STATE  IDLE -> LISTENING
    //
    // three times in one YouTube search. IDLE is the dim, near-still orb, so
    // the orb appeared to vanish in the middle of the work, which is also a
    // false statement: Axon was not idle, it was about to act on the result.
    //
    // While a conversation is live the voice agent always receives the result
    // and either replies or proposes the next step, so the honest resting
    // state is THINKING — and the session's own phases (reply.started,
    // tool.call, reply.done) move it on from there.
    //
    // SPEAKING is the session's to end, as LISTENING is. A slow tool can
    // finish while Axon is still saying "Opening YouTube", and taking the orb
    // out of SPEAKING then would contradict the audio the user is hearing.
    const conversing = this.voiceConversationLive;
    if (conversing && this.machine.state === 'SPEAKING') return;

    const target: AxonState = this.activeTurn || conversing ? 'THINKING' : 'IDLE';
    if (this.machine.state !== target && this.machine.canTransition(target)) {
      this.machine.transition(target, reason);
    }
  }

  /**
   * A spoken conversation is open and has not begun to close.
   *
   * `voicePhase` is written before the session reports CLOSED or FAILED, and
   * `voiceSession` is cleared before the final settle in
   * `onVoiceSessionClosed`, so a conversation that is ending is never treated
   * as live — its last settle lands in IDLE, which is then true.
   */
  private get voiceConversationLive(): boolean {
    return (
      this.voiceSession !== null &&
      this.voicePhase !== 'CLOSED' &&
      this.voicePhase !== 'FAILED' &&
      this.voicePhase !== 'IDLE'
    );
  }

  fail(scope: string, message: string, detail: JsonValue | null = null): void {
    this.bus.emit({ type: 'ERROR', scope, message, detail });
    this.moveTo('ERROR', message);
  }

  /**
   * Move toward `target`, repairing through THINKING when a direct hop is not
   * legal.
   *
   * A tool call arriving while Axon is IDLE is a real situation — it is what
   * the developer Tool Console does. IDLE -> EXECUTING is not legal, and
   * rightly so: acting without having understood anything is precisely the
   * transition the table exists to forbid. Passing through THINKING is not a
   * workaround; it is the honest description of what happened, and it keeps
   * the timeline readable.
   *
   * If no legal route exists, the state is left alone rather than forced.
   */
  private moveTo(target: AxonState, reason: string): void {
    if (this.machine.state === target) return;

    if (this.machine.canTransition(target)) {
      this.machine.transition(target, reason);
      return;
    }

    if (this.machine.canTransition('THINKING') && isLegalTransition('THINKING', target)) {
      this.machine.transition('THINKING', reason);
      this.machine.transition(target, reason);
      return;
    }

    console.warn(`[orchestrator] no legal route from ${this.machine.state} to ${target}; state unchanged`);
  }

  // --- Renderer-facing API ------------------------------------------------

  snapshot(): AxonSnapshot {
    return {
      sessionId: this.bus.sessionId,
      state: this.machine.state,
      events: this.bus.recent(),
      pendingApprovals: this.approvals.list(),
      devConsoleEnabled: this.devConsoleEnabled,
      brain: this.brainStatus(),
      busy: this.activeTurn !== null,
      speech: this.speechStatus(),
      listening: this.listeningStatus(),
      voiceAgent: this.voiceAgentStatus(),
      browser: this.browserStatus(),
      persistence: this.persistence?.status() ?? {
        available: false,
        reason: 'Persistence is not configured.',
        databasePath: null,
        schemaVersion: 0,
        sessionCount: 0,
        memoryCount: 0,
      },
      settings: this.persistence?.currentSettings() ?? DEFAULT_SNAPSHOT_SETTINGS,
      profile: this.persistence?.profile() ?? { displayName: null, language: null, createdAt: '', profileVersion: 1 },
      conversationId: this.conversationId,
    };
  }

  /**
   * What the renderer is told about the brain.
   *
   * A boolean, a name and a reason — never a key, never the environment, never
   * the model configuration. This is the whole of the brain's exposure to the
   * sandboxed page.
   */
  brainStatus(): BrainStatus {
    return {
      available: this.brain !== null,
      name: this.brain?.name ?? 'none',
      reason: this.brain ? null : (this.brainUnavailableReason ?? 'No brain is attached.'),
    };
  }

  /** Tool schemas, computed once — the registry does not change at runtime. */
  listTools(): readonly ToolSchema[] {
    this.toolSchemas ??= toToolSchemas(this.registry.list());
    return this.toolSchemas;
  }

  /**
   * Settle a pending approval. Returns false if there was nothing pending.
   *
   * `fingerprint` is what the dialog the user acted on described. Supplying it
   * turns "the user pressed Allow" into "the user pressed Allow on THIS act":
   * a mismatch leaves the request pending rather than applying an answer to a
   * question that was not the one on screen. Absent means unchecked, which is
   * how the dev console and the timeout path settle — and both of those only
   * ever produce a DENY or a decision made against the live request.
   */
  resolveApproval(callId: string, decision: ApprovalDecision, fingerprint?: string): boolean {
    return this.approvals.settle(callId, decision, 'user', fingerprint);
  }

  /**
   * Run a tool through the dispatcher.
   *
   * Used by the developer Tool Console and, via `dispatch`, by the brain.
   * Both take this same path: there is no privileged variant.
   */
  invokeTool(tool: string, input: JsonValue): Promise<ToolResult> {
    return this.dispatcher.dispatch({ callId: newCallId(), tool, input });
  }

  /** A proposed transition from outside. The machine decides. */
  requestState(to: AxonState, reason: string): StateRequestResult {
    return this.machine.tryTransition(to, reason);
  }

  /**
   * Hand a message to the brain and start a turn.
   *
   * Returns as soon as the turn is *accepted*, not when it completes.
   * Everything the user sees — progress, tool calls, approvals, the reply —
   * arrives on the event stream, so a renderer that reloads mid-turn misses
   * nothing and the IPC call cannot time out behind a long task.
   */
  sendUserMessage(text: string, source: 'text' | 'voice' = 'text'): SendMessageResult {
    const utterance = text.trim();

    if (utterance === '') {
      return { accepted: false, error: 'Message was empty.' };
    }
    if (utterance.length > MAX_UTTERANCE_LENGTH) {
      return { accepted: false, error: `Message is too long (limit ${MAX_UTTERANCE_LENGTH} characters).` };
    }
    if (this.activeTurn) {
      return { accepted: false, error: 'Axon is already working on something.' };
    }
    if (!this.brain) {
      // Still record what the user said. The transcript should show the
      // request that went unanswered, not silently swallow it.
      const reason = this.brainStatus().reason ?? 'No brain is attached.';
      this.bus.emit({ type: 'USER_MESSAGE', text: utterance, source });
      this.fail('brain', reason, null);
      return { accepted: false, error: reason };
    }

    this.bus.emit({ type: 'USER_MESSAGE', text: utterance, source });

    const turn = new AbortController();
    // Assigned before the first await so `busy` is already true when this
    // method returns to the IPC handler.
    this.activeTurn = turn;

    // ERROR leaves only to IDLE, deliberately: the state table treats recovery
    // as something that must be asked for rather than something the system
    // slides back into. Sending a new message *is* that explicit request, so
    // it is cleared here — and only here.
    //
    // Without this the machine would sit in ERROR for the whole of the next
    // turn (ERROR -> THINKING is not legal, and neither is ERROR -> SPEAKING),
    // so the orb would read "Something went wrong" while Axon worked and
    // spoke perfectly well.
    if (this.machine.state === 'ERROR') {
      this.machine.transition('IDLE', 'New request');
    }

    this.moveTo('THINKING', 'Reading your message');

    // A fresh action budget for this request. The bound is per-turn because a
    // long session of deliberate requests is fine; one request that never
    // terminates is not.
    this.browser?.beginTurn();
    // And a fresh spend for the dispatcher: tool calls, wall-clock, identical
    // repeats, and the record of what has already left the machine. Opened
    // here rather than inside the brain, so the bound holds for any brain.
    // The goal is the user's OWN words. The goal boundary compares proposed
    // navigations against it, so a modest request cannot silently become a
    // consequential one — see `safety/goal-boundary.ts`.
    this.dispatcher.beginTurn(new TurnBudget(), utterance);
    // Executors now abort when this turn is cancelled, not only on shutdown.
    this.dispatcher.setTurnSignal(turn.signal);

    void this.runTurn(this.brain, utterance, turn);
    return { accepted: true, error: null };
  }

  /**
   * Drive one brain turn to completion.
   *
   * Nothing in here may throw. This runs detached from the IPC call that
   * started it, so an escaping rejection would become an unhandled rejection
   * in the main process — precisely the class of failure that takes an
   * Electron app down.
   */
  private async runTurn(brain: Brain, utterance: string, turn: AbortController): Promise<void> {
    try {
      // Built here, from the database, and passed as an argument. The brain
      // has no way to ask for more than this — see `BrainTurnInput.context`.
      const restored = this.persistence?.contextForTurn() ?? { context: null, history: [] };

      const result = await brain.run(
        {
          // The persisted conversation, so history resumes across restarts.
          // Falls back to the run id when there is no database, which keeps a
          // degraded Axon coherent within a single session.
          sessionId: this.conversationId ?? this.bus.sessionId,
          utterance,
          tools: this.listTools(),
          signal: turn.signal,
          context: restored.context,
          emit: (event: BrainEventInput): void => {
            this.bus.emit(event);
          },
        },
        (call) => this.dispatcher.dispatch(call),
      );

      // Cleared before settling so `settle` resolves to IDLE, not THINKING.
      if (this.activeTurn === turn) this.activeTurn = null;
      this.dispatcher.setTurnSignal(null);
      this.dispatcher.endTurn();

      if (turn.signal.aborted) {
        this.settle('Turn cancelled');
        return;
      }

      // Speak the reply, then finish. Note what is passed: `result.reply` —
      // the model's visible answer, the same string the transcript shows and
      // the same one ASSISTANT_MESSAGE carried. Diagnostics, tool output and
      // error text are never routed here, so an internal detail cannot be
      // read aloud by accident.
      if (result.reply) await this.speakReply(result.reply);

      this.bus.emit({ type: 'COMPLETED', summary: result.reply ?? 'Finished.' });
      this.settle('Turn finished');
    } catch (error) {
      if (this.activeTurn === turn) this.activeTurn = null;
      this.dispatcher.setTurnSignal(null);
      this.dispatcher.endTurn();
      // A classified detail, never the raw error — see `toBrainErrorDetail`.
      this.fail('brain', describeModelError(error), toBrainErrorDetail(error));
    }
  }

  // --- speech -------------------------------------------------------------

  /**
   * Speak one reply and wait for it to finish.
   *
   * The await is what keeps SPEAKING truthful: the turn does not report itself
   * COMPLETED, and the machine does not return to IDLE, while audio is still
   * playing. It cannot hang — `SpeechService` settles every utterance through
   * one path, on a deadline derived from the audio's own duration.
   *
   * Speech failing is not turn failure. Axon says what it can and stays quiet
   * otherwise; the reply is on screen regardless.
   */
  private async speakReply(reply: string): Promise<void> {
    const speech = this.speech;
    if (!speech) return;

    const finished = new Promise<void>((resolve) => {
      this.speechFinished = resolve;
    });

    let started = false;
    try {
      started = await speech.speak(reply);
    } catch {
      // `speak` is written not to throw; this is belt and braces so a
      // synthesiser bug can never take down the turn that called it.
      started = false;
    }

    if (!started) {
      this.speechFinished = null;
      return;
    }

    await finished;
  }

  /** The service began an utterance. Only main may move the machine here. */
  onSpeechStarted(info: { speechId: string; characters: number; durationMs: number; truncated: boolean }): void {
    this.bus.emit({
      type: 'SPEECH_STARTED',
      speechId: info.speechId,
      characters: info.characters,
      durationMs: info.durationMs,
      truncated: info.truncated,
    });
    this.moveTo('SPEAKING', 'Speaking');
  }

  /**
   * The utterance ended, however it ended.
   *
   * Always releases the turn's await. A failure mode where speech ends but the
   * waiter is never resolved would leave the turn hanging and the app stuck in
   * SPEAKING — precisely what the watchdog exists to prevent, so it must not
   * be reintroduced here.
   */
  onSpeechEnded(speechId: string, reason: SpeechEndReason): void {
    this.bus.emit({ type: 'SPEECH_ENDED', speechId, reason });

    const resolve = this.speechFinished;
    this.speechFinished = null;

    if (resolve) {
      // A turn is awaiting this utterance. It settles the machine itself once
      // it has emitted COMPLETED, and doing it here as well would add a
      // spurious THINKING flash between the last word and IDLE.
      resolve();
      return;
    }

    // Nobody was waiting — speech that began outside a turn. Nothing else will
    // move the machine, so leaving SPEAKING is this method's job. Without
    // this, an utterance with no turn behind it would strand the state.
    this.settle('Finished speaking');
  }

  /** A speech problem worth showing, phrased for a person. */
  onSpeechFailure(message: string): void {
    // An OBSERVATION, not an ERROR: Axon failing to speak is a degraded turn,
    // not a failed one, and moving to ERROR would misreport a turn whose work
    // actually succeeded.
    this.bus.emit({ type: 'OBSERVATION', callId: null, summary: message, detail: null });
  }

  /** Whether Axon can speak. Safe to hand to the renderer. */
  speechStatus(): SpeechStatus {
    return this.speech?.status() ?? { available: false, name: 'none', reason: 'Speech is not configured.' };
  }

  /** Stop speaking now. Returns false when Axon was not speaking. */
  cancelSpeech(): boolean {
    return this.speech?.cancel('cancelled') ?? false;
  }

  /** The renderer's advisory playback report. Validated by the service. */
  reportSpeech(speechId: string, status: 'started' | 'ended' | 'failed'): void {
    this.speech?.report(speechId, status);
  }

  // --- listening ----------------------------------------------------------

  /**
   * Start listening.
   *
   * This method is the policy; `ListeningService` is the mechanism. It decides
   * whether opening the microphone is legal right now, and it is the only
   * place that decision is made — the hotkey, the on-screen button and the IPC
   * request all arrive here.
   *
   * BARGE-IN. Activating while Axon is speaking cancels the speech first,
   * through the existing cancellation path rather than a second one. The user
   * talking over Axon is the most natural interruption there is, and it has to
   * work without a thought.
   *
   * Listening is refused while Axon is thinking, executing or waiting for an
   * approval. Those states are mid-action: taking a new instruction there
   * would either interleave two intentions through one approval dialog or
   * silently abandon work the user is watching. Refusal is explicit and says
   * why, rather than opening a microphone that goes nowhere.
   */
  startListening(trigger: WakeTrigger = 'manual'): StartListeningResult {
    const listening = this.listeningService;
    if (!listening) {
      return { accepted: false, error: this.listeningStatus().reason ?? 'Axon cannot listen right now.' };
    }
    if (listening.listening) {
      return { accepted: false, error: 'Axon is already listening.' };
    }

    const state = this.machine.state;

    if (state === 'SPEAKING') {
      // Reuses the cancellation architecture rather than adding a second way
      // to stop the voice. `cancel` settles the utterance, which releases the
      // turn waiting on it; that turn's own settle is what the LISTENING guard
      // in `settle` protects against.
      this.cancelSpeech();
    } else if (state === 'ERROR') {
      // The same explicit recovery a new typed message performs.
      this.machine.transition('IDLE', 'New request');
    } else if (state !== 'IDLE') {
      return { accepted: false, error: `Axon is busy (${state.replace(/_/g, ' ').toLowerCase()}).` };
    }

    if (this.activeTurn) {
      return { accepted: false, error: 'Axon is already working on something.' };
    }

    // The wake word's microphone is released first, exactly as it is for a
    // voice session. Two consumers on one device would mean frames arriving
    // for a capture neither of them owns.
    this.endWakeCapture();

    // Push-to-talk is an explicit start too, so it ends mic-off the same way.
    if (trigger !== 'wake-word') this.resumeFromMicOff();

    const result = listening.start(trigger);
    if (!result.accepted) {
      // The session never opened, so nothing has to be unwound — but if the
      // barge-in above already left SPEAKING, land somewhere sane.
      this.settle('Could not start listening');
    }
    return result;
  }

  /**
   * The window's account of playing the voice agent's reply. Numbers and
   * fixed words, already validated by the bridge; printed only when a
   * development build asked for voice diagnostics, otherwise dropped here.
   */
  reportPlaybackDiagnostics(report: PlaybackDiagnostics): void {
    this.diagnostics?.playback(report);
  }

  /** Stop listening. Anything already said is transcribed. */
  stopListening(): boolean {
    return this.listeningService?.stop() ?? false;
  }

  /**
   * Numeric diagnostics from the capture page. Attributed by capture id, and
   * dropped when nobody asked for them or the id is not a live capture.
   */
  reportCaptureDiagnostics(report: CaptureDiagnostics): void {
    const diagnostics = this.diagnostics;
    if (!diagnostics?.enabled) return;
    if (report.captureId === this.voiceCaptureId) diagnostics.capture('voice', report);
    else if (report.captureId === this.wakeCaptureId) diagnostics.capture('wake', report);
  }

  /**
   * One frame of captured audio from the renderer.
   *
   * Straight through to the listening service, which drops anything that does
   * not belong to the session it opened. Note what this method does NOT do: it
   * does not log, does not emit, does not retain, and does not return
   * anything — the frame's entire journey through the orchestrator is this
   * line.
   */
  pushAudioFrame(captureId: string, samples: Int16Array): void {
    // Exactly one consumer owns the microphone at a time, and which one is
    // decided HERE rather than by whoever happens to be listening. A frame is
    // matched against the capture id main minted for that consumer; anything
    // else is dropped.
    //
    // The order is the privacy order. A live voice session wins, because the
    // user activated it. The wake word comes next, because it is the resting
    // state. The Step 4 listening session is last, because it only exists
    // when there is no voice agent to use instead.
    if (this.voiceSession) {
      if (captureId === this.voiceCaptureId) {
        this.diagnostics?.frame('voice', samples.length, VOICE_AGENT_LIMITS.sampleRate);
        this.pushVoiceAudio(samples);
      }
      return;
    }
    if (this.wakeCaptureId !== null) {
      // To a LOCAL recognizer, and nowhere else. This is the branch that makes
      // "before activation, audio stays on this machine" true.
      if (captureId === this.wakeCaptureId) {
        this.diagnostics?.frame('wake', samples.length, LISTENING_LIMITS.sampleRate);
        this.wakeWord?.pushFrame(samples);
      }
      return;
    }
    this.listeningService?.pushFrame(captureId, samples);
  }

  /**
   * Open the microphone for the local wake word.
   *
   * Through the SAME capture command every other consumer uses, so the
   * permission window opens the same way and the renderer cannot tell the
   * difference. What differs is entirely on this side: the frames go to a
   * local recognizer, and no socket exists.
   */
  beginWakeCapture(): void {
    if (this.wakeCaptureId !== null || this.voiceSession) return;
    const captureId = randomUUID();
    this.wakeCaptureId = captureId;
    this.captureCommand?.({
      action: 'start',
      captureId,
      sampleRate: LISTENING_LIMITS.sampleRate,
      diagnostics: this.diagnostics?.enabled === true,
      ...(this.captureProcessing ? { processing: this.captureProcessing } : {}),
    });
  }

  /**
   * Give the wake word its microphone back after something borrowed it.
   *
   * A RELEASE-BLOCKING BUG, AND HOW IT HID. A voice session and a push-to-talk
   * session both take the microphone from the wake word (`endWakeCapture`), and
   * nothing gave it back. The detector stayed ARMED — the UI said Axon was
   * listening for its name, the event stream said armed — while no audio
   * reached it at all. So "Hey Axon" worked exactly once per launch: the first
   * conversation ended, and Axon was deaf to its name from then on. Every
   * wake-word test drove the detector directly, so none of them saw it.
   *
   * Only while armed, and only when nothing else owns the microphone.
   */
  private resumeWakeCapture(): void {
    if (!this.wakeArmed || this.voiceSession || this.micOff) return;
    this.beginWakeCapture();
  }

  /** Close the wake word's microphone. Reached from every disarm. */
  endWakeCapture(): void {
    const captureId = this.wakeCaptureId;
    if (captureId === null) return;
    this.wakeCaptureId = null;
    this.captureCommand?.({ action: 'stop', captureId, sampleRate: LISTENING_LIMITS.sampleRate });
  }

  /** The renderer's report on the microphone. Validated by the service. */
  reportCapture(captureId: string, status: 'started' | 'ended' | 'failed', failure: CaptureFailure | null): void {
    // Whatever the report says, the permission window for this capture is
    // over: the device either opened or did not, and either way the renderer
    // has no further need to call `getUserMedia`. Closing on the report rather
    // than on the session is what keeps the window milliseconds long while the
    // wake word listens for hours.
    this.micGate?.settle(captureId);
    this.listeningService?.report(captureId, status, failure);
  }

  /** What the browser is doing. Safe to hand to the renderer: a boolean and
   *  a URL Axon itself navigated to, never anything from page storage. */
  browserStatus(): BrowserStatus {
    return this.browser?.status() ?? { available: false, reason: 'Browsing is not configured.', open: false, url: null };
  }

  /** Whether Axon can listen. Safe to hand to the renderer. */
  listeningStatus(): ListeningStatus {
    return (
      this.listeningService?.status() ?? {
        available: false,
        name: 'none',
        reason: 'Voice input is not configured.',
        active: false,
        hotkey: null,
      }
    );
  }

  /** A session opened. Only main may move the machine here. */
  onListeningStarted(trigger: WakeTrigger): void {
    this.bus.emit({ type: 'LISTENING', trigger });
    this.moveTo('LISTENING', 'Listening');
  }

  /**
   * A session closed, however it closed.
   *
   * When a transcript was produced the machine is left alone: the transcript
   * is about to start a turn, and settling to IDLE first would put a visible
   * flash of "Standing by" between the user finishing their sentence and Axon
   * beginning to think about it.
   */
  onListeningEnded(reason: ListeningEndReason): void {
    // Push-to-talk borrowed the microphone from the wake word; give it back
    // however the listening session ended.
    this.resumeWakeCapture();
    this.rearmIfResumed();
    if (reason === 'transcribed') return;
    if (this.machine.state === 'LISTENING') {
      this.machine.transition('IDLE', 'Stopped listening');
    }
  }

  /**
   * The user's words.
   *
   * Note the shape of this method: it takes a string. There is no audio
   * parameter, no buffer and no handle to one, so the path from a microphone
   * to the brain is a path text takes and audio cannot. From here the
   * transcript is treated exactly as a typed message — same validation, same
   * turn, same dispatcher, same approval gate.
   */
  onTranscript(text: string, metrics: ListeningMetrics): void {
    // Timings only. Nothing derived from the content of the audio goes into
    // the event stream or the log.
    this.bus.emit({
      type: 'OBSERVATION',
      callId: null,
      summary: `Heard you in ${metrics.totalMs}ms`,
      detail: {
        micOpenMs: metrics.micOpenMs,
        recognizerReadyMs: metrics.recognizerReadyMs,
        utteranceMs: metrics.utteranceMs,
        transcriptionMs: metrics.transcriptionMs,
        totalMs: metrics.totalMs,
      },
    });

    const result = this.sendUserMessage(text, 'voice');
    if (!result.accepted) {
      // `sendUserMessage` has already recorded what was said and, where the
      // refusal was fatal, moved to ERROR. Nothing to add but a resting state.
      this.settle('Could not start a turn');
    }
  }

  /** A listening problem worth showing, phrased for a person. */
  onListeningNotice(message: string): void {
    this.bus.emit({ type: 'OBSERVATION', callId: null, summary: message, detail: null });
  }

  /** A listening failure. Moves to ERROR, which recovers on the next request. */
  onListeningFailure(message: string): void {
    this.fail('voice', message, null);
  }


  /**
   * Open the accounting a conversation STARTS with.
   *
   * This used to be the only budget a voice session ever got — "a voice
   * session is one intention however many things are said inside it" — and
   * that premise was wrong. A real session's event log:
   *
   *     12:56:55  app.open     BUDGET_EXCEEDED  "running for 444 seconds"
   *     12:58:04  memory.save  BUDGET_EXCEEDED  "running for 513 seconds"
   *     12:58:32  system.time  BUDGET_EXCEEDED  "running for 541 seconds"
   *
   * The five-minute ceiling is a bound on ONE REQUEST converging, and it was
   * being charged against the whole conversation. After five minutes of
   * talking every tool failed, including reading the clock, and the model
   * told the user it had timed out.
   *
   * So each new request now opens its own accounting (`beginRequestAccounting`,
   * from `onVoiceTranscript`). This one still runs at session start, because a
   * provider can propose a tool before any transcript has arrived, and a call
   * with no budget at all is unbounded — the one outcome worse than the bug.
   *
   * Public for the same reason `onVoiceTranscript` is: an integration test that
   * opened its own would be testing its own idea of what a conversation costs.
   * It grants nothing. A budget is a ceiling.
   */
  beginConversation(): void {
    this.beginRequestAccounting(null);
  }

  /**
   * Fresh accounting for one request: a new budget, a new duplicate ledger,
   * and a new browser action count.
   *
   * REPLACED, NEVER CLEARED. `dispatcher.endTurn()` leaves dispatches
   * unbudgeted, so ending the old accounting without opening new accounting
   * would briefly remove every limit — a tool call landing in that gap would
   * spend nothing. Opening the next budget in the same synchronous call is
   * what makes the handover atomic.
   *
   * The limits themselves are untouched: 24 calls, five minutes and three
   * identical attempts, now measured against the request they were written
   * for.
   */
  private beginRequestAccounting(goal: string | null): void {
    this.browser?.beginTurn();
    this.dispatcher.beginTurn(new TurnBudget(), goal);
  }

  /**
   * Something the user said, on its way into a task.
   *
   * PUBLIC because it is the whole conversational entry point, and a test that
   * reconstructed it would be testing its own reconstruction. The voice
   * session calls it with the provider's transcript; an integration test calls
   * it with a sentence. Both take the same path, which is the point.
   *
   * It grants nothing. Everything it can do is: record what was said, decide
   * whether that was an answer or a new request, move the goal, and install an
   * abort signal. No tool becomes callable because of anything here.
   */
  onVoiceTranscript(text: string): void {
    // Exactly what a typed message and a Step 4 transcript become. The
    // spoken word gets no special standing anywhere downstream.
    this.bus.emit({ type: 'USER_MESSAGE', text, source: 'voice' });

    // --- "Go to sleep." / "Stop listening." -------------------------
    // Before cancellation, and for the same reason: matched from the user's
    // OWN WORDS, in main. A real session had the model answer "Goodnight!",
    // "I will stop listening now" and "Stopped." while nothing stopped and
    // the microphone kept streaming. See `matchesLifecycleCommand`.
    const lifecycle = matchesLifecycleCommand(text);
    if (lifecycle) {
      this.endConversationByCommand(lifecycle);
      return;
    }

    // --- "Stop." ---------------------------------------------------
    // Matched against the USER'S OWN WORDS, before anything else happens
    // with them. A model asked to decide whether it had been told to stop
    // is the thing being stopped, and that is not a decision it should be
    // making about itself.
    if (matchesCancellation(text)) {
      const stopped = this.cancelWork();
      this.bus.emit({
        type: 'OBSERVATION',
        callId: null,
        summary: stopped ? 'You asked Axon to stop, and it did' : 'Nothing was running to stop',
        detail: null,
      });
      // No new task. A cancellation is not a request, and opening one for
      // it would immediately give the model somewhere to keep working.
      return;
    }

    // --- a new request ----------------------------------------------
    // The goal moves with the conversation: a spoken session is one
    // connection containing many requests, and each new thing the user
    // says is the goal the next actions are judged against. Set from the
    // TRANSCRIPT, never from the agent's paraphrase.
    //
    // A TRUST ASSUMPTION WORTH STATING, because it is the one place the
    // goal boundary is not self-contained. This transcript is the
    // PROVIDER'S transcription of the user's speech. Axon does not
    // transcribe the streamed audio itself, so a provider that sent a
    // fabricated `transcript.user` could set a goal the user never spoke —
    // and the goal boundary would then judge navigations against it.
    //
    // Three things bound what that could achieve, none of which make it
    // acceptable to forget. The goal only ever WIDENS what needs asking
    // about: a fabricated goal cannot make an action skip the risk policy,
    // the approval gate, the duplicate guard or the budget, because the
    // boundary can only escalate and never de-escalate below the tool's
    // own verdict. It cannot name a tool, a path or a URL. And the user is
    // watching a real window with a real dialog. What it could do is stop
    // Axon asking about a consequential navigation it would otherwise have
    // asked about, which is a real reduction in a defence in depth.
    //
    // Fixing it properly needs a local transcription of the same audio to
    // compare against, which is a milestone of its own rather than a line
    // here. It is recorded in the README's known limitations.
    // ANSWER, OR NEW REQUEST? The ledger decides, from whether Axon had
    // asked a question. An answer CONTINUES the task that asked it —
    // keeping its id, its steps and its original goal — because "the
    // second one" superseding the request it was answering would discard
    // the very context it needs to mean anything.
    const received = this.tasks.receive(text, 'voice');

    // The boundary judges against the ORIGINAL request plus the most
    // recent thing said inside the task. See `TaskLedger.effectiveGoal`
    // for why that pair rather than an accumulating transcript.
    this.dispatcher.setTurnGoal(this.tasks.effectiveGoal ?? text);

    if (received.continued) {
      // Same task, same work, same abort signal. Replacing the signal here
      // would abandon an executor the user is still waiting on.
      this.bus.emit({
        type: 'OBSERVATION',
        callId: null,
        summary: 'You answered Axon, and it carried on with the same request',
        detail: { task: received.taskId },
      });
      return;
    }

    // A NEW request, so new accounting: its own budget, its own duplicate
    // ledger, its own browser action count. An answer to Axon's question took
    // the `continued` branch above and keeps the task's accounting, because it
    // is the same request. See `beginConversation` for the log that made this
    // necessary. Opened with the goal, since `beginTurn` sets it.
    this.beginRequestAccounting(this.tasks.effectiveGoal ?? text);

    // A fresh abort signal per request, so "stop" reaches an executor
    // that is already running. Replaced rather than reused: an aborted
    // signal stays aborted.
    this.voiceWork = new AbortController();
    this.dispatcher.setTurnSignal(this.voiceWork.signal);
  }

  /**
   * Stop the work in flight WITHOUT ending the conversation.
   *
   * The difference from `cancelTurn` is the whole reason this exists. A user
   * who says "stop" is still talking to Axon: closing the socket would drop
   * the microphone, end the session, and make the next thing they say go
   * nowhere. What they want stopped is the WORK.
   *
   * Everything a cancellation has to reach, in the order it has to be reached:
   *
   *   the ledger      so a result already in flight is recognised as unwanted
   *                   and cannot speak or prompt the next step
   *   the executors   so a tool actually running is aborted rather than
   *                   allowed to finish into a task nobody wants
   *   the browser     so a navigation in flight is abandoned
   *   the observations so a target reference minted for the cancelled work
   *                   cannot be acted on afterwards
   *   the accounting  so the next request starts with a fresh budget and a
   *                   fresh duplicate ledger
   *
   * Returns false when there was nothing to stop, which is the difference
   * between "Stopped." and saying nothing.
   */
  cancelWork(reason = 'Stopped'): boolean {
    const cancelled = this.tasks.cancelActive();

    // The abort signal first: it is what stops an executor that is running
    // right now, and everything below it is cleanup.
    const work = this.voiceWork;
    this.voiceWork = null;
    work?.abort();
    this.dispatcher.setTurnSignal(null);

    // A dialog still on screen for work the user has just abandoned is worse
    // than useless: answering it would authorise an act nobody wants any more,
    // and leaving it up asks them to decide about something that is over.
    // Recorded as a USER denial, because it is one — they said stop.
    this.approvals.denyAll('user');

    // A cancelled request that is still loading a page is not cancelled.
    this.browser?.cancel();
    // A reference minted for work the user stopped must not survive it. The
    // store expires on its own clock; this is the user saying so sooner.
    this.observations?.clear();

    // Fresh accounting for whatever they ask for next. A cancelled request
    // must not leave its budget or its side-effect ledger attached to the
    // next one.
    this.dispatcher.endTurn();
    this.browser?.beginTurn();
    this.dispatcher.beginTurn(new TurnBudget());

    if (cancelled) {
      this.bus.emit({
        type: 'OBSERVATION',
        callId: null,
        // `status` without a `step` is how the timeline learns a task ENDED
        // rather than that a step happened inside it.
        detail: { task: cancelled, status: 'CANCELLED' },
        summary: reason,
      });
    }
    return cancelled !== null;
  }

  /** Stop the turn in flight, if any. Returns false when there was none. */
  cancelTurn(reason = 'Cancelled'): boolean {
    // The ledger and the observations are cancelled here too. A typed
    // cancellation stops the same work a spoken one does; what it also does,
    // below, is end the conversation.
    this.tasks.cancelActive();
    this.observations?.clear();
    // Stop the voice too: a cancelled turn that keeps talking is not cancelled.
    this.speech?.cancel('cancelled');
    // And the microphone: a cancelled turn that is still recording is worse.
    this.listeningService?.cancel();
    // And the browser: a cancelled turn that is still loading a page, or about
    // to act on one, is not cancelled either. This abandons the navigation in
    // flight; the turn's abort signal below stops the next action starting.
    this.browser?.cancel();
    // And the voice conversation: a cancelled request that is still streaming
    // audio to a remote service is not cancelled in any sense the user means.
    this.voiceSession?.stop();
    const turn = this.activeTurn;
    if (!turn) return false;
    this.activeTurn = null;
    turn.abort();
    // Close the turn's accounting immediately. `runTurn` will do this too when
    // the brain finally unwinds, but a cancelled turn must not leave a budget
    // or a side-effect ledger attached to whatever the user does next.
    this.dispatcher.setTurnSignal(null);
    this.dispatcher.endTurn();
    this.settle(reason);
    return true;
  }


  // --- voice agent ---------------------------------------------------------

  /**
   * Start a spoken conversation.
   *
   * THE PRIVACY GATE. This method is where microphone audio starts leaving the
   * machine, and it is the only such place. Everything before it — the wake
   * word, the hotkey, the button — is local; everything after it streams. That
   * is why activation is recorded on the event stream with WHO asked, and why
   * the method refuses rather than queues when Axon is busy: a session that
   * opens later, for a reason the user has forgotten, is a microphone they did
   * not knowingly turn on.
   */
  startVoiceSession(activation: VoiceActivation = 'manual'): VoiceSessionResult {
    const provider = this.voiceProvider;
    if (!provider) {
      return { accepted: false, error: this.voiceAgentStatus().reason ?? 'Axon cannot hold a spoken conversation.' };
    }
    if (this.voiceSession) {
      return { accepted: false, error: 'Axon is already in a voice conversation.' };
    }
    if (this.activeTurn) {
      return { accepted: false, error: 'Axon is already working on something.' };
    }
    if (this.listeningService?.listening) {
      return { accepted: false, error: 'Axon is already listening.' };
    }

    const state = this.machine.state;
    if (state === 'ERROR') {
      // The same explicit recovery a new typed message performs.
      this.machine.transition('IDLE', 'New request');
    } else if (state !== 'IDLE') {
      return { accepted: false, error: `Axon is busy (${state.replace(/_/g, ' ').toLowerCase()}).` };
    }

    // The wake word's microphone is released first. Two consumers on one
    // device would mean frames going to both a local recognizer and a socket,
    // and "which one is receiving this?" must never be ambiguous.
    this.endWakeCapture();

    // An explicit start is how the user turns the microphone back on after
    // "stop listening". The wake word cannot have started this one: it was
    // not listening.
    if (activation !== 'wake-word') this.resumeFromMicOff();

    // A fresh spend for the conversation. See `beginConversation`.
    this.beginConversation();

    // What the user has approved Axon to remember, recalled ONCE for the
    // session. The same bounded, memory-setting-aware slice the typed brain
    // is given (`contextForTurn`), of which the voice agent takes only the
    // memories: it holds its own conversation, and a transcript of earlier
    // typed turns would be context it did not have and cannot attribute.
    // Read-only: nothing here writes, and ordinary conversation is never
    // saved — only an explicit, approved `memory.save` does that.
    const memories = this.persistence?.contextForTurn().context?.memories ?? [];

    const session = provider.create({
      tools: this.listTools(),
      memories,
      dispatch: (call) => this.dispatcher.dispatch(call),
      // Read-only. The real gate is still the dispatcher's; this only decides
      // whether the agent is told "pending" now or made to wait.
      willRequireApproval: (tool, input) => this.dispatcher.requiresApproval(tool, input),
      // Also read-only, and the same object the dialog will render from.
      describeApproval: (tool, input) => this.dispatcher.describeApproval(tool, input),
      // Read-only from the session's side. Cancellation writes to it here.
      tasks: this.tasks,
      onUserTranscript: (text) => {
        this.diagnostics?.transcript('final', text);
        this.onVoiceTranscript(text);
      },
      onAgentTranscript: (text) => {
        this.bus.emit({ type: 'ASSISTANT_MESSAGE', text });
      },
      onAudioChunk: (chunk) => {
        const delivered = this.speechChunks?.chunk(chunk) ?? false;
        // Counted per reply: was there a live window to take it? The final
        // chunk is an empty drain marker, not audio, so it is not counted.
        if (!chunk.final) this.diagnostics?.replyDelivered(chunk.speechId, delivered);
      },
      onPhase: (phase, detail) => {
        this.onVoicePhase(phase, detail);
      },
      onNotice: (summary) => {
        this.bus.emit({ type: 'OBSERVATION', callId: null, summary, detail: null });
      },
      onClosed: (error) => {
        this.onVoiceSessionClosed(error ? error.message : null);
      },
      // Diagnostics only, and only wired when someone is listening, so the
      // session does no extra work in the shipping build.
      ...(this.diagnostics?.enabled
        ? {
            onAudioSent: (bytes: number, buffered: number) => this.diagnostics?.audioSent(bytes, buffered),
            onAudioDropped: (bytes: number, reason: 'not-ready' | 'no-socket') =>
              this.diagnostics?.audioDropped(bytes, reason),
            onUserTranscriptDelta: (text: string) => this.diagnostics?.transcript('partial', text),
            // The other direction: what the provider sent back, and what
            // became of it. See `reply-audio.ts`.
            onReplyAudio: (event: ReplyAudioNote) => this.diagnostics?.replyAudio(event),
            onReplySummary: (summary: ReplyNote) => this.diagnostics?.replySummary(summary),
          }
        : {}),
    });

    this.voiceSession = session;
    this.voicePhase = 'CONNECTING';

    this.bus.emit({
      type: 'VOICE_SESSION',
      action: 'activated',
      activation,
      phase: 'CONNECTING',
      detail: 'Voice conversation starting — audio will be streamed to the voice service',
    });

    this.moveTo('THINKING', 'Connecting the voice service');

    // Opens the microphone through the SAME command path Step 4 built: main
    // mints the capture id, the renderer opens the device, frames come back
    // stamped. The renderer gains nothing new, and cannot open a microphone
    // Axon did not ask for.
    const captureId = this.beginVoiceCapture();

    void session
      .start()
      .then(() => {
        this.bus.emit({
          type: 'VOICE_SESSION',
          action: 'connected',
          activation,
          phase: session.currentPhase,
          detail: 'Voice conversation connected',
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'The voice connection failed.';
        this.endVoiceCapture(captureId);
        this.onVoiceSessionClosed(message);
      });

    return { accepted: true, error: null };
  }

  /**
   * The user ended the conversation in words. Act first; say nothing false.
   *
   * TWO STATES, NOT ONE, because they are different promises:
   *
   *   sleep    the conversation ends and the microphone stops streaming now.
   *            The LOCAL wake word keeps listening — no audio leaves the
   *            machine until "Hey Axon" — and the panel says "On-device".
   *   mic-off  the same, and the wake word stops too. Nothing is listened to,
   *            even locally, until the user explicitly starts Axon again (the
   *            orb, the hotkey, the tray). The panel says "Mic off".
   *
   * ORDER MATTERS. The wake word is switched off BEFORE the session closes,
   * because closing a session hands the microphone back to the wake word
   * (`resumeWakeCapture`) — and for mic-off there must be no instant in which
   * it is reopened. `session.stop()` is synchronous, so by the time this
   * returns the socket is closed, the capture is ended and the machine has
   * settled to IDLE.
   *
   * No spoken farewell. The provider's voice is gone once the socket closes,
   * and closing it later to let Axon say goodbye would keep streaming a
   * microphone the user has just asked to stop. What the user gets instead
   * is the truth, immediately: the orb leaves, and the panel's microphone
   * chip changes.
   */
  private endConversationByCommand(command: LifecycleCommand): void {
    // Someone ending the conversation is not asking Axon to finish its work.
    this.cancelWork('Stopped');

    if (command === 'mic-off') {
      this.micOff = true;
      this.rearmWakeAfterSession = false;
      this.wakeWord?.disarm?.();
      // The real detector reports this itself; recorded here too so the
      // panel's "Mic off" is true even for one that does not. Idempotent.
      this.setWakeArmed(false);
    }

    this.voiceSession?.stop();

    const summary =
      command === 'mic-off'
        ? 'Microphone off. Axon is not listening at all — not even for "Hey Axon" — until you start it again.'
        : this.wakeArmed
          ? 'Axon went to sleep. The conversation has ended; say "Hey Axon" when you need it.'
          : 'The conversation has ended. Use the hotkey or the orb when you need Axon again.';
    this.bus.emit({ type: 'OBSERVATION', callId: null, summary, detail: { lifecycle: command } });
  }

  /**
   * An explicit start ends mic-off.
   *
   * Only an explicit one — the orb, the hotkey, the tray — can reach here
   * while the microphone is off, because the wake word is not listening. From
   * that start, normal behaviour resumes: the wake word is re-armed when this
   * conversation ends, exactly as it would have been before "stop listening".
   */
  private resumeFromMicOff(): void {
    if (!this.micOff) return;
    this.micOff = false;
    this.rearmWakeAfterSession = true;
  }

  /** Bring the wake word back after an explicit start ended mic-off. */
  private rearmIfResumed(): void {
    if (!this.rearmWakeAfterSession || this.micOff) return;
    this.rearmWakeAfterSession = false;
    // `arm` reports its own failures through its notice channel; a wake word
    // that cannot start again leaves Axon reachable by the hotkey and the orb.
    void this.wakeWord?.arm?.().catch(() => {});
  }

  /** True while the user has turned the microphone off. For the snapshot. */
  get microphoneOff(): boolean {
    return this.micOff;
  }

  /** End the spoken conversation. Returns false when there was none. */
  stopVoiceSession(): VoiceSessionResult {
    const session = this.voiceSession;
    if (!session) return { accepted: false, error: 'Axon is not in a voice conversation.' };
    session.stop();
    return { accepted: true, error: null };
  }

  /** Whether Axon can hold a spoken conversation. Safe for the renderer. */
  voiceAgentStatus(): VoiceAgentStatus {
    return {
      available: this.voiceProvider !== null,
      name: this.voiceProvider?.name ?? 'none',
      reason: this.voiceProvider ? null : (this.voiceAgentUnavailableReason ?? 'No voice agent is configured.'),
      active: this.voiceSession !== null,
      phase: this.voicePhase,
      armed: this.wakeArmed,
      wake: this.wakeWord?.getStatus() ?? NO_WAKE_DETECTOR,
    };
  }

  /**
   * Bind the local wake word.
   *
   * Late-bound because the detector needs the orchestrator to exist first, the
   * same arrangement the speech and listening services use. It is a SINK, not
   * a controller: the orchestrator hands it frames and it hands back nothing
   * but the fact that a phrase was heard.
   */
  attachWakeWord(sink: WakeAudioSink | null): void {
    this.wakeWord = sink;
  }

  /** The wake word started or stopped listening, locally. */
  setWakeArmed(armed: boolean): void {
    // Mic-off holds against anything that re-arms the detector behind the
    // user's back — a renderer reload re-arms it on `did-finish-load`, and
    // that must not quietly reopen a microphone the user asked to close.
    if (armed && this.micOff) {
      this.wakeWord?.disarm?.();
      return;
    }
    if (this.wakeArmed === armed) return;
    this.wakeArmed = armed;
    // The microphone follows the wake word's state, in both directions. A
    // detector that was armed with no microphone would hear nothing; one that
    // was disarmed with the microphone still open would be a device left on
    // for no reason.
    if (armed) this.beginWakeCapture();
    else this.endWakeCapture();

    this.bus.emit({
      type: 'VOICE_SESSION',
      action: armed ? 'armed' : 'disarmed',
      activation: null,
      phase: this.voicePhase,
      detail: armed
        ? 'Listening locally for "Hey Axon" — no audio leaves this machine until you say it'
        : 'Stopped listening for the wake phrase',
    });
  }

  /**
   * One frame of microphone audio, while a voice session is live.
   *
   * Called from `pushAudioFrame` when a session owns the microphone. Note what
   * it does not do: it does not log, does not emit, does not retain and does
   * not return. The frame's whole journey through the orchestrator is this.
   */
  private pushVoiceAudio(samples: Int16Array): void {
    const session = this.voiceSession;
    if (!session) return;
    session.pushAudio(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  /**
   * Map a provider phase onto Axon's own state machine.
   *
   * NO SECOND STATE MACHINE. Every phase resolves to one of the seven states
   * the orchestrator already owns, through `moveTo`, which still refuses an
   * illegal transition. The voice agent proposes a phase; the machine decides.
   */
  private onVoicePhase(phase: VoiceAgentPhase, detail: string): void {
    this.voicePhase = phase;

    switch (phase) {
      case 'CONNECTING':
      case 'THINKING':
        this.moveTo('THINKING', detail);
        return;
      case 'ARMED':
      case 'LISTENING':
        this.moveTo('LISTENING', detail);
        return;
      case 'SPEAKING':
        this.moveTo('SPEAKING', detail);
        return;
      case 'TOOL':
        this.moveTo('EXECUTING', detail);
        return;
      case 'APPROVAL':
        this.moveTo('WAITING_FOR_APPROVAL', detail);
        return;
      case 'FAILED':
        this.fail('voice', detail, null);
        return;
      case 'IDLE':
      case 'CLOSED':
        this.settle(detail);
        return;
      default: {
        const exhaustive: never = phase;
        void exhaustive;
        return;
      }
    }
  }

  /** The session ended, however it ended. Always closes the microphone. */
  private onVoiceSessionClosed(error: string | null): void {
    const session = this.voiceSession;
    if (!session) return;
    this.voiceSession = null;
    this.voicePhase = error ? 'FAILED' : 'IDLE';

    // The microphone closes with the session, unconditionally. A session that
    // could end while the device stayed open is the exact disagreement between
    // what Axon shows and what Axon is doing that this architecture exists to
    // prevent.
    this.endVoiceCapture(this.voiceCaptureId);
    this.dispatcher.endTurn();
    // And the wake word gets its microphone back. See `resumeWakeCapture`.
    this.resumeWakeCapture();
    // Or, after mic-off and one explicit conversation, the wake word itself
    // comes back on. See `resumeFromMicOff`.
    this.rearmIfResumed();

    this.bus.emit({
      type: 'VOICE_SESSION',
      action: error ? 'failed' : 'ended',
      activation: null,
      phase: this.voicePhase,
      detail: error ?? 'Voice conversation ended',
    });

    // `listeningEnded`: the microphone closed a few lines above, so LISTENING
    // is no longer true and the machine must leave it. See `settle`.
    if (error) this.fail('voice', error, null);
    else this.settle('Voice conversation ended', { listeningEnded: true });
  }

  /** Ask the renderer for the microphone, at the agent's sample rate. */
  private beginVoiceCapture(): string {
    const captureId = randomUUID();
    this.voiceCaptureId = captureId;
    // Through `captureCommand`, which is the transport — so the permission
    // window opens on the command, exactly as it does for a listening session.
    // There is no second route to a microphone here.
    this.captureCommand?.({
      action: 'start',
      captureId,
      sampleRate: VOICE_AGENT_LIMITS.sampleRate,
      diagnostics: this.diagnostics?.enabled === true,
      ...(this.captureProcessing ? { processing: this.captureProcessing } : {}),
    });
    return captureId;
  }

  private endVoiceCapture(captureId: string | null): void {
    if (!captureId) return;
    this.voiceCaptureId = null;
    this.captureCommand?.({ action: 'stop', captureId, sampleRate: VOICE_AGENT_LIMITS.sampleRate });
  }

  shutdown(): void {
    this.activeTurn?.abort();
    this.activeTurn = null;
    // Before anything else: a quit that leaves a socket streaming a live
    // microphone is the worst failure this subsystem has.
    this.voiceSession?.stop();
    this.voiceSession = null;
    this.endWakeCapture();
    // Closes the microphone and kills the recognizer. A quit must never leave
    // a capture running behind a window that has gone.
    this.listeningService?.shutdown();
    // And closes the browser window: an orphaned Chromium outliving Axon is
    // exactly the resource leak this milestone must not introduce.
    this.browser?.close();
    // And forgets what Axon has looked at. The store expires on its own clock,
    // but "it will be gone in a minute" is a weaker promise than "it is gone",
    // and a screen capture is the most personal thing Axon holds.
    this.observations?.clear();
    // Stop the voice and release any turn waiting on it, so a quit during
    // speech cannot leave a promise pending forever.
    this.speech?.shutdown();
    const resolve = this.speechFinished;
    this.speechFinished = null;
    resolve?.();
    // And forgets what Axon was doing. A quit is the end of every task.
    this.tasks.clear();
    this.dispatcher.abortAll();
  }
}
