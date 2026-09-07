/**
 * Classifying what a click or a keystroke would actually do.
 *
 * THE LOAD-BEARING IDEA.
 *
 * Risk here is resolved from AXON'S OWN RECORD of the page — the element list
 * `browser.read` produced and stored in the main process — and never from
 * anything the model said about it. The model's entire input to a click is a
 * reference number; it cannot describe the button, cannot rename it, and
 * cannot assert that it is harmless. If the model asks to click `e17` and
 * Axon's record says `e17` is labelled "Delete repository", this file says
 * HIGH_RISK, and no amount of confident narration changes that.
 *
 * That inverts the usual arrangement, where an agent decides what is dangerous
 * and the system trusts it. Here the system decides, from evidence it gathered
 * itself, and the model is one of the things being checked.
 *
 * WHY LABEL MATCHING IS ENOUGH, AND WHERE IT ISN'T.
 *
 * Matching English words on a button is not a complete theory of consequence,
 * and it is not offered as one. It is a *floor*: it catches the destructive
 * verbs that appear on real interfaces, and everything it does not
 * specifically recognise still has to pass the general rule below — anything
 * that submits a form or sends something requires approval. So a button this
 * file has never heard of does not become SAFE by being unfamiliar; it becomes
 * SAFE only by being, as far as Axon can tell, a link or a navigation.
 *
 * The failure mode to avoid is the reverse: a button labelled in a language or
 * a phrasing not listed here that does something destructive. That is why
 * `submits` is treated as significant on its own, why the approval dialog
 * always names the page and the exact label, and why the user — who can see
 * the real browser window — makes the final call.
 */

import { escalate, type RiskAssessment, type RiskLevel } from '@axon/core';
import type { ObservedElement } from '@axon/core';

/**
 * Phrases that mean "this destroys something, spends money, or cannot be
 * undone". Matched case-insensitively against the element's accessible name.
 */
const HIGH_RISK_PHRASES: readonly string[] = [
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
  'merge',
  'close account',
  'delete account',
  'reset',
  'restore defaults',
  'grant access',
  'add member',
  'change password',
  'security',
  'permissions',
];

/**
 * Phrases that mean "this sends something outward, or changes shared state".
 *
 * Not destructive, but not takeable back either: a comment posted under the
 * user's name is a thing the user said.
 */
const APPROVAL_PHRASES: readonly string[] = [
  'send',
  'post',
  'submit',
  'comment',
  'reply',
  'publish',
  'create',
  'save',
  'apply',
  'update',
  'upload',
  'attach',
  'share',
  'invite',
  'follow',
  'star',
  'watch',
  'fork',
  'open issue',
  'new issue',
  'pull request',
  'request review',
  'approve',
  'sign in',
  'log in',
  'sign up',
  'register',
  'continue',
  'confirm',
  'accept',
  'agree',
];

