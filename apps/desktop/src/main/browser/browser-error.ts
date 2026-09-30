/**
 * How the browser fails, and what each failure means to the rest of Axon.
 *
 * Separate from `axon-browser.ts` so it can be tested without Electron — that
 * file imports `BrowserWindow`, which is why no test value-imports it.
 *
 * The browser has always known precisely what went wrong: a TIMEOUT is not a
 * NAVIGATION_FAILED, and a refused address is not a crash. What it did not do
 * was say so to anything outside itself — every one of these reached the
 * dispatcher as a plain Error and left it as EXECUTION_ERROR, which is how a
 * refused `file:` URL and a slow page came to sound identical to a user.
 *
 * So the mapping lives HERE, at the browser's own boundary, because the
 * browser is what knows what its kinds mean. The dispatcher reads it through
 * `declaredFailureKind` in core without importing the browser, and honours it
 * only when it names a kind an executor may declare.
 *
 *   NOT_OPEN              WINDOW_NOT_FOUND   the browser window Axon would act in is not there
 *   REFUSED               FORBIDDEN          the URL policy refused the address — a security
 *                                            refusal stays a security refusal
 *   TIMEOUT               TIMEOUT            the page or the page script did not finish in time
 *   ELEMENT_NOT_FOUND     NOT_FOUND          the element asked for is not on the page
 *   ELEMENT_SENSITIVE     FORBIDDEN          a password or other protected field
 *   ELEMENT_NOT_EDITABLE  UNSUPPORTED        that element does not accept text
 *   BUDGET_EXCEEDED       BUDGET_EXCEEDED    the browser's own per-request action cap
 *
 * Three are deliberately left unmapped, so they stay EXECUTION_ERROR:
 * NAVIGATION_FAILED (the reason is in the message, and "failed" is the truth),
 * CRASHED (the same), and CANCELLED — the dispatcher already reports
 * CANCELLED from the turn's own abort signal, and a browser that could declare
 * it independently could tell the model the user stopped something they did
 * not.
 */

import type { ExecutorFailureKind } from '@axon/core';

export type BrowserFailureKind =
  | 'NOT_OPEN'
  | 'REFUSED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_SENSITIVE'
  | 'ELEMENT_NOT_EDITABLE'
  | 'BUDGET_EXCEEDED'
  | 'CANCELLED'
  | 'CRASHED';

const TOOL_FAILURE_FOR: Readonly<Record<BrowserFailureKind, ExecutorFailureKind | null>> = {
  NOT_OPEN: 'WINDOW_NOT_FOUND',
  REFUSED: 'FORBIDDEN',
  NAVIGATION_FAILED: null,
  TIMEOUT: 'TIMEOUT',
  ELEMENT_NOT_FOUND: 'NOT_FOUND',
  ELEMENT_SENSITIVE: 'FORBIDDEN',
  ELEMENT_NOT_EDITABLE: 'UNSUPPORTED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  CANCELLED: null,
  CRASHED: null,
};

/** The tool-facing kind a browser failure maps to, or null for EXECUTION_ERROR. */
export function toolFailureFor(kind: BrowserFailureKind): ExecutorFailureKind | null {
  return TOOL_FAILURE_FOR[kind];
}

export class BrowserError extends Error {
  readonly kind: BrowserFailureKind;

  constructor(kind: BrowserFailureKind, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.kind = kind;
  }

  /** Read by the dispatcher via `declaredFailureKind`. Undefined means "no better name". */
  get toolFailureKind(): ExecutorFailureKind | undefined {
    return toolFailureFor(this.kind) ?? undefined;
  }
}
