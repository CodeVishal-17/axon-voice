/**
 * The focus diagnostic's measurements and decisions.
 *
 * The keyword spotter reports no score, so a human miss is explained by three
 * instruments on the same frames: a threshold ladder, an alignment fan, and a
 * free decode of the same model. These tests hold the arithmetic that turns
 * their output into DETECTED / BELOW_THRESHOLD / MISSED_BY_ALIGNMENT /
 * NO_CANDIDATE / INVALID — so a verdict printed in front of a person is the
 * verdict the numbers support.
 */

import { describe, expect, it } from 'vitest';
import {
  FOCUS_OFFSETS_MS,
  FOCUS_THRESHOLDS,
  MODEL_CHUNK_MS,
  classifyUtterance,
  keywordLine,
  ladderTable,
  missingPieces,
  parseFocusLine,
  parseTokenTable,
  piecesOf,
  printablePiece,
  withThreshold,
  type FocusEvent,
} from '../src/main/wake/focus-report.js';
import { keywordsFileContents, WAKE_KEYWORDS } from '../src/main/wake/wake-keywords.js';
import { parseCaptureProcessing } from '../src/main/voice/capture-processing.js';
import { FocusKeywordEngine } from '../src/main/wake/calibration-engine.js';
import { createWakeDetector } from '../src/main/wake/create-wake-detector.js';
import type { KeywordEngine, KeywordEngineHandlers } from '../src/main/wake/keyword-engine.js';

const HEY = WAKE_KEYWORDS[0]?.pieces ?? [];
type Hit = Extract<FocusEvent, { kind: 'hit' }>;
type Heard = Extract<FocusEvent, { kind: 'heard' }>;

const hit = (threshold: number, offsetMs = 0): Hit => ({ kind: 'hit', threshold, offsetMs, id: 'hey_axon', spanMs: 600 });
const heard = (pieces: string[], text: string): Heard => ({
  kind: 'heard',
  rms: 0.04,
  peak: 0.3,
  text,
  pieces,
  logProbs: pieces.map(() => -0.5),
});
const evidence = (over: Partial<Parameters<typeof classifyUtterance>[0]> = {}): Parameters<typeof classifyUtterance>[0] => ({
  activated: false,
  hits: [],
  heard: [],
  productionThreshold: 0.05,
  keywordPieces: HEY,
  diagnosticDroppedMs: 0,
  ...over,
});