function matches(label: string, phrases: readonly string[]): string | null {
  const haystack = label.toLowerCase();
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

/** A short description of the page an action would happen on. */
export interface ActionContext {
  /** The page URL Axon last observed. Shown in the approval dialog. */
  readonly url: string;
  readonly title: string;
}

/**
 * Risk of clicking one element.
 *
 * `element` comes from Axon's stored observation. A null element means the
 * reference is unknown — stale, invented, or from a page that has since
 * changed — and that is never SAFE: Axon does not know what it would be
 * clicking, which is the definition of a call whose risk could not be
 * determined.
 */
export function clickRisk(element: ObservedElement | null, context: ActionContext | null): RiskAssessment {
  if (!element) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason:
        'Risk could not be determined: Axon has no record of that element on the page it last read. ' +
        'Read the page again before acting on it.',
    };
  }

  const where = context ? ` on ${context.url}` : '';
  const label = element.label || element.href || 'an unlabelled element';

  // A password field is not a thing to click through an agent, ever.
  if (element.sensitive) {
    return {
      level: 'FORBIDDEN',
      reason: `"${label}" is a credential or payment field. Axon does not interact with those.`,
    };
  }

  const destructive = matches(element.label, HIGH_RISK_PHRASES);
  if (destructive) {
    return {
      level: 'HIGH_RISK',
      reason: `"${label}"${where} looks destructive, expensive or hard to undo (it says "${destructive}").`,
    };
  }

  // A LINK NAVIGATES; A BUTTON ACTS. This distinction is checked before the
  // wording, and it matters more than it first appears.
  //
  // Without it, GitHub's "Pull requests 721" — an ordinary navigation link —
  // raises an approval, because the phrase list quite reasonably contains
  // "pull request". So does "Sign in", which only opens a login page. Asking
  // about those trains the user to click Allow without reading, which is
  // exactly the harm the HIGH_RISK level exists to prevent. Approval fatigue
  // is a security failure, not a usability one.
  //
  // Following a link is a fetch, and the address it fetches is itself subject
  // to the URL policy at navigation time. A link that genuinely destroys
  // something is still caught above, by the destructive-phrase check.
  if (element.role === 'link') {
    return {
      level: 'SAFE',
      reason: `Following the link "${label}"${where} only opens another page.`,
    };
  }

  // The general rule, independent of wording: anything that submits a form is
  // an outward action whatever it is called.
  if (element.submits) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason: `"${label}"${where} submits a form, which sends something.`,
    };
  }

  const outward = matches(element.label, APPROVAL_PHRASES);
  if (outward) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason: `"${label}"${where} sends something or changes shared state (it says "${outward}").`,
    };
  }

  if (element.role === 'checkbox' || element.role === 'radio' || element.role === 'select') {
    return {
      level: 'SAFE',
      reason: `Setting "${label}"${where} changes a form control without sending it.`,
    };
  }

  // A button that neither submits nor matches a known phrase. Usually a
  // disclosure or a tab; occasionally something this file has not learned.
  // SAFE, and visibly so: the user is watching the real browser window.
  return {
    level: 'SAFE',
    reason: `"${label}"${where} appears to change what is shown without sending anything.`,
  };
}

/**
 * Risk of typing into one element.
 *
 * Typing is not sending. Text going into a visible field on a page the user
 * can see is a draft, and treating every keystroke as an approval-worthy event
 * would make the dialog meaningless by the time it mattered. What requires
 * approval is the sending — the click on "Comment", or a `submit` on this same
 * call, which is the one form of typing that leaves the machine.
 */
export function typeRisk(
  element: ObservedElement | null,
  submit: boolean,
  context: ActionContext | null,
): RiskAssessment {
  if (!element) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason:
        'Risk could not be determined: Axon has no record of that field on the page it last read. ' +
        'Read the page again before typing into it.',
    };
  }

  const where = context ? ` on ${context.url}` : '';
  const label = element.label || 'an unlabelled field';

  // The hard rule. Axon never types a password, a card number or a one-time
  // code — not with approval, not at the user's request, not ever. If a page
  // wants a credential, the person types it themselves.
  if (element.sensitive) {
    return {
      level: 'FORBIDDEN',
      reason:
        `"${label}" is a password, payment or one-time-code field. Axon never types credentials — ` +
        'if the page needs one, the user should type it themselves.',
    };
  }

  if (element.role !== 'textbox') {
    return {
      level: 'REQUIRES_APPROVAL',
      reason: `Risk could not be determined: "${label}" is not a text field.`,
    };
  }

  if (submit) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason: `Typing into "${label}"${where} and pressing Enter submits it, which sends something.`,
    };
  }

  return {
    level: 'SAFE',
    reason: `Typing into "${label}"${where} fills in a field the user can see, and sends nothing.`,
  };
}

/**
 * Combine a URL verdict with an action verdict, taking the worse of the two.
 *
 * Used where an action both goes somewhere and does something.
 */
export function worstOf(...assessments: readonly RiskAssessment[]): RiskAssessment {
  const level: RiskLevel = escalate(...assessments.map((assessment) => assessment.level));
  const worst = assessments.find((assessment) => assessment.level === level);
  return worst ?? { level, reason: 'Combined risk assessment.' };
}
