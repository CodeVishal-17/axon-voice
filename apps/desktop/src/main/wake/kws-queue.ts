/**
 * The spotter's audio queue: bounded, and it throws away the OLDEST audio.
 *
 * PURE. Imports nothing. `kws-host.ts` feeds it bytes from stdin and takes
 * fixed-size blocks out for the model.
 *
 * WHY IT EXISTS.
 *
 * The spotter used to decode synchronously inside its stdin `data` handler. While
 * it decoded, nobody read the pipe; the parent's write buffer filled; and the
 * parent then dropped the frame it was holding — the NEWEST audio — while
 * everything older waited its turn. Under pressure that is exactly backwards
 * for a wake word: the audio worth hearing is the audio that was just spoken.
 *
 * Now reading and decoding are separate. Every byte that arrives is queued
 * immediately, stamped with when it arrived. The model takes 100 ms blocks off
 * the front. If the queue ever holds more than its bound, the front — the
 * stalest audio — is discarded, and the discard is counted, never hidden.
 *
 * WHAT "BEHIND" MEANS HERE. The age of a block is how long ago its first byte
 * arrived at the spotter. That is the only latency the spotter itself adds, it
 * is measured on one clock, and it is zero whenever the model keeps up. The
 * previous metric compared wall time since the model LOADED with audio consumed
 * since, which turned any delay before the microphone opened — and any shortfall
 * of audio upstream — into seconds of fictitious backlog.
 */

/** One arrival from stdin. */
interface Arrival {
  bytes: Uint8Array;
  readonly arrivedAt: number;
}

export interface QueueBlock {
  /** Exactly `blockBytes` of little-endian PCM16. */
  readonly bytes: Uint8Array;
  /** When the block's first byte arrived. */
  readonly arrivedAt: number;
}

export class SpotterAudioQueue {
  /** Largest amount of audio held, in bytes. Always even. */
  readonly maxBytes: number;
  private readonly arrivals: Arrival[] = [];
  private queued = 0;
  private dropped = 0;
  private maxQueued = 0;

  constructor(maxBytes: number) {
    if (!(maxBytes >= 2)) throw new RangeError('the queue must hold at least one sample');
    // Even, so trimming can never split a 16-bit sample.
    this.maxBytes = maxBytes - (maxBytes % 2);
  }

  /** Bytes currently queued. */
  get queuedBytes(): number {
    return this.queued;
  }

  /** Bytes discarded, in total, because the queue was full. */
  get droppedBytes(): number {
    return this.dropped;
  }

  /** The most bytes that were ever queued at once. */
  get maxQueuedBytes(): number {
    return this.maxQueued;
  }

  /** Age of the oldest queued byte, or 0 when empty. */
  oldestAgeMs(now: number): number {
    const first = this.arrivals[0];
    return first ? Math.max(0, now - first.arrivedAt) : 0;
  }

  /**
   * Queue bytes that just arrived. If that overfills the queue, the oldest
   * bytes go — whole samples only.
   */
  push(bytes: Uint8Array, now: number): void {
    if (bytes.byteLength === 0) return;
    // Copied: stdin reuses nothing today, but a queue that aliases its caller's
    // buffer is a queue whose contents can change under it.
    this.arrivals.push({ bytes: new Uint8Array(bytes), arrivedAt: now });
    this.queued += bytes.byteLength;
    this.maxQueued = Math.max(this.maxQueued, this.queued);

    let excess = this.queued - this.maxBytes;
    if (excess > 0) excess += excess % 2;
    while (excess > 0) {
      const first = this.arrivals[0];
      if (!first) break;
      if (first.bytes.byteLength <= excess) {
        this.arrivals.shift();
        this.queued -= first.bytes.byteLength;
        this.dropped += first.bytes.byteLength;
        excess -= first.bytes.byteLength;
      } else {
        first.bytes = first.bytes.subarray(excess);
        this.queued -= excess;
        this.dropped += excess;
        excess = 0;
      }
    }
  }

  /** Take one block from the front, or null if a whole block has not arrived yet. */
  take(blockBytes: number): QueueBlock | null {
    if (this.queued < blockBytes) return null;
    const first = this.arrivals[0];
    if (!first) return null;
    const arrivedAt = first.arrivedAt;
    const out = new Uint8Array(blockBytes);
    let filled = 0;
    while (filled < blockBytes) {
      const head = this.arrivals[0];
      if (!head) break;
      const take = Math.min(blockBytes - filled, head.bytes.byteLength);
      out.set(head.bytes.subarray(0, take), filled);
      filled += take;
      if (take === head.bytes.byteLength) this.arrivals.shift();
      else head.bytes = head.bytes.subarray(take);
    }
    this.queued -= filled;
    return { bytes: out, arrivedAt };
  }

  /** Forget everything queued (a capture gap). Not counted as dropped: it was never going to be heard. */
  clear(): void {
    this.arrivals.length = 0;
    this.queued = 0;
  }
}

/** p95 and mean of a bounded sample of durations. */
export function summarize(values: readonly number[]): { mean: number; p95: number; max: number } {
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  return { mean, p95, max: sorted[sorted.length - 1] ?? 0 };
}
