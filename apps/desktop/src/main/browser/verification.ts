/**
 * Did the action actually do anything?
 *
 * AN EXECUTOR THAT RETURNS IS NOT AN ACTION THAT WORKED.
 *
 * `click` resolves when the click was delivered. A disabled button, a
 * validation failure, a submission the server rejected and a submission that
 * posted all resolve the same way. So every browser action Axon takes is
 * followed by a fresh read, and the two readings are compared here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not decide whether the user's goal was achieved. It cannot: that
 * needs to know what "posted" looks like on this particular site, which is
 * exactly the kind of knowledge an agent invents when it does not have it.
 * What it produces is EVIDENCE — the URL changed, the text changed, the words
 * we submitted are now on the page — phrased so the model and the user can
 * see what was established and what was not.
 *
 * "Nothing observable changed" is a first-class, useful answer. It is the one
 * that stops Axon reporting success it did not verify.
 *
 * Pure. Two observations in, one verdict out.
 */

import type { ChangeVerification, ObservedElement, PageObservation } from '@axon/core';

/** Collapse whitespace so re-flow and re-render are not reported as change. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** An element's identity, independent of the reference number Axon minted. */
function identity(element: ObservedElement): string {
  return `${element.role}|${element.label}|${element.href ?? ''}`;
}

function elementSet(observation: PageObservation): Set<string> {
  return new Set(observation.elements.map(identity));
}

function setsDiffer(before: Set<string>, after: Set<string>): boolean {
  if (before.size !== after.size) return true;
  for (const entry of before) {
    if (!after.has(entry)) return true;
  }
  return false;
}

export interface VerifyInputs {
  readonly before: PageObservation | null;
  readonly after: PageObservation;
  /**
   * Text Axon just sent, when it sent any.
   *
   * The strongest site-independent evidence of a submission is the submitted
   * words appearing in the page's visible text afterwards. It is evidence and
   * not proof: a site may render a comment asynchronously, or truncate it, or
   * show it in a place the observer does not reach. So a false here is
   * reported as "could not confirm", never as "it failed".
   */
  readonly submittedText?: string | null;
}

/**
 * Whether the submitted text is now visible on the page.
 *
 * Compared on a normalized, lowercased prefix rather than the whole string:
 * sites wrap, trim and re-flow what they render, and a whole-string match
 * would report "not confirmed" for a comment that is plainly there. The
 * prefix is long enough that an unrelated coincidence is not a realistic
 * concern, and short enough to survive the site's own formatting.
 */
export function submittedTextVisible(text: string, observation: PageObservation): boolean {
  const needle = normalize(text).toLowerCase();
  if (needle.length === 0) return false;
  const haystack = normalize(observation.text).toLowerCase();
  const probe = needle.slice(0, Math.min(needle.length, 80));
  return haystack.includes(probe);
}

export function verifyChange(inputs: VerifyInputs): ChangeVerification {
  const { before, after } = inputs;
  const submitted = inputs.submittedText ?? null;

  // No prior reading means no comparison is possible. Saying so is the honest
  // answer; claiming "changed" or "unchanged" would both be inventions.
  if (!before) {
    const visible = submitted === null ? null : submittedTextVisible(submitted, after);
    return {
      changed: false,
      urlChanged: false,
      titleChanged: false,
      textChanged: false,
      elementsChanged: false,
      submittedTextVisible: visible,
      summary:
        'Axon had no earlier reading of this page to compare against, so it cannot say what the action changed.' +
        (visible === true ? ' The text that was sent is visible on the page now.' : ''),
    };
  }

  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const textChanged = normalize(before.text) !== normalize(after.text);
  const elementsChanged = setsDiffer(elementSet(before), elementSet(after));
  const visible = submitted === null ? null : submittedTextVisible(submitted, after);

  const changed = urlChanged || titleChanged || textChanged || elementsChanged;

  const parts: string[] = [];
  if (urlChanged) parts.push(`the address changed to ${after.url}`);
  if (titleChanged && !urlChanged) parts.push(`the page title is now "${after.title}"`);
  if (textChanged) parts.push('the visible text changed');
  if (elementsChanged && !textChanged) parts.push('the controls on the page changed');

  let summary: string;
  if (!changed) {
    summary =
      'Nothing observable changed on the page after this action. It may not have taken effect. ' +
      'Do not report it as done — check the page, or tell the user what you saw.';
  } else {
    summary = `After the action, ${parts.join(', ')}.`;
  }

  if (visible === true) {
    summary += ' The text that was sent is now visible on the page.';
  } else if (visible === false) {
    summary +=
      ' The text that was sent is NOT visible on the page, so Axon could not confirm it was accepted. ' +
      'That is not proof it failed — say what was and was not confirmed rather than claiming either.';
  }

  return { changed, urlChanged, titleChanged, textChanged, elementsChanged, submittedTextVisible: visible, summary };
}
