/**
 * Why a human "Hey Axon" is not detected — as measurements, not guesses.
 *
 * PURE. Imports nothing. Shared by the focus diagnostic inside the spotter
 * process (`kws-focus.ts`), which produces the measurements, and by
 * `npm run wake:live` in focus mode, which classifies them per utterance.
 *
 * WHAT THE KEYWORD SPOTTER CAN AND CANNOT TELL US.
 *
 * sherpa-onnx's keyword spotter reports a keyword, its word pieces and their
 * timestamps — and only when the keyword's score clears its threshold. There is
 * NO score in its result (`KeywordResult` in the runtime's own types), so
 * "candidate hey_axon, score 0.31" cannot be read out of it. Rather than invent
 * one, the diagnostic measures around that gap three ways, on the SAME live
 * frames, in memory, recording nothing:
 *
 *   A THRESHOLD LADDER. Eight spotters at 0.01 ... 0.50. The highest threshold
 *   that still fires brackets the keyword's score: fired at 0.10 but not 0.20
 *   means 0.10 <= score < 0.20. Nothing firing even at 0.01 means the model
 *   never produced the keyword path at all.
 *
 *   AN ALIGNMENT FAN. The model decodes in 320 ms chunks, and offline
 *   measurement already showed a phrase's position inside a chunk decides
 *   detection. Four streams at the production threshold, each started 80 ms
 *   later than the last, cover one whole chunk. "Fired at 1 of 4 offsets" is
 *   alignment sensitivity measured on the real voice.
 *
 *   A FREE DECODE. The same acoustic model loaded as a streaming recognizer,
 *   greedy search, no keyword context. It reports the word pieces the model
 *   actually emits for the utterance, with a log-probability per piece — so a
 *   miss can be read as "the model heard HEY ACTION" or "the model heard HEY
 *   and then nothing", which are very different next steps.
 */

/** The ladder, as the investigation brief specifies it. */
export const FOCUS_THRESHOLDS: readonly number[] = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5];

/** The decode chunk the model uses, measured: `isReady` becomes true every 5120 samples. */
export const MODEL_CHUNK_MS = 320;

/**
 * Offsets covering one decode chunk in 80 ms steps.
 *
 * Measured, not chosen for neatness: with 40 ms steps (eight offset streams)
 * the diagnostic process decoded at mean 47 ms / p95 104 ms per 100 ms block —
 * at the edge of real time, where a human test could silently lose audio. Two
 * inference threads made it SLOWER (mean 62 ms). Four offsets keeps a
 * quarter-chunk resolution with headroom.
 */
export const FOCUS_OFFSETS_MS: readonly number[] = [0, 80, 160, 240];

/** Sentencepiece's word-boundary mark. */
const WORD_START = '\u2581';

