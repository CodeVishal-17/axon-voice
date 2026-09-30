/**
 * How an utterance reaches the window.
 *
 * A one-way channel with a late-bound sink. The speech service is built during
 * runtime assembly, before any window exists, so it cannot hold a reference to
 * something that can send to one. It holds this instead, and the renderer
 * bridge attaches itself once IPC is up.
 *
 * The direction is the point. There is a `deliver` and a `stop`, both
 * main -> renderer; there is nothing here that lets the renderer nominate what
 * should be played. Audio flows outward only, chosen by main.
 */

import type { SpeechChunk, SpeechDelivery } from '@axon/core';

/** Implemented by the renderer bridge. */
export interface SpeechSink {
  deliver(delivery: SpeechDelivery): void;
  /**
   * One chunk of a streamed utterance.
   *
   * The same direction and the same rule as `deliver`: bytes chosen by main,
   * with no counterpart that lets the renderer ask for audio. Streaming is a
   * different framing of the same one-way channel, not a new privilege.
   *
   * Returns false when no live window took it — the voice surface was gone —
   * so a reply that was sent but never reached anything that could play it
   * is a number in the diagnostics rather than a mystery. A sink that cannot
   * tell returns nothing, which is read as delivered.
   */
  chunk(chunk: SpeechChunk): boolean | void;
  stop(speechId: string): void;
}

export class SpeechTransport {
  private sink: SpeechSink | null = null;

  attach(sink: SpeechSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = null;
  }

  /**
   * Send audio to whatever is listening.
   *
   * Silently drops when nothing is attached — which happens legitimately
   * during shutdown, after the bridge has been disposed but before a
   * synthesis in flight has finished. Throwing there would turn an ordinary
   * quit into an error the user sees.
   */
  deliver(delivery: SpeechDelivery): void {
    this.sink?.deliver(delivery);
  }

  /**
   * Send one chunk of streamed audio.
   *
   * Drops silently with nothing attached, exactly as `deliver` does. A dropped
   * chunk means Axon is quieter than intended, which is the safe failure; the
   * alternative — throwing inside a socket handler — takes the process down.
   */
  /** True when a live window took the chunk. See `SpeechSink.chunk`. */
  chunk(chunk: SpeechChunk): boolean {
    if (!this.sink) return false;
    return this.sink.chunk(chunk) !== false;
  }

  stop(speechId: string): void {
    this.sink?.stop(speechId);
  }
}
