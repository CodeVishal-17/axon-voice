/**
 * The dispatcher — the only path from an intention to an effect.
 *
 *     caller (brain, or the dev console)
 *        -> Dispatcher -> Policy -> Approval -> Executor
 *
 * Nothing else in the application may call `RegisteredTool.execute`. That is
 * enforced structurally (only `tools/registry.ts` imports executors, and only
 * this class holds the registry) and mechanically, by
 * `tests/architecture.test.ts`.
 *
 * Invariants this class guarantees:
 *
 * 1. Exactly one TOOL_CALL and exactly one TOOL_RESULT per dispatch, always —
 *    including for unknown tools, invalid input, refusals and crashes. A
 *    timeline that can lose the second half of a pair is a timeline that can
 *    show an action as running forever.
 * 2. An executor only ever sees input that has passed `inputSchema`.
 * 3. Risk is resolved from the parsed arguments. If resolution throws, the
 *    call escalates to REQUIRES_APPROVAL — it never degrades to SAFE.
 * 4. Failure is returned as a structured `ToolResult`, not thrown. Callers
 *    (including a future language model) have to be able to read a failure and
 *    react to it, and an exception thrown back into a model loop is not
 *    something the model can read.
 *
 * STEP 7 ADDED FOUR GATES, all of them before execution and all of them
 * narrowing. The order below is not arbitrary:
 *
 *     schema  ->  precheck  ->  budget  ->  risk  ->  policy
 *             ->  duplicate ->  approval -> re-bind -> execute
 *
 * - `precheck` runs before risk so a stale element reference is answered with
 *   "read the page again", not with an approval dialog about clicking
 *   something that is no longer there.
 * - The budget runs before risk so a turn that has run out of time stops
 *   spending the user's attention as well as their tokens.
 * - The duplicate guard runs before approval so a repeated outward action is
 *   refused rather than re-asked. Asking twice is how a user ends up
 *   approving the second copy of a comment.
 * - `re-bind` recomputes the approval fingerprint from the arguments that are
 *   actually about to run and compares it with the one the user was shown.
 *   Equality is the whole guarantee that an approval authorises one act.
 */

import { randomUUID } from 'node:crypto';
import {
  toJsonValue,
  unknownRisk,
  type ApprovalRequest,
  type JsonValue,
  type PrecheckVerdict,
  type RegisteredTool,
  type RiskAssessment,
  type RiskLevel,
  type SideEffectClass,
  type ToolCall,
  type ToolExecutionContext,
  type ToolFailure,
  type ToolFailureKind,
  type ToolResult,
  type ToolSummary,
} from '@axon/core';
import type { EventBus } from '../bus/event-bus.js';
import type { ApprovalBroker } from './approval-broker.js';
import type { Policy } from './policy.js';
import type { ToolRegistry } from '../tools/registry.js';
import { bindApproval, classifySideEffect, fingerprintCall } from './approval-binding.js';
import { withGoalBoundary } from './goal-boundary.js';
import { SideEffectLedger } from './side-effect-ledger.js';
import type { TurnBudget } from './turn-budget.js';

/**
 * The dispatcher's view of the state machine.
 *
 * A port rather than the machine itself: state authority stays with the
 * orchestrator, and the dispatcher stays testable without one.
 */
export interface StateController {
  enterExecuting(reason: string): void;
  enterAwaitingApproval(reason: string): void;
  /** Work finished, either way — return to a resting state. */
  settle(reason: string): void;
}

export interface DispatcherOptions {
  readonly registry: ToolRegistry;
  readonly policy: Policy;
  readonly approvals: ApprovalBroker;
  readonly bus: EventBus;
  readonly states: StateController;
  readonly approvalTimeoutMs: number;
  readonly now?: () => Date;
  /**
   * What page Axon last observed, for the approval binding's `target`.
   *
   * A getter rather than a value: the dispatcher must read it at the moment
   * the request is raised, not at construction. Returns a URL Axon itself
   * navigated to — never anything from page storage.
   */
  readonly currentPage?: () => string | null;
}

export class Dispatcher {
  private readonly registry: ToolRegistry;
  private readonly policy: Policy;
  private readonly approvals: ApprovalBroker;
  private readonly bus: EventBus;
  private readonly states: StateController;
  private readonly approvalTimeoutMs: number;
  private readonly now: () => Date;
  private readonly shutdown = new AbortController();

