/**
 * An amplitude source backed by a real Web Audio `AnalyserNode`.
 *
 * This is the only thing in Axon that produces a non-zero level, and it does
 * so by measuring samples that are on their way to the speakers. There is no
 * timer, no oscillator, no "speaking so animate" heuristic anywhere in the
 * path: if the orb moves, audio is moving it, and when the audio is silent the
 * measurement is silent too.
 *
 * That matters beyond honesty. An animation driven by a clock and an animation
 * driven by the waveform look different — the second one lands on consonants
 * and pauses where the voice does, and people notice.
 *
 * RMS rather than peak: peak follows single-sample spikes and produces a
 * jittery, percussive response, while RMS tracks perceived loudness, which is
 * what a listener expects the motion to correspond to.
 */

import type { AmplitudeSource } from './amplitude.js';

/**
 * Maps RMS to the orb's 0..1 range.
 *
 * Speech RMS sits well below full scale — a normalised utterance rarely
 * exceeds ~0.25 — so raw RMS would barely move the geometry. This scales that
 * working range up rather than applying gain to the audio, which would change
 * what the user hears to suit the animation.
 */
const RMS_FULL_SCALE = 0.28;

/** Below this, treat it as silence. Suppresses dither and DC offset. */
const NOISE_FLOOR = 0.006;

/** Perceptual curve. Speech spends most of its time quiet; 0.7 lifts that. */
const CURVE = 0.7;

export class AnalyserAmplitudeSource implements AmplitudeSource {
  /**
   * Which graph this is measuring.
   *
   * Named rather than fixed because there are now two: the speech playback
   * graph on the way to the speakers, and the microphone graph on the way in.
   * The measurement is identical — RMS of real samples — and it is worth being
   * able to tell at a glance which one is driving the orb.
   */
  readonly name: string;

  private readonly analyser: AnalyserNode;
  /**
   * Explicitly backed by an `ArrayBuffer`, not `ArrayBufferLike`.
   *
   * `getByteTimeDomainData` will not accept a view over a `SharedArrayBuffer`,
   * and the default `Uint8Array` type admits one.
   */
  private readonly samples: Uint8Array<ArrayBuffer>;
  private detached = false;

  constructor(analyser: AnalyserNode, name = 'speech-analyser') {
    this.analyser = analyser;
    this.name = name;
    // One reused buffer. Allocating per frame would hand the GC ~60 arrays a
    // second during every utterance.
    this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }

  /**
   * Stop reporting.
   *
   * Called when playback ends. Without it the source keeps reading a
   * disconnected analyser, which returns silence anyway — but "returns zero
   * because it was told to stop" and "returns zero because the graph happens
   * to be quiet" are different claims, and the orb should be driven by the
   * first one once speech is over.
   */
  detach(): void {
    this.detached = true;
  }

  level(): number {
    if (this.detached) return 0;

    // Time domain: the waveform itself, centred on 128 in byte form.
    this.analyser.getByteTimeDomainData(this.samples);

    let sumSquares = 0;
    for (let i = 0; i < this.samples.length; i += 1) {
      const deviation = ((this.samples[i] ?? 128) - 128) / 128;
      sumSquares += deviation * deviation;
    }

    const rms = Math.sqrt(sumSquares / this.samples.length);
    if (rms < NOISE_FLOOR) return 0;

    const normalised = Math.min(1, rms / RMS_FULL_SCALE);
    return Math.pow(normalised, CURVE);
  }
}
