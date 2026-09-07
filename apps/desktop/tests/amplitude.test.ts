/**
 * The amplitude source that drives the orb while Axon speaks.
 *
 * WHAT IS AND IS NOT FAKED HERE.
 *
 * The `AnalyserNode` is a stub, because Node has no Web Audio implementation.
 * The *samples* are not faked: each test generates a real waveform — silence,
 * a sine at a known amplitude, a clipped square — encodes it the way
 * `getByteTimeDomainData` does (unsigned bytes centred on 128), and runs it
 * through the production RMS code. So what is under test is the real
 * measurement path, fed real audio.
 *
 * The distinction matters because the thing being asserted is precisely that
 * the orb's motion comes from audio. A test that fed it invented numbers would
 * be asserting the opposite of the property we care about.
 */

import { describe, expect, it, vi } from 'vitest';
import { AnalyserAmplitudeSource } from '../src/renderer/components/orb/analyser-amplitude';
import { SilentAmplitudeSource, SmoothedAmplitudeSource } from '../src/renderer/components/orb/amplitude';

const FFT_SIZE = 1024;

/**
 * A stand-in for `AnalyserNode` that hands back a waveform we generated.
 *
 * Only the two members the source touches are implemented; anything else it
 * reached for would be a change worth failing on.
 */
function analyserWith(waveform: Float32Array): AnalyserNode {
  const bytes = new Uint8Array(waveform.length);
  for (let i = 0; i < waveform.length; i += 1) {
    // Exactly the encoding the Web Audio API uses: signed -1..1 mapped onto
    // unsigned bytes centred on 128.
    const clamped = Math.max(-1, Math.min(1, waveform[i] ?? 0));
    bytes[i] = Math.round(clamped * 128 + 128);
  }

  return {
    fftSize: waveform.length,
    getByteTimeDomainData: (target: Uint8Array): void => {
      target.set(bytes.subarray(0, target.length));
    },
  } as unknown as AnalyserNode;
}

/** Digital silence: every sample at zero. */
function silence(length = FFT_SIZE): Float32Array {
  return new Float32Array(length);
}

/** A sine at a given peak amplitude. RMS is peak / sqrt(2). */
function sine(peak: number, length = FFT_SIZE, cycles = 8): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin((i / length) * cycles * 2 * Math.PI) * peak;
  }
  return out;
}

/** Full-scale square wave — the loudest thing representable. */
function square(length = FFT_SIZE): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 2 === 0 ? 1 : -1;
  return out;
}

// ---------------------------------------------------------------------------

