/**
 * What Axon is currently doing, and for whom.
 *
 * THE ONE QUESTION THIS ANSWERS: "is this result still wanted?"
 *
 * Before Phase 3 nothing could answer it. A tool result came back and was
 * delivered, because there was nothing to compare it against — no record of
 * which request it belonged to, and no way to know the user had said "stop"
 * or asked for something else while it was running. So a cancelled action's
 * result could still arrive, still be spoken, and still prompt the next step
 * of work the user had abandoned.
 *
 * The ledger is the smallest structure that closes that. A TASK is minted when
 * the user asks for something. Every proposed action becomes a STEP inside it.
 * Both carry ids. Cancelling bumps the task out of `ACTIVE`, and every result
 * is checked against the task it was started for before it is allowed to reach
 * the conversation.
 *
 * WHAT IT DELIBERATELY IS NOT.
 *
 * It is not a plan, a queue, or a scope. It holds no approved future actions —
 * that structure is exactly how one approval comes to authorise a second act,
 * and Axon does not have one. It grants nothing: there is no method here that
 * any caller could use to make an action legal. Every step still passes the
 * dispatcher's schema, precheck, budget, risk, policy, duplicate and approval
 * gates on its own, and this records what happened rather than deciding it.
 *
 * It is also not an audit log. The bus is. This holds counters, ids and
 * outcomes so a task can be reconstructed and a stale result recognised; it
 * carries no arguments, no outputs, no page text and no typed text, because
 * those are the things that must not accumulate in memory keyed by anything.
 *
 * Pure of Electron, of the filesystem and of the network: a clock in, ids out.
 */

import {
  TASK_LIMITS,
  type StepOutcome,
  type TaskContext,
  type TaskStatus,
  type TaskStepTrace,
} from '@axon/core';

/** How a task came to exist. Recorded because "who asked?" is worth knowing. */
export type TaskOrigin = 'voice' | 'text' | 'console';

interface TaskRecord {
  readonly id: string;
  readonly origin: TaskOrigin;
  /**
   * What the user actually said when they opened this task, verbatim.
   *
   * The ORIGINAL request, and it never changes. A continuation is recorded
   * separately in `latest` rather than replacing this, so a task that has run
   * for six steps is still judged against what was actually asked for.
   */
  readonly goal: string;
  /**
   * The most recent thing the user said within this task.
   *
   * Kept as ONE value rather than a growing transcript, deliberately. The goal
   * boundary reads `goal` and `latest` together, so an accumulating history
   * would mean the set of destinations a task permits only ever grows — six
   * turns in, a stray "how do I create an account" would still be authorising
   * a signup page. Two values keep the context without the ratchet.
   */
  latest: string | null;
  readonly startedAt: number;
  status: TaskStatus;
  endedAt: number | null;
  steps: number;
  /**
   * The question Axon is waiting for an answer to.
   *
   * THE STATE THAT MAKES CLARIFICATION USABLE. Without it, Axon asks "which
   * one?", the user says "the second", and that answer opens a NEW task —
   * superseding the one that asked the question, discarding the context the
   * answer was about, and leaving the model to act on a request that means
   * nothing on its own.
   *
   * With it, the next utterance is understood as an answer and continues the
   * task it belongs to. Cleared as soon as it is answered, so a task cannot
   * sit in this state and swallow a genuinely new request.
   */
  awaitingAnswerTo: string | null;
}

/** A step, as the caller holds it while the work is in flight. */
export interface StepHandle {
  readonly taskId: string;
  readonly stepId: string;
  readonly tool: string;
}

export interface TaskLedgerOptions {
  /** Injected in tests so ids and expiry are deterministic. */
  readonly now?: () => number;
  /** Emits a trace line. The bus, in production; an array, in tests. */
  onTrace?(trace: TaskStepTrace): void;
}

/** Longest goal text the ledger will hold. A bound on memory, not on the user. */
const MAX_GOAL_CHARACTERS = 500;

