/**
 * The Anthropic adapter — the only place Axon talks to a model provider.
 *
 * SECURITY: the API key enters here and stops here.
 *
 * It is read from the environment in `runtime.ts` and passed to this factory
 * as an argument. It is never placed on `RuntimeConfig`, never written to an
 * AxonEvent, never sent over IPC, and never logged. `BrainStatus` — the only
 * thing the renderer learns about the brain — carries a boolean and a model
 * name, nothing more. `tests/brain-security.test.ts` asserts this by running a
 * turn with a sentinel key and scanning every emitted event for it.
 *
 * API notes, verified against @anthropic-ai/sdk 0.123.0:
 *
 * - `messages.stream()` + `finalMessage()` rather than `messages.create()`.
 *   The response is assembled the same way, but streaming keeps a long
 *   tool-heavy turn from running into the HTTP timeout, and it is the shape a
 *   future token-level UI would need.
 * - `thinking: {type: 'adaptive'}` — the current form. `budget_tokens` is
 *   removed on this model family and would be rejected with a 400.
 * - `display` is left at its default of `omitted`. Axon must not show hidden
 *   reasoning, and the cleanest way to guarantee that is to never receive it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ModelError, type ModelClient, type ModelErrorKind, type ModelTurnRequest } from './model-client.js';

/** Matches the `.env.example` default. Overridable with AXON_MODEL. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Output ceiling for one turn.
 *
 * Generous because a turn that hits the cap is truncated mid-thought and has
 * to be retried, which costs more than the headroom does.
 */
const MAX_TOKENS = 16_000;

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Injected in tests to avoid a real network client. */
  readonly client?: Anthropic;
}

/**
 * Translate an SDK error into the loop's vocabulary.
 *
 * Most specific first, per the SDK's class hierarchy — every one of these
 * extends `APIError`, so an `APIError`-first chain would collapse the
 * distinctions the loop needs.
 */
function classify(error: unknown): ModelError {
  if (error instanceof ModelError) return error;

  const describe = (kind: ModelErrorKind, message: string, status: number | null, retryable: boolean): ModelError =>
    new ModelError(kind, message, { status, retryable });

  if (error instanceof Anthropic.APIUserAbortError) {
    return describe('ABORTED', 'The request was cancelled.', null, false);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    // Note the wording: it names the variable, never the value.
    return describe('AUTH', 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY.', 401, false);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return describe('AUTH', 'This API key is not permitted to use that model.', 403, false);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return describe('RATE_LIMIT', 'Anthropic rate limit reached. Try again shortly.', 429, true);
  }
  if (error instanceof Anthropic.BadRequestError) {
    return describe('BAD_REQUEST', `Anthropic rejected the request: ${error.message}`, 400, false);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return describe('SERVER', 'Anthropic had a server error.', error.status ?? 500, true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return describe('NETWORK', 'Could not reach Anthropic. Check the network connection.', null, true);
  }
  if (error instanceof Anthropic.APIError) {
    return describe('UNKNOWN', error.message, error.status ?? null, false);
  }
  // An AbortSignal firing outside an in-flight request surfaces as a plain
  // DOMException rather than the SDK's abort class.
  if (error instanceof Error && error.name === 'AbortError') {
    return describe('ABORTED', 'The request was cancelled.', null, false);
  }
  return describe('UNKNOWN', error instanceof Error ? error.message : String(error), null, false);
}

export function createAnthropicClient(options: AnthropicClientOptions): ModelClient {
  const model = options.model?.trim() || DEFAULT_MODEL;

  // `maxRetries` covers the transient cases the SDK already knows how to
  // retry (429, 5xx, connection resets). The loop's own retry sits on top of
  // it for the cases that survive.
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });

  return {
    model,

    async createTurn(request: ModelTurnRequest): Promise<Anthropic.Message> {
      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: request.system,
            messages: request.messages as Anthropic.MessageParam[],
            tools: request.tools as Anthropic.Tool[],
            // Adaptive thinking, reasoning text withheld. See the file header.
            thinking: { type: 'adaptive' },
          },
          { signal: request.signal },
        );

        return await stream.finalMessage();
      } catch (error) {
        throw classify(error);
      }
    },
  };
}