  /**
   * The current agent turn's abort signal, or null between turns.
   *
   * Executors receive a signal that aborts on EITHER shutdown or cancellation
   * of the turn that started them. Without this, "stop" reached the model loop
   * and the voice but not the tool already running — so a page would carry on
   * loading, and the next action would start against a request the user had
   * already abandoned. Long-running executors are exactly what Step 5 added,
   * which is what makes this matter now.
   */
  private turnSignal: AbortSignal | null = null;

  /**
   * This turn's spend, or null between turns.
   *
   * Null means unbudgeted, which is the developer Tool Console: a human
   * clicking a button one call at a time is already rate-limited by being a
   * human. Every brain-driven dispatch runs with one.
   */
  private budget: TurnBudget | null = null;

  private readonly currentPage: () => string | null;

  /** What already left the machine during this turn. Cleared per turn. */
  private readonly ledger = new SideEffectLedger();

  /**
   * What the user actually asked for this turn, verbatim.
   *
   * Used by the goal boundary and by nothing else. It is the USER'S words, not
   * the model's paraphrase of them — a model that could restate the goal could
   * restate it as whatever would authorise its next action, which would make
   * the check worthless.
   */
  private turnGoal: string | null = null;

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.approvals = options.approvals;
    this.bus = options.bus;
    this.states = options.states;
    this.approvalTimeoutMs = options.approvalTimeoutMs;
    this.now = options.now ?? ((): Date => new Date());
    this.currentPage = options.currentPage ?? ((): string | null => null);
  }

  /** Abort in-flight executors and deny anything awaiting approval. */
  abortAll(): void {
    this.shutdown.abort();
    this.approvals.denyAll('shutdown');
  }

  /**
   * Bind executors to the turn in flight.
   *
   * Set by the orchestrator when a turn starts and cleared when it ends. It
   * grants no authority — a signal can only ever stop work — so this widens
   * nothing that the safety layer gates.
   */
  setTurnSignal(signal: AbortSignal | null): void {
    this.turnSignal = signal;
  }

  /**
   * Start a turn's accounting.
   *
   * Both the budget and the duplicate ledger are per-turn, and both are
   * installed here rather than passed on each dispatch — so a caller cannot
   * dispatch without one by forgetting an argument.
   */
  beginTurn(budget: TurnBudget, goal: string | null = null): void {
    this.budget = budget;
    this.turnGoal = goal;
    this.ledger.reset();
  }

  /**
   * Update the goal within a turn.
   *
   * A spoken conversation is one turn with many things said in it, so the goal
   * moves as the user speaks. Called only with a real user utterance.
   */
  setTurnGoal(goal: string | null): void {
    this.turnGoal = goal;
  }

  /** End a turn's accounting. Subsequent dispatches are unbudgeted. */
  endTurn(): void {
    this.budget = null;
    this.turnGoal = null;
    this.ledger.reset();
  }

  /** What this turn has spent, for the timeline. Counters only. */
  budgetSnapshot(): ReturnType<TurnBudget['snapshot']> | null {
    return this.budget?.snapshot() ?? null;
  }

  /**
   * Would this call need a human, if it were dispatched right now?
   *
   * A READ-ONLY QUERY, and it is important that it is only that. It executes
   * nothing, emits nothing, spends no budget, records nothing in the ledger
   * and settles no approval. It exists for one caller: the voice agent, which
   * must decide whether to answer a tool call immediately as "pending" or to
   * run it inline (see `agent/tool-bridge.ts`).
   *
   * WHY THIS IS NOT A SECOND POLICY. It calls the same registry, the same
   * `resolveRisk` and the same `Policy` instance the real dispatch does. It
   * cannot disagree with the real decision because it IS the real decision,
   * asked a moment earlier — and if the world changes in between, the real
   * dispatch is still the one that gates execution. Getting this answer wrong
   * cannot let anything through: a false positive defers an action that did
   * not need deferring, and a false negative simply means the approval dialog
   * appears during the call rather than after it.
   *
   * Deny-by-default: anything unresolvable answers `true`.
   */
  requiresApproval(tool: string, input: JsonValue): boolean {
    const registered = this.registry.get(tool);
    if (!registered) return true;

    const parsed = registered.inputSchema.safeParse(input);
    // Invalid input never reaches an approval — the real dispatch will refuse
    // it outright — so answering `false` here is right: it should be attempted
    // inline and fail fast with a schema error the model can read.
    if (!parsed.success) return false;

    try {
      const decision = this.policy.decide(this.assessRisk(registered, parsed.data));
      return decision.action === 'REQUIRE_APPROVAL';
    } catch {
      return true;
    }
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = this.registry.get(call.tool);

    // --- Unknown tool -----------------------------------------------------
    // Deny-by-default starts here: an unrecognized name is not a no-op, it is
    // a refusal, and it is recorded like every other refusal.
    if (!tool) {
      const message = `No tool named "${call.tool}" is registered.`;
      this.emitCall(call, 'FORBIDDEN', message);
      return this.fail(call, startedAt, {
        kind: 'UNKNOWN_TOOL',
        message,
        detail: { registered: [...this.registry.names()] },
      });
    }

    // --- Input validation -------------------------------------------------
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      this.emitCall(call, 'FORBIDDEN', 'Input did not match the tool schema.');
      return this.fail(call, startedAt, {
        kind: 'INVALID_INPUT',
        message: `Input for "${tool.name}" did not match its schema.`,
        detail: toJsonValue(parsed.error.issues),
      });
    }
    const input: unknown = parsed.data;

    // --- Preconditions ----------------------------------------------------
    // Before risk, before the budget, before anybody is asked anything. A
    // reference to an element on a page that has since changed is not a
    // dangerous call to be weighed — it is a call that cannot be evaluated at
    // all, and the honest answer is "look again".
    const precheck = this.precheck(tool, input);
    if (!precheck.ok) {
      this.emitCall(call, 'FORBIDDEN', precheck.reason);
      return this.fail(call, startedAt, {
        kind: precheck.retryable ? 'STALE_REFERENCE' : 'FORBIDDEN',
        message: precheck.reason,
        detail: null,
      });
    }

    // --- Turn budget ------------------------------------------------------
    // Spent here, at the one boundary every effect crosses, so the bound holds
    // for any brain rather than only for one that respects its own limits.
    const spend = this.budget?.spend(call.tool, input, this.repeatKeyFor(tool, input)) ?? { ok: true as const };
    if (!spend.ok) {
      this.emitCall(call, 'FORBIDDEN', spend.message);
      return this.fail(call, startedAt, {
        kind: 'BUDGET_EXCEEDED',
        message: spend.message,
        detail: { breach: spend.breach },
      });
    }

    // --- Risk resolution --------------------------------------------------
    // The goal boundary is applied on top, and can only escalate. It is the
    // control that stops "open GitHub" turning into "create a GitHub account"
    // — see `goal-boundary.ts` for what went wrong without it.
    const assessment = withGoalBoundary(this.assessRisk(tool, input), {
      tool: call.tool,
      input,
      goal: this.turnGoal,
    });
    this.emitCall(call, assessment.level, assessment.reason);

    const decision = this.policy.decide(assessment);

    if (decision.action === 'REFUSE') {
      return this.fail(call, startedAt, {
        kind: 'FORBIDDEN',
        message: decision.reason,
        detail: null,
      });
    }

    // --- What this call would send outward --------------------------------
    // Computed once, from the arguments that passed the schema, and reused for
    // the duplicate guard, the approval binding and the ledger entry. One
    // derivation means those three cannot disagree about what a call is.
    const escalated = decision.action === 'REQUIRE_APPROVAL';
    const declared = this.declaredSideEffect(tool, input);
    const effect: SideEffectClass = escalated && declared !== 'EXTERNAL' ? 'EXTERNAL' : declared;
    const fingerprint = fingerprintCall(call.tool, input);

    // --- Duplicate outward action -----------------------------------------
    // Before the approval, so a repeat is refused rather than re-asked.
    const duplicate = this.ledger.check(effect, fingerprint);
    if (!duplicate.ok) {
      return this.fail(call, startedAt, {
        kind: 'DUPLICATE_SIDE_EFFECT',
        message: duplicate.message,
        detail: { fingerprint },
      });
    }

    // --- Human gate -------------------------------------------------------
    if (escalated) {
      const gate = await this.requestApproval(call, tool, input, assessment, effect, fingerprint);
      if (!gate.ok) {
        // Denial leaves the machine in WAITING_FOR_APPROVAL, and this return
        // sits outside the try/finally below, so settle explicitly. Without
        // this the UI stays stuck on the approval state after a "Deny".
        this.states.settle(`${tool.name} was not approved`);
        return this.fail(call, startedAt, gate.failure);
      }

      // --- Approval binding, re-checked -----------------------------------
      // The user answered a question about a specific act. This asserts that
      // the act about to run is still that one. It cannot fail today — `input`
      // is a const captured before the await — and that is exactly why it is
      // here: it makes the property a checked invariant rather than a fact
      // about the current shape of this function, so a later change that
      // recomputes or mutates arguments after the await fails loudly instead
      // of silently executing something nobody approved.
      const executingFingerprint = fingerprintCall(call.tool, input);
      if (executingFingerprint !== gate.fingerprint) {
        this.states.settle(`${tool.name} changed after approval`);
        return this.fail(call, startedAt, {
          kind: 'APPROVAL_MISMATCH',
          message:
            'What was about to run is not what the user approved, so it was refused. ' +
            'Ask again, describing the action you actually intend.',
          detail: { approved: gate.fingerprint, attempted: executingFingerprint },
        });
      }
    }

    // --- Execution --------------------------------------------------------
    this.states.enterExecuting(`Running ${tool.name}`);
    // Recorded BEFORE the executor runs, not after. The dangerous case is an
    // action whose request reached the network and whose executor then threw
    // or was cancelled: a ledger written on success would leave that
    // unrecorded and let the next attempt repeat it.
    this.ledger.record(effect, fingerprint, call.tool, 'attempted');
    try {
      const output = await tool.execute(input, this.contextFor(call));
      const durationMs = Date.now() - startedAt;
      this.bus.emit({
        type: 'TOOL_RESULT',
        callId: call.callId,
        tool: call.tool,
        ok: true,
        durationMs,
        output,
        failure: null,
      });
      return { callId: call.callId, tool: call.tool, ok: true, output, durationMs };
    } catch (error) {
      return this.fail(call, startedAt, {
        // A cancelled turn and a shutdown are both cancellation from the
        // caller's point of view: neither is a fault in the tool, and neither
        // is worth retrying.
        kind: this.shutdown.signal.aborted || this.turnSignal?.aborted ? 'CANCELLED' : 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error),
        detail: toJsonValue(error),
      });
    } finally {
      this.states.settle(`${tool.name} finished`);
    }
  }

  // --- internals ----------------------------------------------------------

  /**
   * Resolve risk, treating any failure as "unknown" rather than "fine".
   *
   * A tool whose `resolveRisk` throws has, by definition, not established that
   * the call is safe.
   */
  private assessRisk(tool: RegisteredTool, input: unknown): RiskAssessment {
    try {
      const assessment = tool.resolveRisk(input);
      if (!assessment || typeof assessment.level !== 'string') {
        return unknownRisk(`${tool.name} returned a malformed risk assessment`);
      }
      return assessment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unknownRisk(`${tool.name}.resolveRisk threw: ${message}`);
    }
  }

  /**
   * Ask the tool whether its preconditions still hold.
   *
   * A tool without a `precheck` passes. A `precheck` that throws does NOT:
   * a check that could not be completed has not established anything, which
   * is the same deny-by-default rule `assessRisk` applies to risk.
   */
  private precheck(tool: RegisteredTool, input: unknown): { ok: true } | { ok: false; reason: string; retryable: boolean } {
    if (!tool.precheck) return { ok: true };
    let verdict: PrecheckVerdict;
    try {
      verdict = tool.precheck(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `${tool.name} could not confirm its preconditions: ${message}`, retryable: true };
    }
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason, retryable: verdict.retryable };
  }

  /**
   * The tool's own repeat key, when it has one.
   *
   * A key that throws is treated as absent rather than fatal: the fallback is
   * the argument-based key, which is the stricter of the two, so a broken
   * `repeatKey` bounds MORE tightly rather than less.
   */
  private repeatKeyFor(tool: RegisteredTool, input: unknown): string | undefined {
    if (!tool.repeatKey) return undefined;
    try {
      return tool.repeatKey(input);
    } catch {
      return undefined;
    }
  }

  /**
   * What the tool says this call sends outward, falling back to the table in
   * `approval-binding.ts` and, failing that, to EXTERNAL.
   */
  private declaredSideEffect(tool: RegisteredTool, input: unknown): SideEffectClass {
    if (tool.sideEffect) {
      try {
        return tool.sideEffect(input);
      } catch {
        return 'EXTERNAL';
      }
    }
    return classifySideEffect(tool.name, input);
  }

  private async requestApproval(
    call: ToolCall,
    tool: RegisteredTool,
    input: unknown,
    assessment: RiskAssessment,
    effect: SideEffectClass,
    fingerprint: string,
  ): Promise<{ ok: true; fingerprint: string } | { ok: false; failure: ToolFailure }> {
    const summary = this.summarize(tool, input);
    const requestedAt = this.now();
    const binding = bindApproval({
      tool: tool.name,
      input,
      page: this.currentPage(),
      escalated: true,
    });
    const request: ApprovalRequest = {
      callId: call.callId,
      tool: tool.name,
      risk: assessment.level,
      title: summary.title,
      detail: assessment.reason,
      parameters: summary.parameters,
      // The effect the dispatcher computed wins over the binding's own guess:
      // the dispatcher knows whether the policy escalated, and the binding
      // module does not.
      binding: { ...binding, effect, fingerprint },
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + this.approvalTimeoutMs).toISOString(),
    };

    this.states.enterAwaitingApproval(summary.title);
    this.bus.emit({ type: 'APPROVAL_REQUIRED', request });

    const resolution = await this.approvals.request(request, this.approvalTimeoutMs);

    this.bus.emit({
      type: 'APPROVAL_RESOLVED',
      callId: resolution.callId,
      decision: resolution.decision,
      resolvedBy: resolution.resolvedBy,
    });

    if (resolution.decision === 'ALLOW') return { ok: true, fingerprint: request.binding.fingerprint };

    const timedOut = resolution.resolvedBy === 'timeout';
    const kind: ToolFailureKind = timedOut ? 'APPROVAL_TIMEOUT' : 'DENIED';
    return {
      ok: false,
      failure: {
        kind,
        message: timedOut
          ? `Approval for ${tool.name} was not answered in time, so it was denied.`
          : `Approval for ${tool.name} was denied.`,
        detail: { resolvedBy: resolution.resolvedBy },
      },
    };
  }

  /** A tool that cannot describe itself still has to be describable to a human. */
  private summarize(tool: RegisteredTool, input: unknown): ToolSummary {
    try {
      return tool.summarize(input);
    } catch {
      return {
        title: `Axon wants to run ${tool.name}`,
        parameters: [{ label: 'input', value: JSON.stringify(input) ?? 'unrepresentable' }],
      };
    }
  }

  private contextFor(call: ToolCall): ToolExecutionContext {
    return {
      callId: call.callId,
      signal: this.signalFor(),
      observe: (summary: string, detail?: JsonValue): void => {
        this.bus.emit({
          type: 'OBSERVATION',
          callId: call.callId,
          summary,
          detail: detail ?? null,
        });
      },
    };
  }

  /**
   * The signal handed to an executor: shutdown, or this turn's cancellation.
   *
   * `AbortSignal.any` links the two without either owning the other, so
   * clearing the turn signal cannot detach an executor from shutdown.
   */
  private signalFor(): AbortSignal {
    const turn = this.turnSignal;
    if (!turn) return this.shutdown.signal;
    return AbortSignal.any([this.shutdown.signal, turn]);
  }

  private emitCall(call: ToolCall, risk: RiskLevel, riskReason: string): void {
    this.bus.emit({
      type: 'TOOL_CALL',
      callId: call.callId,
      tool: call.tool,
      input: call.input,
      risk,
      riskReason,
    });
  }

  private fail(call: ToolCall, startedAt: number, failure: ToolFailure): ToolResult {
    const durationMs = Date.now() - startedAt;
    this.bus.emit({
      type: 'TOOL_RESULT',
      callId: call.callId,
      tool: call.tool,
      ok: false,
      durationMs,
      output: null,
      failure,
    });
    return { callId: call.callId, tool: call.tool, ok: false, failure, durationMs };
  }
}

/** Mint a call id. Used by callers that do not already have one. */
export function newCallId(): string {
  return randomUUID();
}
