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
  VOICE_AGENT_LIMITS,
  type ApprovalDecision,
  type AxonSnapshot,
  type AxonState,
  type Brain,
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
}

export interface OrchestratorOptions {
  readonly bus: EventBus;
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
  /** The capture the wake word is listening on, or null when it is not. */
  private wakeCaptureId: string | null = null;
  /** Bound after construction: the detector is built after the orchestrator. */
  private wakeWord: WakeAudioSink | null = null;

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
  settle(reason: string): void {
    // LISTENING is not a resting state — it is a live session with an open
    // microphone, owned by the listening service. Settling out of it here
    // would take the UI out of LISTENING while the microphone was still on,
    // which is precisely the disagreement between what Axon shows and what
    // Axon is doing that this architecture exists to prevent.
    //
    // This matters concretely during barge-in: interrupting speech resolves
    // the turn that was waiting on it, and that turn then settles a moment
    // after the machine has already entered LISTENING.
    if (this.machine.state === 'LISTENING') return;

    const target: AxonState = this.activeTurn ? 'THINKING' : 'IDLE';
    if (this.machine.state !== target && this.machine.canTransition(target)) {
      this.machine.transition(target, reason);
    }
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

    const result = listening.start(trigger);
    if (!result.accepted) {
      // The session never opened, so nothing has to be unwound — but if the
      // barge-in above already left SPEAKING, land somewhere sane.
      this.settle('Could not start listening');
    }
    return result;
  }

  /** Stop listening. Anything already said is transcribed. */
  stopListening(): boolean {
    return this.listeningService?.stop() ?? false;
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
      if (captureId === this.voiceCaptureId) this.pushVoiceAudio(samples);
      return;
    }
    if (this.wakeCaptureId !== null) {
      // To a LOCAL recognizer, and nowhere else. This is the branch that makes
      // "before activation, audio stays on this machine" true.
      if (captureId === this.wakeCaptureId) this.wakeWord?.pushFrame(samples);
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
    this.captureCommand?.({ action: 'start', captureId, sampleRate: LISTENING_LIMITS.sampleRate });
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

  /** Stop the turn in flight, if any. Returns false when there was none. */
  cancelTurn(reason = 'Cancelled'): boolean {
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

    // A fresh spend for the conversation. A voice session is one intention
    // however many things are said inside it, so it gets one budget and one
    // duplicate ledger — the same treatment a typed turn gets.
    this.browser?.beginTurn();
    this.dispatcher.beginTurn(new TurnBudget());

    const session = provider.create({
      tools: this.listTools(),
      dispatch: (call) => this.dispatcher.dispatch(call),
      // Read-only. The real gate is still the dispatcher's; this only decides
      // whether the agent is told "pending" now or made to wait.
      willRequireApproval: (tool, input) => this.dispatcher.requiresApproval(tool, input),
      onUserTranscript: (text) => {
        // The goal moves with the conversation: a spoken session is one turn
        // containing many requests, and each new thing the user says is the
        // goal the next actions are judged against. Set from the TRANSCRIPT,
        // which is what the user said — never from the agent's paraphrase.
        this.dispatcher.setTurnGoal(text);
        // Exactly what a typed message and a Step 4 transcript become. The
        // spoken word gets no special standing anywhere downstream.
        this.bus.emit({ type: 'USER_MESSAGE', text, source: 'voice' });
      },
      onAgentTranscript: (text) => {
        this.bus.emit({ type: 'ASSISTANT_MESSAGE', text });
      },
      onAudioChunk: (chunk) => {
        this.speechChunks?.chunk(chunk);
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

    this.bus.emit({
      type: 'VOICE_SESSION',
      action: error ? 'failed' : 'ended',
      activation: null,
      phase: this.voicePhase,
      detail: error ?? 'Voice conversation ended',
    });

    if (error) this.fail('voice', error, null);
    else this.settle('Voice conversation ended');
  }

  /** Ask the renderer for the microphone, at the agent's sample rate. */
  private beginVoiceCapture(): string {
    const captureId = randomUUID();
    this.voiceCaptureId = captureId;
    // Through `captureCommand`, which is the transport — so the permission
    // window opens on the command, exactly as it does for a listening session.
    // There is no second route to a microphone here.
    this.captureCommand?.({ action: 'start', captureId, sampleRate: VOICE_AGENT_LIMITS.sampleRate });
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
    // Stop the voice and release any turn waiting on it, so a quit during
    // speech cannot leave a promise pending forever.
    this.speech?.shutdown();
    const resolve = this.speechFinished;
    this.speechFinished = null;
    resolve?.();
    this.dispatcher.abortAll();
  }
}
