/**
 * Turning a brain failure into a sentence a user can act on.
 *
 * Split out from `claude-brain.ts` so the orchestrator can render an error
 * without importing the loop — and, more to the point, without pulling the
 * Anthropic SDK's types into a module that has no business seeing them.
 *
 * Every message here is written for someone who did not read the stack trace.
 * None of them echo the request, the response, or anything read from the
 * environment: an error string is a place secrets leak, and the fix is to
 * never interpolate one in the first place.
 */

import type { JsonValue } from '@axon/core';
import { ModelError } from './model-client.js';

/**
 * The structured half of a brain failure, safe to put on an event.
 *
 * Deliberately NOT `toJsonValue(error)`. A raw error carries whatever the
 * thrower put in it, and a provider error can quote the request it rejected —
 * including, in the worst case, the credential that was rejected. An AxonEvent
 * is written to the JSONL log and pushed to the renderer, so anything on one
 * has crossed both boundaries by the time anyone notices.
 *
 * This returns only fields we chose: a classification, an HTTP status, and
 * whether a retry could help. No message, no stack, no cause.
 */
export function toBrainErrorDetail(error: unknown): JsonValue {
  if (error instanceof ModelError) {
    return { kind: error.kind, status: error.status, retryable: error.retryable };
  }
  return { kind: 'UNKNOWN', name: error instanceof Error ? error.name : typeof error };
}

/**
 * Strip anything key-shaped from a message before it is shown or logged.
 *
 * The messages this module writes by hand never contain a credential. This
 * covers the ones it passes through — a provider's own error text, which we do
 * not control and which can quote the request it rejected. Belt and braces:
 * the real guarantee is that the key only ever exists in one local in
 * `runtime.ts`, and this is what catches the case where it escaped anyway.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, 'sk-ant-[redacted]')
    .replace(/\b(x-api-key|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi, '$1: [redacted]');
}

export function describeModelError(error: unknown): string {
  return redactSecrets(describeModelErrorRaw(error));
}

function describeModelErrorRaw(error: unknown): string {
  if (error instanceof ModelError) {
    switch (error.kind) {
      case 'AUTH':
        return 'Axon could not authenticate with Anthropic. Check that ANTHROPIC_API_KEY is set correctly, then restart Axon.';
      case 'RATE_LIMIT':
        return 'Anthropic is rate limiting Axon right now. Try again in a moment.';
      case 'NETWORK':
        return 'Axon could not reach Anthropic. Check your network connection.';
      case 'ABORTED':
        return 'That request was cancelled.';
      case 'MALFORMED_RESPONSE':
        return 'Anthropic returned a response Axon could not read.';
      case 'BAD_REQUEST':
      case 'SERVER':
      case 'UNKNOWN':
        return error.message;
      default: {
        const exhaustive: never = error.kind;
        void exhaustive;
        return error.message;
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}
