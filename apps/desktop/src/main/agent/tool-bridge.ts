/**
 * From a spoken proposal to an effect, or not.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE.
 *
 * A `tool.call` from the voice provider is a REQUEST, arriving over a socket,
 * from a model Axon does not trust, quite possibly influenced by a web page
 * Axon trusts even less. It reaches the world through exactly the same door
 * every other proposal uses:
 *
 *     tool.call -> ToolCall -> Dispatcher -> schema -> precheck -> budget
 *               -> risk -> policy -> duplicate -> approval -> re-bind
 *               -> execute -> observe -> verify -> ToolResult -> tool.result
 *
 * There is no second pipeline, no fast path and no privileged variant. This
 * module holds a `dispatch` callback and nothing else — it cannot reach an
 * executor, cannot resolve risk, cannot raise or settle an approval, and
 * cannot emit a TOOL_CALL or TOOL_RESULT event. It is exactly as powerful as
 * `ClaudeBrain`, which is to say not at all.
 *
 * FOUR TIMING RULES THAT ARE NOT NEGOTIABLE.
 *
 * 1. RESULTS GO BACK ON `reply.done`, NOT WHEN THEY FINISH. The protocol says
 *    so: sending a `tool.result` mid-turn confuses the agent's turn-taking.
 *    Results are collected here and flushed by the session when the turn
 *    closes. A turn that ends `interrupted` — the user talked over it —
 *    discards them, because the agent has already abandoned that reply.
 *
 * 2. AN APPROVAL IS NEVER HELD OPEN ON THE WIRE. See `DEFERRED_TOOL_RESULT` in
 *    core. A tool needing a human is answered immediately and truthfully —
 *    "this has not run, the user is being asked" — and the approval then
 *    proceeds on Axon's clock, under Axon's expiry and cancellation rules,
 *    with no network request depending on how long a person takes to read.
 *
 * 3. A SLOW TOOL IS ANSWERED "IN PROGRESS", NOT LEFT UNANSWERED. See
 *    `IN_PROGRESS_TOOL_RESULT`. This is Phase 3's correction of a real live
 *    failure, and it is worth stating exactly:
 *
 *      A tool slower than `TASK_LIMITS.inlineBudgetMs` used to leave the agent
 *      composing a reply with nothing in hand. It filled the gap by GUESSING,
 *      and it guessed failure — "GitHub did not load" about a page on the
 *      user's screen, "I could not capture a screenshot" about a capture that
 *      had succeeded. When the real result arrived Axon corrected itself, so
 *      one action produced two contradictory sentences.
 *
 *      The fix is not a better guess and it is not a longer wait. It is to
 *      make the intermediate state SAYABLE. The agent is told, truthfully,
 *      that the work is under way and that there is no outcome yet; it
 *      acknowledges briefly; and the outcome, when it arrives, is the first
 *      statement anybody makes about what happened. There is nothing to
 *      contradict because nothing was claimed.
 *
 *      And when the work finishes before the flush anyway, the in-progress
 *      answer is REPLACED by the real one and the user hears a single
 *      sentence. The intermediate state is a fallback, not a ceremony.
 *
 * 4. A RESULT IS DELIVERED ONLY IF ITS TASK STILL WANTS IT. Cancellation and a
 *    change of subject both end a task, and a result that arrives afterwards
 *    belongs to an intention that no longer exists. Delivering it would let a
 *    cancelled action speak, and — worse — prompt the next step of work the
 *    user had abandoned. Every delivery path below asks the ledger first.
 *
 * Rule 2 is what keeps the security decision and the network request
 * independent: a dropped socket during an approval must never make the state
 * of that approval ambiguous. Rules 3 and 4 are what keep Axon's account of
 * what happened, and what actually happened, from drifting apart.
 */

