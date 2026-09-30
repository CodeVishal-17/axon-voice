/**
 * The audio Axon sends is the audio it thinks it sends.
 *
 * Severe misrecognition has causes that live entirely before a recognizer: a
 * wrong sample rate, aliasing from a resampler with no low-pass, a phase jump at
 * every block boundary, a PCM conversion that wraps instead of clipping, bytes in
 * the wrong order. Each of those is a number, and each is checked here against
 * the real conversion code — the same functions the capture page runs.
 */

import { describe, expect, it } from 'vitest';
import { StreamingResampler, downmix } from '../src/renderer/audio/resampler.js';
import { resample, toPcm16 } from '../src/renderer/audio/microphone.js';
import { CaptureDiagnosticsWindow, SILENCE_PEAK } from '../src/renderer/audio/capture-diagnostics.js';

const sine = (frequency: number, rate: number, seconds: number, amplitude = 0.5): Float32Array => {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
};

/** Run a stream through a resampler in blocks of `block` samples. */
const inBlocks = (resampler: StreamingResampler, input: Float32Array, block: number): Float32Array => {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += block) parts.push(resampler.process(input.subarray(i, i + block)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const rms = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Amplitude of one frequency, by correlation. */
const toneAmplitude = (x: Float32Array, frequency: number, rate: number, from: number): number => {
  let re = 0;
  let im = 0;
  for (let i = from; i < x.length; i += 1) {
    re += (x[i] ?? 0) * Math.cos((2 * Math.PI * frequency * i) / rate);
    im += (x[i] ?? 0) * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return (2 * Math.hypot(re, im)) / (x.length - from);
};

describe('the streaming resampler', () => {
  for (const [from, to] of [
    [48_000, 16_000],
    [48_000, 24_000],
    [44_100, 24_000],
    [44_100, 16_000],
  ] as const) {
    describe(`${from} -> ${to} Hz`, () => {
      it('produces the right amount of audio, with no drift over a minute', () => {
        const resampler = new StreamingResampler(from, to);
        let produced = 0;
        const block = new Float32Array(Math.round(from / 100)); // 10 ms, like a capture track
        for (let i = 0; i < 6_000; i += 1) produced += resampler.process(block).length;
        // Sixty seconds in; within one kernel of sixty seconds out.
        expect(Math.abs(produced - to * 60)).toBeLessThan(100);
      });

      it('passes speech-band tones at their true frequency and amplitude', () => {
        const resampler = new StreamingResampler(from, to);
        const out = inBlocks(resampler, sine(1_000, from, 1), Math.round(from / 100));
        expect(toneAmplitude(out, 1_000, to, 200)).toBeGreaterThan(0.48);
        expect(toneAmplitude(out, 1_000, to, 200)).toBeLessThan(0.52);
      });

      it('removes energy above the target Nyquist instead of folding it into speech', () => {
        // A tone above the target's Nyquist would alias to (rate - f); after a
        // proper low-pass there is almost nothing left at all.
        const above = to / 2 + 2_000;
        const resampler = new StreamingResampler(from, to);
        const out = inBlocks(resampler, sine(above, from, 1), Math.round(from / 100));
        expect(rms(out, 200)).toBeLessThan(0.01);
      });

      it('gives the same output whatever the block size — no phase jump at block boundaries', () => {
        const input = sine(440, from, 0.5);
        const whole = new StreamingResampler(from, to).process(input);
        for (const block of [1, 7, 128, 441, 1024]) {
          const pieces = inBlocks(new StreamingResampler(from, to), input, block);
          const n = Math.min(whole.length, pieces.length);
          expect(Math.abs(whole.length - pieces.length)).toBeLessThanOrEqual(1);
          let worst = 0;
          for (let i = 0; i < n; i += 1) worst = Math.max(worst, Math.abs((whole[i] ?? 0) - (pieces[i] ?? 0)));
          expect(worst, `block ${block}`).toBeLessThan(1e-6);
        }
      });
    });
  }

  it('keeps DC exactly, so silence is silence and offsets are not invented', () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const out = inBlocks(resampler, new Float32Array(48_000).fill(0.25), 480);
    for (let i = 100; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0.25, 5);
  });

  it('passes samples through untouched when the rates already match', () => {
    const resampler = new StreamingResampler(24_000, 24_000);
    const block = sine(300, 24_000, 0.01);
    expect(resampler.process(block)).toBe(block);
  });

  it('holds bounded history, not the stream', () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    for (let i = 0; i < 1_000; i += 1) resampler.process(new Float32Array(480));
    const history = (resampler as unknown as { history: Float32Array }).history;
    expect(history.length).toBeLessThan(400);
  });

  it('refuses a nonsense rate rather than dividing by it', () => {
    expect(() => new StreamingResampler(0, 16_000)).toThrow(RangeError);
    expect(() => new StreamingResampler(48_000, -1)).toThrow(RangeError);
  });
});

describe('the old per-block linear resampler, measured (why it was replaced)', () => {
  it('aliases: a 10 kHz tone taken to 16 kHz survives, inside one block, as a 6 kHz tone', () => {
    // Measured within ONE block. Across blocks the old helper's phase restarts
    // at every boundary, which scrambles the aliased tone's phase and makes a
    // whole-stream measurement cancel out — a second defect, not an absence of
    // the first.
    const out = resample(sine(10_000, 48_000, 0.25).subarray(0, 12_000), 48_000, 16_000);
    expect(toneAmplitude(out, 6_000, 16_000, 0)).toBeGreaterThan(0.4);
    // The replacement, same input, same measurement.
    const fixed = new StreamingResampler(48_000, 16_000).process(sine(10_000, 48_000, 0.25));
    expect(toneAmplitude(fixed, 6_000, 16_000, 200)).toBeLessThan(0.01);
  });

  it('loses audio at a non-integer ratio, a little in every block', () => {
    let produced = 0;
    for (let i = 0; i < 1_000; i += 1) produced += resample(new Float32Array(1024), 44_100, 24_000).length;
    const exact = (1_000 * 1024 * 24_000) / 44_100;
    expect(exact - produced).toBeGreaterThan(100);
  });
});

describe('downmixing to mono', () => {
  it('averages channels deterministically and never interleaves', () => {
    const left = new Float32Array([1, 0.5, -1, 0]);
    const right = new Float32Array([0, 0.5, 1, 0.2]);
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, 0, 0.10000000149011612]);
    expect(downmix([left, right])).toHaveLength(4);
  });

  it('returns a mono channel unchanged and an empty layout as empty', () => {
    const mono = new Float32Array([0.1, 0.2]);
    expect(downmix([mono])).toBe(mono);
    expect(downmix([])).toHaveLength(0);
  });
});

