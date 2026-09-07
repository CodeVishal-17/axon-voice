/**
 * Amplitude sources.
 *
 * The orb reacts to a single scalar in 0..1, sampled once per frame. Today the
 * only implementation returns silence, because no microphone is connected yet
 * and inventing a signal would make the interface lie about what Axon can
 * hear.
 *
 * In Step 4 the microphone `AudioWorklet` implements this interface, and in
 * Step 3 the text-to-speech playback graph implements it for the speaking
 * state. Neither will require a change to the renderer: they are constructed
 * where the audio lives and handed in.
 */

export interface AmplitudeSource {
  readonly name: string;
  /** Current level, 0..1. Called once per animation frame. */
  level(): number;
}

/**
 * The default source: no audio pipeline attached.
 *
 * The orb still moves under this source — it has its own intrinsic motion —
 * but every part of the animation that is labelled "reactive" contributes
 * exactly zero. What you see is the orb breathing, not audio.
 */
export class SilentAmplitudeSource implements AmplitudeSource {
  readonly name = 'silent';

  level(): number {
    return 0;
  }
}

/**
 * Smooths a raw source with an asymmetric follower: quick to rise, slow to
 * fall.
 *
 * Raw RMS from a microphone is far too jittery to drive geometry — a ring
 * driven by it flickers rather than breathes. Fast attack keeps the response
 * feeling immediate; slow release keeps it from strobing between syllables.
 */
export class SmoothedAmplitudeSource implements AmplitudeSource {
  readonly name: string;

  private value = 0;
  private lastSampleAt = 0;

  constructor(
    private readonly inner: AmplitudeSource,
    private readonly attackSeconds = 0.05,
    private readonly releaseSeconds = 0.25,
  ) {
    this.name = `smoothed(${inner.name})`;
  }

  level(): number {
    const now = performance.now();
    const dt = this.lastSampleAt === 0 ? 1 / 60 : Math.min((now - this.lastSampleAt) / 1000, 0.1);
    this.lastSampleAt = now;

    const target = Math.max(0, Math.min(1, this.inner.level()));
    const tau = target > this.value ? this.attackSeconds : this.releaseSeconds;
    // Frame-rate independent exponential approach.
    const k = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
    this.value += (target - this.value) * k;
    return this.value;
  }
}