/** A keywords-file line, with its threshold replaced. `#0.05` becomes `#0.20`. */
export function withThreshold(line: string, threshold: number): string {
  return line.replace(/#\d+(\.\d+)?/, `#${threshold.toFixed(2)}`);
}

/** The keywords-file line for one keyword id, or null. */
export function keywordLine(lines: readonly string[], id: string): string | null {
  return lines.find((line) => line.trim().endsWith(`@${id}`)) ?? null;
}

/** The word pieces of a keywords-file line: everything before ` :score`. */
export function piecesOf(line: string): string[] {
  const cut = line.search(/\s[:#@]/);
  return (cut < 0 ? line : line.slice(0, cut)).trim().split(/\s+/).filter(Boolean);
}

/** A piece made printable: the boundary mark spelt out, so a console cannot eat it. */
export function printablePiece(piece: string): string {
  return piece.replace(new RegExp(WORD_START, 'g'), 'U+2581');
}

/** The model's token table: piece -> id. */
export function parseTokenTable(text: string): Map<string, number> {
  const table = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const cut = line.lastIndexOf(' ');
    if (cut <= 0) continue;
    const id = Number.parseInt(line.slice(cut + 1), 10);
    if (Number.isFinite(id)) table.set(line.slice(0, cut), id);
  }
  return table;
}

/** One line of focus output, parsed. */
export type FocusEvent =
  | { readonly kind: 'hit'; readonly threshold: number; readonly offsetMs: number; readonly id: string; readonly spanMs: number }
  | {
      readonly kind: 'heard';
      readonly rms: number;
      readonly peak: number;
      readonly text: string;
      readonly pieces: readonly string[];
      readonly logProbs: readonly number[];
    };

/**
 * Parse a `FOCUS ...` line (with or without a `[wake] spotter ` prefix).
 *
 *   FOCUS hit t=0.05 off=40 id=hey_axon span=520
 *   FOCUS heard rms=0.041 peak=0.310 pieces=U+2581HE|Y|U+2581A|X|ON logp=-0.50|-0.11|-1.12|-0.53|-0.89 text=HEY AXON
 */
export function parseFocusLine(line: string): FocusEvent | null {
  const at = line.indexOf('FOCUS ');
  if (at < 0) return null;
  const body = line.slice(at + 'FOCUS '.length);
  const field = (name: string): string | null => {
    const match = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(body);
    return match ? (match[1] ?? '') : null;
  };
  if (body.startsWith('hit ')) {
    const threshold = Number.parseFloat(field('t') ?? '');
    const offsetMs = Number.parseInt(field('off') ?? '', 10);
    const spanMs = Number.parseInt(field('span') ?? '', 10);
    const id = field('id') ?? '';
    if (!Number.isFinite(threshold) || !Number.isFinite(offsetMs) || id === '') return null;
    return { kind: 'hit', threshold, offsetMs, id, spanMs: Number.isFinite(spanMs) ? spanMs : 0 };
  }
  if (body.startsWith('heard ')) {
    const textAt = body.indexOf(' text=');
    const text = textAt < 0 ? '' : body.slice(textAt + ' text='.length);
    const pieces = (field('pieces') ?? '').split('|').filter(Boolean).map((p) => p.replace(/U\+2581/g, WORD_START));
    const logProbs = (field('logp') ?? '')
      .split('|')
      .filter(Boolean)
      .map((value) => Number.parseFloat(value));
    return {
      kind: 'heard',
      rms: Number.parseFloat(field('rms') ?? '0') || 0,
      peak: Number.parseFloat(field('peak') ?? '0') || 0,
      text,
      pieces,
      logProbs,
    };
  }
  return null;
}

/**
 * Which keyword pieces the free decode did NOT produce, in order.
 *
 * Greedy in-order matching: the keyword's pieces are walked against what the
 * model emitted; a piece that cannot be found after the previous match is
 * missing. `_HE Y _A X ON` against `_HE Y _ACTION` is missing `_A X ON`.
 */
export function missingPieces(keyword: readonly string[], heard: readonly string[]): string[] {
  const missing: string[] = [];
  let from = 0;
  for (const piece of keyword) {
    const found = heard.indexOf(piece, from);
    if (found < 0) missing.push(piece);
    else from = found + 1;
  }
  return missing;
}

export type FocusResult =
  /** The production detector fired. */
  | 'DETECTED'
  /** The keyword path existed, but only below the production threshold. */
  | 'BELOW_THRESHOLD'
  /** At the production threshold the keyword fired at some alignment — just not the one the production stream had. */
  | 'MISSED_BY_ALIGNMENT'
  /** Nothing, at any threshold down to the lowest, at any alignment. */
  | 'NO_CANDIDATE'
  /** The diagnostic process dropped audio during the utterance, so its measurement cannot be trusted. */
  | 'INVALID';

export interface UtteranceEvidence {
  /** Whether the production detector activated. */
  readonly activated: boolean;
  /** FOCUS hit events inside the utterance's window, for the focused id. */
  readonly hits: readonly Extract<FocusEvent, { kind: 'hit' }>[];
  /** FOCUS heard events inside the window. */
  readonly heard: readonly Extract<FocusEvent, { kind: 'heard' }>[];
  readonly productionThreshold: number;
  /** The focused keyword's pieces. */
  readonly keywordPieces: readonly string[];
  /** Audio the diagnostic process dropped during the window. */
  readonly diagnosticDroppedMs: number;
}

export interface UtteranceVerdict {
  readonly result: FocusResult;
  /** Score bracket from the ladder at offset 0: atLeast <= score < below. Null bounds are open. */
  readonly scoreAtLeast: number | null;
  readonly scoreBelow: number | null;
  /** Offsets at which the production threshold fired. */
  readonly offsetsFiring: readonly number[];
  /** Highest threshold that fired at ANY offset (the ladder only runs at offset 0, so this is offset 0 or the production threshold). */
  readonly ladderFired: readonly number[];
  /** What the free decode heard, joined. */
  readonly heardText: string;
  readonly heardPieces: readonly string[];
  readonly heardLogProbs: readonly number[];
  /** Keyword pieces the free decode did not produce. */
  readonly missing: readonly string[];
  readonly rms: number;
  readonly peak: number;
}

export function classifyUtterance(evidence: UtteranceEvidence): UtteranceVerdict {
  const ladderFired = Array.from(
    new Set(evidence.hits.filter((hit) => hit.offsetMs === 0).map((hit) => hit.threshold)),
  ).sort((a, b) => a - b);
  const offsetsFiring = Array.from(
    new Set(
      evidence.hits
        .filter((hit) => Math.abs(hit.threshold - evidence.productionThreshold) < 1e-9)
        .map((hit) => hit.offsetMs),
    ),
  ).sort((a, b) => a - b);

  const top = ladderFired.length > 0 ? ladderFired[ladderFired.length - 1] ?? null : null;
  const next = top === null ? (FOCUS_THRESHOLDS[0] ?? null) : (FOCUS_THRESHOLDS.find((t) => t > top + 1e-9) ?? null);

  // Pieces and text across every heard segment in the window.
  const heardPieces = evidence.heard.flatMap((segment) => segment.pieces);
  const heardLogProbs = evidence.heard.flatMap((segment) => segment.logProbs);
  const heardText = evidence.heard.map((segment) => segment.text).filter(Boolean).join(' / ');
  const rms = evidence.heard.reduce((max, segment) => Math.max(max, segment.rms), 0);
  const peak = evidence.heard.reduce((max, segment) => Math.max(max, segment.peak), 0);

  let result: FocusResult;
  if (evidence.activated) result = 'DETECTED';
  else if (evidence.diagnosticDroppedMs > 0) result = 'INVALID';
  else if (offsetsFiring.length > 0) result = 'MISSED_BY_ALIGNMENT';
  else if (ladderFired.length > 0) result = 'BELOW_THRESHOLD';
  else result = 'NO_CANDIDATE';

  return {
    result,
    scoreAtLeast: top,
    scoreBelow: next,
    offsetsFiring,
    ladderFired,
    heardText,
    heardPieces,
    heardLogProbs,
    missing: missingPieces(evidence.keywordPieces, heardPieces),
    rms,
    peak,
  };
}

export interface LadderRow {
  readonly threshold: number;
  /** Utterances where the ladder spotter at this threshold fired (offset 0). */
  readonly candidates: number;
  /** Utterances the production detector activated on. */
  readonly detected: number;
}

/** The "threshold | candidates | detected" table. */
export function ladderTable(verdicts: readonly UtteranceVerdict[]): LadderRow[] {
  const detected = verdicts.filter((v) => v.result === 'DETECTED').length;
  return FOCUS_THRESHOLDS.map((threshold) => ({
    threshold,
    candidates: verdicts.filter((v) => v.ladderFired.some((t) => Math.abs(t - threshold) < 1e-9)).length,
    detected,
  }));
}