import {
  DEFERRED_TOOL_RESULT,
  FAILURE_GUIDANCE,
  IN_PROGRESS_TOOL_RESULT,
  TASK_LIMITS,
  describeProgress,
  VOICE_AGENT_LIMITS,
  type JsonValue,
  type ToolCall,
  type ToolResult,
  type ToolSchema,
} from '@axon/core';
import type { StepHandle, TaskLedger } from './task-ledger.js';

/** One result waiting for `reply.done`. */
export interface PendingToolResult {
  readonly callId: string;
  /** The JSON-encoded string the protocol requires in `tool.result`. */
  readonly result: string;
}

export interface ToolBridgeOptions {
  /** The dispatcher, bound by the orchestrator. The only authority here. */
  dispatch(call: ToolCall): Promise<ToolResult>;
  /** The tools actually registered. A name outside this is refused locally. */
  readonly tools: readonly ToolSchema[];
  /** Mints Axon call ids. Injected so tests are deterministic. */
  readonly newCallId: () => string;
  /**
   * What Axon is currently doing, and whether it still wants each result.
   *
   * Held rather than reimplemented: "is this still wanted?" must have one
   * answer, and the orchestrator's cancellation writes to the same object.
   */
  readonly tasks: TaskLedger;
  /**
   * Whether this call will need a human before it can run.
   *
   * Supplied by the session, which asks the orchestrator. Deciding it here
   * would mean a second copy of the risk policy, and a second copy of a
   * safety rule is a second answer to a question that must have one.
   */
  willRequireApproval(tool: string, input: JsonValue): boolean;
  /**
   * One line describing the act a pending approval is about.
   *
   * Optional: a bridge without it says "Axon is asking the user", which is
   * true but not useful. With it, the agent can say WHAT is being asked
   * about and WHERE it lands — the sentence a person can actually answer
   * without looking at the screen.
   */
  describeApproval?(tool: string, input: JsonValue): string | null;
  /**
   * Put an outcome back into the conversation as a new spoken turn.
   *
   * Used for an approval that has settled, and for a slow tool whose result
   * arrived after its turn closed. In both cases the tool call itself was
   * answered long ago and re-answering it would be a protocol violation.
   */
  onDeferredOutcome(summary: string): void;
  /**
   * Send a tool result the flush has already gone without.
   *
   * The turn had closed by the time the tool finished, so there is no flush
   * left to carry it. Sending it now is not a mid-turn result — the turn has
   * ended — and it is what stops the agent's picture of the world diverging
   * from what actually happened.
   */
  onLateResult(pending: PendingToolResult): void;
  /** Something worth showing in the timeline. */
  onNotice(summary: string): void;
  /** Injected in tests so the inline budget can be pinned. */
  readonly inlineBudgetMs?: number;
}

/**
 * How a `ToolResult` is described back to the voice agent.
 *
 * Deliberately NOT `serializeToolResult` from the brain layer. That one is
 * tuned for a text model reading JSON in a tool_result block; this one is read
 * by a model that is about to say something out loud, so it is smaller and its
 * error text is a sentence. What both share is the important property: a
 * failure is DATA the model can react to, never an exception thrown into a
 * loop it cannot catch.
 */
