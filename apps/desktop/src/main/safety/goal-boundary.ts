/**
 * The agent may pursue the user's goal. It may not invent a new one.
 *
 * WHAT WENT WRONG, AND WHY A PROMPT WAS NOT THE FIX.
 *
 * A live test asked Axon to "open my GitHub". Axon opened GitHub, then went to
 * `/signup`, then into a Google sign-in flow. Nothing in that sequence broke a
 * rule: each navigation was a public https page, each was SAFE by the URL
 * policy, and the model believed it was being helpful. The failure was that a
 * modest goal silently became a consequential one, and no layer noticed
 * because no layer was looking at the goal at all.
 *
 * Telling the model to behave is not a fix. The model is the thing that
 * drifted, and a drifting model asked to police its own drift is not a
 * control. So this is a control: Axon compares the destination against what
 * the user actually said, and escalates when they do not match.
 *
 * THE RULE, STATED ONCE.
 *
 *   Substeps required by the user's stated goal are fine.
 *   A NEW consequential goal the user did not ask for requires a human.
 *
 * WHAT THIS IS NOT.
 *
 * It is not a refusal, and it is not an attempt to guess intent correctly. It
 * escalates to the existing approval gate, which means the worst case is that
 * Axon asks about something the user did want — a small annoyance with a
 * visible, informative dialog naming the destination. The failure it prevents
 * is Axon signing the user up for something while they watched.
 *
 * It is also not site-specific. There is no GitHub in this file. What it
 * recognises is the SHAPE of a consequential destination, which is remarkably
 * consistent across the web because these flows are named by convention.
 *
 * Pure: two strings in, a verdict out. No network, no state, no clock.
 */

import type { RiskAssessment, RiskLevel } from '@axon/core';
import { escalate } from '@axon/core';
import { assumeHttps } from '../browser/url-policy.js';

/**
 * Kinds of destination that change something about a person rather than
 * merely showing them a page.
 *
 * Each carries the words a user would use if they actually wanted it. The
 * match is deliberately generous on the goal side and strict on the
 * destination side: a user who said "sign me in" gets no friction, and a user
 * who said "open my GitHub" gets asked before an account is created.
 */
interface ConsequentialIntent {
  readonly id: string;
  /** How Axon describes it in the approval dialog. */
  readonly description: string;
  /**
   * Path SEGMENTS that identify the destination. Lowercased.
   *
   * Whole segments, not substrings. `/news/register-of-members` is an article
   * and `/register` is a form, and a substring match cannot tell them apart —
   * which is how a rule meant to catch account creation starts firing on the
   * news.
   */
  readonly destination: readonly string[];
  /** Phrases in the user's own request that would authorise it outright. */
  readonly goalWords: readonly string[];
  /**
   * Looser authorisation: every token in a group must appear somewhere.
   *
   * People do not phrase goals the way a match table does. "Create a GitHub
   * account for me" contains neither "create account" nor "sign up", and
   * refusing it would mean asking a user to approve the thing they had just
   * asked for in plain words.
   */
  readonly goalGroups?: readonly (readonly string[])[];
  readonly level: RiskLevel;
}

const INTENTS: readonly ConsequentialIntent[] = [
  {
    id: 'account-creation',
    description: 'create an account',
    destination: ['signup', 'sign-up', 'sign_up', 'register', 'registration', 'join', 'create-account', 'createaccount', 'new-account'],
    goalWords: ['sign up', 'signup', 'register', 'create an account', 'create account', 'new account'],
    goalGroups: [
      ['account', 'create'],
      ['account', 'make'],
      ['account', 'new'],
      ['account', 'set up'],
      ['account', 'register'],
    ],
    // Creating an account under somebody's name and email is not reversible
    // by clicking back, and it is often tied to a real identity.
    level: 'HIGH_RISK',
  },
  {
    id: 'authentication',
    description: 'sign in',
    destination: ['signin', 'sign-in', 'sign_in', 'login', 'log-in', 'log_in', 'oauth', 'sso', 'session/new', 'auth/login'],
    goalWords: ['sign in', 'signin', 'log in', 'login', 'log me in', 'sign me in', 'authenticate'],
    goalGroups: [['account', 'connect'], ['in', 'credentials']],
    level: 'REQUIRES_APPROVAL',
  },
  {
    id: 'payment',
    description: 'go to a checkout or payment page',
    destination: ['checkout', 'payment', 'billing', 'purchase', 'subscribe', 'upgrade', 'pricing/buy', 'cart/pay'],
    goalWords: ['buy', 'purchase', 'checkout', 'check out', 'pay', 'subscribe', 'upgrade', 'order'],
    level: 'HIGH_RISK',
  },
  {
    id: 'account-settings',
    description: 'change account or security settings',
    destination: ['settings/security', 'settings/account', 'account/delete', 'delete-account', 'settings/password', 'change-password', 'security/keys', 'tokens/new', 'apikeys', 'api-keys'],
    goalWords: ['settings', 'password', 'security', 'delete my account', 'api key', 'token'],
    goalGroups: [['account', 'change'], ['account', 'delete']],
    level: 'HIGH_RISK',
  },
];

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/:._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which consequential intent, if any, a destination represents.
 *
 * Matched against the PATH AND QUERY ONLY, never the host. A host named
 * "loginsystems.com" is not a sign-in page, and matching hosts would make this
 * fire on ordinary sites with unlucky names — a false positive here costs a
 * needless approval dialog, and enough of those is how a dialog stops being
 * read.
 */
