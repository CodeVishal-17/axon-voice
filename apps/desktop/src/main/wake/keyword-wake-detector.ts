/**
 * Listening for Axon's name with a dedicated local keyword spotter.
 *
 * THIS FILE IS THE PRIVACY GUARANTEE, in the same sense `wake-word.ts` is for
 * the Windows recognizer: while Axon is armed, the microphone is open and the
 * audio goes to a local process and nowhere else. No socket exists, nothing is
 * written to disk, and nothing is logged. The only thing that escapes this
 * class is one bit — "somebody said the name" — and `onWake` carries no text,
 * because a keyword spotter produces none.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * The Windows `System.Speech` recognizer scored 0/15 on a real human
 * microphone. Not 0/15 because the microphone was silent — the audio arrived,
 * the recognizer detected speech repeatedly — but because a general-purpose
 * dictation engine constrained by a grammar is not a keyword detector, and on
 * one person's voice in one room it simply did not hear the phrase. Lowering
 * the confidence floor would have traded the one property that measurement DID
 * establish, zero false activations, for a chance at the one it did not.
 *
 * So the engine changed. A keyword spotter is a small transducer trained to
 * fire on one sequence of word pieces and to emit nothing the rest of the
 * time. It does not transcribe, so there is nothing for it to mis-transcribe,
 * and "AXON alone must never wake Axon" stops being a rule applied to text
 * afterwards and becomes a property of what the model is watching for: every
 * keyword begins with a greeting piece, so the name on its own is not a prefix
 * of anything that can fire.
 *
 * WHAT THIS CLASS DOES, AND WHAT IT REFUSES TO DO.
 *
 *     armed   -> microphone open, audio to a LOCAL spotter only
 *     woken   -> the user has activated a session; audio may now be streamed
 *     asleep  -> microphone closed
 *
 * It owns a lifecycle and two refusals. It does not own the microphone — main
 * opens that, through the same capture command every other consumer uses — and
 * it does not decide what happens when the phrase is heard. It says "now",
 * once.
 *
 * NO VOICE ACTIVITY DETECTOR. The Windows path had to cut audio into
 * utterances because its recognizer was batch: it read a whole window and then
 * recognised, so silence had to be kept away from it. The spotter is
 * streaming, costs about three per cent of one core (measured real-time factor
 * 0.032), and is at its best when it simply hears everything — segmenting for
 * it would only add a way to clip the start of "hey". The audio it holds is
 * the few hundred milliseconds its own feature extractor needs, and nothing
 * else is kept anywhere.
 *
 * This file imports only `@axon/core` and Axon's own wake modules. The child
 * process, the model and the native runtime are all behind
 * `keyword-engine.ts`, which is handed in — so what this decision logic can
 * reach is visible in its import block, and it can be tested with no model,
 * no microphone and no child process at all.
 */

import { LISTENING_LIMITS } from '@axon/core';
import type { WakeDetector, WakeDetectorStatus } from './wake-detector.js';
import type { KeywordEngine, KeywordHit } from './keyword-engine.js';
import { KEYWORD_ENGINE_DETAIL, MAX_KEYWORD_SPAN_MS, keywordById } from './wake-keywords.js';

/**
 * How long after waking the spotter's hits are ignored.
 *
 * The microphone moves to the conversation on activation, but frames already
 * in flight can still arrive, and the spotter's own stream may report the same
 * phrase from a following block. One activation per phrase, and two seconds is
 * comfortably longer than either window without being long enough that a
 * person who was refused a session cannot immediately try again.
 */
export const WAKE_REFRACTORY_MS = 2_000;

/**
 * How long without a frame counts as "not hearing anything".
 *
 * Only ever reported, never acted on: the detector does not own the
 * microphone, so the honest thing to do when audio stops arriving is to say so
 * in the tray rather than to pretend to recover something it does not hold.
 */
export const AUDIO_STARVED_AFTER_MS = 10_000;

/** How often debug mode reports the microphone level. */
const LEVEL_REPORT_MS = 5_000;

/**
 * Root-mean-square level of a frame, 0..1.
 *
 * For DEBUG REPORTING ONLY, and computed only when a debug callback exists, so
 * the shipping build never runs it. A level is a number about loudness; it
 * carries no more of what was said than a VU meter does, and it is the one
 * thing that distinguishes "the detector is deaf" from "the microphone is
 * muted" when somebody says the name and nothing happens.
 */
