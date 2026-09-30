/**
 * Counting what the microphone page actually produces.
 *
 * PURE. No DOM, no audio APIs, no timers — the capture code hands it numbers
 * and it hands back a `CaptureDiagnostics` window. It holds running sums and
 * maxima, never a sample: after `record` returns, nothing of the audio it was
 * shown remains here except how loud it was.
 *
 * Why it exists: a wake detector that "falls seconds behind" and a transcript
 * that is "extremely wrong" can both be the page failing to deliver real-time
 * audio — a starved callback, a context running at a rate nobody expected, a
 * silent device. Those are all visible as numbers, and this is where they are
 * counted.
 */

import type { CaptureDiagnostics } from '@axon/core';

/** A callback whose peak is below this is counted as silent. About -54 dBFS. */
export const SILENCE_PEAK = 0.002;

export interface CaptureFormat {
  readonly captureId: string;
  readonly pipeline: 'track-processor' | 'script-processor';
  readonly targetSampleRate: number;
  readonly contextSampleRate: number;
  readonly trackSampleRate: number | null;
  readonly trackChannelCount: number | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
}

export class CaptureDiagnosticsWindow {
  private format: CaptureFormat;
  private startedAt: number;
  private audioClockStart: number | null = null;
  private audioClockLast = 0;
  private lastCallbackAt: number | null = null;
  private callbacks = 0;
  private produced = 0;
  private maxGap = 0;
  private sumSquares = 0;
  private sampleCount = 0;
  private peak = 0;
  private silent = 0;
  private clipped = 0;

  constructor(format: CaptureFormat, now: number) {
    this.format = format;
    this.startedAt = now;
  }

  /**
   * One processing callback.
   *
   * `input` is the context-rate block as captured (before resampling, so
   * clipping is seen before conversion hides it); `producedSamples` is how many
   * target-rate samples were sent on; `audioClock` is `AudioContext.currentTime`
   * in seconds.
   */
  record(input: Float32Array, producedSamples: number, now: number, audioClock: number): void {
    this.callbacks += 1;
    this.produced += producedSamples;
    if (this.lastCallbackAt !== null) this.maxGap = Math.max(this.maxGap, now - this.lastCallbackAt);
    this.lastCallbackAt = now;
    if (this.audioClockStart === null) this.audioClockStart = audioClock;
    this.audioClockLast = audioClock;

    let blockPeak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i] ?? 0;
      const magnitude = Math.abs(sample);
      if (magnitude > blockPeak) blockPeak = magnitude;
      if (magnitude >= 1) this.clipped += 1;
      this.sumSquares += sample * sample;
    }
    this.sampleCount += input.length;
    if (blockPeak > this.peak) this.peak = blockPeak;
    if (blockPeak < SILENCE_PEAK) this.silent += 1;
  }

  /** The source rate is only known once the first frame arrives on the track path. */
  setSourceRate(rate: number): void {
    if (this.format.contextSampleRate !== rate) this.format = { ...this.format, contextSampleRate: rate };
  }

  /** Whether a window's worth of wall time has passed. */
  due(now: number, intervalMs: number): boolean {
    return now - this.startedAt >= intervalMs;
  }

  /** Close the window: report it, and start the next one from `now`. */
  take(now: number): CaptureDiagnostics {
    const report: CaptureDiagnostics = {
      ...this.format,
      windowMs: Math.round(now - this.startedAt),
      callbacks: this.callbacks,
      producedMs: Math.round((this.produced / this.format.targetSampleRate) * 1000),
      audioClockMs: this.audioClockStart === null ? 0 : Math.round((this.audioClockLast - this.audioClockStart) * 1000),
      maxCallbackGapMs: Math.round(this.maxGap),
      rms: this.sampleCount === 0 ? 0 : Math.sqrt(this.sumSquares / this.sampleCount),
      peak: this.peak,
      silentCallbacks: this.silent,
      clippedSamples: this.clipped,
    };
    this.startedAt = now;
    // The audio clock continues from where this window ended, so consecutive
    // windows measure consecutive stretches rather than overlapping ones.
    this.audioClockStart = this.audioClockStart === null ? null : this.audioClockLast;
    this.callbacks = 0;
    this.produced = 0;
    this.maxGap = 0;
    this.sumSquares = 0;
    this.sampleCount = 0;
    this.peak = 0;
    this.silent = 0;
    this.clipped = 0;
    return report;
  }
}
