/**
 * Measuring the threshold instead of guessing it.
 *
 * The brief for this work is explicit: do not pick a detection threshold by
 * intuition, measure the trade-off. Measuring it honestly on a human voice has
 * an obvious problem — the natural way to sweep a threshold is to record
 * somebody saying the phrase twenty times and replay the recording at each
 * setting, and Axon is not allowed to record anybody. Ever. That rule has no
 * exception for measurement.
 *
 * So the sweep runs sideways instead of in sequence. This engine starts SEVERAL
 * spotters at once, at different thresholds, and hands every one of them the
 * same live microphone frames as they arrive. One utterance produces one row
 * of the table rather than one cell of it: the person says "Hey Axon" once, and
 * every threshold reports whether it heard it. Nothing is stored, nothing is
 * replayed, and at the end of the session there is no audio to delete because
 * there never was any.
 *
 * WHICH SPOTTER ACTUALLY WAKES AXON. The first one — the configured default.
 * The others are observers: their hits go to the debug channel as
 * `calibration <threshold> <id>` lines that `wake-calibrate.cjs` counts, and
 * they can neither wake Axon nor stop it waking.
 *
 * DEVELOPMENT ONLY. `config.ts` builds this list only in a development build
 * with `AXON_WAKE_CALIBRATE` set, for the same reason wake diagnostics are
 * gated: a packaged Axon should not be able to be made to run five speech
 * models by setting an environment variable.
 */

import type { KeywordEngine, KeywordEngineHandlers, KeywordHit } from './keyword-engine.js';
import { SherpaKeywordEngine } from './keyword-engine.js';

/** One threshold under measurement, and the spotter running at it. */
interface Arm {
  readonly threshold: number;
  readonly engine: KeywordEngine;
  /** The first arm is the one that may wake Axon. The rest only report. */
  readonly primary: boolean;
}

export interface CalibrationEngineOptions {
  /** The thresholds to run, primary first. */
  readonly thresholds: readonly number[];
  /** Build one spotter. Injected so this file can be tested without a model. */
  readonly build?: (threshold: number) => KeywordEngine;
}

/**
 * Several spotters, one microphone, no recording.
 *
 * Costs one spotter's CPU per threshold — about three per cent of one core
 * each, measured — which is why this is a calibration session a developer
 * starts and not something Axon ever does on its own.
 */
export class CalibrationKeywordEngine implements KeywordEngine {
  private readonly arms: readonly Arm[];
  private handlers: KeywordEngineHandlers | null = null;

  constructor(options: CalibrationEngineOptions) {
    const build = options.build ?? ((threshold: number): KeywordEngine => new SherpaKeywordEngine({ threshold }));
    this.arms = options.thresholds.map((threshold, index) => ({
      threshold,
      engine: build(threshold),
      primary: index === 0,
    }));
  }

  private get primary(): Arm | undefined {
    return this.arms[0];
  }

  get available(): boolean {
    return this.primary?.engine.available ?? false;
  }

  get unavailableReason(): string | null {
    return this.primary?.engine.unavailableReason ?? 'No spotter was configured for calibration.';
  }

  get detail(): string {
    const list = this.arms.map((arm) => arm.threshold.toFixed(2)).join(', ');
    return `${this.primary?.engine.detail ?? 'local keyword spotter'} — CALIBRATING thresholds ${list}`;
  }

  get restarts(): number {
    return this.arms.reduce((total, arm) => total + arm.engine.restarts, 0);
  }

  start(handlers: KeywordEngineHandlers): void {
    this.handlers = handlers;
    for (const arm of this.arms) {
      arm.engine.start({
        // Only the primary's readiness is Axon's readiness. An observer that
        // takes an extra second to load must not delay arming, and must not
        // be able to report Axon as listening when the primary has not loaded.
        onReady: (detail) => {
          if (arm.primary) handlers.onReady(detail);
        },
        onHit: (hit) => {
          this.onHit(arm, hit);
        },
        // Only the primary can take the wake word down. An observer that dies
        // is a hole in the table, not a reason to stop listening.
        onFailure: (message) => {
          if (arm.primary) handlers.onFailure(message);
          else handlers.onDebug?.(`calibration arm ${arm.threshold.toFixed(2)} stopped: ${message}`);
        },
        onDebug: handlers.onDebug,
      });
    }
  }

