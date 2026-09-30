/**
 * Choosing a wake detector.
 *
 * The single place an engine is named. Everything above depends on the
 * `WakeDetector` interface, so a third engine later is a new file beside these
 * two and an arm in this switch.
 *
 * WHY A DEDICATED KEYWORD SPOTTER, AND NOT THE ALTERNATIVES.
 *
 * The Windows recognizer scored 0/15 on a real human microphone — audio
 * arriving, speech detected, phrase never heard — while scoring well on
 * synthesised voices. That is the signature of an engine that is not a keyword
 * detector being asked to be one. These are the local options that were
 * examined before replacing it, and why each ended where it did.
 *
 * sherpa-onnx keyword spotter, zipformer-gigaspeech-3.3M — CHOSEN.
 *   A transducer TRAINED for keyword spotting, not a recognizer constrained to
 *   one. Apache-2.0 for the runtime and Apache-2.0 for the model. Fully
 *   offline: no account, no access key, no telemetry, no endpoint. Ships as a
 *   prebuilt N-API addon (`sherpa-onnx-node` + `sherpa-onnx-win-x64`, 23 MB)
 *   that loads unmodified under Electron because N-API is ABI-stable, so there
 *   is no native rebuild step on the demo machine. The model is 18 MB and
 *   streams: measured real-time factor on this machine is 0.032, about three
 *   per cent of one core, which is affordable for a process that runs from
 *   sign-in to shutdown. Crucially, a CUSTOM PHRASE NEEDS NO TRAINING: the
 *   spotter is told which word pieces to watch for, and "HEY AXON" tokenizes
 *   to `_HE Y _A X ON` under the model's own tokenizer. Latency is the end of
 *   the word plus one trailing blank frame. On synthesised speech, across two
 *   voices, three speaking rates and eight audio alignments, it scored 48/48 on
 *   "Hey Axon" and 0/624 against the brief's negative list at the chosen
 *   threshold — with one stubborn false activation on a fast "Hey Jackson"
 *   that no threshold removed. See `wake-keywords.ts` for that table and for
 *   the first, wrong version of it. None of it settles anything about a human
 *   voice, which is why `npm run wake:live` exists and why it is the only
 *   thing allowed to say the wake word works.
 *
 * Picovoice Porcupine — REJECTED, on licensing rather than quality.
 *   Probably the best-known wake-word engine and genuinely good. It requires a
 *   Picovoice AccessKey, which means an account and a key to defend, and a
 *   custom "Hey Axon" keyword is trained in Picovoice's cloud console. Axon's
 *   claim is that the wake word needs no third party at all; an engine whose
 *   free tier is metered by someone else's server is a different claim.
 *
 * openWakeWord — REJECTED for this milestone, and the closest call.
 *   Excellent quality, Apache-2.0, ONNX models. But its runtime is Python, and
 *   there is no pretrained "hey axon": a custom phrase means training a model
 *   on synthetic speech, which is GPU hours before anyone can say the name
 *   into a microphone. It is the right answer if the spotter's recall on real
 *   voices turns out to be inadequate, and that is a measurement away rather
 *   than a guess.
 *
 * Vosk with a phrase-list grammar — REJECTED.
 *   Offline, Apache-2.0, and its grammar mode really does restrict decoding to
 *   a word list, which would have worked. Its Node binding depends on
 *   `ffi-napi`, which does not build on Node 20 or under Electron, so it would
 *   have meant an unmaintained fork or a second child-process language runtime
 *   for strictly less than the spotter gives.
 *
 * whisper.cpp — REJECTED. A general recognizer, not a detector: the same
 *   category error as the engine being replaced, at ten times the CPU.
 *
 * Windows `System.Speech` with the wake grammar — KEPT, NOT DEFAULT.
 *   It is still here, still tested, and still reachable with
 *   `AXON_WAKE_ENGINE=windows`. It costs nothing to keep and it is the control
 *   arm for every future measurement. It is not what Axon arms.
 *
 * Absence is a normal state, not a failure: with no engine Axon runs, does not
 * listen for the phrase, and says why.
 */

import type { SpeechToText } from '@axon/core';
import type { WakeDetector, WakeDetectorStatus, WakeEngineKind } from './wake-detector.js';
import { KeywordWakeDetector } from './keyword-wake-detector.js';
import { SherpaKeywordEngine, type KeywordEngine } from './keyword-engine.js';
import { WAKE_ACTIVITY_OPTIONS, WakeWordDetector, type ActivityDetector } from './wake-word.js';
import { DEFAULT_KEYWORD_THRESHOLD, keywordById } from './wake-keywords.js';
import { CalibrationKeywordEngine, FocusKeywordEngine, parseCalibrationThresholds } from './calibration-engine.js';

