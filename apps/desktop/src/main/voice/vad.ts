/**
 * Voice activity detection.
 *
 * WHY THIS RUNS IN MAIN, NOT IN THE RENDERER.
 *
 * VAD is not a visualisation; it is the thing that decides when an utterance
 * is over, and therefore when Axon stops listening and starts thinking. That
 * is a state decision, and state decisions belong to the main process. The
 * renderer measures amplitude too, but only to move the orb — if the two ever
 * disagree, the one that matters is this one, because it is the one holding
 * the audio.
 *
 * WHY NOT A TIMER.
 *
 * A fixed "record for four seconds" would be simpler and would be a lie: it
 * cuts off anyone who pauses to think and it makes everyone else wait after
 * they have finished. This detector works from the audio itself — an energy
 * measurement per frame, an adaptive noise floor, and hysteresis so a quiet
 * syllable between two loud ones does not read as the end of a sentence.
 *
 * WHAT IT DELIBERATELY IS NOT.
 *
 * It is not speech/non-speech classification. A loud cough ends up looking
 * like speech to an energy detector, and that is acceptable: the cost of a
 * false positive here is an empty transcript and a return to IDLE, which the
 * listening service already handles as a normal outcome. A model-based VAD
 * would be more precise and would add a model, a download and a second thing
 * to keep alive — for a push-to-talk interaction where the user has already
 * signalled intent, that trade is not worth making.
 *
 * TIME IS MEASURED IN SAMPLES, NOT ON A CLOCK. Every threshold below is
 * expressed in milliseconds of *audio*, derived from how many samples have
 * arrived. That makes the detector deterministic and testable, and it means a
 * renderer that sends frames faster than real time cannot stretch an utterance
 * past its limit.
 */

import { LISTENING_LIMITS } from '@axon/core';

/** What the detector concluded from the frame it was just given. */
export type VadEvent =
  | 'none'
  /** The first frames of speech. Emitted once per utterance. */
  | 'speech-started'
  /** Enough trailing silence after speech to call the utterance finished. */
  | 'speech-ended'
  /** Nothing was ever said. An accidental activation, ending harmlessly. */
  | 'no-speech-timeout'
  /** The duration ceiling. Whatever was said so far is what gets transcribed. */
  | 'max-duration';

export interface VadOptions {
  readonly sampleRate?: number;
  /** Trailing silence that ends an utterance. */
  readonly silenceMs?: number;
  /** How long to wait for speech to begin at all. */
  readonly speechStartTimeoutMs?: number;
  /** Hard ceiling on one utterance. */
  readonly maxUtteranceMs?: number;
  /**
   * Continuous audio above threshold before speech is declared.
   *
   * Guards against a key click, a chair creak or a single-frame spike opening
   * an utterance that then waits out the full silence window.
   */
  readonly onsetMs?: number;
  /** RMS below which nothing is ever treated as speech, whatever the room. */
  readonly absoluteThreshold?: number;
  /** How far above the measured noise floor speech has to be. */
  readonly noiseRatio?: number;
  /** Fraction of the speech threshold below which audio counts as silence. */
  readonly releaseRatio?: number;
  /** Audio measured before any of it may be judged. See `calibrationMs`. */
  readonly calibrationMs?: number;
}

const DEFAULTS = {
  silenceMs: LISTENING_LIMITS.silenceMs,
  speechStartTimeoutMs: LISTENING_LIMITS.speechStartTimeoutMs,
  maxUtteranceMs: LISTENING_LIMITS.maxUtteranceMs,
  onsetMs: 120,
  // Speech at a normal distance from a laptop microphone sits around 0.03-0.2
  // RMS; a quiet room sits below 0.005. 0.012 is comfortably between the two
  // and is a floor, not the operating threshold - see `threshold` below.
  absoluteThreshold: 0.012,
  noiseRatio: 3.5,
  releaseRatio: 0.55,
  /**
   * The room is measured before it is judged.
   *
   * A session opens with no idea what the room sounds like, and the starting
   * floor is a guess. In a quiet room the guess is fine; next to a fan, an air
   * conditioner or a laptop with its own speakers on, the room itself sits
   * above the absolute threshold and would be declared speech within a couple
   * of frames — after which the floor freezes, the microphone stays open on
   * nothing, and the transcript comes back empty.
   *
   * So the first fifth of a second is used to measure rather than to decide:
   * the floor follows quickly in both directions and no utterance can open.
   * This costs nothing in practice — a person cannot press a hotkey and be
   * mid-word 200ms later, and the microphone itself takes a comparable time to
   * start. Someone who does begin immediately is still heard, because the
   * measured floor is capped well below a speaking voice.
   */
  calibrationMs: 200,
} as const;

/**
 * How fast the noise floor follows the room, per frame.
 *
 * Deliberately asymmetric, and this asymmetry is load-bearing.
 *
 * Downward is quick: a room that goes quiet should be measured as quiet
 * promptly, so the detector becomes sensitive again soon after a noise stops.
 *
 * Upward is very slow, because rising energy is far more likely to be someone
 * starting to talk than the room getting louder. A symmetric follower has a
 * failure mode that is easy to miss and fatal in use: during the onset window
 * — after audio has gone loud but before it has been declared speech — the
 * floor climbs to meet the voice, the threshold overtakes it, the onset
 * counter resets, and the utterance is never opened at all. Someone talking
 * clearly into the microphone is simply not heard.
 */
const NOISE_ADAPT_DOWN = 0.3;
const NOISE_ADAPT_UP = 0.01;

/** Where the noise floor starts before any audio has been measured. */
const INITIAL_NOISE = 0.002;

