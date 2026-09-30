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
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      /**
       * What kind of failure this is, when the precheck knows — from the
       * same permitted set an executor may declare. "No application called
       * that" is NOT_FOUND, not a policy refusal, and saying so before any
       * approval is asked for is the difference between "Spotify isn't
       * installed" and a dialog asking permission to open nothing. Absent:
       * STALE_REFERENCE when retryable, FORBIDDEN otherwise, as before.
       */
      readonly kind?: ExecutorFailureKind;
      /**
       * The request was understood but matches more than one thing: answered
       * as CLARIFICATION_NEEDED, with `reason` as the question. Nobody is
       * asked to approve a request Axon cannot yet name.
       */
      readonly clarify?: boolean;
    };

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

/**
 * Every way a tool call can fail. ONE list: the type, the event schema and
 * the renderers all derive from it, so a kind cannot exist in one and be
 * rejected by another — an event carrying a kind the schema did not know
 * would fail validation and vanish from the log.
 *
 *   UNKNOWN_TOOL          no such tool
 *   INVALID_INPUT         the arguments did not match the schema
 *   FORBIDDEN             refused by policy; nobody can approve it
 *   DENIED                a person said no
 *   APPROVAL_TIMEOUT      a person did not answer in time
 *   CANCELLED             the user stopped it
 *   EXECUTION_ERROR       the tool ran and failed, for a reason with no better name
 *   STALE_REFERENCE       a precondition no longer holds — usually an element
 *                         reference from a screen that has since changed.
 *                         Recoverable by looking again.
 *   BUDGET_EXCEEDED       the request's tool-call, time or repeat budget is
 *                         spent. Not recoverable within this request.
 *   DUPLICATE_SIDE_EFFECT this exact outward action already succeeded in this
 *                         request; refused so a retry cannot do it twice
 *   APPROVAL_MISMATCH     what was about to run is not what was approved
 *   CLARIFICATION_NEEDED  understood, but not specific enough — ask, do not fail
 *
 * Added after a real conversation in which nearly every failure reached the
 * user as "that timed out" (most were budget exhaustion; see
 * `voice-request-budget.test.ts`). Each names a DIFFERENT thing to tell the
 * user, which is the whole test for whether it deserves to exist:
 *
 *   NOT_FOUND             the thing asked for does not exist — an application
 *                         that is not installed, an element that is not there
 *   TIMEOUT               it was attempted and did not finish in time
 *   VERIFICATION_FAILED   it ran, and checking showed the result is not what
 *                         was intended. NOT "could not confirm": an act Axon
 *                         could not confirm is reported as a success carrying
 *                         `verified: false`, which is a different sentence
 *   AUTH_REQUIRED         the destination needs the user to sign in, which
 *                         Axon never does for them
 *   UNSUPPORTED           the capability does not exist here, or the target
 *                         does not accept that kind of action
 *   WINDOW_NOT_FOUND      a window Axon expected to be there is not
 *   UI_NOT_ACCESSIBLE     the application publishes nothing Axon can read
 *                         through the accessibility layer
 */
export const TOOL_FAILURE_KINDS = [
  'UNKNOWN_TOOL',
  'INVALID_INPUT',
  'FORBIDDEN',
  'DENIED',
  'APPROVAL_TIMEOUT',
  'CANCELLED',
  'EXECUTION_ERROR',
  'STALE_REFERENCE',
  'BUDGET_EXCEEDED',
  'DUPLICATE_SIDE_EFFECT',
  'APPROVAL_MISMATCH',
  'CLARIFICATION_NEEDED',
  'NOT_FOUND',
  'TIMEOUT',
  'VERIFICATION_FAILED',
  'AUTH_REQUIRED',
  'UNSUPPORTED',
  'WINDOW_NOT_FOUND',
  'UI_NOT_ACCESSIBLE',
] as const;

export type ToolFailureKind = (typeof TOOL_FAILURE_KINDS)[number];

/**
 * The kinds an EXECUTOR may declare for its own failure.
 *
 * A SECURITY BOUNDARY, not a convenience. Every kind outside this list is a
 * fact only the dispatcher can establish — whether a person approved, whether
 * an approval matched, whether the input was valid, whether this was a
 * duplicate — and an executor that could declare one could forge it. The
 * dispatcher reads a declared kind only if it is in this list, and treats
 * anything else as a plain EXECUTION_ERROR.
 *
 * Everything here is either a description of what went wrong in the world
 * (NOT_FOUND, TIMEOUT, ...) or a refusal that can only make Axon do LESS:
 * FORBIDDEN (a protected field, a refused address) and BUDGET_EXCEEDED (a
 * browser's own action cap). STALE_REFERENCE is here because an executor is
 * often the first to discover the screen changed.
 */
export const EXECUTOR_FAILURE_KINDS = [
  'NOT_FOUND',
  'TIMEOUT',
  'VERIFICATION_FAILED',
  'AUTH_REQUIRED',
  'UNSUPPORTED',
  'WINDOW_NOT_FOUND',
  'UI_NOT_ACCESSIBLE',
  'STALE_REFERENCE',
  'FORBIDDEN',
  'BUDGET_EXCEEDED',
] as const satisfies readonly ToolFailureKind[];

export type ExecutorFailureKind = (typeof EXECUTOR_FAILURE_KINDS)[number];

/**
 * An executor's failure, with its kind stated.
 *
 * Throw this where the failure is understood. Anything thrown without a kind
 * still becomes EXECUTION_ERROR, exactly as before: nothing is reclassified
 * by guessing at its message.
 */
export class ToolError extends Error {
  readonly toolFailureKind: ExecutorFailureKind;

