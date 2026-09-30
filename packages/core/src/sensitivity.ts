/**
 * What KIND of thing a piece of text or an action is.
 *
 * WHY THIS EXISTS, STATED AS THE BUG IT FIXES.
 *
 * A live voice test asked Axon about an email address and Axon described it as
 * forbidden sensitive data it could not touch. That is wrong in a way that
 * matters more than it looks: a system that calls everything secret has said
 * nothing, and a user who is refused their own email address learns that the
 * refusals are noise. The next refusal — the one about an API key — is then
 * read the same way.
 *
 * Axon had exactly one axis for this: `containsSecret`, a boolean. A boolean
 * cannot tell "hunter2" from an ordinary email address from "delete the
 * repository", so everything that felt delicate collapsed into one answer.
 * This file splits that into four classes that behave differently:
 *
 *   NORMAL         ordinary text. Handled, spoken, stored, no ceremony.
 *   PERSONAL       an email address, a phone number, a postal address, a name.
 *                  NOT a secret. Axon may read it, say it and act on it; what
 *                  it does is flag it, so a memory row can be marked and a
 *                  screen-shared timeline is readable at a glance.
 *   SECRET         passwords, API keys, tokens, one-time codes. Refused
 *                  outright — never typed, never stored, never logged, and no
 *                  approval unlocks them.
 *   CONSEQUENTIAL  not a property of text at all, but of an ACT: money moving,
 *                  an account being created, a credential being changed,
 *                  something destroyed, something submitted to a stranger.
 *                  A human decides.
 *
 * WHERE AUTHORITY LIVES, WHICH IS NOT HERE AND NOT IN THE MODEL.
 *
 * This file classifies. It does not decide. `riskFloorFor` below turns a class
 * into the LEAST restrictive verdict a caller may reach — a floor, never a
 * ceiling — and the caller's own `resolveRisk` may escalate above it and never
 * below. The dispatcher then applies the policy and, where it matters, asks a
 * person. Nothing a model says about how sensitive something is participates
 * in any of that; the model's opinion is not an input to this file.
 *
 * A CLASSIFIER IS NOT A GUARANTEE. The patterns below catch shapes that are
 * almost never anything but a credential. They will not catch every secret,
 * and no version of this file ever will — a password is a string that looks
 * like any other string. The architecture does not rest on it: Axon persists
 * almost nothing, typing a credential is refused by shape AND by target AND by
 * the field's own declaration, and this is the last line rather than the
 * first. See the header of `redaction.ts` in the desktop app, which now takes
 * its patterns from here so there is one answer to "what does a secret look
 * like" rather than two that can drift apart.
 *
 * Pure: regular expressions and string comparison. No Node, no Electron.
 */

import type { RiskLevel } from './risk.js';

export const SENSITIVITY_CLASSES = ['NORMAL', 'PERSONAL', 'SECRET', 'CONSEQUENTIAL'] as const;

export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

/**
 * How restrictive each class is, for escalation.
 *
 * SECRET sits above CONSEQUENTIAL because a consequential act can be
 * authorised by a person and a secret cannot be authorised by anyone.
 */
const SENSITIVITY_ORDER: Readonly<Record<SensitivityClass, number>> = Object.freeze({
  NORMAL: 0,
  PERSONAL: 1,
  CONSEQUENTIAL: 2,
  SECRET: 3,
});

export function isSensitivityClass(value: unknown): value is SensitivityClass {
  return typeof value === 'string' && (SENSITIVITY_CLASSES as readonly string[]).includes(value);
}

/** Combine classes by taking the most restrictive. Escalation only. */
export function escalateSensitivity(...classes: readonly SensitivityClass[]): SensitivityClass {
  let worst: SensitivityClass = 'NORMAL';
  for (const entry of classes) {
    if (SENSITIVITY_ORDER[entry] > SENSITIVITY_ORDER[worst]) worst = entry;
  }
  return worst;
}

/** True when `value` is at least as restrictive as `floor`. */
export function isAtLeastSensitivity(value: SensitivityClass, floor: SensitivityClass): boolean {
  return SENSITIVITY_ORDER[value] >= SENSITIVITY_ORDER[floor];
}

