/**
 * The approval card's content, derived from the real request.
 *
 * PURE, so what a person is shown can be tested without a DOM.
 *
 * The card leads with the two facts that matter — the ACT and WHERE it lands —
 * taken from the same one-line description the dialog has always shown and
 * the voice agent now speaks, so the card, the dialog and the sentence cannot
 * disagree. Content that is about to be sent is still shown in full: a person
 * cannot consent to text they have not read.
 *
 * Secrets never reach a request — credentials are refused before an approval
 * is ever raised — but the card does not rely on that alone. Anything shaped
 * like a key, token or card number is hidden here as well.
 *
 * This is presentation only. Approval is enforced by main, bound to a
 * fingerprint of the exact arguments, and nothing here can widen it.
 */

import type { ApprovalRequest } from '@axon/core';

export interface CardLine {
  readonly label: string;
  readonly value: string;
  /** True when the value was hidden because it looked like a secret. */
  readonly hidden: boolean;
}

export interface ApprovalCardModel {
  /** "Click “Submit application”" — the act, as a short imperative. */
  readonly act: string;
  /** "careers.example.com", or a path, or null. */
  readonly where: string | null;
  readonly highRisk: boolean;
  /**
   * Whether the act may send something from a web page.
   *
   * Not simply `effect === 'EXTERNAL'`: the dispatcher promotes anything a
   * human was asked about to EXTERNAL, so its duplicate guard errs safe, and a
   * local file write carries that class too. Only a web page can actually
   * send, so only a web-page act gets the line, and the line says "may".
   */
  readonly outward: boolean;
  /** What will be sent, shown in full. */
  readonly contents: readonly CardLine[];
  /** Everything else about the request, for anyone who wants it. */
  readonly details: readonly CardLine[];
}

const CONTENT_LABELS = new Set(['Text', 'Content', 'Draft', 'Message']);

const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
  /\b(?:\d[ -]?){13,19}\b/, // a card number
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/, // a long opaque token
];

export function looksSecret(value: string): boolean {
  return SECRET_SHAPES.some((pattern) => pattern.test(value));
}

function line(label: string, value: string): CardLine {
  return looksSecret(value) ? { label, value: 'Hidden', hidden: true } : { label, value, hidden: false };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function hostOrPath(target: string | null): string | null {
  if (!target) return null;
  try {
    const url = new URL(target);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host || null;
  } catch {
    /* not a URL: a path, shown as it is */
  }
  return target;
}

export function describeApprovalCard(request: ApprovalRequest): ApprovalCardModel {
  const title = request.title.replace(/^Axon wants to\s+/i, '').trim();

  // "click “Submit application” on careers.example.com" -> act + where.
  const split = title.match(/^(.*\S)\s+on\s+([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)$/i);
  const act = capitalise(split ? (split[1] ?? title) : title);
  const where = split ? (split[2] ?? null) : hostOrPath(request.binding.target);

  return {
    act,
    where,
    highRisk: request.risk === 'HIGH_RISK',
    outward: request.binding.effect === 'EXTERNAL' && request.tool.startsWith('browser.'),
    contents: request.parameters.filter((p) => CONTENT_LABELS.has(p.label)).map((p) => line(p.label, p.value)),
    details: request.parameters.filter((p) => !CONTENT_LABELS.has(p.label)).map((p) => line(p.label, p.value)),
  };
}
