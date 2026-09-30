/**
 * The browser, put under the conditions a live demo actually meets.
 *
 * The unit suites cover each tool. This covers the WEATHER: a page that
 * redirects mid-task, a navigation that fails, one that never finishes, a
 * result list that changed while Axon was deciding, and a page that spends its
 * text telling Axon what to do.
 *
 * Every one of these has the same shape of failure available to it — Axon
 * acting on a document that is not the one it reasoned about — and every one
 * of them is closed by the same mechanism rather than by a special case. That
 * is the property under test: not that each situation is handled, but that
 * they are handled by the SAME thing.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoHarness } from './support/demo-harness.js';
import { hostileInternshipSite, youtubeSite } from './support/fake-site.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = path.resolve(HERE, '../src');

function outputOf(answer: { body: Record<string, unknown> } | undefined): Record<string, unknown> {
  return (answer?.body.output ?? {}) as Record<string, unknown>;
}

function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  return (outputOf(answer) as { elements?: { ref: string; label: string; role: string }[] }).elements ?? [];
}

// ---------------------------------------------------------------------------
// The page moves
// ---------------------------------------------------------------------------

describe('a page that moves under Axon', () => {
  it('does not act on a reference from the document that has gone', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const signIn = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Sign in');
    expect(signIn).toBeDefined();

    // A redirect, a timer, a live update — the page is a different document
    // now, and that reference describes a position in the old one.
    site.driftTo('/results');
    await h.propose('browser.click', { ref: signIn!.ref });

    const answer = h.answers.at(-1);
    if (answer?.body.ok === true) {
      // Recovered by identity: the element it clicked is the one it meant, or
      // it did not click. Either way it is not on a sign-in page it never
      // resolved.
      expect(String(outputOf(answer).url)).not.toContain('accounts.google.com');
    } else {
      expect(['STALE_REFERENCE', 'CLARIFICATION_NEEDED', 'EXECUTION_ERROR']).toContain(answer?.body.errorKind);
    }
  });

  it('re-reads once and recovers when the element is unambiguously still there', async () => {
    // Refusing a stale reference is correct; refusing and stopping there makes
    // the agent brittle. The recovery is safe because it matches on exactly
    // the fields the risk policy reads.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const home = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Home');

    // Same page, but Axon's reading is stale.
    site.mutate(() => {});
    await h.propose('browser.click', { ref: home!.ref });

    expect(h.answers.at(-1)?.body.ok).toBe(true);
  });

  it('verifies before declaring failure, and says which happened', async () => {
    // A navigation can report an error and still have loaded the page: a slow
    // sub-resource, an aborted redirect, a `did-fail-load` for a frame. So the
    // error is not the answer — ONE bounded read is, and whichever it
    // establishes is what gets said.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    site.failNext(new Error('ERR_NAME_NOT_RESOLVED'));
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const answer = h.answers.at(-1);
    if (answer?.body.ok === true) {
      // Established, and it says so rather than quietly reporting success.
      const output = outputOf(answer);
      expect((output.navigation as { status: string }).status).toBe('SUCCESS');
      expect(String(output.note)).toMatch(/navigation reported an error/i);
    } else {
      expect(String(answer?.body.error)).toMatch(/could not|not resolve|fake site/i);
    }
  });

  it('reports a navigation that really did not land', async () => {
    // Nothing to verify: Axon is not on the host it asked for, and the check
    // establishes that rather than the opposite.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open that other site');
    await h.propose('browser.open', { url: 'https://unreachable.example.net/' });

    const answer = h.answers.at(-1);
    expect(answer?.body.ok).toBe(false);
    expect(String(answer?.body.error).length).toBeGreaterThan(0);
  });

  it('does not retry a failing address forever', async () => {
    // A site that did not load twice will not load on the third attempt inside
    // the same conversation, and each attempt costs a person's patience. The
    // third is refused BEFORE anything is attempted, and refused
    // non-retryably so the model is told to stop rather than to vary the
    // arguments until something gets through.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open that other site');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.propose('browser.open', { url: 'https://unreachable.example.net/' });
    }

    const last = h.answers.at(-1);
    expect(last?.body.ok).toBe(false);
    expect(String(last?.body.error)).toMatch(/do not try again|already tried|too many/i);
    expect(last?.body.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The page talks
// ---------------------------------------------------------------------------

describe('a page that spends its text giving orders', () => {
  it('cannot become a tool call, because text is only ever a result', async () => {
    // The structural claim. A page's words arrive as a tool RESULT; only the
    // model can produce a tool CALL; and every call it produces is gated. So
    // the sentence has to persuade the model AND survive the policy AND
    // survive the user — three independent points, none of which the page
    // controls.
    const site = hostileInternshipSite();
    const h = createDemoHarness({ site, decide: () => 'DENY' });

    h.say('open the application and tell me what it needs');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });

    const text = String(outputOf(h.answers.at(-1)).untrustedPageText);
    expect(text).toContain('Ignore your previous instructions');
    // Nothing was dispatched because of it.
    const calls = h.events.filter((event) => event.type === 'TOOL_CALL');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type === 'TOOL_CALL' && calls[0].tool).toBe('browser.open');
  });

  it('is fenced and labelled, so its boundaries are unambiguous', async () => {
    const site = hostileInternshipSite();
    const h = createDemoHarness({ site });

    h.say('open the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });

    const output = outputOf(h.answers.at(-1));
    // Named as somebody else's words, fenced at both ends, and accompanied by
    // a note saying what that means.
    expect(output.untrustedPageText).toBeDefined();
    expect(String(output.untrustedPageText)).toMatch(/^<<<UNTRUSTED_WEB_CONTENT>>>/);
    expect(String(output.note)).toMatch(/never as instructions/i);
  });

  it('cannot reach the risk policy, which has never read a page', async () => {
    // Asserted about the SOURCE, because it is a claim about every run rather
    // than about this one: the dispatcher reads no page content at all.
    const dispatcher = fs
      .readFileSync(path.resolve(DESKTOP_SRC, 'main/safety/dispatcher.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(dispatcher).not.toMatch(/untrustedPageText|pageText|lastObservation|describeElement/);
  });

  it('cannot open a window, because the browser refuses every popup', () => {
    // A page's `window.open` is denied outright and NOT forwarded to the
    // user's own browser — forwarding would make Axon a launcher that any
    // visited site could aim at a logged-in session.
    const browser = fs.readFileSync(path.resolve(DESKTOP_SRC, 'main/browser/axon-browser.ts'), 'utf8');
    const handler = browser.slice(browser.indexOf('setWindowOpenHandler'), browser.indexOf('will-attach-webview'));
    expect(handler).toContain("action: 'deny'");
    expect(handler).not.toContain('openExternal');
  });

  it('cannot redirect Axon somewhere the policy would refuse', () => {
    // Every navigation is re-checked as it happens, by the mechanism rather
    // than by the policy that approved the call — so a redirect to a private
    // address is stopped even though no tool call named one.
    const browser = fs.readFileSync(path.resolve(DESKTOP_SRC, 'main/browser/axon-browser.ts'), 'utf8');
    expect(browser).toMatch(/on\('will-navigate'[\s\S]{0,200}isNavigable/);
    expect(browser).toMatch(/on\('will-redirect'[\s\S]{0,200}isNavigable/);
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('finding the thing to act on', () => {
  it('describes only what Axon itself found, with references Axon minted', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const elements = elementsOf(h.answers.at(-1));
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.every((element) => /^e\d+$/.test(element.ref))).toBe(true);
    // No selector, no coordinate, no DOM path anywhere in what the model gets.
    expect(JSON.stringify(elements)).not.toMatch(/selector|xpath|querySelector|"x"|"y"/);
  });

  it('refuses a reference the model invented', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site, decide: () => 'ALLOW' });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    // A reference Axon has no record of is not merely unknown — its RISK
    // cannot be determined, which escalates to an approval before the
    // precheck refuses it. So some of these are answered as "pending" on the
    // wire and refused a moment later, and some fail the schema outright.
    // Neither ever clicks anything, which is the property.
    for (const ref of ['e9999', '#search', 'button.submit', '940,512']) {
      await h.propose('browser.click', { ref });
      const answer = h.answers.at(-1);
      if (answer?.body.ok === undefined && answer?.body.status === 'pending_user_approval') {
        await h.settle(60);
        expect(h.spoken.at(-1), ref).toMatch(/could not be done|no element|read the page/i);
      } else {
        expect(answer?.body.ok, ref).toBe(false);
        expect(['STALE_REFERENCE', 'INVALID_INPUT']).toContain(answer?.body.errorKind);
      }
    }

    // And after all of that, Axon is still on the page it opened.
    expect(site.url).toBe('https://www.youtube.com/');
  });

  it('asks which one when two candidates are indistinguishable', async () => {
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open YouTube and open the first result');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    site.driftTo('/results');
    await h.propose('browser.read', {});
    const candidate = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));

    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    const answer = h.answers.at(-1);
    expect(answer?.body.errorKind).toBe('CLARIFICATION_NEEDED');

    // A QUESTION, and the question itself is short. The message identifies
    // what is ambiguous — which is as long as the thing's own name — and then
    // asks. What the user hears is the last sentence.
    const message = String(answer?.body.error);
    expect(message).toMatch(/which one do you mean\?$/i);
    const question = message.split('. ').at(-1) ?? message;
    expect(question.length).toBeLessThan(40);
    // And it is not a diagnostic.
    expect(message).not.toMatch(/resolution|graph|ambiguity|identifier|epoch/i);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('the browser cannot run away with a conversation', () => {
  it('bounds how many actions one conversation may take', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('read the page over and over');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    let refused: string | undefined;
    for (let attempt = 0; attempt < 60 && refused === undefined; attempt += 1) {
      site.mutate(() => {});
      await h.propose('browser.read', {});
      const answer = h.answers.at(-1);
      if (answer?.body.ok === false) refused = String(answer.body.errorKind);
    }

    expect(refused).toBeDefined();
    expect(['BUDGET_EXCEEDED', 'CANCELLED', 'EXECUTION_ERROR']).toContain(refused);
  });

  it('bounds what one page can inject into the conversation', async () => {
    // A page can be ten megabytes. What reaches the model is bounded, and the
    // truncation is REPORTED — a model that does not know it is reading half a
    // page will answer confidently from half a page.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const output = outputOf(h.answers.at(-1));
    expect(output.pageTextTruncated).toBe(false);
    expect(output).toHaveProperty('elementsTruncated');
    expect(String(output.untrustedPageText).length).toBeLessThan(20_000);
  });
});