/**
 * The LEAST restrictive risk verdict a caller may reach for a class.
 *
 * A floor, deliberately. A tool that finds PERSONAL text is free to decide the
 * act around it is HIGH_RISK for its own reasons; what it may not do is call a
 * SECRET SAFE.
 *
 * PERSONAL maps to SAFE, and that is the whole correction this file was
 * written for. Reading somebody their own email address is not an act that
 * needs a dialog. What PERSONAL buys is a LABEL — on a memory row, in a
 * timeline — not a gate.
 */
export function riskFloorFor(sensitivity: SensitivityClass): RiskLevel {
  switch (sensitivity) {
    case 'SECRET':
      return 'FORBIDDEN';
    case 'CONSEQUENTIAL':
      return 'REQUIRES_APPROVAL';
    case 'PERSONAL':
    case 'NORMAL':
    default:
      return 'SAFE';
  }
}

interface NamedPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Shapes that are almost never anything but a credential.
 *
 * Anchored on STRUCTURE — a prefix, a length, a header name, an assignment —
 * rather than on the word "secret", because the string that matters rarely
 * announces itself. Ordered roughly by confidence.
 *
 * Note what is deliberately NOT here: an email address, a phone number, a
 * person's name. Those are PERSONAL, they are matched separately below, and
 * conflating them with this list is the bug this file exists to fix.
 */