describe('amplitude from real samples', () => {
  it('reports zero for digital silence', () => {
    const source = new AnalyserAmplitudeSource(analyserWith(silence()));
    expect(source.level()).toBe(0);
  });

  it('reports zero for a signal below the noise floor', () => {
    // Dither and DC offset should not make the orb twitch.
    const source = new AnalyserAmplitudeSource(analyserWith(sine(0.002)));
    expect(source.level()).toBe(0);
  });

  it('reports a non-zero level for audible speech-level audio', () => {
    const source = new AnalyserAmplitudeSource(analyserWith(sine(0.2)));
    expect(source.level()).toBeGreaterThan(0.2);
  });

  it('rises monotonically across the working range', () => {
    // Below saturation only. A sine peaking at ~0.4 already has an RMS at the
    // full-scale point, and everything above it is deliberately clamped to 1 -
    // asserting strict growth up there would be asserting against the clamp.
    const levels = [0.02, 0.05, 0.1, 0.15, 0.2].map((peak) =>
      new AnalyserAmplitudeSource(analyserWith(sine(peak))).level(),
    );

    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    }
  });

  it('clamps everything above the working range to full scale', () => {
    for (const peak of [0.5, 0.8, 1]) {
      expect(new AnalyserAmplitudeSource(analyserWith(sine(peak))).level()).toBe(1);
    }
  });

  it('saturates at 1 rather than overshooting', () => {
    // The orb's geometry assumes 0..1; a level above it would distort.
    const source = new AnalyserAmplitudeSource(analyserWith(square()));
    expect(source.level()).toBeLessThanOrEqual(1);
    expect(source.level()).toBeGreaterThan(0.9);
  });

  it('stays within 0..1 for every input we can represent', () => {
    for (const peak of [0, 0.001, 0.01, 0.1, 0.5, 1]) {
      const level = new AnalyserAmplitudeSource(analyserWith(sine(peak))).level();
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it('reports zero once detached, whatever the analyser still holds', () => {
    // Playback ending must stop the orb reacting, even if the graph is not yet
    // torn down.
    const source = new AnalyserAmplitudeSource(analyserWith(sine(0.5)));
    expect(source.level()).toBeGreaterThan(0);

    source.detach();

    expect(source.level()).toBe(0);
  });

  it('does not read the analyser at all after detaching', () => {
    let reads = 0;
    const analyser = {
      fftSize: FFT_SIZE,
      getByteTimeDomainData: (): void => {
        reads += 1;
      },
    } as unknown as AnalyserNode;

    const source = new AnalyserAmplitudeSource(analyser);
    source.level();
    expect(reads).toBe(1);

    source.detach();
    source.level();
    source.level();

    expect(reads).toBe(1);
  });

  it('reuses one buffer instead of allocating per frame', () => {
    // 60 allocations a second for the length of every utterance is the kind of
    // garbage that shows up as jank in the animation it is driving.
    const seen = new Set<Uint8Array>();
    const analyser = {
      fftSize: FFT_SIZE,
      getByteTimeDomainData: (target: Uint8Array): void => {
        seen.add(target);
      },
    } as unknown as AnalyserNode;

    const source = new AnalyserAmplitudeSource(analyser);
    for (let i = 0; i < 10; i += 1) source.level();

    expect(seen.size).toBe(1);
  });
});

describe('the silent source', () => {
  it('reports nothing, which is what "no audio attached" means', () => {
    expect(new SilentAmplitudeSource().level()).toBe(0);
  });
});

describe('smoothing', () => {
  it('approaches a steady signal without overshooting it', () => {
    const clock = vi.spyOn(performance, 'now');
    let t = 0;
    clock.mockImplementation(() => t);

    const source = new SmoothedAmplitudeSource(new AnalyserAmplitudeSource(analyserWith(sine(0.1))), 0.01, 0.05);

    let level = 0;
    for (let i = 0; i < 60; i += 1) {
      t += 16;
      level = source.level();
    }
    clock.mockRestore();

    const raw = new AnalyserAmplitudeSource(analyserWith(sine(0.1))).level();
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThanOrEqual(raw + 1e-6);
  });

  it('decays toward zero when the audio stops', () => {
    // The follower is frame-rate independent: it advances by wall-clock delta,
    // not by call count. A tight loop therefore barely moves it, which is the
    // correct behaviour and means the clock has to be driven explicitly.
    const clock = vi.spyOn(performance, 'now');
    let t = 0;
    clock.mockImplementation(() => t);

    try {
      const inner = new AnalyserAmplitudeSource(analyserWith(sine(0.5)));
      const source = new SmoothedAmplitudeSource(inner, 0.01, 0.02);

      for (let i = 0; i < 30; i += 1) {
        t += 16;
        source.level();
      }
      const whileLoud = source.level();

      inner.detach();
      for (let i = 0; i < 30; i += 1) {
        t += 16;
        source.level();
      }

      expect(whileLoud).toBeGreaterThan(0.1);
      expect(source.level()).toBeLessThan(0.05);
    } finally {
      clock.mockRestore();
    }
  });

  it('never reports a level the source did not justify', () => {
    // Smoothing shapes a real signal; it must not invent one.
    const source = new SmoothedAmplitudeSource(new SilentAmplitudeSource());
    for (let i = 0; i < 100; i += 1) expect(source.level()).toBe(0);
  });
});
