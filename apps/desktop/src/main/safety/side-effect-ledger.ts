/**
 * What has already left the machine during this turn.
 *
 * IDEMPOTENCY IS NOT A PROPERTY OF THE WORLD.
 *
 * "Submit comment" is not safely repeatable, and neither is "send", "create"
 * or "pay". The failure mode is specific and easy to reach: an action
 * succeeds, its verification is ambiguous (the page reloaded, the element
 * vanished, the read timed out), the model reads that as "it didn't work" and
 * asks again. Two comments under the user's name, from one approval.
 *
 * So Axon keeps its own record. An EXTERNAL action that completed is recorded
 * by fingerprint, and an identical fingerprint later in the same turn is
 * refused with an explanation the model can act on: it already happened, go
 * and look before doing it again.
 *
 * WHY PER-TURN, AND WHY ONLY EXTERNAL.
 *
 * Per-turn because a user who asks twice, in two requests, means it twice —
 * that is a person exercising judgement, and the approval dialog is where
 * they exercise it. Only EXTERNAL because refusing a repeated *read* would
 * break the observe-act-verify loop this milestone is built on: re-reading a
 * page after acting is the whole point.
 *
 * A refusal here is not a claim that the first attempt succeeded. It is a
 * claim that it RAN, which is the only thing Axon actually knows and exactly
 * the thing that makes repeating it dangerous.
 */

import type { SideEffectClass } from '@axon/core';

interface Entry {
  readonly tool: string;
  readonly at: number;
  readonly outcome: 'succeeded' | 'attempted';
}

export class SideEffectLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Forget everything. Called when a turn begins. */
  reset(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Whether this exact outward action already ran in this turn.
   *
   * Only EXTERNAL is guarded; anything else is always allowed through.
   */
  check(effect: SideEffectClass, fingerprint: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    if (effect !== 'EXTERNAL') return { ok: true };

    const previous = this.entries.get(fingerprint);
    if (!previous) return { ok: true };

    const seconds = Math.max(1, Math.round((this.now() - previous.at) / 1000));
    return {
      ok: false,
      message:
        `Axon already ran ${previous.tool} with exactly these arguments ${seconds} second(s) ago in this request, ` +
        'and it is not an action that can be safely repeated. ' +
        'Read the page and check whether it already took effect before proposing it again. ' +
        'If it genuinely needs doing a second time, say so to the user and let them ask.',
    };
  }

  /**
   * Record that an outward action ran.
   *
   * Recorded on completion whether or not the *outcome* was a success, because
   * "the executor threw after the request left" is precisely the case where a
   * blind retry duplicates. Nothing but EXTERNAL is recorded, so the map stays
   * as small as the number of consequential things one turn did.
   */
  record(effect: SideEffectClass, fingerprint: string, tool: string, outcome: 'succeeded' | 'attempted'): void {
    if (effect !== 'EXTERNAL') return;
    if (this.entries.has(fingerprint)) return;
    this.entries.set(fingerprint, { tool, at: this.now(), outcome });
  }
}