export const SECRET_PATTERNS: readonly NamedPattern[] = [
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'openai-api-key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'authorization-header', pattern: /\bauthorization\s*[:=]\s*\S/i },
  { name: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'cookie-header', pattern: /\b(?:set-)?cookie\s*[:=]\s*\S/i },
  { name: 'session-cookie', pattern: /\b(?:sessionid|session_id|jsessionid|phpsessid|connect\.sid)\s*[:=]\s*\S/i },
  // A password or key ASSIGNED a value, e.g. an `api_key=` line. Requires the
  // assignment, so prose about passwords does not match.
  {
    name: 'assigned-credential',
    pattern:
      /\b(?:pass(?:word|wd|phrase)|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?\S{4,}/i,
  },
  // The same, as an environment line: `ASSEMBLYAI_API_KEY=...`. The pattern
  // above needs a word boundary before `api`, and an underscore is a word
  // character, so a .env file open in an editor slipped past it.
  { name: 'env-credential', pattern: /\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)\s*=\s*["']?[^\s"']{8,}/ },
  // A card-shaped number: 13-19 digits, optionally grouped. Deliberately
  // matched loosely; a false positive costs a refused memory, which is cheap.
  { name: 'card-number', pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'one-time-code', pattern: /\b(?:otp|2fa|mfa|totp|verification|auth)\s*code\s*[:=]?\s*\d{4,8}\b/i },
];

/**
 * Shapes that identify a person without being a credential.
 *
 * The point of naming these separately is that the correct answer for all of
 * them is "yes, Axon can handle this". They are matched so a row can be
 * flagged and a user can see at a glance what a stored memory is about — not
 * so that anything can be refused.
 */
export const PERSONAL_PATTERNS: readonly NamedPattern[] = [
  { name: 'email-address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Loose on purpose: international formats vary and a false positive only
  // adds a label. Requires enough digits that a year or a price is not
  // mistaken for a phone number.
  { name: 'phone-number', pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{2,4}\b/ },
  {
    name: 'postal-address',
    pattern:
      /\b\d{1,5}\s+[A-Za-z][\w.-]*(?:\s+[A-Za-z][\w.-]*)*\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b/i,
  },
  { name: 'date-of-birth', pattern: /\b(?:date of birth|d\.?o\.?b\.?|born on)\b/i },
];

/** Words that describe a person, used when nothing structural matched. */
const PERSONAL_HINTS: readonly string[] = [
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
 * Acts that destroy something, spend money, or cannot be undone.
 *
 * Shared vocabulary rather than a per-subsystem list, so a button labelled
 * "Delete" is classified the same way whether Axon found it on a web page or
 * on the desktop. Matched case-insensitively against a control's accessible
 * name — which is AXON'S reading of it, never the model's description.
 */
export const DESTRUCTIVE_PHRASES: readonly string[] = [
  'delete',
  'remove',
  'destroy',
  'erase',
  'wipe',
  'purge',
  'revoke',
  'deactivate',
  'disable',
  'uninstall',
  'format',
  'shut down',
  'restart',
  'sign out',
  'log out',
  'transfer ownership',
  'make public',
  'force push',
  'buy',
  'purchase',
  'place order',
  'pay',
  'checkout',
  'subscribe',
  'upgrade plan',
  'confirm payment',
  'close account',
  'delete account',
  'reset',
  'restore defaults',
  'grant access',
  'change password',
];

/** Acts that send something outward or change state other people can see. */
export const OUTWARD_PHRASES: readonly string[] = [
  'send',
  'post',
  'submit',
  'publish',
  'share',
  'invite',
  'upload',
  'attach',
  'sign in',
  'log in',
  'sign up',
  'register',
  'create account',
  'confirm',
  'accept',
  'agree',
  'apply',
  'install',
];

/** The first phrase from `phrases` that appears in `text`, or null. */
export function matchPhrase(text: string, phrases: readonly string[]): string | null {
  if (typeof text !== 'string' || text === '') return null;
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

/** What a scan concluded, and which patterns said so. Never the matched text. */
export interface SensitivityVerdict {
  readonly sensitivity: SensitivityClass;
  /** Pattern or phrase NAMES only. The matched span is never carried. */
  readonly matched: readonly string[];
}

/**
 * Classify a piece of text.
 *
 * SECRET wins over PERSONAL when both match, because the consequence of
 * getting that order wrong is asymmetric: a credential treated as an email
 * address ends up in a database, and an email address treated as a credential
 * only costs a refusal.
 *
 * Never returns CONSEQUENTIAL: that is a property of an act, not of a string.
 * Use `classifyActionLabel` for the label on a control.
 */
export function classifyText(text: string): SensitivityVerdict {
  if (typeof text !== 'string' || text === '') return { sensitivity: 'NORMAL', matched: [] };

  const secrets = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
  if (secrets.length > 0) return { sensitivity: 'SECRET', matched: secrets };

  const personal = PERSONAL_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
  if (personal.length > 0) return { sensitivity: 'PERSONAL', matched: personal };

  const hint = matchPhrase(text, PERSONAL_HINTS);
  if (hint) return { sensitivity: 'PERSONAL', matched: [`mentions-${hint}`] };

  return { sensitivity: 'NORMAL', matched: [] };
}

/**
 * Classify what activating a named control would do.
 *
 * The name is AXON'S OWN reading — an accessible name off a page or off the
 * desktop's accessibility tree. Nothing the model wrote reaches this function,
 * which is what makes the verdict worth anything: a model that calls the
 * "Delete repository" button "the back link" changes nothing, because its
 * description is not an argument here.
 */
export function classifyActionLabel(label: string): SensitivityVerdict {
  const destructive = matchPhrase(label, DESTRUCTIVE_PHRASES);
  if (destructive) return { sensitivity: 'CONSEQUENTIAL', matched: [`destructive:${destructive}`] };

  const outward = matchPhrase(label, OUTWARD_PHRASES);
  if (outward) return { sensitivity: 'CONSEQUENTIAL', matched: [`outward:${outward}`] };

  return { sensitivity: 'NORMAL', matched: [] };
}

/** True when text must never be typed, stored or logged. */
export function isSecretText(text: string): boolean {
  return classifyText(text).sensitivity === 'SECRET';
}

/** One sentence a person can read, for a dialog or the timeline. */
export function describeSensitivity(sensitivity: SensitivityClass): string {
  switch (sensitivity) {
    case 'SECRET':
      return 'a password, key, token or one-time code — Axon never handles these';
    case 'PERSONAL':
      return 'personal information such as an email address or phone number — Axon can use it, and marks it';
    case 'CONSEQUENTIAL':
      return 'an action with consequences a person should authorise';
    case 'NORMAL':
    default:
      return 'ordinary information';
  }
}