describe('Float32 -> signed 16-bit PCM', () => {
  it('maps the representative values exactly', () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(pcm)).toEqual([0, 32_767, -32_768, 16_383, -16_384]);
  });

  it('clips instead of wrapping, so an over-range sample is loud, not a click of the opposite sign', () => {
    const pcm = toPcm16(new Float32Array([1.5, -1.5, 100, -100]));
    expect(Array.from(pcm)).toEqual([32_767, -32_768, 32_767, -32_768]);
  });

  it('turns NaN into silence rather than a garbage sample', () => {
    const pcm = toPcm16(new Float32Array([Number.NaN]));
    expect(pcm[0]).toBe(0);
  });

  it('is little-endian on the wire, which is what AssemblyAI and the spotter read', () => {
    // Main sends `new Uint8Array(samples.buffer)`. That is only PCM16 LE on a
    // little-endian host — true of every machine Axon supports, and asserted
    // here so a port to anything else fails loudly instead of transcribing noise.
    const pcm = toPcm16(new Float32Array([0.5]));
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(Array.from(bytes)).toEqual([16_383 & 0xff, (16_383 >> 8) & 0xff]);
  });

  it('keeps byte alignment: two bytes per sample, whole frames only', () => {
    const pcm = toPcm16(new Float32Array(1024));
    expect(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).byteLength).toBe(2048);
  });
});

describe('capture diagnostics', () => {
  const format = {
    captureId: 'c1',
    pipeline: 'track-processor' as const,
    targetSampleRate: 16_000,
    contextSampleRate: 48_000,
    trackSampleRate: 48_000,
    trackChannelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  it('reports real time when the page produces what the wall clock says it should', () => {
    const window = new CaptureDiagnosticsWindow(format, 0);
    for (let i = 0; i < 100; i += 1) window.record(new Float32Array(480).fill(0.1), 160, i * 10, i * 0.01);
    const report = window.take(1_000);
    expect(report.producedMs).toBe(1_000);
    expect(report.windowMs).toBe(1_000);
    expect(report.audioClockMs).toBe(990);
    expect(report.maxCallbackGapMs).toBe(10);
    expect(report.rms).toBeCloseTo(0.1, 5);
  });

  it('shows a starved page as audio SHORT of wall time, with the gap that caused it', () => {
    const window = new CaptureDiagnosticsWindow(format, 0);
    // Two thirds of the callbacks, spaced out: what was measured at ~30 s.
    for (let i = 0; i < 66; i += 1) window.record(new Float32Array(480), 160, i * 15, i * 0.01);
    const report = window.take(1_000);
    expect(report.producedMs).toBe(660);
    expect(report.maxCallbackGapMs).toBe(15);
  });

  it('counts silence and clipping, and carries no samples', () => {
    const window = new CaptureDiagnosticsWindow(format, 0);
    window.record(new Float32Array(480), 160, 0, 0);
    window.record(new Float32Array([1, -1, SILENCE_PEAK * 10]), 1, 10, 0.01);
    const report = window.take(20);
    expect(report.silentCallbacks).toBe(1);
    expect(report.clippedSamples).toBe(2);
    expect(Object.values(report).every((v) => v === null || ['number', 'boolean', 'string'].includes(typeof v))).toBe(true);
  });

  it('starts each window fresh', () => {
    const window = new CaptureDiagnosticsWindow(format, 0);
    window.record(new Float32Array(480).fill(0.5), 160, 0, 0);
    window.take(10);
    const next = window.take(20);
    expect(next.callbacks).toBe(0);
    expect(next.peak).toBe(0);
  });
});
