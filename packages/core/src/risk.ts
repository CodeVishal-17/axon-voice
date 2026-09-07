/**
 * Risk classification for tool actions.
 *
 * Risk is resolved per call from the *actual arguments*, never declared once
 * per tool. `fs.write` into the agent workspace and `fs.write` into System32
 * are the same tool and completely different acts, so a static label on the
 * tool would be a lie the safety layer then acts on.
 */

/**
 * The four verdicts, ordered by how restrictive they are.
 *
 * SAFE               runs immediately, and is still fully logged.
 * REQUIRES_APPROVAL  a human is asked first.
 * HIGH_RISK          a human is asked first, and the dialog says plainly that
 *                    this one is destructive, expensive or hard to undo.
 * FORBIDDEN          refused outright. No approval can unlock it.
 *
 * HIGH_RISK is not a third kind of "ask" bolted on for emphasis. It exists
 * because a user who is asked the same way about "write a file to your
 * Desktop" and "delete this repository" learns to answer both the same way,
 * and the second question is the one that matters. Separating them keeps the
 * dialog's weight proportional to the act.
 *
 * FORBIDDEN is spelled FORBIDDEN rather than DENIED because "denied" is
 * already what the *user* does to an approval request — `ApprovalDecision` has
 * a `DENY`. One word for "the policy refused this outright" and another for
 * "the human said no" is worth keeping distinct in a log someone reads later.
 */
export const RISK_LEVELS = ['SAFE', 'REQUIRES_APPROVAL', 'HIGH_RISK', 'FORBIDDEN'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = Object.freeze({
  SAFE: 0,
  REQUIRES_APPROVAL: 1,
  HIGH_RISK: 2,
  FORBIDDEN: 3,
});

/** A risk verdict plus the human-readable reason shown in the approval UI. */
export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reason: string;
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

/** True when a level asks a human rather than running or refusing. */
export function requiresApproval(level: RiskLevel): boolean {
  return level === 'REQUIRES_APPROVAL' || level === 'HIGH_RISK';
}

/** True when `level` is at least as restrictive as `floor`. */
export function isAtLeast(level: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER[floor];
}

/**
 * Combine risk verdicts by taking the most restrictive.
 *
 * Escalation is the only legal direction. A tool that inspects five aspects of
 * its input and finds one dangerous one is dangerous — safety never averages.
 */
export function escalate(...levels: readonly RiskLevel[]): RiskLevel {
  let worst: RiskLevel = 'SAFE';
  for (const level of levels) {
    if (RISK_ORDER[level] > RISK_ORDER[worst]) worst = level;
  }
  return worst;
}

/**
 * The verdict used whenever risk could not be established — an unexpected
 * input shape, a path that would not resolve, a `resolveRisk` that threw.
 *
 * This is the deny-by-default rule in concrete form. It escalates to
 * REQUIRES_APPROVAL rather than FORBIDDEN so a human can still say yes; what
 * it must never do is fall through to SAFE.
 */
export function unknownRisk(reason: string): RiskAssessment {
  return { level: 'REQUIRES_APPROVAL', reason: `Risk could not be determined: ${reason}` };
}
