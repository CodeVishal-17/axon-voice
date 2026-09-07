/**
 * Tool contracts.
 *
 * The split in this file is the safety architecture in miniature:
 *
 * - `ToolDefinition` carries an `execute` function. It lives only in the tool
 *   layer and in the dispatcher.
 * - `ToolSchema` carries no code at all — just a name, a description and a
 *   JSON Schema. It is the *only* view of the tool surface the brain ever
 *   receives.
 *
 * The brain therefore cannot call a tool even by accident. It can only emit a
 * `ToolCall`, which the dispatcher validates, classifies and gates.
 */

import type { ZodType } from 'zod';
import type { SideEffectClass } from './agent.js';
import type { RiskAssessment } from './risk.js';
import type { ApprovalParameter } from './approval.js';
import type { JsonObject, JsonValue } from './json.js';

/** Per-invocation context handed to an executor by the dispatcher. */
export interface ToolExecutionContext {
  readonly callId: string;
  /** Aborted on shutdown or cancellation. Long-running tools must honour it. */
  readonly signal: AbortSignal;
  /** Emits an OBSERVATION event attributed to this call. */
  observe(summary: string, detail?: JsonValue): void;
}

/** How a pending call is described to the human in the approval dialog. */
export interface ToolSummary {
  readonly title: string;
  readonly parameters: readonly ApprovalParameter[];
}

/**
 * A tool, with its typed input, its risk policy and its executor.
 *
 * `resolveRisk`, `summarize` and `execute` are only ever called with a value
 * that has already passed `inputSchema`, so implementations may treat their
 * `input` as validated.
 */
export interface ToolDefinition<TInput, TOutput extends JsonValue> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  /**
   * Refuse a call whose preconditions no longer hold, BEFORE anyone is asked
   * about it.
   *
   * Narrowing only, by construction: the return type has no "allow" that
   * skips anything. A tool that omits this is exactly as gated as before; a
   * tool that implements it can only add a refusal. See `precheck` in
   * `Dispatcher` for why this runs ahead of risk resolution rather than
   * inside it — asking a human to approve a click on an element that is no
   * longer on the page is a question with no right answer, and asking it
   * teaches the user that the dialog is noise.
   */
  precheck?(input: TInput): PrecheckVerdict;
  resolveRisk(input: TInput): RiskAssessment;
  summarize(input: TInput): ToolSummary;
  /**
   * How this call should be counted for the repeat bound.
   *
   * The bound normally keys on (tool, arguments), which is right for an action
   * and wrong for an OBSERVATION. `browser.read` takes no arguments, so three
   * reads in a turn look identical and the fourth is refused — and reading is
   * how the agent recovers from a stale reference, so refusing it breaks the
   * recovery path this milestone depends on.
   *
   * A tool that implements this returns a key describing what it would
   * OBSERVE. Two reads of an unchanged page produce the same key and are
   * correctly bounded; a read after the page changed produces a different one
   * and is correctly allowed. The distinction the bound actually wants is "did
   * anything change?", not "were the arguments equal".
   *
   * Narrowing is preserved: the key still feeds the same counter with the same
   * ceiling, and the per-turn tool-call and time bounds are untouched.
   */
  repeatKey?(input: TInput): string;
  /**
   * How this call's consequence leaves the machine, if it does.
   *
   * Consulted by the duplicate-side-effect guard. Omitted means EXTERNAL is
   * assumed for anything that required approval — deny-by-default applies to
   * repeatability as much as to permission.
   */
  sideEffect?(input: TInput): SideEffectClass;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}

/**
 * The result of a precondition check.
 *
 * `retryable` says whether the model doing something else first — reading the
 * page again, most often — could make the same call legal. It is the
 * difference between "look again" and "stop".
 */
export type PrecheckVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/**
 * A tool erased of its input type, as held by the registry.
 *
 * The dispatcher works with these uniformly. `defineTool` below is the single
 * audited place where the widening happens.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ZodType<unknown>;
  precheck?(input: unknown): PrecheckVerdict;
  repeatKey?(input: unknown): string;
  resolveRisk(input: unknown): RiskAssessment;
  summarize(input: unknown): ToolSummary;
  sideEffect?(input: unknown): SideEffectClass;
  execute(input: unknown, ctx: ToolExecutionContext): Promise<JsonValue>;
}

/**
 * Register a typed tool.
 *
 * The cast is sound because the dispatcher guarantees the invariant stated on
 * `ToolDefinition`: nothing reaches these methods without passing
 * `inputSchema` first. Keeping the cast here means no executor has to weaken
 * its own types, and there is exactly one line to audit.
 */
export function defineTool<TInput, TOutput extends JsonValue>(
  definition: ToolDefinition<TInput, TOutput>,
): RegisteredTool {
  return definition as unknown as RegisteredTool;
}

/** A request to run a tool. This is all the brain is able to produce. */
export interface ToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly input: JsonValue;
}

export type ToolFailureKind =
  | 'UNKNOWN_TOOL'
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION_ERROR'
  /** A precondition no longer holds — usually an element reference from a
   *  page that has since changed. Recoverable by re-observing. */
  | 'STALE_REFERENCE'
  /** The turn's tool-call, time or repeat budget is spent. Not recoverable
   *  within this turn, by design. */
  | 'BUDGET_EXCEEDED'
  /** This exact outward action already succeeded in this turn. Refused so a
   *  retry cannot post a second comment under the user's name. */
  | 'DUPLICATE_SIDE_EFFECT'
  /** What was about to run is not what the user approved. */
  | 'APPROVAL_MISMATCH';

export interface ToolFailure {
  readonly kind: ToolFailureKind;
  readonly message: string;
  readonly detail: JsonValue | null;
}

export type ToolResult =
  | {
      readonly callId: string;
      readonly tool: string;
      readonly ok: true;
      readonly output: JsonValue;
      readonly durationMs: number;
    }
  | {
      readonly callId: string;
      readonly tool: string;
      readonly ok: false;
      readonly failure: ToolFailure;
      readonly durationMs: number;
    };

/**
 * The code-free projection of a tool, safe to hand to a language model.
 *
 * `inputSchema` here is a JSON Schema object, not a Zod schema — the brain
 * gets data, never a callable.
 */
export interface ToolSchema {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}