export interface WakeDetectorFactoryOptions {
  /**
   * `AXON_WAKE_ENGINE`: 'keyword' (the default), 'windows' for the original
   * recognizer, or 'none' to arm nothing.
   */
  readonly engine: string | undefined;
  /**
   * `AXON_WAKE_THRESHOLD`: the spotter's detection threshold. Present so the
   * calibration harness can sweep it without a rebuild. Out-of-range values
   * fall back to the default rather than being clamped silently onto a number
   * nobody chose.
   */
  readonly threshold?: string | undefined;
  /**
   * `AXON_WAKE_CALIBRATE`: extra thresholds to MEASURE alongside the real one.
   *
   * Development only, and `config.ts` is what enforces that. When it is set,
   * several spotters run on the same live frames so one utterance produces a
   * whole row of the threshold table — see `calibration-engine.ts` for why the
   * sweep has to run sideways rather than in sequence.
   */
  readonly calibrate?: string | undefined;
  /**
   * `AXON_WAKE_FOCUS`: a keyword id to run the focus DIAGNOSTIC for, alongside
   * the production spotter. Development only (`config.ts`), and only when wake
   * debugging is on, because its output is debug lines. Unknown ids are ignored.
   */
  readonly focus?: string | undefined;
  /** The local recognizer, for the Windows engine. Null when there is none. */
  readonly stt: SpeechToText | null;
  /** A fresh activity detector, for the Windows engine. */
  readonly activity: () => ActivityDetector;
  /** A stand-in spotter. TESTS AND HARNESSES ONLY. */
  readonly keywordEngine?: KeywordEngine;
  onWake(): void;
  onArmedChanged(armed: boolean): void;
  onNotice(message: string): void;
  readonly debug?: ((line: string) => void) | null;
}

export interface WakeDetectorCreation {
  /**
   * Always a detector, never null.
   *
   * When the wake word is off or misconfigured this is a detector that
   * reports itself unavailable and refuses to arm. A null here would have
   * meant an optional-chain at every call site in main, the tray, and five
   * verification harnesses — and one of those chains being forgotten is a
   * crash on the path that is supposed to be the calm one.
   */
  readonly detector: WakeDetector;
  /** Why Axon will not listen for the phrase. Null when it will. Never a path or a key. */
  readonly unavailableReason: string | null;
  /** For the startup observation and the live test's report. */
  readonly engineName: WakeEngineKind;
}

/**
 * The wake detector for "Axon is not listening for a phrase".
 *
 * Exists so that "off" and "misconfigured" are ordinary states with a status
 * line, rather than an absence every caller has to remember to handle.
 */
class DisabledWakeDetector implements WakeDetector {
  readonly isArmed = false;
  readonly available = false;
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  arm(): Promise<boolean> {
    return Promise.resolve(false);
  }

  disarm(): void {
    /* never armed */
  }

  pushFrame(): void {
    /* never armed; audio reaches nothing */
  }

  getStatus(): WakeDetectorStatus {
    return {
      engine: 'disabled',
      detail: 'no wake-word engine',
      armed: false,
      available: false,
      unavailableReason: this.reason,
      restarts: 0,
      starvedOfAudio: false,
    };
  }
}

/** Parse the threshold override. Anything outside the useful range is not an override. */
export function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEYWORD_THRESHOLD;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return DEFAULT_KEYWORD_THRESHOLD;
  return value;
}

export function createWakeDetector(options: WakeDetectorFactoryOptions): WakeDetectorCreation {
  const requested = (options.engine ?? 'keyword').trim().toLowerCase();

  if (requested === 'none' || requested === 'off') {
    const reason = 'The wake word is turned off (AXON_WAKE_ENGINE=none).';
    return { detector: new DisabledWakeDetector(reason), unavailableReason: reason, engineName: 'disabled' };
  }

  if (requested !== 'keyword' && requested !== 'windows') {
    // Echoes a configured value, which is the user's own input and never a
    // secret — but it is bounded so a pathological value cannot flood the UI.
    const reason = `Unknown wake-word engine "${requested.slice(0, 32)}". Axon will not listen for the phrase.`;
    return { detector: new DisabledWakeDetector(reason), unavailableReason: reason, engineName: 'disabled' };
  }

  if (requested === 'keyword') {
    const threshold = parseThreshold(options.threshold);
    // The configured threshold is always FIRST, and first is the only arm that
    // may wake Axon. Calibration adds observers; it never moves the decision.
    const extra = parseCalibrationThresholds(options.calibrate).filter((value) => value !== threshold);
    const focus =
      typeof options.debug === 'function' && options.focus !== undefined && keywordById(options.focus.trim()) !== null
        ? options.focus.trim()
        : null;
    const engine =
      options.keywordEngine ??
      (focus !== null
        ? new FocusKeywordEngine({ threshold, focus })
        : extra.length > 0
        ? new CalibrationKeywordEngine({ thresholds: [threshold, ...extra] })
        : new SherpaKeywordEngine({ threshold, stats: typeof options.debug === 'function' }));
    const detector = new KeywordWakeDetector({
      engine,
      onWake: options.onWake,
      onArmedChanged: options.onArmedChanged,
      onNotice: options.onNotice,
      debug: options.debug,
    });
    // A detector that cannot run is still returned: it reports `available:
    // false` and the reason, which is what the tray and the settings panel
    // show. Swapping silently to the engine the human microphone test already
    // failed would be the worst of both — Axon would appear to be listening.
    return {
      detector,
      unavailableReason: detector.available ? null : engine.unavailableReason,
      engineName: 'keyword-spotter',
    };
  }

  const detector = new WakeWordDetector({
    stt: options.stt,
    activity: options.activity,
    onWake: options.onWake,
    onArmedChanged: options.onArmedChanged,
    onNotice: options.onNotice,
    debug: options.debug,
  });
  return {
    detector,
    unavailableReason: detector.available ? null : 'No local speech recognizer is available on this machine.',
    engineName: 'windows-speech',
  };
}

/** Re-exported so the runtime configures the Windows engine's activity detector without importing two modules. */
export { WAKE_ACTIVITY_OPTIONS };