export function toAgentResult(result: ToolResult): string {
  if (result.ok) {
    return JSON.stringify({ ok: true, output: result.output });
  }

  // A request that was understood but was not specific enough is not a
  // failure, and saying so is what turns "I could not do that" into "which
  // one?". See `CLARIFICATION_NEEDED` in the tool contract.
  const needsClarification = result.failure.kind === 'CLARIFICATION_NEEDED';

  return JSON.stringify({
    ok: false,
    error: result.failure.message,
    errorKind: result.failure.kind,
    // What to SAY about this kind of failure, from the table the typed brain
    // reads too. Added because a real session narrated nearly every failure
    // as "it timed out" — most were a spent budget, one was a stale page —
    // and a model handed only a kind name and a message guessed. The
    // guidance for BUDGET_EXCEEDED and EXECUTION_ERROR says in so many words
    // that they are not timeouts; only TIMEOUT is.
    guidance: FAILURE_GUIDANCE[result.failure.kind].say,
    ...(needsClarification
      ? {
          needsClarification: true,
          instruction:
            'Do not apologise and do not say you failed. Ask the user the question in that message, ' +
            'in one short sentence, and wait for their answer.',
        }
      : {}),
    // The agent must not try again on its own for a settled refusal. The
    // dispatcher enforces this too — a repeat hits the duplicate guard or the
    // repeat bound — but saying so plainly produces a better spoken answer.
    // From the shared table, so this cannot drift from the typed brain's
    // answer. For every kind that existed before it is exactly what this line
    // used to compute; TIMEOUT is the one new kind worth a second attempt.
    retryable: FAILURE_GUIDANCE[result.failure.kind].retryable,
  });
}

/** Provider call ids remembered for duplicate detection. A bound on memory. */
const MAX_ANSWERED_CALLS = 200;

/**
 * Did the tool look, and what did it see?
 *
 * Tools report verification in their own vocabulary, because the words belong
 * to the act: a browser navigation says whether the page `changed`, and an
 * application launch says whether a window `opened`. Both mean "Axon checked
 * rather than assumed", and reading only one of them recorded a verified
 * launch as unverified in the timeline and the demo recording — which is a
 * lie about the safest thing Axon does.
 *
 * `null` is a third answer and it is the important one: the tool does not
 * verify at all. Collapsing that into `false` would make "did not check" and
 * "checked and it had not happened" indistinguishable.
 */
