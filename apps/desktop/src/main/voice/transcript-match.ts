/**
 * Did the recognizer hear what the person said?
 *
 * PURE. Used by `npm run voice:live` to score a human speaking controlled
 * phrases into the real microphone. The goal is to catch SEVERE corruption —
 * "Open Calculator" coming back as an unrelated sentence — not to punish a
 * capital letter, a full stop, or "125" written as "one hundred twenty-five".
 *
 * Scoring is word error rate after normalisation: lowercase, punctuation
 * removed, number words turned into digits, a few symbol spellings unified.
 */

const SMALL: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Turn runs of number words ("one hundred twenty five") into digits ("125"). Handles 0-999,999. */
function numberWordsToDigits(words: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let total = 0;
    let current = 0;
    let consumed = 0;
    while (i + consumed < words.length) {
      const word = words[i + consumed] ?? '';
      if (word in SMALL) current += SMALL[word] ?? 0;
      else if (word in TENS) current += TENS[word] ?? 0;
      else if (word === 'hundred' && consumed > 0) current *= 100;
      else if (word === 'thousand' && consumed > 0) {
        total += current * 1000;
        current = 0;
      } else if (word === 'and' && consumed > 0 && i + consumed + 1 < words.length && ((words[i + consumed + 1] ?? '') in SMALL || (words[i + consumed + 1] ?? '') in TENS)) {
        // "one hundred and five"
      } else break;
      consumed += 1;
    }
    if (consumed === 0) {
      out.push(words[i] ?? '');
      i += 1;
    } else {
      out.push(String(total + current));
      i += consumed;
    }
  }
  return out;
}

/** Normalise a phrase for comparison. */
export function normalizeTranscript(text: string): string[] {
  const lowered = text
    .toLowerCase()
    .replace(/[×*]/g, ' times ')
    .replace(/(\d),(\d{3})\b/g, '$1$2') // 1,250 -> 1250
    .replace(/-/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (lowered === '') return [];
  const words = lowered.split(' ').map((word) => (word === 'x' ? 'times' : word));
  // "you tube" -> "youtube", so a brand name is not two word errors.
  const joined: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === 'you' && words[i + 1] === 'tube') {
      joined.push('youtube');
      i += 1;
    } else joined.push(words[i] ?? '');
  }
  return numberWordsToDigits(joined);
}

/** Levenshtein distance over words. */
function wordDistance(a: readonly string[], b: readonly string[]): number {
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

export type MatchVerdict = 'PASS' | 'CLOSE' | 'FAIL';

export interface TranscriptMatch {
  readonly expected: string;
  readonly recognized: string;
  /** Word error rate against the expected phrase, 0 = perfect. */
  readonly wordErrorRate: number;
  readonly verdict: MatchVerdict;
}

/**
 * Score one recognition.
 *
 * PASS at WER <= 0.25 (one wrong word in four): close enough to act on.
 * CLOSE up to 0.5: the gist survived. FAIL beyond, or when nothing was heard.
 */
export function matchTranscript(expected: string, recognized: string | null): TranscriptMatch {
  const reference = normalizeTranscript(expected);
  const hypothesis = normalizeTranscript(recognized ?? '');
  const wordErrorRate =
    reference.length === 0 ? (hypothesis.length === 0 ? 0 : 1) : wordDistance(reference, hypothesis) / reference.length;
  const verdict: MatchVerdict =
    recognized === null || hypothesis.length === 0 ? 'FAIL' : wordErrorRate <= 0.25 ? 'PASS' : wordErrorRate <= 0.5 ? 'CLOSE' : 'FAIL';
  return { expected, recognized: recognized ?? '', wordErrorRate, verdict };
}
