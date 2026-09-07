/**
 * The port between the agent loop and whatever actually talks to a model.
 *
 * `ClaudeBrain` depends on this interface, not on the Anthropic SDK. That buys
 * two things:
 *
 * 1. The loop — the part with the safety-relevant behaviour — is tested with a
 *    scripted client and no network, no key and no beta surface. Every branch
 *    (denied tool, unknown tool, malformed arguments, sequential calls, API
 *    failure) is reachable deterministically.
 * 2. The SDK is confined to `anthropic-client.ts`, which is a thin adapter
 *    with nothing to test but its own wiring.
 *
 * The types are the SDK's own (`Anthropic.MessageParam`, `Anthropic.Tool`, …)
 * rather than hand-rolled equivalents. Redefining them would lose type safety
 * against the real request shape for no gain — and the whole brain layer is
 * permitted to see the SDK's types, since the boundary that matters is
 * "no layer *below* the brain may import it".
 */

import type Anthropic from '@anthropic-ai/sdk';

/** One request to the model. Everything the loop varies per iteration. */
export interface ModelTurnRequest {
  readonly system: string;
  readonly messages: readonly Anthropic.MessageParam[];
  readonly tools: readonly Anthropic.Tool[];
  readonly signal: AbortSignal;
}

/**
 * How a model call failed, in terms the loop can act on.
 *
 * The loop does not care which SDK class was thrown; it cares whether the
 * failure is worth retrying and what to tell the user. Classification happens
 * once, in the adapter, where the SDK's typed errors are actually in scope.
 */
export type ModelErrorKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'ABORTED'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'MALFORMED_RESPONSE'
  | 'UNKNOWN';

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  /** True for transient failures where trying the same request again is sane. */
  readonly retryable: boolean;

  constructor(kind: ModelErrorKind, message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface ModelClient {
  /** Human-readable model identity, for logs and the brain's `name`. */
  readonly model: string;
  /**
   * Run one request to completion.
   *
   * Implementations must throw `ModelError` and nothing else, so the loop has
   * a single failure vocabulary to handle.
   */
  createTurn(request: ModelTurnRequest): Promise<Anthropic.Message>;
}
