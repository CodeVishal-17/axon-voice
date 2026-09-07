/**
 * Pending human decisions.
 *
 * The broker turns "a human must answer this" into a promise the dispatcher
 * can await. Two properties matter:
 *
 * - Every request has a deadline. An approval nobody answers resolves to DENY,
 *   never to ALLOW and never to a hang.
 * - Shutdown denies everything outstanding, so a quit can never race an
 *   approval into execution.
 * - An ALLOW must name what it is allowing. From Step 7 the caller may echo
 *   back the fingerprint it was shown, and a mismatch is treated as an answer
 *   to a question that is no longer on screen: refused, not applied. A DENY
 *   is never refused for this reason — "no" is a safe answer to any question.
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalResolution, ApprovalResolvedBy } from '@axon/core';

interface Pending {
  readonly request: ApprovalRequest;
  readonly settle: (resolution: ApprovalResolution) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Requests still awaiting an answer, for the renderer's snapshot. */
  list(): readonly ApprovalRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.request);
  }

  has(callId: string): boolean {
    return this.pending.has(callId);
  }

  request(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResolution> {
    if (this.pending.has(request.callId)) {
      // Two approvals for one call id would make the resolution ambiguous.
      return Promise.resolve(this.denial(request.callId, 'shutdown'));
    }

    return new Promise<ApprovalResolution>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(request.callId, 'DENY', 'timeout');
      }, timeoutMs);

      // Do not let a pending approval hold the process open at exit.
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(request.callId, { request, settle: resolve, timer });
    });
  }

  /**
   * Answer a pending request. Returns false if there was nothing to answer.
   *
   * `fingerprint` is what the answerer believes it is answering about. When
   * supplied it must match the pending request's binding, or the ALLOW is
   * discarded — the dialog the user acted on described a different act, and
   * an approval for one act is not an approval for another.
   *
   * Omitting it is allowed and means "I did not check": that is the timeout
   * path and the shutdown path, both of which only ever DENY.
   */
  settle(
    callId: string,
    decision: ApprovalDecision,
    resolvedBy: ApprovalResolvedBy,
    fingerprint?: string,
  ): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;

    if (
      decision === 'ALLOW' &&
      fingerprint !== undefined &&
      fingerprint !== entry.request.binding.fingerprint
    ) {
      // Left pending deliberately. The request has not been answered, its
      // deadline still runs, and it will deny itself if nobody answers the
      // question that is actually on screen.
      return false;
    }

    clearTimeout(entry.timer);
    this.pending.delete(callId);
    entry.settle({ callId, decision, resolvedBy, at: this.now().toISOString() });
    return true;
  }

  /** Deny everything outstanding. Called on shutdown. */
  denyAll(resolvedBy: ApprovalResolvedBy = 'shutdown'): void {
    for (const callId of Array.from(this.pending.keys())) {
      this.settle(callId, 'DENY', resolvedBy);
    }
  }

  private denial(callId: string, resolvedBy: ApprovalResolvedBy): ApprovalResolution {
    return { callId, decision: 'DENY', resolvedBy, at: this.now().toISOString() };
  }
}