export class TaskLedger {
  private readonly now: () => number;
  private readonly onTrace: (trace: TaskStepTrace) => void;

  private current: TaskRecord | null = null;
  /**
   * Every task this session has had, most recent last.
   *
   * Bounded: a long conversation is many tasks and none of the old ones is
   * interesting once its results can no longer arrive.
   */
  private readonly history: TaskRecord[] = [];

  /**
   * Monotonic and never reset, for both tasks and steps.
   *
   * Reusing an id would let a result from a cancelled task match a live one,
   * which is precisely the failure this class exists to prevent.
   */
  private taskOrdinal = 0;
  private stepOrdinal = 0;

  /**
   * What Axon has observed, as opposed to what it was asked for.
   *
   * Held beside the task rather than inside it because they outlive one task
   * in the way a person's sense of "where we are" does: the browser is still
   * on YouTube after the user changes the subject. Cleared on cancellation and
   * on `clear`, because a page Axon stopped caring about is not grounding.
   */
  private currentPage: string | null = null;
  private lastActedOn: string | null = null;

  constructor(options: TaskLedgerOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.onTrace = options.onTrace ?? ((): void => {});
  }

  /**
   * Take in something the user said, and say what it turned out to be.
   *
   * TWO OUTCOMES, and telling them apart is the whole of Phase 4's
   * conversational continuity:
   *
   *   CONTINUED   The active task had asked a question, so this is the ANSWER.
   *               The task keeps its id, its steps and its original goal, and
   *               gains this utterance as `latest`.
   *
   *   BEGAN       Anything else. A user who asks for something new has stopped
   *               wanting the old thing, which is SUPERSEDED rather than
   *               CANCELLED — they did not tell Axon to stop, they moved on,
   *               and only the first of those is worth saying out loud.
   *
   * The caller is responsible for actually stopping superseded work; this
   * records the decision, it does not enforce it. See
   * `Orchestrator.cancelWork` for the enforcement, which is deliberately
   * somewhere that can reach an abort signal.
   */
  receive(utterance: string, origin: TaskOrigin): { readonly taskId: string; readonly continued: boolean } {
    const text = typeof utterance === 'string' ? utterance.slice(0, MAX_GOAL_CHARACTERS) : '';
    const active = this.current?.status === 'ACTIVE' ? this.current : null;

    // An answer to a question Axon asked belongs to the task that asked it.
    if (active && active.awaitingAnswerTo !== null) {
      active.awaitingAnswerTo = null;
      active.latest = text;
      return { taskId: active.id, continued: true };
    }

    return { taskId: this.begin(text, origin), continued: false };
  }

  /**
   * Start a task, superseding whatever was running.
   *
   * Prefer `receive` from the conversational path: this one always begins a
   * new task, which is wrong for an answer to a question Axon asked.
   */
  begin(goal: string, origin: TaskOrigin): string {
    if (this.current?.status === 'ACTIVE') this.close(this.current.id, 'SUPERSEDED');

    this.taskOrdinal += 1;
    const record: TaskRecord = {
      id: `task-${this.taskOrdinal}`,
      origin,
      goal: typeof goal === 'string' ? goal.slice(0, MAX_GOAL_CHARACTERS) : '',
      latest: null,
      startedAt: this.now(),
      status: 'ACTIVE',
      endedAt: null,
      steps: 0,
      awaitingAnswerTo: null,
    };

    this.current = record;
    this.history.push(record);
    while (this.history.length > 20) this.history.shift();
    return record.id;
  }

  /**
   * Record that Axon has asked the user something and is waiting.
   *
   * Called when a tool refuses with `CLARIFICATION_NEEDED`. It does NOT stop
   * the task, pause the budget, or grant anything — it only changes what the
   * next utterance is understood to be.
   *
   * A question asked against no active task is dropped rather than stored: an
   * answer with nothing to answer would be a task resurrected by a sentence
   * that was never a request.
   */
  awaitClarification(question: string): void {
    const active = this.current?.status === 'ACTIVE' ? this.current : null;
    if (!active) return;
    active.awaitingAnswerTo = typeof question === 'string' ? question.slice(0, MAX_GOAL_CHARACTERS) : '';
  }

