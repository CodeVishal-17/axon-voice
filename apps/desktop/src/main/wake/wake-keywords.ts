/**
 * The wake phrase, as the keyword spotter spells it.
 *
 * PURE. No imports, no I/O, no state. Everything the dedicated detector is
 * configured with is a constant in this file, so "what can wake Axon" is one
 * short list a reviewer can read.
 *
 * WHY THIS LOOKS LIKE LINE NOISE.
 *
 * The keyword spotter is a small transducer trained on BPE word pieces, not on
 * whole words: it is told which SEQUENCE OF PIECES to watch for, and it fires
 * when the acoustic model emits that sequence. So "HEY AXON" has to be written
 * the way the model's own tokenizer writes it:
 *
 *     HEY AXON    ->    _HE Y _A X ON
 *
 * where `_` is U+2581, sentencepiece's word-boundary mark. Those five pieces
 * are not a guess. They were produced by running the model's own `bpe.model`
 * through sentencepiece, and `npm run wake:model` re-derives and re-checks them
 * every time the model is fetched, so a model change that re-tokenizes the name
 * fails the fetch instead of silently making Axon deaf.
 *
 * Note that the encoding puts the greeting and the name in separate pieces,
 * which is exactly why the false-activation story holds. "AXON" alone is
 * `_A X ON` — a PREFIX of nothing the spotter is watching for, because every
 * keyword below begins with a greeting piece. The spotter is not matching text
 * and then checking for a greeting; there is no path through it that fires on
 * the name by itself.
 *
 * WHY THE PHRASES ARE NOT CONFIGURABLE.
 *
 * A configurable wake phrase is a string from outside deciding when a
 * microphone starts uploading. That is not a setting worth having.
 */

/** Sentencepiece's word-boundary mark, U+2581. Spelt as an escape so an editor cannot eat it. */
const WORD_START = '\u2581';

/** One phrase the spotter watches for. */
export interface WakeKeyword {
  /** What a person says. Used in diagnostics and in the live test's report. */
  readonly phrase: string;
  /** The model's own word pieces, space separated, without the boundary marks. */
  readonly pieces: readonly string[];
  /** A short identifier the spotter reports back. ASCII, no spaces. */
  readonly id: string;
}

/**
 * The phrases, in full. Exactly three, primary first.
 *
 * "Hey Axon" is THE wake phrase; the other two exist because the spotter costs
 * nothing extra to watch for them and people say them. If a measurement ever
 * shows a secondary phrase dragging the primary's precision down, the
 * secondary goes — the order of this list is the order of that argument.
 */
export const WAKE_KEYWORDS: readonly WakeKeyword[] = [
  { phrase: 'Hey Axon', id: 'hey_axon', pieces: [`${WORD_START}HE`, 'Y', `${WORD_START}A`, 'X', 'ON'] },
  { phrase: 'Hello Axon', id: 'hello_axon', pieces: [`${WORD_START}HE`, 'LL', 'O', `${WORD_START}A`, 'X', 'ON'] },
  { phrase: 'Hi Axon', id: 'hi_axon', pieces: [`${WORD_START}HI`, `${WORD_START}A`, 'X', 'ON'] },
];

/** The primary phrase's id, which the live test reports separately from the rest. */
export const PRIMARY_KEYWORD_ID = 'hey_axon';

/**
 * The detection threshold, and how it was chosen.
 *
 * NOT by intuition, and not by the first measurement either — the first one was
 * wrong in an instructive way, so here is both.
 *
 * A first pass fed each phrase to the spotter once and reported 6/6 positives
 * and 0/22 false activations at every threshold from 0.15 to 0.50. That
 * suggested a comfortable default around 0.25, and it was WRONG, because it
 * tested each utterance at ONE alignment. The encoder consumes audio in fixed
 * chunks, so where a phrase happens to land relative to a chunk boundary
 * changes whether it is detected — and on a live microphone that alignment is
 * arbitrary. Re-running each utterance at eight different offsets across one
 * chunk turned "6/6" at 0.25 into 13/16.
 *
 * The table below is the honest one: two synthesised voices, three speaking
 * rates, eight alignments each, against the brief's thirteen negatives and a
 * set of adversarial greeting-plus-name near misses.
 *
 *     threshold   "Hey Axon"     all phrases     brief negatives   near misses
 *     0.02        48/48  100%    131/144  91%    0/624             1/624
 *     0.05        48/48  100%    131/144  91%    0/624             1/624
 *     0.10        47/48   98%    127/144  88%    0/624             1/624
 *     0.15        47/48   98%    123/144  85%    0/624             1/624
 *     0.20        44/48   92%    119/144  83%    0/624             1/624
 *
 * Read the last two columns first, because they are the surprise: precision is
 * FLAT. Raising the threshold across this whole range buys nothing against
 * false activation and costs recall monotonically. The one false activation is
 * the same utterance every time — "Hey Jackson" said quickly by one voice — and
 * it survives every threshold up to 0.20, so it is not a threshold problem at
 * all. It is what an acoustic near-miss looks like, and the honest thing is to
 * say so rather than to raise a number until that row reads zero and the recall
 * column has quietly collapsed.
 *
 * So the default sits at the bottom, where recall is perfect. 0.05 rather than
 * 0.02 only because a floor of nearly nothing is not a floor, and this leaves
 * somewhere to go if a human voice needs it.
 *
 * `npm run wake:calibrate` re-runs this table on a REAL microphone, several
 * thresholds at once on the same live frames, and none of the above is a
 * substitute for it: these are synthesised voices, and the engine this replaced
 * scored well on synthesised voices and 0/15 on a person.
 */