  constructor(kind: ExecutorFailureKind, message: string) {
    super(message);
    this.name = 'ToolError';
    this.toolFailureKind = kind;
  }
}

/**
 * The kind an error declares for itself, if it declares a permitted one.
 *
 * Structural rather than `instanceof`, for the reason `isClarificationRequired`
 * gives: executors, the browser and the dispatcher can hold different copies
 * of a class. Any Error with a `toolFailureKind` in EXECUTOR_FAILURE_KINDS is
 * honoured — which is how `BrowserError` maps its own kinds without the
 * dispatcher importing the browser. Anything else, including an Error that
 * claims DENIED or APPROVAL_MISMATCH, is not.
 */
export function declaredFailureKind(error: unknown): ExecutorFailureKind | null {
  if (!(error instanceof Error)) return null;
  const kind = (error as { toolFailureKind?: unknown }).toolFailureKind;
  return typeof kind === 'string' && (EXECUTOR_FAILURE_KINDS as readonly string[]).includes(kind)
    ? (kind as ExecutorFailureKind)
    : null;
}

/**
 * What each kind means for what happens next: whether trying again could
 * help, and how to put it to the user. ONE table, read by the typed brain's
 * result view and by the voice agent's, so the two paths cannot explain the
 * same failure differently.
 *
 * The guidance is about what to SAY, because the recurring failure was never
 * the kind being wrong in the log — it was the model saying "it timed out"
 * about something that had not.
 */
export const FAILURE_GUIDANCE: Readonly<Record<ToolFailureKind, { readonly retryable: boolean; readonly say: string }>> = {
  UNKNOWN_TOOL: { retryable: false, say: 'Use only the tools you were given.' },
  INVALID_INPUT: { retryable: false, say: "Re-read the tool's schema and correct the arguments." },
  FORBIDDEN: { retryable: false, say: 'This is refused by Axon\'s safety policy and nobody can approve it. Say so plainly.' },
  DENIED: { retryable: false, say: 'The user said no. Do not try again.' },
  APPROVAL_TIMEOUT: { retryable: false, say: 'Nobody answered the approval in time, so it was not done.' },
  CANCELLED: { retryable: false, say: 'The user stopped this. Do not carry on with it.' },
  EXECUTION_ERROR: { retryable: true, say: 'Tell the user it did not work, using the reason given. Do not call it a timeout.' },
  STALE_REFERENCE: { retryable: true, say: 'The screen changed. Look again, then act on what is actually there.' },
  BUDGET_EXCEEDED: {
    retryable: false,
    say: 'Axon has reached its limit for this request. Tell the user what you did manage. This is not a timeout.',
  },
  DUPLICATE_SIDE_EFFECT: { retryable: false, say: 'That was already done in this request. Do not do it twice.' },
  APPROVAL_MISMATCH: { retryable: false, say: 'What was about to run was not what the user approved, so it was stopped.' },
  CLARIFICATION_NEEDED: { retryable: false, say: 'Ask the user the question in the message, and wait for the answer.' },
  NOT_FOUND: {
    retryable: false,
    say: 'Say plainly that it could not be found — for example "I couldn\'t find Spotify on this computer." Do not call it a timeout.',
  },
  TIMEOUT: {
    retryable: true,
    say: 'Say it took too long to respond — for example "The page took too long to respond." Only this kind is a timeout.',
  },
  VERIFICATION_FAILED: {
    retryable: false,
    say: 'It ran, but checking showed it did not have the intended result. Say that; do not claim it worked.',
  },
  AUTH_REQUIRED: {
    retryable: false,
    say: 'It needs the user to sign in, and Axon never signs in for them. Ask them to sign in themselves.',
  },
  UNSUPPORTED: { retryable: false, say: 'Say that this is not something Axon can do there.' },
  WINDOW_NOT_FOUND: {
    retryable: false,
    say: 'Say the window is not open any more — for example "That window isn\'t open." Offer to open it if you can.',
  },
  UI_NOT_ACCESSIBLE: {
    retryable: false,
    say: 'Say you couldn\'t access that application\'s controls — it does not expose them to the accessibility layer.',
  },
};

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
/**
 * Thrown by an executor when the request was understood but was not specific
 * enough to act on.
 *
 * WHY A DISTINCT ERROR RATHER THAN A MESSAGE.
 *
 * "There are two Notepad windows open" and "Notepad could not be opened" reach
 * a model identically if both are `EXECUTION_ERROR` with prose attached — and
 * a model that cannot tell them apart apologises for a failure when the
 * correct answer is a question. That is the difference between an assistant
 * that asks which one you meant and one that gives up.
 *
 * The dispatcher recognises this type and maps it to `CLARIFICATION_NEEDED`,
 * so the distinction survives all the way to what the user hears. It is not a
 * way to skip anything: an executor that throws this has REFUSED to act, and
 * refusing is the only thing it can do with it.
 *
 * The message is a QUESTION FOR THE USER, phrased as one. It is read aloud.
 */
export class ClarificationRequired extends Error {
  constructor(question: string) {
    super(question);
    this.name = 'ClarificationRequired';
  }
}

/**
 * Is this the ambiguity signal?
 *
 * Checked structurally rather than with `instanceof`. An executor and the
 * dispatcher can end up holding different copies of this class — two bundles,
 * a test double, a re-export — and an `instanceof` that silently fails would
 * turn every clarification back into the generic failure this type exists to
 * escape.
 */
export function isClarificationRequired(error: unknown): error is ClarificationRequired {
  return error instanceof Error && error.name === 'ClarificationRequired';
}

export interface ToolSchema {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}
