/**
 * The policy engine: risk verdict in, action out.
 *
 * Small on purpose. The interesting judgement happens in each tool's
 * `resolveRisk`, which can see the arguments; this stage only decides what the
 * system does about a level, and it is the place where deny-by-default is
 * written down once.
 */

import type { RiskAssessment } from '@axon/core';

export type PolicyAction = 'ALLOW' | 'REQUIRE_APPROVAL' | 'REFUSE';

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly reason: string;
}

export class Policy {
  decide(assessment: RiskAssessment): PolicyDecision {
    switch (assessment.level) {
      case 'SAFE':
        return { action: 'ALLOW', reason: assessment.reason };
      case 'REQUIRES_APPROVAL':
        return { action: 'REQUIRE_APPROVAL', reason: assessment.reason };
      // Same action, deliberately. What HIGH_RISK changes is how the request
      // is *presented* — the dialog says outright that this one is
      // destructive, expensive or hard to undo — not whether a human decides.
      // Routing it anywhere else would either make it refusable-only (removing
      // the user's authority over their own machine) or auto-allowed
      // (removing the point of the level).
      case 'HIGH_RISK':
        return { action: 'REQUIRE_APPROVAL', reason: assessment.reason };
      case 'FORBIDDEN':
        return { action: 'REFUSE', reason: assessment.reason };
      default: {
        // Unreachable while RiskLevel is exhaustive — but if a new level is
        // ever added and someone forgets this switch, the safe answer is to
        // refuse, not to fall through into execution.
        const level: never = assessment.level;
        return { action: 'REFUSE', reason: `Unrecognized risk level: ${String(level)}` };
      }
    }
  }
}
