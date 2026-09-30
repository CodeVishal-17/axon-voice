/**
 * Deciding whether something may be written to disk.
 *
 * READ THIS BEFORE TRUSTING IT.
 *
 * The patterns this file scans with catch obvious secrets. They will not catch
 * every secret, they cannot, and no version of them ever will — a password is
 * a string that looks like any other string, and a memorable word is
 * indistinguishable from a word. Anyone who reads a classifier like this and
 * concludes that secrets are therefore handled has misunderstood what it does.
 *
 * So the architecture does not rest on it. It rests on three things, in order:
 *
 * 1. AXON DOES NOT PERSIST MOST THINGS. Tool arguments, tool results, page
 *    text, audio, reasoning and environment variables have no table to go
 *    into. The set of things that reach the database is small and enumerated,
 *    which is a far stronger property than any amount of scanning.
 *
 * 2. LONG-TERM MEMORY IS DELIBERATE. A memory is written because someone asked
 *    for it and approved it, not because Axon noticed something. The default is
 *    not to remember.
 *
 * 3. THIS CLASSIFIER IS THE LAST LINE, NOT THE FIRST. It exists to stop the
 *    accident — a user pasting a key into a sentence, a model helpfully
 *    offering to remember a token it saw — and it fails closed: anything it
 *    flags is refused outright rather than stored with a warning.
 *
 * WHERE THE PATTERNS LIVE, AND WHY NOT HERE ANY MORE.
 *
 * They moved to `sensitivity.ts` in `@axon/core`. Two subsystems now need the
 * same answer to "what does a secret look like" — this one, deciding what may
 * be stored, and the desktop input tools, deciding what may be typed into
 * another application. Two copies of a security-relevant word list is two
 * answers that drift, and the one that drifts is always the one nobody is
 * looking at. This module keeps the STORAGE decisions, which are its own, and
 * takes the vocabulary from one place.
 *
 * Conversation messages are treated differently from memories, and the
 * difference is deliberate. A message is what was actually said, and silently
 * rewriting somebody's words in their own history would make the transcript a
 * lie. So a message that looks like it contains a secret is stored with the
 * secret-shaped span replaced by a marker, and the redaction is visible.
 */

import { SECRET_PATTERNS, classifyText } from '@axon/core';

/** What a scan concluded. */
export type SecretVerdict = 'clean' | 'suspected';

export interface ScanResult {
  readonly verdict: SecretVerdict;
  /** Which patterns matched, by name. Never the matched text itself. */
  readonly matched: readonly string[];
}

/** Text substituted for a secret-shaped span in a stored message. */
export const REDACTION_MARKER = '[redacted]';

/**
 * Scan text for credential-shaped content.
 *
 * Pure and allocation-light: this runs on every message on its way to disk.
 *
 * Delegates the classification to `classifyText`, then narrows a four-way
 * answer to the two-way one storage needs. PERSONAL is deliberately CLEAN
 * here: an email address in a sentence is not a reason to refuse a memory,
 * and treating it as one is the behaviour that made Axon call a user's own
 * address forbidden.
 */
export function scanForSecrets(text: string): ScanResult {
  if (typeof text !== 'string' || text === '') return { verdict: 'clean', matched: [] };

  const verdict = classifyText(text);
  return verdict.sensitivity === 'SECRET'
    ? { verdict: 'suspected', matched: verdict.matched }
    : { verdict: 'clean', matched: [] };
}

/** True when the text should never become a long-term memory. */
export function containsSecret(text: string): boolean {
  return scanForSecrets(text).verdict === 'suspected';
}

/**
 * Replace secret-shaped spans in text that will be stored anyway.
 *
 * Used for CONVERSATION MESSAGES, which are a record of what was said and
 * cannot simply be dropped. The marker is visible on purpose: a user reading
 * their own history should be able to see that Axon removed something, rather
 * than finding a sentence that quietly makes no sense.
 *
 * Not used for memories. A memory that needed redacting is a memory that
 * should not exist, and it is refused instead.
 *
 * Only SECRET patterns are replaced. A phone number in a message stays a phone
 * number: redacting it would damage a transcript to no benefit, since the
 * message is already the user's own words in the user's own history.
 */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  if (typeof text !== 'string' || text === '') return { text: '', redacted: false };

  let output = text;
  let redacted = false;

  for (const { pattern } of SECRET_PATTERNS) {
    // A fresh global regex per call: the shared constants are not global, and
    // sharing a stateful `lastIndex` across calls would make results depend on
    // call order.
    const global = new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g');
    if (!global.test(output)) continue;
    global.lastIndex = 0;
    output = output.replace(global, REDACTION_MARKER);
    redacted = true;
  }

  return { text: output, redacted };
}