/**
 * Ceiling on the measured noise floor.
 *
 * Without one, a genuinely loud room drags the threshold up past the level of
 * ordinary speech and the detector goes deaf. The cap keeps the adaptive
 * threshold at or below roughly 0.1 RMS, which is under a normal speaking
 * voice at a laptop microphone. Past this point an energy detector is the
 * wrong tool anyway; what it must not do is fail silently.
 */
const MAX_NOISE_FLOOR = 0.03;

export interface VadFrameResult {
  readonly event: VadEvent;
  /** RMS of the frame just pushed, 0..1. For diagnostics, never for display. */
  readonly level: number;
  /** Milliseconds of audio seen so far. */
  readonly elapsedMs: number;
}

/** RMS of a frame of 16-bit PCM, normalised to 0..1. */
export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = (frame[i] ?? 0) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / frame.length);
}

export class VoiceActivityDetector {
  private readonly sampleRate: number;
  private readonly silenceMs: number;
  private readonly speechStartTimeoutMs: number;
  private readonly maxUtteranceMs: number;
  private readonly onsetMs: number;
  private readonly absoluteThreshold: number;
  private readonly noiseRatio: number;
  private readonly releaseRatio: number;
  private readonly calibrationMs: number;

  private samples = 0;
  private noiseFloor = INITIAL_NOISE;
  private onsetMsAccumulated = 0;
  private silenceMsAccumulated = 0;
  private speaking = false;
  /** True once the utterance has been closed; further frames are ignored. */
  private finished = false;

  constructor(options: VadOptions = {}) {
    this.sampleRate = options.sampleRate ?? LISTENING_LIMITS.sampleRate;
    this.silenceMs = options.silenceMs ?? DEFAULTS.silenceMs;
    this.speechStartTimeoutMs = options.speechStartTimeoutMs ?? DEFAULTS.speechStartTimeoutMs;
    this.maxUtteranceMs = options.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs;
    this.onsetMs = options.onsetMs ?? DEFAULTS.onsetMs;
    this.absoluteThreshold = options.absoluteThreshold ?? DEFAULTS.absoluteThreshold;
    this.noiseRatio = options.noiseRatio ?? DEFAULTS.noiseRatio;
    this.releaseRatio = options.releaseRatio ?? DEFAULTS.releaseRatio;
    this.calibrationMs = options.calibrationMs ?? DEFAULTS.calibrationMs;
  }

  /** True while the detector is still measuring the room. See `calibrationMs`. */
  get calibrating(): boolean {
    return this.elapsedMs < this.calibrationMs;
  }

  /** Milliseconds of audio pushed so far. */
  get elapsedMs(): number {
    return (this.samples / this.sampleRate) * 1000;
  }

  /** True once speech has been heard. The service uses this to decide whether
   *  an ended session is worth transcribing at all. */
  get heardSpeech(): boolean {
    return this.speaking || this.silenceMsAccumulated > 0;
  }

  /** Current speech threshold. Exposed for tests and diagnostics. */
  get threshold(): number {
    return Math.max(this.absoluteThreshold, this.noiseFloor * this.noiseRatio);
  }

  /**
   * Feed one frame.
   *
   * Returns at most one event per frame. Once an utterance has ended, every
   * subsequent frame returns 'none' — the detector never re-opens itself, so a
   * late frame arriving after the session closed cannot restart it.
   */
  push(frame: Int16Array): VadFrameResult {
    if (this.finished) {
      return { event: 'none', level: 0, elapsedMs: this.elapsedMs };
    }

    const level = frameRms(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    // Read before the sample count moves, so a frame is judged against the
    // state of the room as it was measured up to that frame.
    const calibrating = this.calibrating;
    this.samples += frame.length;

    const threshold = this.threshold;
    const loud = level >= threshold;

    if (!this.speaking) {
      // Track the room only while nothing is being said. Adapting during
      // speech would raise the floor to meet the voice and then treat the
      // voice as background — the utterance would end mid-sentence.
      //
      // While calibrating, follow quickly in both directions: the point of
      // that window is to arrive at a usable measurement of the room before
      // any of it is judged.
      const rate = calibrating || level < this.noiseFloor ? NOISE_ADAPT_DOWN : NOISE_ADAPT_UP;
      this.noiseFloor = Math.min(MAX_NOISE_FLOOR, this.noiseFloor + (level - this.noiseFloor) * rate);

      if (calibrating) {
        // Nothing may be declared speech yet, and nothing counts toward the
        // onset window — a room that happens to be loud must not accumulate an
        // utterance out of its own background noise.
        this.onsetMsAccumulated = 0;
      } else if (loud) {
        this.onsetMsAccumulated += frameMs;
        if (this.onsetMsAccumulated >= this.onsetMs) {
          this.speaking = true;
          this.silenceMsAccumulated = 0;
          return { event: 'speech-started', level, elapsedMs: this.elapsedMs };
        }
      } else {
        this.onsetMsAccumulated = 0;
      }

      if (this.elapsedMs >= this.speechStartTimeoutMs) {
        this.finished = true;
        return { event: 'no-speech-timeout', level, elapsedMs: this.elapsedMs };
      }
    } else {
      // Hysteresis: it takes more energy to start speech than to sustain it,
      // so an unvoiced consonant does not read as a pause.
      if (level >= threshold * this.releaseRatio) {
        this.silenceMsAccumulated = 0;
      } else {
        this.silenceMsAccumulated += frameMs;
        if (this.silenceMsAccumulated >= this.silenceMs) {
          this.finished = true;
          return { event: 'speech-ended', level, elapsedMs: this.elapsedMs };
        }
      }
    }

    if (this.elapsedMs >= this.maxUtteranceMs) {
      this.finished = true;
      return { event: 'max-duration', level, elapsedMs: this.elapsedMs };
    }

    return { event: 'none', level, elapsedMs: this.elapsedMs };
  }
}
