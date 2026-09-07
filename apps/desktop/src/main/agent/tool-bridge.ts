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
 * TWO TIMING RULES THAT ARE NOT NEGOTIABLE.
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
 *    When it settles, the outcome is delivered back into the conversation as
 *    a new turn.
 *
 * The second rule is what keeps the security decision and the network request
 * independent. A dropped socket during an approval must never make the state
 * of that approval ambiguous.
 */

import {
  DEFERRED_TOOL_RESULT,
  VOICE_AGENT_LIMITS,
  type JsonValue,
  type ToolCall,
  type ToolResult,
  type ToolSchema,
} from '@axon/core';

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
   * Whether this call will need a human before it can run.
   *
   * Supplied by the session, which asks the orchestrator. Deciding it here
   * would mean a second copy of the risk policy, and a second copy of a
   * safety rule is a second answer to a question that must have one.
   */
  willRequireApproval(tool: string, input: JsonValue): boolean;
  /**
   * Deliver the outcome of a deferred action back into the conversation.
   *
   * Called after an approval settles and the action has actually run and been
   * verified. The session turns this into a spoken turn.
   */
  onDeferredOutcome(summary: string): void;
  /** Something worth showing in the timeline. */
  onNotice(summary: string): void;
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
  return JSON.stringify({
    ok: false,
    error: result.failure.message,
    errorKind: result.failure.kind,
    // The agent must not try again on its own for a settled refusal. The
    // dispatcher enforces this too — a repeat hits the duplicate guard or the
    // repeat bound — but saying so plainly produces a better spoken answer.
    retryable: result.failure.kind === 'EXECUTION_ERROR' || result.failure.kind === 'STALE_REFERENCE',
  });
}

export class ToolBridge {
  private readonly options: ToolBridgeOptions;
  private readonly pending: PendingToolResult[] = [];
  private toolCallCount = 0;
  /** Set when the session ends, so a late dispatch cannot still speak. */
  private closed = false;

  constructor(options: ToolBridgeOptions) {
    this.options = options;
  }

  /** Results collected so far this turn, and not yet flushed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
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

    // The provider's `arguments` object is arbitrary. It is passed through
    // as-is: the dispatcher validates it against the tool's Zod schema, and a
    // second, weaker check here would be a liability rather than a safeguard.
    const input = (args ?? {}) as JsonValue;

    // --- The approval fork ------------------------------------------------
    if (this.options.willRequireApproval(name, input)) {
      // Answer NOW, truthfully, and let the conversation continue. The action
      // has not run and this result does not say it has.
      this.queue(callId, {
        ...DEFERRED_TOOL_RESULT,
        message:
          'This action needs the user to approve it. Axon is asking them now. ' +
          'Do not repeat this call and do not say it is done — you will be told the outcome.',
      });
      this.options.onNotice('Waiting for you to approve an action Axon proposed');
      // Dispatched WITHOUT awaiting the queue: the approval runs on Axon's
      // clock and the conversation is not blocked on a person reading a
      // dialog. `void` is deliberate and the promise cannot reject.
      void this.runDeferred(name, input);
      return;
    }

    // --- Ordinary path ----------------------------------------------------
    const result = await this.dispatchSafely(name, input);
    this.pending.push({ callId, result: toAgentResult(result) });
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
    return status === 'interrupted' ? [] : results;
  }

  // --- internals ----------------------------------------------------------

  /**
   * Run an approval-gated action to completion, then speak the outcome.
   *
   * Everything about the approval — the dialog, the binding, the expiry, the
   * cancellation — is the dispatcher's, unchanged. This method only waits for
   * it and reports what happened.
   */
  private async runDeferred(name: string, input: JsonValue): Promise<void> {
    const result = await this.dispatchSafely(name, input);
    if (this.closed) return;

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
  private async dispatchSafely(name: string, input: JsonValue): Promise<ToolResult> {
    const callId = this.options.newCallId();
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

  private queue(callId: string, body: Record<string, unknown>): void {
    this.pending.push({ callId, result: JSON.stringify(body) });
  }
}

/** Keep a spoken summary to something a person would actually listen to. */
function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
