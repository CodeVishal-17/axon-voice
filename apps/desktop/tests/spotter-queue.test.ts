/**
 * The spotter's audio queue: bounded, drops the stalest audio, measures honestly.
 *
 * A human wake test reported the detector "3629 ms behind live audio" with
 * frames "dropped rather than queued". Measurement found two things: the capture
 * page upstream was delivering only 65% of real-time audio (fixed in
 * `microphone.ts`), and the spotter's own structure had it backwards under
 * pressure — it decoded inside the stdin handler, the parent's pipe filled, and
 * the parent dropped the NEWEST frames while older ones waited. These tests hold
 * the replacement to the brief: bounded, drop stale, prioritise fresh, and a
 * backlog number that cannot be faked by audio that never arrived.
 */

import { describe, expect, it } from 'vitest';
import { SpotterAudioQueue, summarize } from '../src/main/wake/kws-queue.js';

/** `n` bytes whose value is their chunk id, so tests can see what survived. */
const chunk = (n: number, id: number): Uint8Array => new Uint8Array(n).fill(id);

describe('a queue that keeps up', () => {
  it('returns whole blocks in arrival order', () => {
    const queue = new SpotterAudioQueue(16_000);
    queue.push(chunk(2_048, 1), 0);
    queue.push(chunk(2_048, 2), 64);
    const block = queue.take(3_200);
    expect(block?.bytes.byteLength).toBe(3_200);
    expect(block?.bytes[0]).toBe(1);
    expect(block?.bytes[2_048]).toBe(2);
    expect(queue.queuedBytes).toBe(896);
  });

  it('does not hand out a partial block', () => {
    const queue = new SpotterAudioQueue(16_000);
    queue.push(chunk(3_198, 1), 0);
    expect(queue.take(3_200)).toBeNull();
    queue.push(chunk(2, 2), 10);
    expect(queue.take(3_200)?.bytes.byteLength).toBe(3_200);
  });

  it('stamps a block with when its FIRST byte arrived', () => {
    const queue = new SpotterAudioQueue(16_000);
    queue.push(chunk(1_000, 1), 100);
    queue.push(chunk(3_000, 2), 164);
    expect(queue.take(3_200)?.arrivedAt).toBe(100);
    // The next block begins inside the second chunk.
    queue.push(chunk(3_000, 3), 228);
    expect(queue.take(3_200)?.arrivedAt).toBe(164);
  });

  it('reports zero age when it holds nothing, and the oldest byte otherwise', () => {
    const queue = new SpotterAudioQueue(16_000);
    expect(queue.oldestAgeMs(500)).toBe(0);
    queue.push(chunk(100, 1), 400);
    expect(queue.oldestAgeMs(500)).toBe(100);
  });

  it('copies what it is given, so a reused buffer cannot change queued audio', () => {
    const queue = new SpotterAudioQueue(16_000);
    const buffer = chunk(3_200, 7);
    queue.push(buffer, 0);
    buffer.fill(9);
    expect(queue.take(3_200)?.bytes[0]).toBe(7);
  });
});

describe('a queue under pressure', () => {
  it('never holds more than its bound', () => {
    const queue = new SpotterAudioQueue(16_000);
    for (let i = 0; i < 100; i += 1) {
      queue.push(chunk(2_048, i % 250), i * 64);
      expect(queue.queuedBytes).toBeLessThanOrEqual(16_000);
    }
  });

  it('drops the OLDEST audio and keeps the newest', () => {
    const queue = new SpotterAudioQueue(8_000);
    queue.push(chunk(4_000, 1), 0);
    queue.push(chunk(4_000, 2), 100);
    queue.push(chunk(4_000, 3), 200); // overfills by 4000: chunk 1 goes
    const first = queue.take(4_000);
    expect(first?.bytes[0]).toBe(2);
    expect(queue.take(4_000)?.bytes[0]).toBe(3);
    expect(queue.droppedBytes).toBe(4_000);
  });

  it('trims inside a chunk by whole samples, never splitting a 16-bit value', () => {
    const queue = new SpotterAudioQueue(5_000);
    queue.push(chunk(4_000, 1), 0);
    queue.push(chunk(1_001, 2), 10); // 5001 queued: odd excess must round up to 2 bytes
    expect(queue.droppedBytes % 2).toBe(0);
    expect(queue.queuedBytes % 2).toBe(1); // only the odd arrival itself, not a split sample
    expect(queue.droppedBytes).toBe(2);
  });

  it('rounds an odd bound down so trimming stays sample-aligned', () => {
    expect(new SpotterAudioQueue(16_001).maxBytes).toBe(16_000);
  });

  it('counts every dropped byte — the drop is reported, never hidden', () => {
    const queue = new SpotterAudioQueue(4_000);
    for (let i = 0; i < 10; i += 1) queue.push(chunk(2_000, i), i);
    expect(queue.droppedBytes + queue.queuedBytes).toBe(20_000);
    expect(queue.maxQueuedBytes).toBe(6_000);
  });

  it('a stalled decoder resumes on FRESH audio: the block it gets is recent, not seconds old', () => {
    // Ten seconds of 64 ms frames arrive while nothing is decoded.
    const queue = new SpotterAudioQueue(16_000); // half a second
    for (let t = 0; t < 10_000; t += 64) queue.push(chunk(2_048, 1), t);
    const block = queue.take(3_200);
    // The oldest surviving audio is from the last half second, not t = 0.
    expect(10_000 - (block?.arrivedAt ?? 0)).toBeLessThanOrEqual(600);
  });

  it('forgets everything on a capture gap without calling it dropped', () => {
    const queue = new SpotterAudioQueue(16_000);
    queue.push(chunk(3_000, 1), 0);
    queue.clear();
    expect(queue.queuedBytes).toBe(0);
    expect(queue.droppedBytes).toBe(0);
    expect(queue.take(2)).toBeNull();
  });

  it('refuses a queue that could not hold a single sample', () => {
    expect(() => new SpotterAudioQueue(1)).toThrow(RangeError);
  });
});

describe('timing summaries', () => {
  it('reports mean, p95 and max, and zeros for no data', () => {
    expect(summarize([])).toEqual({ mean: 0, p95: 0, max: 0 });
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const summary = summarize(values);
    expect(summary.mean).toBeCloseTo(50.5);
    expect(summary.p95).toBe(96);
    expect(summary.max).toBe(100);
  });
});
