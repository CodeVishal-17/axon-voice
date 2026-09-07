/**
 * Human-in-the-loop approval contracts.
 *
 * An approval request is a *rendering-ready* description of a pending action.
 * The renderer is sandboxed and holds no tool knowledge, so everything the
 * user needs to make the decision has to be in this object.
 *
 * STEP 7 ADDED BINDING. An approval used to be identified by a call id alone,
 * which answers "which pending question is this an answer to?" but not "is the
 * thing about to run the thing that was described?". Those come apart the
 * moment anything between the dialog and the executor can change — a retry
 * that reuses a call id, a refactor that re-reads arguments after the await, a
 * renderer holding a stale dialog. `ApprovalBinding` closes that: the
 * fingerprint is computed from the normalized arguments, shown with the
 * request, echoed back with the decision, and re-checked immediately before
 * execution. A mismatch is a refusal, not a warning.
 */

import type { RiskLevel } from './risk.js';
import type { SideEffectClass } from './agent.js';

export const APPROVAL_DECISIONS = ['ALLOW', 'DENY'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** How a pending approval came to be resolved. Only 'user' is a real yes. */
export type ApprovalResolvedBy = 'user' | 'timeout' | 'shutdown';

export interface ApprovalParameter {
  readonly label: string;
  readonly value: string;
}

/**
 * What, exactly, the user is being asked to authorise.
 *
 * The fingerprint is the load-bearing field. Everything else here is for the
 * human: `action` and `target` are how the dialog and the log describe the
 * act, and `effect` is why it needed asking about at all.
 */
export interface ApprovalBinding {
  readonly tool: string;
  /** Short verb phrase: "submit a comment", "write a file". */
  readonly action: string;
  /** Where it lands — a URL, a path. Never a credential. */
  readonly target: string | null;
  readonly effect: SideEffectClass;
  /**
   * Digest of (tool, normalized arguments).
   *
   * An approval authorises THIS call and nothing else. Not the tool, not the
   * site, not "GitHub actions from now on".
   */
  readonly fingerprint: string;
}

export interface ApprovalRequest {
  readonly callId: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  /** Short imperative line, e.g. "Axon wants to write a file". */
  readonly title: string;
  /** Why this needs approval — comes from the RiskAssessment reason. */
  readonly detail: string;
  /** The concrete arguments, already stringified for display. */
  readonly parameters: readonly ApprovalParameter[];
  /** What this approval authorises, and nothing more. */
  readonly binding: ApprovalBinding;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface ApprovalResolution {
  readonly callId: string;
  readonly decision: ApprovalDecision;
  readonly resolvedBy: ApprovalResolvedBy;
  readonly at: string;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}