function readVerified(verified: Record<string, unknown> | undefined): boolean | null {
  if (!verified || typeof verified !== 'object') return null;
  for (const key of ['changed', 'opened']) {
    const value = verified[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export class ToolBridge {
  private readonly options: ToolBridgeOptions;
  private readonly inlineBudgetMs: number;
  private readonly pending: PendingToolResult[] = [];
  private toolCallCount = 0;
  /** Set when the session ends, so a late dispatch cannot still speak. */
  private closed = false;

  /**
   * Whether the agent's reply turn is still open.
   *
   * Opened by a `tool.call` and closed by the `reply.done` that flushes. A
   * result finishing while it is open is queued; one finishing after it is
   * sent immediately, because there is no flush left to carry it.
   */
  private turnOpen = false;

  /**
   * Whether the turn that just closed was interrupted.
   *
   * An interrupted turn discards its results — the agent abandoned that reply
   * — and that has to hold for the late ones too, or a user who talked over
   * Axon would hear the answer to the thing they interrupted.
   */
  private turnInterrupted = false;

  /**
   * What each provider call id was already answered with.
   *
   * THE DUPLICATE GATE FOR THE WIRE, distinct from the dispatcher's ledger for
   * the world. The dispatcher stops the same outward ACTION happening twice;
   * this stops the same REQUEST being executed twice at all — a provider
   * retry, a reconnect that replays, a model that emits the same call id
   * again. Answering from the record is both safer and more truthful than
   * re-running: the second call would otherwise hit the duplicate guard and be
   * reported as a failure, when what actually happened is that it succeeded
   * once.
   */
  private readonly answered = new Map<string, { readonly tool: string; readonly result: string }>();

  /** Provider call ids whose work is still running, so a retry can wait. */
  private readonly inFlight = new Set<string>();

  constructor(options: ToolBridgeOptions) {
    this.options = options;
    this.inlineBudgetMs = options.inlineBudgetMs ?? TASK_LIMITS.inlineBudgetMs;
  }

  /** Results collected so far this turn, and not yet flushed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.answered.clear();
    this.inFlight.clear();
  }

  /**
   * Handle one `tool.call` from the provider.
   *
   * Returns nothing: the result is queued for `reply.done`. Never throws — a
   * rejection here would escape into a socket message handler, and an
   * unhandled rejection in the main process is how an Electron app dies.
   */
  async handleToolCall(callId: string, name: string, args: unknown): Promise<void> {
    if (this.closed) return;
    // A tool call belongs to a reply the agent is composing, so the turn is
    // open from here until the `reply.done` that flushes.
    this.turnOpen = true;
    this.turnInterrupted = false;

    // --- Already answered? -----------------------------------------------
    // Before anything else, and before the budget: a retry of a call Axon has
    // already run is not a second request and must not be counted, dispatched
    // or executed as one.
    const previous = this.answered.get(callId);
    // The RECORDED TOOL has to match. A call id reused for a different tool is
    // not a retry — it is either a confused provider or an attempt to be
    // handed one tool's answer in another's name. Either way the honest thing
    // is to treat it as a new request, which means dispatching it and gating
    // it like any other rather than replaying something it did not ask for.
    if (previous !== undefined && previous.tool === name) {
      this.options.onNotice('The voice service repeated a request Axon had already carried out');
      this.pending.push({ callId, result: previous.result });
      return;
    }
    if (this.inFlight.has(callId)) {
      // The same call, still running. Answering "in progress" is truthful and
      // costs nothing; dispatching it again would run it twice.
      this.queue(callId, {
        ...IN_PROGRESS_TOOL_RESULT,
        message: 'Axon is already doing this. Do not ask again; you will be told the outcome.',
      });
      return;
    }

    // --- Bounds ----------------------------------------------------------
    if (this.toolCallCount >= VOICE_AGENT_LIMITS.maxToolCallsPerSession) {
      this.queue(callId, {
        ok: false,
        error: 'This conversation has run too many actions. Tell the user what you have done and stop.',
        errorKind: 'BUDGET_EXCEEDED',
        retryable: false,
      });
      return;
    }
    this.toolCallCount += 1;

    // --- Is this even a tool? --------------------------------------------
    // The dispatcher would refuse an unknown name anyway, and does so with a
    // TOOL_CALL/TOOL_RESULT pair in the timeline. Refusing here as well keeps
    // a hallucinated name out of the event stream, where it would read as
    // though Axon had attempted something.
    if (!this.options.tools.some((tool) => tool.name === name)) {
      this.queue(callId, {
        ok: false,
        error: `There is no tool called "${String(name).slice(0, 60)}". Use only the tools you were given.`,
        errorKind: 'UNKNOWN_TOOL',
        retryable: false,
      });
      return;
    }

    // --- Is anybody still asking for this? -------------------------------
    // A step can only be opened against an ACTIVE task. A cancelled one, a
    // superseded one, or one that has run out of steps returns null — and
    // that refusal is what stops a model carrying on with work the user has
    // already stopped.
    const step = this.options.tasks.beginStep(name);
    if (!step) {
      this.queue(callId, {
        ok: false,
        error:
          'That request is no longer active — the user stopped it or asked for something else. ' +
          'Do not carry on with it. Wait for what they say next.',
        errorKind: 'CANCELLED',
        retryable: false,
      }, name);
      return;
    }

    // The provider's `arguments` object is arbitrary. It is passed through
    // as-is: the dispatcher validates it against the tool's Zod schema, and a
    // second, weaker check here would be a liability rather than a safeguard.
    const input = (args ?? {}) as JsonValue;

    // --- The approval fork ------------------------------------------------
    if (this.options.willRequireApproval(name, input)) {
      // Answer NOW, truthfully, and let the conversation continue. The action
      // has not run and this result does not say it has.
      // WHAT and WHERE, when the dispatcher can describe it. The description
      // is Axon's own — the same `summarize` the dialog renders — so what the
      // user hears and what they read cannot disagree. It can contain a label
      // taken from a page, which is untrusted text; it arrives here as the
      // subject of a question, never as an instruction.
      const asking = this.options.describeApproval?.(name, input) ?? null;
      this.queue(callId, {
        ...DEFERRED_TOOL_RESULT,
        message: asking
          ? `${asking}. Axon is asking the user to approve it right now. Say what it is asking ` +
            'about, briefly, in your own words, and stop. Do not repeat this call and do not say ' +
            'it is done — you will be told the outcome.'
          : 'This action needs the user to approve it. Axon is asking them now. ' +
            'Do not repeat this call and do not say it is done — you will be told the outcome.',
      });
      this.options.onNotice('Waiting for you to approve an action Axon proposed');
      this.options.tasks.endStep(step, 'AWAITING_APPROVAL', { approval: 'requested' });
      // Dispatched WITHOUT awaiting the queue: the approval runs on Axon's
      // clock and the conversation is not blocked on a person reading a
      // dialog. `void` is deliberate and the promise cannot reject.
      void this.runDeferred(step, callId, name, input);
      return;
    }

    // --- Ordinary path, raced against the inline budget -------------------
    await this.runBounded(step, callId, name, input);
  }

  /**
   * Flush collected results.
   *
   * `interrupted` discards them: the agent abandoned that reply when the user
   * spoke over it, and answering a turn that no longer exists desynchronises
   * the conversation.
   */
  flush(status: string): readonly PendingToolResult[] {
    const results = [...this.pending];
    this.pending.length = 0;
    // The turn is over. Anything still running now has no flush to come, so
    // it goes out on its own — see `deliver`.
    this.turnOpen = false;
    this.turnInterrupted = status === 'interrupted';
    return this.turnInterrupted ? [] : results;
  }

  // --- internals ----------------------------------------------------------

  /**
   * Run a tool, answering within the inline budget whatever happens.
   *
   * The whole of rule 3. There are exactly two shapes:
   *
   *   FAST  the work finished in time, and its real result is the answer. One
   *         turn, one sentence, nothing to correct.
   *
   *   SLOW  the budget passed first, so the call is answered "in progress" and
   *         the outcome follows as its own turn. If the work then finishes
   *         before the flush, the in-progress answer is REPLACED and the user
   *         still hears one sentence.
   *
   * Never throws, and always answers: an unanswered `tool.call` is a turn the
   * agent has to guess its way out of, which is the failure this exists to end.
   */
  private async runBounded(step: StepHandle, callId: string, name: string, input: JsonValue): Promise<void> {
    this.inFlight.add(callId);
    const work = this.dispatchSafely(name, input, step);

    // A marker object rather than a rejection: a deadline is not an error, and
    // shaping it as one would mean catching it somewhere that also catches
    // real failures.
    const deadline = Symbol('inline-budget');
    const raced = await Promise.race([
      work,
      new Promise<typeof deadline>((resolve) => {
        const timer = setTimeout(() => resolve(deadline), this.inlineBudgetMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    if (raced !== deadline) {
      // --- FAST ----------------------------------------------------------
      this.inFlight.delete(callId);
      if (this.closed) return;
      this.settleStep(step, raced);
      this.deliver({ callId, result: toAgentResult(raced) }, name, raced, step);
      return;
    }

    // --- SLOW -------------------------------------------------------------
    // Answer the call so the agent is never composing a reply with nothing in
    // hand, and say plainly that there is no outcome yet.
    //
    // AXON SUPPLIES THE WORDS. "Opening YouTube" is a statement of INTENT,
    // derived by Axon from the tool and its arguments, and it is safe to say
    // before anything has happened — unlike "YouTube is open", which is a
    // claim about the world and has to wait for verification. Handing the
    // phrasing over rather than leaving the agent to invent one is what stops
    // an acknowledgement quietly becoming an announcement.
    const intent = describeProgress(name, input);
    const inProgress = {
      ...IN_PROGRESS_TOOL_RESULT,
      ...(intent ? { doing: intent } : {}),
      message:
        (intent
          ? `Axon is doing this now: ${intent.toLowerCase()}. Say exactly that and nothing more — ` +
            `"${intent}." — then stop. `
          : 'Axon is doing this now. Acknowledge in at most a few words — "One moment." — then stop. ') +
        'There is NO outcome yet, so do not say it worked and do not say it failed. ' +
        'You will be told what happened as soon as Axon knows.',
    };
    // The reply may already have finished — reply.done can land before the
    // budget does. Queued then, this answer waits for a flush that is not
    // coming, and the provider's tool timeout speaks for Axon instead ("could
    // not read", about a read that then succeeded). So it goes out now.
    if (this.turnOpen) this.queue(callId, inProgress);
    else if (!this.turnInterrupted) this.options.onLateResult({ callId, result: JSON.stringify(inProgress) });
    this.options.onNotice(intent ?? `Working on ${name}`);

    const result = await work;
    this.inFlight.delete(callId);
    if (this.closed) return;
    this.settleStep(step, result);

    // Did the work finish before the flush after all? Then the user never has
    // to hear the intermediate state: replace it and let the single answer go
    // out on the flush that was coming anyway.
    if (this.turnOpen && this.replaceQueued(callId, name, toAgentResult(result))) return;

    if (!this.wanted(step, name)) return;

    // Otherwise the outcome is a turn of its own — and it is the FIRST thing
    // said about this action, so there is nothing to contradict.
    this.options.onDeferredOutcome(this.describeOutcome(name, result));
  }

  /**
   * Route a finished result to wherever it can still be received.
   *
   * One place, so there is one answer to "where does a result go?" rather than
   * one at each call site.
   */
  private deliver(entry: PendingToolResult, tool: string, result: ToolResult, step: StepHandle): void {
    this.answered.set(entry.callId, { tool, result: entry.result });
    this.rememberBounded();

    if (this.turnOpen) {
      this.pending.push(entry);
      return;
    }

    // The turn closed while this was running. An interrupted turn discards, as
    // it always has; anything else is sent straight away.
    if (this.turnInterrupted) return;
    if (!this.wanted(step, tool)) return;

    this.options.onLateResult(entry);
    // The agent composed its reply without this, so it spoke without knowing.
    // Telling it the outcome now is what stops that reply standing as Axon's
    // account of what happened.
    this.options.onDeferredOutcome(this.describeOutcome(tool, result));
  }

  /**
   * Is this result still wanted, and say so in the timeline when it is not.
   *
   * The whole of rule 4. A cancelled or superseded task never wants anything:
   * delivering it would let abandoned work speak, and would hand the model a
   * result it could use to justify the next step of something the user
   * already stopped.
   */
  private wanted(step: StepHandle, tool: string): boolean {
    if (this.options.tasks.wants(step.taskId)) return true;
    this.options.onNotice(
      this.options.tasks.wasCancelled(step.taskId)
        ? `${tool} finished after you stopped it, so Axon did not act on the result`
        : `${tool} finished after you had moved on, so Axon did not act on the result`,
    );
    return false;
  }

  /** Record how a step ended, from the result rather than from optimism. */
  private settleStep(step: StepHandle, result: ToolResult): void {
    if (result.ok) {
      const output = result.output as { verified?: Record<string, unknown> } | null;
      const verified = output && typeof output === 'object' ? readVerified(output.verified) : null;
      this.options.tasks.endStep(step, 'SUCCEEDED', { approval: 'not-required', verified, callId: result.callId });
      this.ground(step.tool, result);
      return;
    }

    // A question Axon asked is remembered, so the next thing the user says is
    // understood as the ANSWER rather than as a new request that would
    // supersede the task the question was about.
    if (result.failure.kind === 'CLARIFICATION_NEEDED') {
      this.options.tasks.awaitClarification(result.failure.message);
    }

    this.options.tasks.endStep(
      step,
      result.failure.kind === 'CANCELLED' ? 'CANCELLED' : result.failure.kind === 'DENIED' ? 'DENIED' : 'FAILED',
      { approval: result.failure.kind === 'DENIED' ? 'denied' : 'not-required', callId: result.callId },
    );
  }

  /**
   * Record what Axon SAW, from a result Axon produced.
   *
   * Only fields the executors themselves wrote — the URL the browser read
   * back, the window the accessibility layer reported, the control Axon
   * activated. Nothing here comes from the model's arguments, so a reference
   * later resolved against this grounding is resolved against an observation
   * rather than against an intention.
   */
  private ground(tool: string, result: Extract<ToolResult, { ok: true }>): void {
    const output = (result.output ?? {}) as Record<string, unknown>;

    if (typeof output.url === 'string' && output.url !== '') {
      this.options.tasks.observed({ page: output.url });
    } else if (typeof output.foregroundWindow === 'string' && output.foregroundWindow !== '') {
      this.options.tasks.observed({ page: output.foregroundWindow });
    }

    const verified = output.verified as { window?: unknown; summary?: unknown } | undefined;
    if (verified && typeof verified.window === 'string' && verified.window !== '') {
      this.options.tasks.observed({ page: verified.window });
    }

    // What was acted on, as Axon described it at the time. Used for "that one"
    // and "go back to it", and for nothing that grants anything.
    if (tool === 'browser.click' || tool === 'ui.click' || tool === 'app.focus') {
      const summary = verified && typeof verified.summary === 'string' ? verified.summary : null;
      if (summary) this.options.tasks.observed({ actedOn: summary.slice(0, 160) });
    }
  }

  /**
   * The facts of the task, attached to whatever Axon is about to say.
   *
   * GROUNDING, NOT AUTHORITY. It tells the model which page actually loaded
   * and what actually got clicked, so "search there" has something real to
   * mean. It authorises nothing, and every action the model proposes off the
   * back of it goes through the same gates as one proposed from nothing.
   */
  private contextLine(): string {
    const context = this.options.tasks.context();
    if (!context) return '';

    const parts: string[] = [];
    if (context.currentPage) parts.push(`on ${context.currentPage}`);
    if (context.lastActedOn) parts.push(`last action: ${context.lastActedOn}`);
    if (parts.length === 0) return '';

    return ` Where things stand: ${parts.join('; ')}.`;
  }

  /**
   * What to say about a finished action, as an instruction to the agent.
   *
   * Never "correct yourself": with the in-progress answer in place, the agent
   * has not claimed an outcome, so there is nothing to retract. It is being
   * told the answer for the first time.
   */
  private describeOutcome(tool: string, result: ToolResult): string {
    if (result.ok) {
      return (
        `${tool} finished and it SUCCEEDED. Result: ${truncate(JSON.stringify(result.output))}. ` +
        'Tell the user what happened now, in one short sentence, based only on that result. ' +
        'Read any "verified" or "navigation" field before you speak. Do not mention timing or how the ' +
        `result reached you.${this.contextLine()}`
      );
    }

    if (result.failure.kind === 'CLARIFICATION_NEEDED') {
      return (
        `${tool} could not be carried out because the request was ambiguous: ${truncate(result.failure.message)} ` +
        'Ask the user that question, as briefly as it can be asked — "Which one?" is usually the whole of it. ' +
        `Do not apologise, do not say it failed, and do not explain the mechanism.${this.contextLine()}`
      );
    }

    return (
      `${tool} finished and it did NOT succeed: ${truncate(result.failure.message)} ` +
      'Say so plainly in one short sentence and stop. Do not try again on your own.'
    );
  }

  /**
   * Run an approval-gated action to completion, then speak the outcome.
   *
   * Everything about the approval — the dialog, the binding, the expiry, the
   * cancellation — is the dispatcher's, unchanged. This method only waits for
   * it and reports what happened.
   */
  private async runDeferred(step: StepHandle, callId: string, name: string, input: JsonValue): Promise<void> {
    this.inFlight.add(callId);
    const result = await this.dispatchSafely(name, input, step);
    this.inFlight.delete(callId);
    if (this.closed) return;

    this.options.tasks.endStep(step, result.ok ? 'SUCCEEDED' : result.failure.kind === 'DENIED' ? 'DENIED' : 'FAILED', {
      approval: result.ok ? 'allowed' : result.failure.kind === 'DENIED' ? 'denied' : 'requested',
      callId: result.callId,
    });

    // NOT sent as a `tool.result`: that call was answered as pending long ago,
    // and re-answering it would be a protocol violation. The outcome comes
    // back as a new turn, which is what it actually is.
    if (!this.wanted(step, name)) return;

    if (result.ok) {
      this.options.onDeferredOutcome(
        `The user approved it and Axon carried it out. Result: ${truncate(JSON.stringify(result.output))}. ` +
          'Tell them briefly what happened, based only on that result.',
      );
      return;
    }

    // A denial, a timeout, a cancellation and a genuine failure are four
    // different things to say out loud, and the agent needs the difference.
    const failure = result.failure;
    const spoken =
      failure.kind === 'DENIED'
        ? 'The user denied it, so nothing was done. Acknowledge that briefly and do not ask again.'
        : failure.kind === 'APPROVAL_TIMEOUT'
          ? 'The approval was not answered in time, so it was denied by default and nothing was done.'
          : failure.kind === 'CANCELLED'
            ? 'The user cancelled before it ran, so nothing was done.'
            : `It could not be done: ${truncate(failure.message)}`;

    this.options.onDeferredOutcome(spoken);
  }

  /**
   * Dispatch, converting any escape into a structured failure.
   *
   * The dispatcher is written not to throw; this is belt and braces, because
   * the caller is a socket event handler and there is nothing above it to
   * catch an exception.
   */
  private async dispatchSafely(name: string, input: JsonValue, step?: StepHandle): Promise<ToolResult> {
    const callId = this.options.newCallId();
    // Recorded before the dispatch, so every event this call produces can be
    // joined to the step exactly rather than by ordering. See
    // `TaskLedger.linkCall`.
    if (step) this.options.tasks.linkCall(step, callId);
    try {
      return await this.options.dispatch({ callId, tool: name, input });
    } catch (error) {
      return {
        callId,
        tool: name,
        ok: false,
        failure: {
          kind: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'The action failed.',
          detail: null,
        },
        durationMs: 0,
      };
    }
  }

  private queue(callId: string, body: Record<string, unknown>, tool = ''): void {
    const encoded = JSON.stringify(body);
    // An in-progress answer is provisional and must NOT be remembered as this
    // call's answer: a retry arriving later should get the real outcome, not a
    // frozen "working on it".
    if (body.status !== IN_PROGRESS_TOOL_RESULT.status) {
      this.answered.set(callId, { tool, result: encoded });
      this.rememberBounded();
    }
    this.pending.push({ callId, result: encoded });
  }

  /**
   * Swap a queued answer for a better one, if it has not been flushed yet.
   *
   * Returns false when there is nothing to replace, which means the flush has
   * already gone and the outcome has to travel as its own turn.
   */
  private replaceQueued(callId: string, tool: string, result: string): boolean {
    const index = this.pending.findIndex((entry) => entry.callId === callId);
    if (index === -1) return false;
    this.pending[index] = { callId, result };
    this.answered.set(callId, { tool, result });
    this.rememberBounded();
    return true;
  }

  /** Keep the duplicate record from growing without bound in a long session. */
  private rememberBounded(): void {
    while (this.answered.size > MAX_ANSWERED_CALLS) {
      const oldest = this.answered.keys().next().value;
      if (oldest === undefined) return;
      this.answered.delete(oldest);
    }
  }
}

/** Keep a spoken summary to something a person would actually listen to. */
function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