function levelOf(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = (frame[i] ?? 0) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

export interface KeywordWakeDecision {
  readonly wake: boolean;
  /** Why, in words a developer can read in debug mode. Never shown to users. */
  readonly reason: string;
}

/**
 * Should this hit wake Axon?
 *
 * PURE, and it can only REFUSE. The spotter has already decided that the word
 * pieces of a wake phrase were spoken; nothing here can turn a non-hit into a
 * wake.
 *
 * Two refusals:
 *
 *   An id Axon did not ask for. The spotter is configured from
 *   `wake-keywords.ts` and can only report those three ids, so this cannot
 *   happen — which is exactly why it is checked. A detector whose vocabulary
 *   is bounded by a lookup rather than by trust is one fewer thing to reason
 *   about when the engine changes.
 *
 *   A match stretched over more audio than the phrase takes. On synthesised
 *   speech the three phrases spanned 600-800 ms; the ceiling sits at more than
 *   twice that, which leaves room for a slow speaker. Be clear about what this
 *   is: in the synthesised sweep it rejected NOTHING, because a spotter does
 *   not find its pieces smeared across a sentence the way a grammar
 *   recognizer finds its nearest known phrase. It is a guard against a failure
 *   mode that the previous engine really did have, not a tuned second stage,
 *   and it is here because it costs one subtraction.
 */
export function judgeKeywordHit(hit: KeywordHit): KeywordWakeDecision {
  const keyword = keywordById(hit.id);
  if (keyword === null) return { wake: false, reason: `the spotter reported an id Axon never asked for` };

  const span = hit.endMs - hit.startMs;
  if (span > MAX_KEYWORD_SPAN_MS) {
    return { wake: false, reason: `the match was stretched over ${span}ms, more audio than the phrase takes` };
  }
  // The ID, not the phrase. A keyword spotter can only report the three ids it
  // was configured with, so printing the phrase would not actually leak
  // anything — but a debug line that reads like a transcript is a debug line
  // somebody will one day treat as one, and `keyword-wake.test.ts` holds that
  // nothing this subsystem emits looks like speech.
  return { wake: true, reason: `the spotter matched ${keyword.id} in ${span}ms` };
}

export interface KeywordWakeDetectorOptions {
  /**
   * The spotter. Handed in rather than constructed, so this file's imports
   * stay `@axon/core` and Axon's own wake modules, and so the decision logic
   * above can be tested with no model on the machine.
   */
  readonly engine: KeywordEngine;
  /** Fires when the phrase is heard. Takes NO transcript — see the header. */
  onWake(): void;
  /** Armed or disarmed, for the UI and the audit trail. */
  onArmedChanged(armed: boolean): void;
  /** A problem worth showing, phrased for a person. */
  onNotice(message: string): void;
  /**
   * Developer diagnostics: what the spotter did, and why it did or did not
   * wake. Absent — the default — means silent. The runtime supplies it only in
   * a development build with AXON_WAKE_DEBUG=1, and routes it to the developer
   * console: never to the event log, never over IPC.
   */
  readonly debug?: ((line: string) => void) | null;
  /** Wall clock, injected in tests. */
  readonly now?: () => number;
  /** How long `arm()` waits for the spotter to load before answering. */
  readonly armTimeoutMs?: number;
  /** Timers, injected in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_ARM_TIMEOUT_MS = 30_000;

/** A local wake detector built on a dedicated keyword spotter. */
export class KeywordWakeDetector implements WakeDetector {
  private readonly options: KeywordWakeDetectorOptions;
  private readonly now: () => number;
  private readonly armTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private armed = false;
  private ready = false;
  /** What is listening. From the engine, so a calibration or focus run says so in the status. */
  private detail: string;
  private lastFrameAt = 0;
  private lastWakeAt = 0;
  private framesSinceArm = 0;
  private peakLevel = 0;
  private lastLevelReportAt = 0;
  /** Guards against a stale engine's hit waking a disarmed detector. */
  private generation = 0;
  private arming: Promise<boolean> | null = null;

  constructor(options: KeywordWakeDetectorOptions) {
    this.options = options;
    this.detail = options.engine.detail || KEYWORD_ENGINE_DETAIL;
    this.now = options.now ?? ((): number => Date.now());
    this.armTimeoutMs = options.armTimeoutMs ?? DEFAULT_ARM_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get available(): boolean {
    return this.options.engine.available;
  }

  /**
   * Begin listening locally. Idempotent.
   *
   * Resolves once the spotter has loaded its model, so a caller that waits for
   * this knows Axon is actually listening rather than about to be. A spotter
   * that will not load resolves false, having already said why.
   */
  arm(): Promise<boolean> {
    // Already armed means already armed. Starting the engine a second time
    // would bump the generation and orphan the handlers the FIRST start was
    // given — which would leave Axon armed, listening, and permanently unable
    // to act on anything it heard. Reachable in one line: `arm()` answers when
    // its own timeout expires, and a caller that then retried would hit it.
    if (this.armed) return this.arming ?? Promise.resolve(this.ready);

    if (!this.available) {
      this.options.onNotice(
        this.options.engine.unavailableReason ??
          'Axon cannot listen for a wake phrase: no local wake-word engine is available.',
      );
      return Promise.resolve(false);
    }

    this.armed = true;
    this.lastFrameAt = 0;
    this.framesSinceArm = 0;
    this.peakLevel = 0;
    this.generation += 1;
    const generation = this.generation;
    this.options.onArmedChanged(true);
    this.debug('armed; starting the local keyword spotter and waiting for microphone audio');

    // The promise is built, and published on `this.arming`, BEFORE the engine
    // is started. A spotter that reports itself ready synchronously would
    // otherwise resolve an arming promise that nothing was holding yet.
    let settle: (value: boolean) => void = () => undefined;
    const arming = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.arming = arming;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) this.clearTimer(timer);
      // Only clear the field if it is still THIS arming. A disarm-then-arm in
      // between has already replaced it, and stamping null over the new one
      // would make the next `arm()` start a second engine.
      if (this.arming === arming) this.arming = null;
      settle(value);
    };

    // Armed is armed even if the model is slow: the timeout answers the caller
    // rather than abandoning the attempt, and the engine keeps loading.
    timer = this.setTimer(() => {
      this.debug('the spotter has not finished loading; still armed, still trying');
      finish(this.ready);
    }, this.armTimeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();

    this.options.engine.start({
      onReady: (detail) => {
        if (generation !== this.generation) return;
        this.ready = true;
        this.detail = detail;
        finish(true);
      },
      onHit: (hit) => {
        this.onHit(generation, hit);
      },
      onFailure: (message) => {
        if (generation !== this.generation) return;
        this.failed(message);
        finish(false);
      },
      onDebug: this.options.debug ? (line) => this.debug(line) : undefined,
    });

    return arming;
  }

  /** Stop listening locally. Idempotent, and reached from every exit. */
  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.ready = false;
    this.generation += 1;
    this.arming = null;
    this.options.engine.stop();
    this.options.onArmedChanged(false);
    this.debug('disarmed; the local keyword spotter is closed');
  }

  /**
   * One frame of microphone audio.
   *
   * To the local spotter and nowhere else. Note what this method does not do:
   * it does not log audio, does not emit, does not persist and does not return
   * anything.
   */
  pushFrame(frame: Int16Array): void {
    if (!this.armed) return;
    if (frame.length === 0 || frame.length > LISTENING_LIMITS.maxFrameSamples) return;
    const now = this.now();
    this.lastFrameAt = now;
    this.noteLevel(frame, now);
    this.options.engine.push(frame);
  }

  getStatus(): WakeDetectorStatus {
    const engine = this.options.engine;
    return {
      engine: 'keyword-spotter',
      detail: this.detail,
      armed: this.armed,
      available: engine.available,
      unavailableReason: engine.unavailableReason,
      restarts: engine.restarts,
      starvedOfAudio:
        this.armed && this.lastFrameAt !== 0 && this.now() - this.lastFrameAt > AUDIO_STARVED_AFTER_MS,
    };
  }

  private onHit(generation: number, hit: KeywordHit): void {
    if (generation !== this.generation || !this.armed) return;

    const decision = judgeKeywordHit(hit);
    const now = this.now();
    const repeated = this.lastWakeAt !== 0 && now - this.lastWakeAt < WAKE_REFRACTORY_MS;
    const wake = decision.wake && !repeated;

    if (this.options.debug) {
      const why = repeated ? 'the same phrase was already acted on' : decision.reason;
      // The shape of this line is part of what `npm run wake:live` reads: the
      // harness's "detector backlog" column is these numbers. `behind` is how
      // far behind live audio the spotter was, which is the only latency it
      // can report honestly — see `kws-host.ts`.
      this.debug(
        `heard [SPOTTER ${hit.id}] ${hit.startMs}+${hit.endMs - hit.startMs}ms behind ${hit.behindMs}ms -> ` +
          `${wake ? 'ACTIVATE' : 'no activation'} (${why})`,
      );
    }
    if (!wake) return;

    this.lastWakeAt = now;
    this.options.onWake();
  }

  /**
   * A spotter that cannot be kept alive is reported once, and the detector
   * disarms: an assistant that complains every few seconds is worse than one
   * that is quietly not listening and says so in the tray.
   */
  private failed(message: string): void {
    if (!this.armed) return;
    this.armed = false;
    this.ready = false;
    this.generation += 1;
    this.options.engine.stop();
    this.options.onArmedChanged(false);
    this.options.onNotice(message);
    this.debug('the local keyword spotter could not be kept running; disarmed');
  }

  /**
   * "Is the microphone actually feeding the detector?"
   *
   * Two lines, in debug mode only: one the first time a frame arrives, and a
   * peak level every few seconds after that. `verify-lifecycle.cjs` reads both
   * to prove that audio still reaches the detector with no window open, which
   * is the whole of the background-assistant claim.
   */
  private noteLevel(frame: Int16Array, now: number): void {
    if (!this.options.debug) return;
    this.framesSinceArm += 1;
    if (this.framesSinceArm === 1) {
      this.debug('microphone audio is arriving');
      this.lastLevelReportAt = now;
    }
    this.peakLevel = Math.max(this.peakLevel, levelOf(frame));
    if (now - this.lastLevelReportAt >= LEVEL_REPORT_MS) {
      this.debug(`microphone level: peak ${this.peakLevel.toFixed(3)}`);
      this.peakLevel = 0;
      this.lastLevelReportAt = now;
    }
  }

  private debug(line: string): void {
    this.options.debug?.(line);
  }
}
