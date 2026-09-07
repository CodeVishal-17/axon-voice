/**
 * Preparing model output to be spoken.
 *
 * SECURITY: this is where untrusted text enters the voice subsystem.
 *
 * Axon's whole purpose is to bring the outside world in - a web page, a file,
 * a GitHub comment - and summarise it. So the text arriving here may have been
 * written by someone hostile, laundered through a model. The defence is not
 * this file's cleaning; the defence is that the text is only ever *data*:
 *
 *   - it is passed to the synthesiser over stdin, never on a command line and
 *     never interpolated into a script (see `sapi-tts.ts`);
 *   - nothing downstream parses it for commands, paths, URLs or markup;
 *   - the renderer receives audio samples, not this string.
 *
 * What this file adds on top of that is hygiene and bounds: control characters
 * that could confuse a subprocess boundary are removed, and length is capped
 * so an enormous reply cannot become an enormous synthesis job.
 *
 * It is emphatically NOT a sanitiser in the "make dangerous text safe" sense.
 * If safety depended on stripping the right characters here, the architecture
 * would already be wrong.
 */

import { SPEECH_LIMITS } from '@axon/core';

export interface PreparedSpeech {
  /** The text to synthesise. Empty when there is nothing worth speaking. */
  readonly text: string;
  readonly truncated: boolean;
  /** Characters after preparation. */
  readonly characters: number;
}

/**
 * Characters removed before synthesis.
 *
 * C0 and C1 controls except tab, newline and carriage return, plus the Unicode
 * bidirectional overrides. The bidi controls matter because the transcript and
 * the spoken sentence should agree about what was said, and an embedded RLO
 * can make displayed text read differently from its logical order.
 *
 * Built with `new RegExp` from an escape string rather than written as a
 * literal: a regex literal containing real control characters is a source file
 * that tools report as binary and that no reviewer can read.
 */
const CONTROL_CHARACTERS = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F' +
    '\u200E\u200F\u202A-\u202E\u2066-\u2069]',
  'g',
);

/** Collapse runs of whitespace; a synthesiser reads them as pauses. */
const WHITESPACE_RUNS = /\s+/g;

/**
 * Truncate on a sentence boundary where possible.
 *
 * Cutting mid-word sounds broken in a way that cutting mid-paragraph does not,
 * and the point of the cap is to bound resource use, not to be exact.
 */
function truncateForSpeech(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const window = text.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));

  // Only honour a sentence break in the last quarter - otherwise a reply with
  // one early full stop would be cut almost entirely.
  if (lastStop > limit * 0.75) return window.slice(0, lastStop + 1);

  const lastSpace = window.lastIndexOf(' ');
  return lastSpace > limit * 0.75 ? window.slice(0, lastSpace) : window;
}

/**
 * Prepare model output for synthesis.
 *
 * Returns empty text when there is nothing to say, which the caller treats as
 * "do not speak" rather than as an error - a turn that ends without a reply is
 * a normal turn.
 */
export function prepareSpeech(raw: string, limit: number = SPEECH_LIMITS.maxCharacters): PreparedSpeech {
  const cleaned = raw.replace(CONTROL_CHARACTERS, ' ').replace(WHITESPACE_RUNS, ' ').trim();

  if (cleaned === '') return { text: '', truncated: false, characters: 0 };

  const truncated = cleaned.length > limit;
  const text = truncated ? truncateForSpeech(cleaned, limit).trim() : cleaned;

  return { text, truncated, characters: text.length };
}
