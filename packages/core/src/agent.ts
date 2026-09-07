/**
 * The trusted agent loop's contracts.
 *
 * Step 7's thesis in one file: the model proposes, Axon decides. Everything
 * here describes a bound Axon enforces *on* the loop, never a bound the loop
 * enforces on itself.
 *
 * That distinction is the reason this file exists at all. Before Step 7 the
 * iteration and tool-call caps lived inside `ClaudeBrain` — which is to say,
 * inside the component being bounded. A brain implementation that ignored
 * them (a future one, a buggy one, a scripted one) simply would not be
 * bounded. Here the numbers are contract, and `TurnBudget` in the main
 * process spends them at the DISPATCH boundary, which every effect must
 * cross.
 *
 * Pure: no Node, no Electron, no SDK. The renderer imports this package.
 */

/**
 * Hard ceilings on one agent turn.
 *
 * Each of these is a security control, not a performance tuning knob:
 *
 * - `maxIterations` / `maxToolCalls` stop a model that has decided to try the
 *   same thing forever. Both are needed: twelve iterations of one call and
 *   one iteration of a hundred parallel calls are the same failure.
 * - `maxTurnMilliseconds` is the one bound that holds even when the model is
 *   making apparent progress. Without it a loop that alternates between two
 *   legitimate-looking actions runs until the user force-quits.
 * - `maxToolResultCharacters` bounds what a single result can inject into the
 *   model's context. A page, a file listing or an error can all be enormous,
 *   and an unbounded result is an unbounded bill and an unbounded prompt.
 * - `maxRepeatedAttempts` bounds identical retries of the SAME call. Three is
 *   deliberate: one try, one retry after a transient failure, one more if the
 *   world genuinely changed. A fourth identical attempt is a loop.
 */
export const AGENT_LOOP_LIMITS = {
  /** Model round trips in one turn. */
  maxIterations: 12,
  /** Tool calls dispatched in one turn, across all iterations. */
  maxToolCalls: 24,
  /** Wall-clock for one turn, including approval waits. */
  maxTurnMilliseconds: 5 * 60_000,
  /** Characters of one serialized tool result handed back to the model. */
  maxToolResultCharacters: 24_000,
  /** Identical (tool, arguments) dispatches permitted in one turn. */
  maxRepeatedAttempts: 3,
} as const;

/** Why a turn's budget refused a dispatch. */
export const BUDGET_BREACHES = ['TOOL_CALLS', 'TIME', 'REPEATS'] as const;
export type BudgetBreach = (typeof BUDGET_BREACHES)[number];

/** What a budget check returns. Refusal always says which bound bit. */
export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly breach: BudgetBreach; readonly message: string };

/** A turn's budget as the UI and the log see it. Counters, never content. */
export interface TurnBudgetSnapshot {
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly elapsedMs: number;
  readonly maxTurnMilliseconds: number;
  readonly exhausted: boolean;
}

/**
 * How a tool call's outward consequence is classified.
 *
 * Distinct from `RiskLevel`, which answers "does a human decide?". This
 * answers "did something leave this machine?", and it is what the duplicate
 * guard keys on: repeating a read is free, repeating a submission is a second
 * comment under the user's name.
 */
export const SIDE_EFFECT_CLASSES = ['NONE', 'LOCAL', 'EXTERNAL'] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

/**
 * The states an agent task moves through.
 *
 * Deliberately NOT a second state machine. These are the phases of one turn as
 * the loop reports them, and each maps onto exactly one `AxonState` that the
 * orchestrator's machine already owns:
 *
 *   UNDERSTANDING        -> THINKING
 *   ACTING / OBSERVING   -> EXECUTING
 *   WAITING_FOR_APPROVAL -> WAITING_FOR_APPROVAL
 *   COMPLETED / FAILED / CANCELLED -> IDLE or ERROR
 *
 * Having the vocabulary without having the machine is the point: the phase is
 * a label on an event, and authority over state stays in one place.
 */
export const AGENT_PHASES = [
  'IDLE',
  'UNDERSTANDING',
  'ACTING',
  'OBSERVING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type AgentPhase = (typeof AGENT_PHASES)[number];

export function isAgentPhase(value: unknown): value is AgentPhase {
  return typeof value === 'string' && (AGENT_PHASES as readonly string[]).includes(value);
}

/**
 * JSON with sorted keys, for fingerprinting.
 *
 * Argument order is not stable across model turns, so `JSON.stringify` alone
 * would let `{a,b}` and `{b,a}` look like different calls — which would defeat
 * both the repeat bound and the approval binding below. Exported from core
 * because three layers (the loop, the budget and the approval binding) must
 * agree on exactly one normalization.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