  /** The question the active task is waiting on, or null. */
  get awaitingAnswerTo(): string | null {
    return this.current?.status === 'ACTIVE' ? this.current.awaitingAnswerTo : null;
  }

  /**
   * What the goal boundary should judge against.
   *
   * The ORIGINAL request plus the most recent thing said inside the task, and
   * nothing else. "Open GitHub" followed by "sign me in" permits the sign-in
   * page, because the user asked for it — and six turns of unrelated
   * conversation do not accumulate into permission for anything.
   */
  get effectiveGoal(): string | null {
    const active = this.current?.status === 'ACTIVE' ? this.current : null;
    if (!active) return null;
    return active.latest && active.latest !== active.goal ? `${active.goal} ${active.latest}` : active.goal;
  }

  /** The task in flight, or null when Axon is between requests. */
  get activeTaskId(): string | null {
    return this.current?.status === 'ACTIVE' ? this.current.id : null;
  }

  get activeGoal(): string | null {
    return this.current?.status === 'ACTIVE' ? this.current.goal : null;
  }

  /**
   * Open a step against the active task.
   *
   * Returns null when there is nothing to open one against — no active task,
   * or a task that has run out of steps. A NULL RETURN IS A REFUSAL and the
   * caller must treat it as one: it is what stops a cancelled task's model
   * from continuing to propose actions into it.
   */
  beginStep(tool: string): StepHandle | null {
    const task = this.current;
    if (!task || task.status !== 'ACTIVE') return null;
    if (task.steps >= TASK_LIMITS.maxStepsPerTask) return null;

    task.steps += 1;
    this.stepOrdinal += 1;
    const handle: StepHandle = { taskId: task.id, stepId: `step-${this.stepOrdinal}`, tool };

    this.trace(handle, 'PROPOSED', {});
    return handle;
  }

  /**
   * Record what happened to a step.
   *
   * Every field is optional because a step can end at any gate: refused by the
   * schema before risk was resolved, denied before it ran, cancelled before it
   * finished. What is recorded is what was actually established.
   */
  endStep(
    handle: StepHandle,
    outcome: StepOutcome,
    detail: {
      risk?: string | null;
      approval?: TaskStepTrace['approval'];
      verified?: boolean | null;
      callId?: string | null;
    } = {},
  ): void {
    this.trace(handle, outcome, detail, this.now());
  }

  /**
   * Note which dispatcher call a step became, at the moment it becomes one.
   *
   * Emitted BEFORE the dispatch rather than after it, and that ordering is the
   * whole point. The `TOOL_CALL`, the approval and the result all arrive
   * carrying a call id; a timeline that only learned the id from the step's
   * OUTCOME would see those three events before it knew whose they were, and
   * would have to attribute them by ordering. Ordering is wrong exactly when
   * it matters — two steps of the same tool in flight at once — so the id goes
   * out first and the join is exact.
   */
  linkCall(handle: StepHandle, callId: string): void {
    this.trace(handle, 'RUNNING', { callId });
  }

  /**
   * Is this step's result still wanted?
   *
   * THE GATE THE WHOLE CLASS EXISTS FOR. Called before a late result is
   * allowed to reach the conversation or to prompt another action.
   *
   * A result is wanted when its task is still the active one, or when it
   * belongs to a task that finished normally within the grace window — a task
   * can complete while its last result is still travelling. A CANCELLED or
   * SUPERSEDED task never wants anything: the user said stop, or asked for
   * something else, and in both cases delivering it would be Axon acting on an
   * intention that no longer exists.
   */
  wants(taskId: string): boolean {
    const task = this.find(taskId);
    if (!task) return false;
    if (task.status === 'CANCELLED' || task.status === 'SUPERSEDED') return false;
    if (task.status === 'ACTIVE') return true;
    return task.endedAt !== null && this.now() - task.endedAt <= TASK_LIMITS.lateResultGraceMs;
  }

