/**
 * The renderer's microphone capture.
 *
 * Vitest runs in Node, where there is no `AudioContext`, no `MediaStream` and
 * no `getUserMedia`. What can be tested here honestly is everything that is
 * pure: the sample conversion, the resampler, and the mapping from a browser's
 * device error onto the closed enum that crosses the IPC boundary.
 *
 * The parts that need a browser — the node graph, the track lifecycle, the
 * `AudioContext` teardown — are covered by the architectural rules in
 * `architecture.test.ts` (which constrain what this module may do at all) and
 * by manual verification in the running app. Simulating a Web Audio graph in
 * Node and calling the result a microphone test would be the kind of fake this
 * milestone was explicit about avoiding.
 */

import { describe, expect, it } from 'vitest';
import { classifyMediaError, resample, toPcm16 } from '../src/renderer/audio/microphone.js';

describe('converting samples to 16-bit PCM', () => {
  it('maps silence to zero', () => {
    expect(Array.from(toPcm16(new Float32Array([0, 0, 0])))).toEqual([0, 0, 0]);
  });

  it('maps full scale to the ends of the range', () => {
    const out = toPcm16(new Float32Array([1, -1]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it('is linear in between', () => {
    const out = toPcm16(new Float32Array([0.5, -0.5]));
    expect(out[0]).toBeCloseTo(16383, -1);
    expect(out[1]).toBeCloseTo(-16384, -1);
  });

  it('clamps rather than wrapping around', () => {
    // Automatic gain control can push a sample past full scale. Wrapping would
    // turn a loud moment into a click — audible, and a spike the voice
    // activity detector would read as the start of speech.
    const out = toPcm16(new Float32Array([1.5, -1.5, 12, -12]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(32767);
    expect(out[3]).toBe(-32768);
  });

  it('survives a NaN without producing garbage', () => {
    const out = toPcm16(new Float32Array([Number.NaN]));
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it('preserves length', () => {
    expect(toPcm16(new Float32Array(1024)).length).toBe(1024);
    expect(toPcm16(new Float32Array(0)).length).toBe(0);
  });
});

describe('resampling to the recognizer rate', () => {
  it('does nothing when the rates already match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(input, 16_000, 16_000)).toBe(input);
  });

  it('shortens correctly when downsampling', () => {
    const input = new Float32Array(48_000);
    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(16_000);
  });

  it('preserves a constant signal', () => {
    const input = new Float32Array(4_800).fill(0.5);
    const out = resample(input, 48_000, 16_000);
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 5);
  });

  it('preserves the shape of a ramp', () => {
    // Linear interpolation of a linear signal is exact, which makes this a
    // real check rather than a smoke test.
    const input = new Float32Array(300);
    for (let i = 0; i < input.length; i += 1) input[i] = i / input.length;

    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(100);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[50]).toBeCloseTo(150 / 300, 3);
  });

  it('roughly preserves loudness, which is what the detector measures', () => {
    const input = new Float32Array(9_600);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((i / 48_000) * 2 * Math.PI * 220) * 0.4;

    const rms = (samples: Float32Array): number =>
      Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);

    expect(rms(resample(input, 48_000, 16_000))).toBeCloseTo(rms(input), 1);
  });

  it('refuses a nonsensical rate rather than dividing by zero', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resample(input, 0, 16_000)).toBe(input);
    expect(resample(input, 16_000, 0)).toBe(input);
    expect(resample(input, -1, 16_000)).toBe(input);
  });
});

describe('classifying a device error', () => {
  const error = (name: string): Error => Object.assign(new Error('a message naming C:\\devices\\mic'), { name });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'device-error'],
    ['AbortError', 'device-error'],
    ['SomethingUnexpected', 'capture-error'],
  ])('maps %s to %s', (name, expected) => {
    expect(classifyMediaError(error(name))).toBe(expected);
  });

  it('handles a thrown non-error', () => {
    expect(classifyMediaError('nope')).toBe('capture-error');
    expect(classifyMediaError(null)).toBe('capture-error');
    expect(classifyMediaError(undefined)).toBe('capture-error');
  });

  it('discards the message, which can name hardware and user accounts', () => {
    // The returned value is a fixed enum member. There is no path by which the
    // browser's own text reaches an event, a log, or the screen.
    const failure = classifyMediaError(error('NotReadableError'));
    expect(failure).toBe('device-error');
    expect(failure).not.toContain('C:');
  });
});
