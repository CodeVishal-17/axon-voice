/**
 * What one agent turn is allowed to spend.
 *
 * WHY THIS IS NOT IN THE BRAIN.
 *
 * Until Step 7 the iteration and tool-call caps lived inside `ClaudeBrain`.
 * That bounded Claude, which was never the thing that needed bounding: a
 * brain that ignores its own limit is not bounded at all, and "the component
 * we are containing enforces its own containment" is the exact arrangement
 * this product exists to invert.
 *
 * So the budget lives here, and the dispatcher spends it. Every effect Axon
 * can cause crosses that boundary, so a budget checked there holds for any
 * brain — the real one, a scripted one, a future one, or one that has decided
 * to try the same thing forever.
 *
 * The brain still receives its OWN copies of the iteration limits, because a
 * loop that stops politely produces a better answer than one that runs into a
 * wall. But those are courtesy. This is the wall.
 *
 * Pure apart from a clock, which is injected.
 */

import {
  AGENT_LOOP_LIMITS,
  stableStringify,
  type BudgetVerdict,
  type TurnBudgetSnapshot,
} from '@axon/core';

export interface TurnBudgetOptions {
  readonly maxToolCalls?: number;
  readonly maxTurnMilliseconds?: number;
  readonly maxRepeatedAttempts?: number;
  readonly now?: () => number;
}

export class TurnBudget {
  private readonly maxToolCalls: number;
  private readonly maxTurnMilliseconds: number;
  private readonly maxRepeatedAttempts: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly attempts = new Map<string, number>();

  private toolCalls = 0;

  constructor(options: TurnBudgetOptions = {}) {
    this.maxToolCalls = options.maxToolCalls ?? AGENT_LOOP_LIMITS.maxToolCalls;
    this.maxTurnMilliseconds = options.maxTurnMilliseconds ?? AGENT_LOOP_LIMITS.maxTurnMilliseconds;
    this.maxRepeatedAttempts = options.maxRepeatedAttempts ?? AGENT_LOOP_LIMITS.maxRepeatedAttempts;
    this.now = options.now ?? ((): number => Date.now());
    this.startedAt = this.now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      toolCalls: this.toolCalls,
      maxToolCalls: this.maxToolCalls,
      elapsedMs: this.elapsedMs,
      maxTurnMilliseconds: this.maxTurnMilliseconds,
      exhausted: this.toolCalls >= this.maxToolCalls || this.elapsedMs >= this.maxTurnMilliseconds,
    };
  }

  /**
   * Charge one dispatch to this turn, or explain why it cannot be charged.
   *
   * Checked and spent in one call, deliberately: a separate "can I?" and
   * "I did" would let a caller check once and dispatch twice.
   *
   * Time is checked BEFORE the count. A turn that has been running for five
   * minutes should be told it has run out of time, not out of calls — the
   * message is the only diagnosis the model and the user get.
   */
  spend(tool: string, input: unknown, repeatKey?: string): BudgetVerdict {
    const elapsed = this.elapsedMs;
    if (elapsed >= this.maxTurnMilliseconds) {
      return {
        ok: false,
        breach: 'TIME',
        message:
          `This request has been running for ${Math.round(elapsed / 1000)} seconds, which is the limit. ` +
          'Stop and tell the user what you managed to do.',
      };
    }

    if (this.toolCalls >= this.maxToolCalls) {
      return {
        ok: false,
        breach: 'TOOL_CALLS',
        message:
          `Axon has run ${this.maxToolCalls} tool calls for this request, which is the limit. ` +
          'Stop and tell the user what you found.',
      };
    }

    // The repeat bound is keyed on (tool, normalized arguments) so reordered
    // keys cannot disguise a repeat as a new call — unless the tool supplied
    // its own key, which observations do so that "the same read" means "the
    // same page" rather than "the same empty argument object". See
    // `repeatKey` in the tool contract.
    const key = repeatKey === undefined ? `${tool}:${stableStringify(input)}` : `${tool}#${repeatKey}`;
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    if (attempts > this.maxRepeatedAttempts) {
      return {
        ok: false,
        breach: 'REPEATS',
        message:
          `You have already tried ${tool} with these exact arguments ${this.maxRepeatedAttempts} times. ` +
          'Repeating it will not produce a different result. Try something materially different, or stop.',
      };
    }

    // Counted only once the call is actually going through, so a refusal
    // above does not also consume the budget it just refused for.
    this.attempts.set(key, attempts);
    this.toolCalls += 1;
    return { ok: true };
  }
}
