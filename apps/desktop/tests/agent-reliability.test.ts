/**
 * Reliability behaviours, each one a bug seen in a live session.
 *
 * These are not hypotheticals. Every describe block below corresponds to
 * something Axon actually did wrong while somebody was talking to it:
 *
 *   "open my GitHub"        -> went on to /signup and into a Google sign-in
 *   a page that re-rendered -> refused, and stayed refused
 *   four page reads         -> BUDGET_EXCEEDED, in a session doing nothing odd
 *   a navigation that erred -> reported failure for a page that had loaded
 *
 * The fixes share a shape: Axon establishes what is true rather than trusting
 * either the model's optimism or its own first answer. Nothing here relaxes a
 * check — the goal boundary only escalates, recovery only ever matches an
 * element with an identical risk identity, and the read bound still bounds.
 */

import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '@axon/core';
import { checkGoalBoundary, classifyDestination, goalPermits, withGoalBoundary } from '../src/main/safety/goal-boundary.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { createHarness } from './support/agent-harness.js';
import { githubIssueSite } from './support/fake-site.js';
import { ScriptedBrain, refFor, type Step } from './support/scripted-brain.js';

const SAFE: RiskAssessment = { level: 'SAFE', reason: 'ordinary page' };

// ---------------------------------------------------------------------------
// 1. Opening a site is not permission to sign up on it.
// ---------------------------------------------------------------------------

describe('the agent may not invent a consequential goal', () => {
  it('recognises destinations that change something about a person', () => {
    expect(classifyDestination('https://github.com/signup')?.id).toBe('account-creation');
    expect(classifyDestination('https://example.com/users/sign_in')?.id).toBe('authentication');
    expect(classifyDestination('https://shop.example/checkout/pay')?.id).toBe('payment');
    expect(classifyDestination('https://example.com/settings/security')?.id).toBe('account-settings');
  });

  it('leaves ordinary pages alone', () => {
    // A false positive here costs a needless approval dialog, and enough of
    // those is how a dialog stops being read. The bar is deliberately high.
    for (const url of [
      'https://github.com',
      'https://github.com/axon/demo/issues/41',
      'https://news.example/2026/09/register-of-members',
      'https://example.com/docs/logistics',
      'https://example.com/blog/how-we-joined-forces',
    ]) {
      expect(classifyDestination(url), url).toBeNull();
    }
  });

  it('over-triggers on an article whose path segment is a flow name', () => {
    // A KNOWN and ACCEPTED false positive, recorded rather than hidden.
    // Wikipedia's article about logging in lives at `/wiki/Login`, and by
    // segment matching that is indistinguishable from a sign-in page.
    //
    // The cost is one approval dialog naming the destination, on a page that
    // does nothing. The alternative — trying to tell articles from forms by
    // their surrounding path — would be guesswork that fails silently in the
    // other direction, and a missed sign-in page is the failure that matters.
    expect(classifyDestination('https://en.wikipedia.org/wiki/Login')?.id).toBe('authentication');
  });

  it('never matches on the host, only the path', () => {
    // "loginsystems.com" is a company, not a sign-in page.
    expect(classifyDestination('https://loginsystems.com/')).toBeNull();
    expect(classifyDestination('https://signup.example.com/')).toBeNull();
  });

  it('escalates a signup the user did not ask for', () => {
    // The exact live failure: "Can you open my GitHub?" followed by /signup.
    const verdict = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://github.com/signup' },
      goal: 'Can you open my GitHub?',
    });

    expect(verdict?.level).toBe('HIGH_RISK');
    expect(verdict?.reason).toMatch(/did not ask for/i);
    expect(verdict?.reason).toMatch(/not permission to sign up/i);
  });

  it('lets the same navigation through when the user asked for it', () => {
    const verdict = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://github.com/signup' },
      goal: 'Create a GitHub account for me',
    });
    expect(verdict?.level).toBe('SAFE');
  });

  it('treats signing in as a goal of its own', () => {
    const asked = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://github.com/login' },
      goal: 'Sign in to GitHub',
    });
    expect(asked?.level).toBe('SAFE');

    const unasked = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://github.com/login' },
      goal: 'open my GitHub',
    });
    expect(unasked?.level).toBe('REQUIRES_APPROVAL');
  });

  it('is generic, not a list of sites', () => {
    // The same rule on a site nobody wrote code for.
    const verdict = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://some-forum.example/account/register' },
      goal: 'open the forum',
    });
    expect(verdict?.level).toBe('HIGH_RISK');
  });

  it('escalates and never de-escalates', () => {
    // The property that makes it safe to add to the pipeline: a bug here
    // produces an extra dialog, never a missing one.
    const high: RiskAssessment = { level: 'HIGH_RISK', reason: 'destructive' };
    const kept = withGoalBoundary(high, {
      tool: 'browser.open',
      input: { url: 'https://example.com/login' },
      goal: 'sign in',
    });
    expect(kept.level).toBe('HIGH_RISK');

    const raised = withGoalBoundary(SAFE, {
      tool: 'browser.open',
      input: { url: 'https://example.com/signup' },
      goal: 'open the site',
    });
    expect(raised.level).toBe('HIGH_RISK');
  });

  it('says nothing about tools that are not navigation', () => {
    // A click is already classified from Axon's own reading of the element,
    // which is better evidence than a URL.
    expect(checkGoalBoundary({ tool: 'browser.click', input: { ref: 'e1' }, goal: 'anything' })).toBeNull();
    expect(checkGoalBoundary({ tool: 'fs.write', input: { path: 'x' }, goal: null })).toBeNull();
  });

  it('escalates when there is no stated goal at all', () => {
    // No goal cannot mean "any goal is fine".
    expect(goalPermits(null, { id: 'x', description: 'd', destination: [], goalWords: ['sign in'], level: 'SAFE' } as never)).toBe(
      false,
    );
    const verdict = checkGoalBoundary({
      tool: 'browser.open',
      input: { url: 'https://example.com/signup' },
      goal: null,
    });
    expect(verdict?.level).toBe('HIGH_RISK');
  });
});