export function classifyDestination(url: string): ConsequentialIntent | null {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    // An unparseable URL is refused by the URL policy long before this. There
    // is nothing here to classify.
    return null;
  }

  // The root path is never consequential, whatever the host is called.
  if (path === '/' || path === '') return null;

  // Split into segments and query tokens. Matching WHOLE segments rather than
  // substrings is what separates `/register` from `/register-of-members` and
  // `/login` from `/logistics`.
  const [pathname = '', query = ''] = path.split('?', 2);
  const segments = new Set(pathname.split('/').filter((segment) => segment !== ''));
  for (const pair of query.split('&')) {
    const [key = '', value = ''] = pair.split('=', 2);
    if (key !== '') segments.add(key);
    if (value !== '') segments.add(value);
  }

  for (const intent of INTENTS) {
    for (const fragment of intent.destination) {
      // A fragment may itself be a path, e.g. "settings/security".
      if (fragment.includes('/')) {
        if (pathname.includes(`/${fragment}`)) return intent;
        continue;
      }
      if (segments.has(fragment)) return intent;
    }
  }
  return null;
}

/**
 * Did the user actually ask for this?
 *
 * Generous by design. Anything that reads like the user naming the goal counts
 * — Axon is deciding whether to ASK, and asking when it did not need to is a
 * far cheaper mistake than not asking when it should have.
 */
export function goalPermits(goal: string | null, intent: ConsequentialIntent): boolean {
  if (goal === null) return false;
  const normalized = normalize(goal);
  if (normalized === '') return false;

  if (intent.goalWords.some((word) => normalized.includes(word))) return true;
  return (intent.goalGroups ?? []).some((group) => group.every((token) => normalized.includes(token)));
}

export interface GoalCheckInput {
  readonly tool: string;
  readonly input: unknown;
  /** What the user said this turn, verbatim. Never the model's paraphrase. */
  readonly goal: string | null;
}

/**
 * Escalate a navigation whose destination the user did not ask for.
 *
 * ESCALATION ONLY. This can raise a verdict and can never lower one, which is
 * what makes it safe to add to the pipeline: a bug here produces an extra
 * approval dialog, never a missing one. `escalate` from core enforces that
 * direction rather than leaving it to this function's discipline.
 *
 * Returns null when it has nothing to say, so the dispatcher can tell "no
 * opinion" from "SAFE".
 */
export function checkGoalBoundary(check: GoalCheckInput): RiskAssessment | null {
  // Only navigation is judged. A click is already classified from Axon's own
  // reading of the element, which is a better signal than a URL — and a click
  // that leads somewhere consequential will be re-judged when the navigation
  // it causes is re-checked by the browser's own policy.
  if (check.tool !== 'browser.open' && check.tool !== 'browser.navigate' && check.tool !== 'web.open') return null;

  const url = (check.input as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return null;

  const intent = classifyDestination(assumeHttps(url));
  if (!intent) return check.tool === 'web.open' ? siteBoundary(url, check.goal) : null;

  if (goalPermits(check.goal, intent)) {
    // The user asked for exactly this. No escalation — and saying so in the
    // reason means the timeline records WHY a consequential page was allowed
    // through without a dialog.
    return {
      level: 'SAFE',
      reason: `The user asked to ${intent.description}, so opening that page is the goal rather than a detour.`,
    };
  }

  return {
    level: intent.level,
    reason:
      `This page would ${intent.description}, which the user did not ask for. ` +
      'Opening a site is not permission to sign up, sign in, buy, or change account settings on it.',
  };
}

/** Second-level labels that are really part of a country suffix: bbc.CO.uk. */
const SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or']);

/**
 * The name a person would say for a site: "youtube" for www.youtube.com,
 * "google" for docs.google.com, "bbc" for www.bbc.co.uk. Null for an address
 * that is not a hostname with a name in it.
 */
export function siteName(url: string): string | null {
  let host: string;
  try {
    host = new URL(assumeHttps(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label))) return null;
  const second = labels[labels.length - 2] ?? '';
  const name = labels.length >= 3 && SUFFIX_LABELS.has(second) ? labels[labels.length - 3] : second;
  return name && name.length >= 2 ? name : null;
}

/**
 * `web.open` hands a site to the user's OWN browser — their sessions, their
 * saved sign-ins — which is more than Axon's sandboxed window ever carries. So
 * a site the user did not name is asked about first. "Open YouTube" names
 * youtube.com; "find me a recipe" names no site, and the model's choice of one
 * is shown to the person before it opens.
 *
 * ESCALATION ONLY, like everything here: a site the user named is simply not
 * escalated, never made safer than the URL policy says.
 */
function siteBoundary(url: string, goal: string | null): RiskAssessment | null {
  const name = siteName(url);
  if (!name) return null;
  const said = (goal ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (said.includes(name)) return null;
  return {
    level: 'REQUIRES_APPROVAL',
    reason:
      `The user did not name ${name}, and web.open opens it in their own browser, where they are signed in. ` +
      'Axon asks before opening a site the user did not ask for.',
  };
}

/**
 * Apply the boundary to a risk verdict, taking the worse of the two.
 *
 * The one place the two are combined, so there is no path where a goal check
 * runs and its verdict is discarded.
 */
export function withGoalBoundary(assessment: RiskAssessment, check: GoalCheckInput): RiskAssessment {
  const verdict = checkGoalBoundary(check);
  if (!verdict) return assessment;

  const level = escalate(assessment.level, verdict.level);
  if (level === assessment.level) return assessment;
  return { level, reason: verdict.reason };
}