  /** Whether a specific task was stopped by the user, for what Axon says. */
  wasCancelled(taskId: string): boolean {
    return this.find(taskId)?.status === 'CANCELLED';
  }

  /**
   * End a task.
   *
   * Idempotent, and it never revives one: a task that is already finished
   * stays finished with the status it finished with. Without that, a late
   * `COMPLETED` could quietly undo a cancellation.
   */
  close(taskId: string, status: Exclude<TaskStatus, 'ACTIVE'>): void {
    const task = this.find(taskId);
    if (!task || task.status !== 'ACTIVE') return;
    task.status = status;
    task.endedAt = this.now();
    if (this.current?.id === taskId) this.current = task;
  }

  /** Cancel whatever is active. Returns the task id, or null if there was none. */
  cancelActive(): string | null {
    const id = this.activeTaskId;
    if (!id) return null;
    this.close(id, 'CANCELLED');
    // And forgets where it was. "Open that one" after a cancellation must not
    // resolve against a page the user has already abandoned.
    this.currentPage = null;
    this.lastActedOn = null;
    return id;
  }

  /** Status of one task, for tests and diagnostics. */
  statusOf(taskId: string): TaskStatus | null {
    return this.find(taskId)?.status ?? null;
  }

  /** Steps opened against one task. Counters only. */
  stepsOf(taskId: string): number {
    return this.find(taskId)?.steps ?? 0;
  }

  /**
   * Record what Axon SAW, so a later reference has something to resolve
   * against.
   *
   * Written only from Axon's own observations — the page it read, the control
   * it activated — never from anything the model said it did. A grounding
   * built from claims would ground a reference in a claim.
   */
  observed(detail: { readonly page?: string | null; readonly actedOn?: string | null }): void {
    const active = this.current?.status === 'ACTIVE' ? this.current : null;
    if (!active) return;
    if (detail.page !== undefined) this.currentPage = detail.page;
    if (detail.actedOn !== undefined) this.lastActedOn = detail.actedOn;
  }

  /**
   * The facts of the task in flight, for the model to reason from.
   *
   * Null between requests. Carries no arguments, no page text and no typed
   * text — a description of where Axon is, not of what has been said to it.
   */
  context(): TaskContext | null {
    const active = this.current?.status === 'ACTIVE' ? this.current : null;
    if (!active) return null;
    return {
      taskId: active.id,
      goal: this.effectiveGoal ?? active.goal,
      stepsTaken: active.steps,
      currentPage: this.currentPage,
      lastActedOn: this.lastActedOn,
      awaitingAnswerTo: active.awaitingAnswerTo,
    };
  }

  /** Forget everything. Called when a session ends. */
  clear(): void {
    this.current = null;
    this.history.length = 0;
    this.currentPage = null;
    this.lastActedOn = null;
  }

  // --- internals ----------------------------------------------------------

  private find(taskId: string): TaskRecord | undefined {
    return this.history.find((task) => task.id === taskId);
  }

  private trace(
    handle: StepHandle,
    outcome: StepOutcome,
    detail: {
      risk?: string | null;
      approval?: TaskStepTrace['approval'];
      verified?: boolean | null;
      callId?: string | null;
    },
    endedAt: number | null = null,
  ): void {
    this.onTrace({
      taskId: handle.taskId,
      stepId: handle.stepId,
      tool: handle.tool,
      outcome,
      callId: detail.callId ?? null,
      risk: detail.risk ?? null,
      approval: detail.approval ?? null,
      verified: detail.verified ?? null,
      startedAt: this.now(),
      endedAt,
    });
  }
}
