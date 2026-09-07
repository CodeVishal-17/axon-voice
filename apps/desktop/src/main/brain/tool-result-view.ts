/**
 * How a `ToolResult` is described back to the model.
 *
 * The dispatcher never throws — it returns a structured failure — and that
 * property is only useful if the failure reaches the model in a form it can
 * reason about. An exception thrown into a model loop is not something a model
 * can read; `{"success": false, "error": "User denied this action"}` is.
 *
 * Every failure kind gets a sentence written for a reader who cannot see the
 * safety layer: what happened, and whether trying again could ever help.
 */

import { AGENT_LOOP_LIMITS } from '@axon/core';
import type { JsonValue, ToolFailureKind, ToolResult } from '@axon/core';

/** The JSON body handed back as a `tool_result` block's content. */
export interface ModelToolResultBody {
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly errorKind?: ToolFailureKind;
  /** True when the same call could plausibly succeed later. */
  readonly retryable?: boolean;
}

/**
 * Whether repeating the identical call could ever produce a different outcome.
 *
 * A denial and a forbidden path are settled facts about this call; a crashing
 * executor might not be. Getting this wrong in the permissive direction is
 * what produces an agent that asks the same question five times.
 */
function isRetryable(kind: ToolFailureKind): boolean {
  switch (kind) {
    case 'EXECUTION_ERROR':
      return true;
    // The one failure whose remedy is a DIFFERENT call the model can make
    // straight away: read the page again, then act on a current reference.
    // Marked retryable so the loop's repeat-suppression does not treat
    // "look again" as a settled refusal.
    case 'STALE_REFERENCE':
      return true;
    // The rest are settled facts about this call. A spent budget does not
    // refill inside the turn that spent it; a duplicate outward action is
    // refused precisely so it is not retried; and an approval mismatch is a
    // statement about what the user actually answered.
    case 'DENIED':
    case 'APPROVAL_TIMEOUT':
    case 'FORBIDDEN':
    case 'UNKNOWN_TOOL':
    case 'INVALID_INPUT':
    case 'CANCELLED':
    case 'BUDGET_EXCEEDED':
    case 'DUPLICATE_SIDE_EFFECT':
    case 'APPROVAL_MISMATCH':
      return false;
    default: {
      // A new failure kind defaults to "do not retry" — the same
      // deny-by-default posture the safety layer takes.
      const exhaustive: never = kind;
      void exhaustive;
      return false;
    }
  }
}

function explain(kind: ToolFailureKind, message: string): string {
  switch (kind) {
    case 'DENIED':
      return 'User denied this action. Do not attempt it again.';
    case 'APPROVAL_TIMEOUT':
      return 'The approval request was not answered in time and was denied by default. Do not attempt it again without saying why you are asking.';
    case 'FORBIDDEN':
      return `Refused by the safety policy: ${message} This cannot be approved by anyone.`;
    case 'UNKNOWN_TOOL':
      return `${message} Use only the tools you were given.`;
    case 'INVALID_INPUT':
      return `The arguments did not match the tool's schema: ${message} Re-read the schema and correct them.`;
    case 'CANCELLED':
      return 'The action was cancelled because Axon is shutting down.';
    case 'EXECUTION_ERROR':
      return `The tool ran but failed: ${message}`;
    case 'STALE_REFERENCE':
      return message;
    case 'BUDGET_EXCEEDED':
      return message;
    case 'DUPLICATE_SIDE_EFFECT':
      return message;
    case 'APPROVAL_MISMATCH':
      return message;
    default:
      return message;
  }
}

export function toModelToolResult(result: ToolResult): ModelToolResultBody {
  if (result.ok) {
    return { success: true, output: result.output };
  }

  return {
    success: false,
    error: explain(result.failure.kind, result.failure.message),
    errorKind: result.failure.kind,
    retryable: isRetryable(result.failure.kind),
  };
}

/**
 * Serialize for the `tool_result` content field, which takes text.
 *
 * BOUNDED, and the bound is the point. Every individual source of tool output
 * has its own limit — a page read is capped at twelve thousand characters, a
 * memory search returns twenty rows — but "each source is bounded" is not the
 * same claim as "the result is bounded", and the gap between them is where an
 * unbounded prompt comes from. A tool added later, or an executor that
 * stringifies an unexpected error object, would otherwise put an arbitrary
 * amount of text into the model's context and the user's bill.
 *
 * Truncation is ANNOUNCED rather than silent, for the same reason page
 * truncation is: a model that does not know it is reading a fragment will
 * answer confidently from the fragment. The notice is appended outside the
 * JSON, so the truncated text cannot be mistaken for a complete document, and
 * the model is told plainly not to treat what it has as the whole result.
 */
export function serializeToolResult(
  result: ToolResult,
  limit: number = AGENT_LOOP_LIMITS.maxToolResultCharacters,
): string {
  const body = JSON.stringify(toModelToolResult(result));
  if (body.length <= limit) return body;

  return (
    `${body.slice(0, limit)}

` +
    `[Axon truncated this result: it was ${body.length} characters and the limit is ${limit}. ` +
    'What you can see above is incomplete and may end mid-value. Do not treat it as the whole result — ' +
    'narrow what you asked for, or tell the user the output was too large to read.]'
  );
}
