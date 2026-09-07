/**
 * Deciding whether something may be written to disk.
 *
 * READ THIS BEFORE TRUSTING IT.
 *
 * The patterns below catch obvious secrets. They will not catch every secret,
 * they cannot, and no version of this file ever will — a password is a string
 * that looks like any other string, and "hunter2" is indistinguishable from a
 * word. Anyone who reads a classifier like this and concludes that secrets are
 * therefore handled has misunderstood what it does.
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
 * Conversation messages are treated differently from memories, and the
 * difference is deliberate. A message is what was actually said, and silently
 * rewriting somebody's words in their own history would make the transcript a
 * lie. So a message that looks like it contains a secret is stored with the
 * secret-shaped span replaced by a marker, and the redaction is visible.
 */

/** What a scan concluded. */
export type SecretVerdict = 'clean' | 'suspected';

export interface ScanResult {
  readonly verdict: SecretVerdict;
  /** Which patterns matched, by name. Never the matched text itself. */
  readonly matched: readonly string[];
}

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Shapes that are almost never anything but a credential.
 *
 * Each one is anchored on structure — a prefix, a length, a header name —
 * rather than on the word "secret", because the string that matters rarely
 * announces itself. Ordered roughly by confidence.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
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
  // A password or key ASSIGNED a value, e.g. `password: hunter2`, `api_key=abc`.
  // Requires the assignment, so prose about passwords does not match.
  {
    name: 'assigned-credential',
    pattern: /\b(?:pass(?:word|wd|phrase)|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?\S{4,}/i,
  },
  // A card-shaped number: 13-19 digits, optionally grouped. Deliberately
  // matched loosely; a false positive costs a refused memory, which is cheap.
  { name: 'card-number', pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'one-time-code', pattern: /\b(?:otp|2fa|mfa|totp|verification|auth)\s*code\s*[:=]?\s*\d{4,8}\b/i },
];

/** Text substituted for a secret-shaped span in a stored message. */
export const REDACTION_MARKER = '[redacted]';

/**
 * Scan text for credential-shaped content.
 *
 * Pure and allocation-light: this runs on every message on its way to disk.
 */
export function scanForSecrets(text: string): ScanResult {
  if (typeof text !== 'string' || text === '') return { verdict: 'clean', matched: [] };

  const matched: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) matched.push(name);
  }

  return { verdict: matched.length > 0 ? 'suspected' : 'clean', matched };
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
 */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  if (typeof text !== 'string' || text === '') return { text: '', redacted: false };

  let output = text;
  let redacted = false;

  for (const { pattern } of SECRET_PATTERNS) {
    // A fresh global regex per call: the module constants are not global, and
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
