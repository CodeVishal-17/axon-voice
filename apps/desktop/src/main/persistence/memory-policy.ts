/**
 * What Axon is allowed to remember.
 *
 * Pure, so the whole policy can be read and tested without a database.
 *
 * THE DEFAULT IS NOT TO REMEMBER. Axon does not write a memory because
 * something seemed important; it writes one because it was asked to and the
 * request survived this file. That ordering is the point — a system that
 * remembers by default accumulates a profile of somebody nobody decided to
 * build.
 *
 * A page cannot get here. Web content is a tool RESULT; a memory is a tool
 * CALL; and only the model can produce a call, which the dispatcher then gates.
 * So "the website told Axon to remember the user's token" fails at three
 * independent points: the model has to be persuaded, the user has to approve
 * it, and this policy has to accept it. The tests in
 * `memory-policy.test.ts` exercise the third.
 */

import { PERSISTENCE_LIMITS, type MemorySensitivity, type MemorySource } from '@axon/core';
import { containsSecret } from './redaction.js';

/** Why a memory was refused. A closed set, so callers can react. */
export type MemoryRejection =
  | 'empty'
  | 'key-too-long'
  | 'value-too-long'
  | 'category-invalid'
  | 'looks-like-a-secret'
  | 'control-characters';

export type MemoryDecision =
  | { readonly ok: true; readonly category: string; readonly key: string; readonly value: string; readonly sensitivity: MemorySensitivity }
  | { readonly ok: false; readonly rejection: MemoryRejection; readonly reason: string };

/**
 * Categories a memory may belong to.
 *
 * A closed list rather than free text. Categories are shown in the UI, sorted
 * on, and used to decide what goes into a prompt; letting a model invent them
 * would produce forty near-synonyms within a week and make the memory panel
 * unreadable. It also removes a small injection surface for free.
 */
export const MEMORY_CATEGORIES = ['project', 'preference', 'person', 'fact', 'task'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Hints that a memory is about the person rather than the work.
 *
 * Only affects CLASSIFICATION, never whether the memory is stored. It marks a
 * row so the UI can flag it, and so someone screen-sharing knows what is on
 * display. Getting this wrong is a cosmetic error, not a security one — which
 * is why it is allowed to be a word list.
 */
const PERSONAL_HINTS = [
  'address',
  'phone',
  'birthday',
  'email',
  'family',
  'partner',
  'wife',
  'husband',
  'child',
  'medical',
  'health',
  'salary',
  'bank',
  'home',
];

/**
 * Characters refused outright in a stored memory.
 *
 * Control characters and the bidirectional overrides, for the same reason the
 * transcript and the speech path strip them: what the user approved in the
 * dialog and what is stored must be the same string, in the same order. An
 * embedded RLO makes those two things differ while looking identical.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]');

/**
 * Decide whether a proposed memory may be stored, and how to classify it.
 *
 * Never throws: a refusal is an answer the caller reports, not an exception it
 * has to catch.
 */
export function evaluateMemory(input: {
  category: unknown;
  key: unknown;
  value: unknown;
  source: MemorySource;
}): MemoryDecision {
  if (!isMemoryCategory(input.category)) {
    return {
      ok: false,
      rejection: 'category-invalid',
      reason: `A memory's category must be one of: ${MEMORY_CATEGORIES.join(', ')}.`,
    };
  }

  const key = typeof input.key === 'string' ? input.key.trim().replace(/\s+/g, ' ') : '';
  const value = typeof input.value === 'string' ? input.value.trim().replace(/\s+/g, ' ') : '';

  if (key === '' || value === '') {
    return { ok: false, rejection: 'empty', reason: 'A memory needs both something to remember and a name for it.' };
  }

  if (key.length > PERSISTENCE_LIMITS.maxMemoryKeyCharacters) {
    return {
      ok: false,
      rejection: 'key-too-long',
      reason: `A memory's name must be ${PERSISTENCE_LIMITS.maxMemoryKeyCharacters} characters or fewer.`,
    };
  }

  if (value.length > PERSISTENCE_LIMITS.maxMemoryValueCharacters) {
    return {
      ok: false,
      rejection: 'value-too-long',
      reason:
        `A memory must be ${PERSISTENCE_LIMITS.maxMemoryValueCharacters} characters or fewer. ` +
        'Long-term memory is for facts worth keeping, not for documents.',
    };
  }

  if (CONTROL_CHARACTERS.test(key) || CONTROL_CHARACTERS.test(value)) {
    return {
      ok: false,
      rejection: 'control-characters',
      reason: 'That text contains control characters, so Axon will not store it.',
    };
  }

  // The hard rule. Refused rather than redacted: a memory that needed
  // redacting is one that should not exist, and storing a hollowed-out version
  // of a credential is worse than storing nothing — it teaches the model that
  // credentials belong in memory.
  if (containsSecret(key) || containsSecret(value)) {
    return {
      ok: false,
      rejection: 'looks-like-a-secret',
      reason:
        'That looks like a password, key or token. Axon does not store credentials — ' +
        'if you need one, keep it in a password manager and type it yourself.',
    };
  }

  return { ok: true, category: input.category, key, value, sensitivity: classify(input.category, key, value) };
}

/** Ordinary or personal. `secret` is never returned: those are refused above. */
function classify(category: MemoryCategory, key: string, value: string): MemorySensitivity {
  if (category === 'person') return 'personal';

  const haystack = `${key} ${value}`.toLowerCase();
  return PERSONAL_HINTS.some((hint) => haystack.includes(hint)) ? 'personal' : 'ordinary';
}