  stop(): void {
    for (const arm of this.arms) arm.engine.stop();
    this.handlers = null;
  }

  push(frame: Int16Array): void {
    // The same frames to every arm, in the same order. Nothing is copied and
    // nothing is kept: each spotter's stdin is the only place they go.
    for (const arm of this.arms) arm.engine.push(frame);
  }

  private onHit(arm: Arm, hit: KeywordHit): void {
    // The line `wake-calibrate.cjs` counts. Timing and an id, as everywhere
    // else in this subsystem.
    this.handlers?.onDebug?.(
      `calibration ${arm.threshold.toFixed(2)} ${hit.id} ${hit.startMs}+${hit.endMs - hit.startMs}ms behind ${hit.behindMs}ms`,
    );
    if (arm.primary) this.handlers?.onHit(hit);
  }
}

/**
 * The production spotter, plus a focus DIAGNOSTIC on the same frames.
 *
 * Why a second process rather than more work in the first: the question being
 * asked is why a human voice is missed, and a diagnostic that slowed the
 * production spotter down would be measuring a different detector. The
 * diagnostic runs eight ladder spotters, an eight-offset alignment fan and a
 * free decode (measured RTF ~0.5) in its own process on its own core, and
 * reports its own queue and drops so an utterance it could not keep up with is
 * marked invalid rather than silently counted.
 *
 * Only the production arm can wake Axon or take the wake word down.
 */
export class FocusKeywordEngine implements KeywordEngine {
  private readonly production: KeywordEngine;
  private readonly diagnostic: KeywordEngine;

  constructor(options: { threshold: number; focus: string; build?: (options: { threshold: number; focus?: string }) => KeywordEngine }) {
    const build =
      options.build ??
      ((o: { threshold: number; focus?: string }): KeywordEngine =>
        new SherpaKeywordEngine({ threshold: o.threshold, stats: true, ...(o.focus ? { focus: o.focus } : {}) }));
    this.production = build({ threshold: options.threshold });
    this.diagnostic = build({ threshold: options.threshold, focus: options.focus });
  }

  get available(): boolean {
    return this.production.available;
  }

  get unavailableReason(): string | null {
    return this.production.unavailableReason;
  }

  get detail(): string {
    return `${this.production.detail} — FOCUS DIAGNOSTIC running alongside`;
  }

  get restarts(): number {
    return this.production.restarts;
  }

  start(handlers: KeywordEngineHandlers): void {
    this.production.start({
      ...handlers,
      // The status keeps saying a diagnostic is running, after ready too.
      onReady: (detail) => handlers.onReady(`${detail} — FOCUS DIAGNOSTIC running alongside`),
    });
    this.diagnostic.start({
      onReady: () => handlers.onDebug?.('focus diagnostic is listening'),
      // A focus process never emits WAKE; if one somehow arrived it must not wake Axon.
      onHit: () => undefined,
      onFailure: (message) => handlers.onDebug?.(`focus diagnostic stopped: ${message}`),
      onDebug: handlers.onDebug,
    });
  }

  stop(): void {
    this.production.stop();
    this.diagnostic.stop();
  }

  push(frame: Int16Array): void {
    this.production.push(frame);
    this.diagnostic.push(frame);
  }
}

/**
 * Parse `AXON_WAKE_CALIBRATE`.
 *
 * A comma-separated list of thresholds, primary first. Anything unparseable or
 * outside (0, 1) is dropped rather than clamped: a typo should cost a row of
 * the table, not silently move the threshold that wakes Axon. An empty result
 * means "not calibrating", which is the normal state.
 */
export function parseCalibrationThresholds(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.trim() === '') return [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const value = Number.parseFloat(part.trim());
    if (!Number.isFinite(value) || value <= 0 || value >= 1) continue;
    seen.add(Number(value.toFixed(2)));
  }
  // Bounded: each threshold is a whole speech model in a process of its own.
  return Array.from(seen).slice(0, 8);
}