describe('"open GitHub" opens GitHub and stops', () => {
  it('navigates once and raises no approval', async () => {
    const site = githubIssueSite();
    const brain = new ScriptedBrain({
      steps: [
        { kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues' } },
        { kind: 'say', text: 'GitHub is open.' },
      ],
    });

    const h = createHarness({ site, brain });
    await h.send('Can you open my GitHub?');

    expect(h.approvals).toHaveLength(0);
    expect(site.calls.filter((call) => call.startsWith('open:') || call.startsWith('navigate:'))).toHaveLength(1);
  });

  it('stops a drift into signup, even with the model insisting', async () => {
    // The brain has already decided to sign the user up. The boundary is what
    // stands between that decision and the page.
    const site = githubIssueSite();
    const brain = new ScriptedBrain({
      steps: [
        { kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues' } },
        { kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/signup' } },
      ],
    });

    const h = createHarness({ site, brain, decide: () => 'DENY' });
    await h.send('Can you open my GitHub?');

    const drift = h.eventsOfType('TOOL_CALL').find((event) => String(event.input).includes('signup') || JSON.stringify(event.input).includes('signup'));
    expect(drift?.risk).toBe('HIGH_RISK');
    expect(h.approvals).toHaveLength(1);
    expect(brain.results[1]?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Reading a page is how the agent recovers. It must not be rationed like
//    an action.
// ---------------------------------------------------------------------------

describe('repeated observation is bounded by CHANGE, not by argument equality', () => {
  it('bounds repeated reads of an unchanged page', () => {
    const budget = new TurnBudget({ maxRepeatedAttempts: 2 });
    const key = 'read:https://example.com/:abcd1234';

    expect(budget.spend('browser.read', {}, key).ok).toBe(true);
    expect(budget.spend('browser.read', {}, key).ok).toBe(true);

    const third = budget.spend('browser.read', {}, key);
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable');
    expect(third.breach).toBe('REPEATS');
  });

  it('allows a read once the page has actually changed', () => {
    // This is the case that broke a live session: `browser.read` takes no
    // arguments, so every read looked identical and the fourth was refused
    // in a conversation doing nothing unusual.
    const budget = new TurnBudget({ maxRepeatedAttempts: 2 });

    expect(budget.spend('browser.read', {}, 'read:page-a').ok).toBe(true);
    expect(budget.spend('browser.read', {}, 'read:page-a').ok).toBe(true);
    // The page changed. This is a different observation, not a repeat.
    expect(budget.spend('browser.read', {}, 'read:page-b').ok).toBe(true);
    expect(budget.spend('browser.read', {}, 'read:page-b').ok).toBe(true);
  });

  it('still bounds an action by its arguments, unchanged', () => {
    // Only tools that supply a key get the new treatment; everything else
    // keeps the stricter argument-based bound it always had.
    const budget = new TurnBudget({ maxRepeatedAttempts: 1 });
    expect(budget.spend('browser.click', { ref: 'e1' }).ok).toBe(true);
    expect(budget.spend('browser.click', { ref: 'e1' }).ok).toBe(false);
  });

  it('lets a real session read as often as the page changes', async () => {
    // Eight reads across a session where the page genuinely changes each
    // time. Under the old rule this died at the fourth read, in a
    // conversation doing nothing unusual.
    const site = githubIssueSite();
    const steps: Step[] = [
      { kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues/41' } },
    ];
    for (let i = 0; i < 8; i += 1) {
      steps.push({
        kind: 'decide',
        next: () => {
          // Real new content on the page — a comment appearing, as one would
          // in a live thread being watched.
          site.acceptComment(`update ${i}`);
          site.mutate(() => {});
          return { kind: 'call', tool: 'browser.read', input: {} };
        },
      });
    }

    const brain = new ScriptedBrain({ steps });
    const h = createHarness({ site, brain });
    await h.send('keep an eye on the page');

    expect(brain.results.every((result) => result.ok)).toBe(true);
    expect(brain.results.length).toBe(9);
  });

  it('still stops a model reading the same unchanged page forever', async () => {
    const site = githubIssueSite();
    const steps: Step[] = [{ kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues' } }];
    for (let i = 0; i < 8; i += 1) steps.push({ kind: 'call', tool: 'browser.read', input: {} });

    const brain = new ScriptedBrain({ steps });
    const h = createHarness({ site, brain });
    await h.send('read the page');

    const refused = brain.results.filter((result) => !result.ok);
    expect(refused.length).toBeGreaterThan(0);
    const first = refused[0];
    if (first?.ok !== false) throw new Error('unreachable');
    expect(first.failure.kind).toBe('BUDGET_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// 4. A navigation that reports an error has not necessarily failed.
// ---------------------------------------------------------------------------

describe('a failed navigation is verified before it is reported as failed', () => {
  it('reports success when the page actually loaded', async () => {
    // The live failure: `browser.open` on YouTube returned EXECUTION_ERROR
    // while the page was on screen, and Axon told the user it could not open
    // a site they were looking at.
    const site = githubIssueSite();
    site.failNext(new Error('ERR_ABORTED'));

    const brain = new ScriptedBrain({
      steps: [{ kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues' } }],
    });

    const h = createHarness({ site, brain });
    await h.send('open my issues');

    const result = brain.results[0];
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.output)).toMatch(/navigation reported an error/i);
  });

  it('reports failure when the page really did not load', async () => {
    // Verification establishes success; it does not manufacture it. With the
    // browser refusing every call, there is nothing to verify and the original
    // failure stands.
    const site = githubIssueSite();
    const brain = new ScriptedBrain({
      steps: [{ kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/nope/nothing' } }],
    });

    const h = createHarness({ site, brain });
    await h.send('open a page that is not there');

    const result = brain.results[0];
    expect(result?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The conversation survives an approval.
// ---------------------------------------------------------------------------

describe('an approval does not lose the task', () => {
  it('keeps the request, the actions and the outcome in one coherent session', async () => {
    const site = githubIssueSite();
    const brain = new ScriptedBrain({
      steps: [
        { kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues/41' } },
        {
          kind: 'decide',
          next: (results) => {
            const ref = refFor(results.at(-1), 'Add a comment', 'textbox');
            return ref ? { kind: 'call', tool: 'browser.type', input: { ref, text: 'thanks', submit: true } } : null;
          },
        },
        { kind: 'say', text: 'Posted.' },
      ],
    });

    const h = createHarness({ site, brain });
    await h.send('reply to the maintainer saying thanks');

    // One user message, one approval, one outcome, in order — and the reply
    // comes after the approval rather than being lost across it.
    const types = h.events.map((event) => event.type);
    expect(types.indexOf('USER_MESSAGE')).toBeLessThan(types.indexOf('APPROVAL_REQUIRED'));
    expect(types.indexOf('APPROVAL_REQUIRED')).toBeLessThan(types.indexOf('APPROVAL_RESOLVED'));
    expect(types.lastIndexOf('ASSISTANT_MESSAGE')).toBeGreaterThan(types.indexOf('APPROVAL_RESOLVED'));
    expect(site.comments).toEqual(['thanks']);
  });
});