describe('the instruments are configured as specified', () => {
  it('ladders exactly the thresholds the investigation asked for, including production', () => {
    expect(FOCUS_THRESHOLDS).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('fans offsets evenly across one whole measured decode chunk', () => {
    expect(MODEL_CHUNK_MS).toBe(320);
    const step = MODEL_CHUNK_MS / FOCUS_OFFSETS_MS.length;
    FOCUS_OFFSETS_MS.forEach((offset, i) => expect(offset).toBe(i * step));
  });

  it('rewrites only the threshold of the production keyword line', () => {
    const lines = keywordsFileContents(0.05).trim().split('\n');
    const line = keywordLine(lines, 'hey_axon') ?? '';
    expect(withThreshold(line, 0.2)).toBe(line.replace('#0.05', '#0.20'));
    expect(piecesOf(withThreshold(line, 0.2))).toEqual([...HEY]);
    expect(keywordLine(lines, 'axon')).toBeNull();
  });

  it('resolves every keyword piece against a token table, and prints the boundary mark', () => {
    const table = parseTokenTable('<blk> 0\n▁HE 49\nY 17\n▁A 6\nX 193\nON 78\n');
    for (const piece of HEY) expect(table.has(piece)).toBe(true);
    expect(printablePiece('▁HE')).toBe('U+2581HE');
  });
});

describe('parsing what the diagnostic process reports', () => {
  it('parses a hit, with or without the debug prefix', () => {
    expect(parseFocusLine('[wake] spotter FOCUS hit t=0.10 off=80 id=hey_axon span=520')).toEqual({
      kind: 'hit',
      threshold: 0.1,
      offsetMs: 80,
      id: 'hey_axon',
      spanMs: 520,
    });
  });

  it('parses a free decode, restoring the boundary marks', () => {
    const event = parseFocusLine(
      'FOCUS heard rms=0.041 peak=0.310 pieces=U+2581HE|Y|U+2581|X|AN logp=-0.64|-0.33|-1.03|-0.36|-2.37 text=HEY XAN',
    );
    expect(event).toMatchObject({ kind: 'heard', rms: 0.041, peak: 0.31, text: 'HEY XAN' });
    expect((event as Heard).pieces).toEqual(['▁HE', 'Y', '▁', 'X', 'AN']);
    expect((event as Heard).logProbs).toEqual([-0.64, -0.33, -1.03, -0.36, -2.37]);
  });

  it('ignores lines that are not focus measurements', () => {
    expect(parseFocusLine('[wake] spotter STATS focus in=998ms/s')).toBeNull();
    expect(parseFocusLine('FOCUS hit t=nope')).toBeNull();
  });
});

describe('which keyword pieces the model did not hear', () => {
  it('finds the missing pieces in order', () => {
    expect(missingPieces(HEY, ['▁HE', 'Y', '▁A', 'X', 'ON'])).toEqual([]);
    // Measured on a synthesised voice: the model heard "HEY XAN".
    expect(missingPieces(HEY, ['▁HE', 'Y', '▁', 'X', 'AN'])).toEqual(['▁A', 'ON']);
    expect(missingPieces(HEY, ['▁HE', 'Y'])).toEqual(['▁A', 'X', 'ON']);
    expect(missingPieces(HEY, [])).toEqual([...HEY]);
  });
});

describe('classifying one utterance', () => {
  it('is DETECTED when the production detector activated, whatever the instruments say', () => {
    expect(classifyUtterance(evidence({ activated: true })).result).toBe('DETECTED');
  });

  it('is INVALID when the diagnostic dropped audio and production did not fire', () => {
    expect(classifyUtterance(evidence({ hits: [hit(0.01)], diagnosticDroppedMs: 120 })).result).toBe('INVALID');
  });

  it('is MISSED_BY_ALIGNMENT when the production threshold fired at some offset', () => {
    const verdict = classifyUtterance(evidence({ hits: [hit(0.01), hit(0.02), hit(0.05, 160)] }));
    expect(verdict.result).toBe('MISSED_BY_ALIGNMENT');
    expect(verdict.offsetsFiring).toEqual([160]);
  });

  it('is BELOW_THRESHOLD when only rungs under production fired', () => {
    const verdict = classifyUtterance(evidence({ hits: [hit(0.01), hit(0.02)] }));
    expect(verdict.result).toBe('BELOW_THRESHOLD');
    expect(verdict.scoreAtLeast).toBe(0.02);
    expect(verdict.scoreBelow).toBe(0.05);
  });

  it('is NO_CANDIDATE when nothing fired anywhere, and says what the model heard instead', () => {
    const verdict = classifyUtterance(evidence({ heard: [heard(['▁HE', 'Y', '▁ACTION'], 'HEY ACTION')] }));
    expect(verdict.result).toBe('NO_CANDIDATE');
    expect(verdict.scoreAtLeast).toBeNull();
    expect(verdict.scoreBelow).toBe(0.01);
    expect(verdict.heardText).toBe('HEY ACTION');
    expect(verdict.missing).toEqual(['▁A', 'X', 'ON']);
  });

  it('brackets an open-ended score when even the top rung fired', () => {
    const verdict = classifyUtterance(evidence({ activated: true, hits: FOCUS_THRESHOLDS.map((t) => hit(t)) }));
    expect(verdict.scoreAtLeast).toBe(0.5);
    expect(verdict.scoreBelow).toBeNull();
  });
});

describe('the threshold table', () => {
  it('counts candidates per rung and production detections', () => {
    const verdicts = [
      classifyUtterance(evidence({ activated: true, hits: [hit(0.01), hit(0.02), hit(0.05), hit(0.1)] })),
      classifyUtterance(evidence({ hits: [hit(0.01)] })),
      classifyUtterance(evidence({})),
    ];
    const table = ladderTable(verdicts);
    expect(table.find((row) => row.threshold === 0.01)).toEqual({ threshold: 0.01, candidates: 2, detected: 1 });
    expect(table.find((row) => row.threshold === 0.1)).toEqual({ threshold: 0.1, candidates: 1, detected: 1 });
    expect(table.find((row) => row.threshold === 0.5)?.candidates).toBe(0);
  });
});

describe('one controlled preprocessing change at a time', () => {
  it('defaults to all processing on', () => {
    expect(parseCaptureProcessing(undefined)).toEqual({ processing: null, label: 'default', refused: null });
    expect(parseCaptureProcessing('default').processing).toBeNull();
  });

  it('turns exactly one switch', () => {
    expect(parseCaptureProcessing('ec=off').processing).toEqual({ echoCancellation: false, noiseSuppression: true, autoGainControl: true });
    expect(parseCaptureProcessing('NS=off').processing).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    expect(parseCaptureProcessing('agc=off').processing).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  });

  it('refuses two changes, unknown names and typos rather than applying part of them', () => {
    for (const raw of ['ec=off,ns=off', 'gain=off', 'ec=0', 'ec off']) {
      const parsed = parseCaptureProcessing(raw);
      expect(parsed.processing, raw).toBeNull();
      expect(parsed.refused, raw).not.toBeNull();
    }
  });
});

class FakeEngine implements KeywordEngine {
  available = true;
  unavailableReason = null;
  detail = 'fake';
  restarts = 0;
  handlers: KeywordEngineHandlers | null = null;
  frames = 0;
  readonly focus: string | undefined;

  constructor(focus?: string) {
    this.focus = focus;
  }

  start(handlers: KeywordEngineHandlers): void {
    this.handlers = handlers;
  }

  stop(): void {
    this.handlers = null;
  }

  push(): void {
    this.frames += 1;
  }
}

describe('running the diagnostic beside the production spotter', () => {
  const build = (): { engine: FocusKeywordEngine; made: FakeEngine[] } => {
    const made: FakeEngine[] = [];
    const engine = new FocusKeywordEngine({
      threshold: 0.05,
      focus: 'hey_axon',
      build: (options) => {
        const fake = new FakeEngine(options.focus);
        made.push(fake);
        return fake;
      },
    });
    return { engine, made };
  };

  it('starts one production spotter and one focus process, and feeds both the same frames', () => {
    const { engine, made } = build();
    expect(made.map((fake) => fake.focus)).toEqual([undefined, 'hey_axon']);
    engine.start({ onHit: () => undefined, onReady: () => undefined, onFailure: () => undefined });
    engine.push(new Int16Array(320));
    expect(made.map((fake) => fake.frames)).toEqual([1, 1]);
  });

  it('lets only production wake Axon or take the wake word down', () => {
    const { engine, made } = build();
    const hits: unknown[] = [];
    const failures: string[] = [];
    engine.start({
      onHit: (value) => hits.push(value),
      onReady: () => undefined,
      onFailure: (message) => failures.push(message),
      onDebug: () => undefined,
    });
    made[1]?.handlers?.onHit({ id: 'hey_axon', startMs: 0, endMs: 600, behindMs: 0 });
    made[1]?.handlers?.onFailure('diagnostic died');
    expect(hits).toEqual([]);
    expect(failures).toEqual([]);
    made[0]?.handlers?.onHit({ id: 'hey_axon', startMs: 0, endMs: 600, behindMs: 0 });
    expect(hits).toHaveLength(1);
  });

  it('is only built with wake debugging on, and only for a real keyword id', () => {
    const base = {
      engine: 'keyword',
      stt: null,
      activity: () => ({ push: () => ({ event: 'idle' }), threshold: 0.02 }),
      onWake: () => undefined,
      onArmedChanged: () => undefined,
      onNotice: () => undefined,
    };
    const detail = (over: { focus?: string; debug?: ((line: string) => void) | null }): string =>
      createWakeDetector({ ...base, ...over }).detector.getStatus().detail;
    // No model is needed: `detail` names the engine that was built.
    expect(detail({ focus: 'hey_axon', debug: () => undefined })).toMatch(/FOCUS DIAGNOSTIC/);
    expect(detail({ focus: 'hey_axon', debug: null })).not.toMatch(/FOCUS/);
    expect(detail({ focus: 'open_calculator', debug: () => undefined })).not.toMatch(/FOCUS/);
  });
});
