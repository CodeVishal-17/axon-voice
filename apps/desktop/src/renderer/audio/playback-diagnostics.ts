/**
 * What the window did with the voice agent's reply audio — the last two hops.
 *
 * Main can count what the provider sent, what it accepted and whether a live
 * window took each chunk. Only the window can say whether the audio then
 * PLAYED. A reply in Hindi reached the screen and never the speakers, and the
 * streamed player's only failure signal was a `console.warn` in a hidden
 * window's devtools — so this reports, per reply:
 *
 *   received   the first chunk arrived — proof of receipt even if playback
 *              never begins
 *   started    the player began producing sound
 *   ended      it finished, with the totals received
 *   failed     it could not play, with the player's own reason
 *
 * At most four small messages per reply, correlated by the `speechId` main
 * minted, carrying counts and one of four words. Never audio, never what Axon
 * said. Main drops them unless a development build asked for voice
 * diagnostics, so the window does not need to know whether anyone is looking.
 *
 * PURE: no AudioContext, no bridge. The hook that owns the player feeds it and
 * hands it a function to report with, which is what lets it be tested.
 */

import type { PlaybackDiagnostics } from '@axon/core';

/** Replies tracked at once. A bound, so a stream of ids cannot grow a map. */
const MAX_TRACKED = 16;

export class PlaybackTracker {
  private readonly replies = new Map<string, { chunks: number; bytes: number }>();

  constructor(private readonly report: (report: PlaybackDiagnostics) => void) {}

  /** A chunk arrived from main. The empty final chunk is a drain marker, not audio. */
  chunk(speechId: string, bytes: number, final: boolean): void {
    if (final && bytes === 0) return;
    const counts = this.replies.get(speechId);
    if (counts) {
      counts.chunks += 1;
      counts.bytes += bytes;
      return;
    }
    this.replies.set(speechId, { chunks: 1, bytes });
    if (this.replies.size > MAX_TRACKED) {
      const oldest = this.replies.keys().next().value;
      if (oldest !== undefined) this.replies.delete(oldest);
    }
    this.send(speechId, 'received', null);
  }

  started(speechId: string): void {
    this.send(speechId, 'started', null);
  }

  ended(speechId: string): void {
    this.send(speechId, 'ended', null);
    this.replies.delete(speechId);
  }

  failed(speechId: string, reason: string): void {
    this.send(speechId, 'failed', reason);
    this.replies.delete(speechId);
  }

  private send(speechId: string, event: PlaybackDiagnostics['event'], reason: string | null): void {
    const counts = this.replies.get(speechId) ?? { chunks: 0, bytes: 0 };
    try {
      this.report({ speechId, event, chunks: counts.chunks, bytes: counts.bytes, reason });
    } catch {
      // Diagnostics must never be the reason audio stops.
    }
  }
}