export const DEFAULT_KEYWORD_THRESHOLD = 0.05;

/**
 * The boosting score applied to keyword paths during decoding.
 *
 * The spotter's own default is 1.0. Axon uses 2.0, which is what the model's
 * published example uses and what the table above was measured at. Raising it
 * further was measured and made things WORSE: at 3.0, "Hey Axon" recall fell
 * from 16/16 to 15/16 at threshold 0.10 and from 13/16 to 10/16 at 0.25, with
 * no improvement in false activation. The threshold is the knob that was
 * actually tuned; this one was tried and left alone.
 */
export const KEYWORD_BOOST_SCORE = 2.0;

/**
 * How many trailing blank frames must follow the last piece before a match is
 * reported. One is the model's default and means "as soon as the phrase is
 * complete", which is what keeps activation latency near the end of the word
 * rather than a beat after it. Two was measured and changed nothing at all —
 * identical recall and identical false activations at every threshold — so the
 * cheaper one stays.
 */
export const KEYWORD_TRAILING_BLANKS = 1;

/** Beam width. The model's default; raising it costs CPU for no measured recall. */
export const KEYWORD_MAX_ACTIVE_PATHS = 4;

/**
 * The longest a wake phrase may span and still be a wake phrase.
 *
 * Measured on the spotter, across two synthesised voices: "Hey Axon" spanned
 * 800 ms, "Hello Axon" 600 ms, "Hi Axon" 800 ms. The ceiling is more than
 * twice the longest of those, which leaves a slow speaker room.
 *
 * Be clear about what this is. In the synthesised sweep it rejected NOTHING:
 * a keyword spotter does not find its word pieces smeared across a sentence
 * the way a grammar recognizer finds its nearest known phrase inside one. It
 * is a guard against a failure mode the PREVIOUS engine really did have —
 * "I was talking about Axon yesterday" came back from the Windows recognizer
 * as "hi axon" stretched over 1.9 seconds — and it is kept because it costs a
 * subtraction, not because tuning it bought anything.
 */
export const MAX_KEYWORD_SPAN_MS = 1_800;

/**
 * The keywords file the spotter is configured with.
 *
 * Its format is the model's, not Axon's: pieces, then `:score`, `#threshold`,
 * `@id`. Built here rather than shipped as a file so that the only place the
 * wake phrase exists is this module — a file on disk is something that can be
 * edited, and a wake phrase that can be edited on disk is a wake phrase an
 * installer can change.
 */
export function keywordsFileContents(threshold: number): string {
  return `${WAKE_KEYWORDS.map(
    (keyword) =>
      `${keyword.pieces.join(' ')} :${KEYWORD_BOOST_SCORE.toFixed(1)} #${threshold.toFixed(2)} @${keyword.id}`,
  ).join('\n')}\n`;
}

/** Look a reported id back up, so a spotter cannot report a phrase Axon never asked for. */
export function keywordById(id: string): WakeKeyword | null {
  return WAKE_KEYWORDS.find((keyword) => keyword.id === id) ?? null;
}

/**
 * The model files the spotter needs, relative to the model directory.
 *
 * The float encoder and joiner rather than their int8 quantisations: on the
 * synthesised sweep the quantised encoder lost a positive at threshold 0.30
 * where the float one did not, and eight megabytes is not a reason to accept
 * a worse ear.
 */
export const KEYWORD_MODEL_FILES = {
  encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
  tokens: 'tokens.txt',
} as const;

/** Every model file, for an existence check that names what is missing. */
export const KEYWORD_MODEL_FILE_LIST: readonly string[] = Object.values(KEYWORD_MODEL_FILES);

/** The directory name the fetch script extracts into, under `resources/`. */
export const KEYWORD_MODEL_DIRNAME = 'wake-model';

/** What the spotter is, in the few words `getStatus()` reports. */
export const KEYWORD_ENGINE_DETAIL = 'local keyword spotter (zipformer, 3.3M, on-device)';
