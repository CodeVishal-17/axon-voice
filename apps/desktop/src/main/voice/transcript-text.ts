/**
 * Preparing a transcript to be handed to the brain.
 *
 * SECURITY: this is where the user's voice becomes text that will be read by a
 * language model, and it is worth being precise about what is and is not being
 * defended here.
 *
 * A transcript is UNTRUSTED CONTENT. Not because the person speaking is
 * hostile, but because a microphone hears whatever is in the room — a podcast,
 * a video call, someone else's phone — and because a recognizer is a piece of
 * software that can be made to emit strange things. So the transcript is
 * treated exactly as a web page or a file would be: it is data, it is bounded,
 * and it goes to the model as a message rather than as an instruction to the
 * machine.
 *
 * What actually keeps a transcript from doing damage is NOT this file. It is
 * that the only thing downstream of it is `Orchestrator.sendUserMessage`,
 * which reaches tools solely through the dispatcher — so "delete everything"
 * spoken aloud is a sentence the model reads, and any action it proposes in
 * response is classified, risk-assessed and gated on human approval like every
 * other action in Axon. There is no path from these characters to a shell, a
 * path, an executor or an IPC channel.
 *
 * What this file adds on top of that is hygiene and bounds: control characters
 * removed, whitespace collapsed, length capped. It is emphatically not a
 * sanitiser in the "make dangerous text safe" sense. If safety depended on
 * stripping the right characters here, the architecture would already be
 * wrong.
 */

import { LISTENING_LIMITS } from '@axon/core';

export interface PreparedTranscript {
  /** The text to hand to the brain. Empty when there is nothing worth saying. */
  readonly text: string;
  readonly truncated: boolean;
  readonly characters: number;
}

/**
 * Characters removed before the transcript is used.
 *
 * C0 and C1 controls plus the Unicode bidirectional overrides. The bidi
 * controls matter because the transcript is rendered in the UI as "what Axon
 * heard": an embedded RLO can make displayed text read differently from its
 * logical order, so what the user sees themselves approving would not be what
 * the model was sent.
 *
 * Built with `new RegExp` from an escape string rather than as a literal: a
 * regex literal containing real control characters is a source file that tools
 * report as binary and that no reviewer can read.
 */
const CONTROL_CHARACTERS = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F' +
    '\u200E\u200F\u202A-\u202E\u2066-\u2069]',
  'g',
);

const WHITESPACE_RUNS = /\s+/g;

/**
 * Join the phrases a recognizer produced into one utterance.
 *
 * A recognizer emits a phrase per pause, so "open notepad" and "then write a
 * note" arrive separately even though they were one breath of instruction.
 * Joining them is what lets a person speak naturally instead of in single
 * clauses.
 */
export function joinPhrases(phrases: readonly string[]): string {
  return phrases.join(' ');
}

export function prepareTranscript(
  raw: string,
  limit: number = LISTENING_LIMITS.maxTranscriptCharacters,
): PreparedTranscript {
  const cleaned = raw.replace(CONTROL_CHARACTERS, ' ').replace(WHITESPACE_RUNS, ' ').trim();

  if (cleaned === '') return { text: '', truncated: false, characters: 0 };

  const truncated = cleaned.length > limit;
  const text = truncated ? cleaned.slice(0, limit).trim() : cleaned;

  return { text, truncated, characters: text.length };
}
