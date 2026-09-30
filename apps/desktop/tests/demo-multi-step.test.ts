/**
 * "Open YouTube, search for AssemblyAI Voice Agent, and open the most relevant
 * result."
 *
 * THE REQUEST THE WHOLE ARCHITECTURE IS FOR.
 *
 * It is four actions, and the interesting property is not that any one of them
 * works. It is that the third depends on what the second ACTUALLY PRODUCED
 * rather than on what anybody intended it to produce — so a search that
 * silently did nothing cannot be followed by a click on a result that is not
 * there, and a page that changed under Axon cannot be acted on with references
 * from before it changed.
 *
 * Each step is proposed, schema-checked, precheck-ed, budgeted, risk-resolved,
 * policy-decided, duplicate-checked, executed and VERIFIED on its own. Nothing
 * about having done step one makes step two legal. These tests walk that
 * whole path with the real pipeline underneath and assert it at every joint —
 * including the joints where it is supposed to stop.
 */

import { describe, expect, it } from 'vitest';
import { createDemoHarness } from './support/demo-harness.js';
import { youtubeSite } from './support/fake-site.js';

/** The interactive elements of the page Axon last read, as the model sees them. */
function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  const output = (answer?.body.output ?? {}) as { elements?: { ref: string; label: string; role: string }[] };
  return output.elements ?? [];
}

function outputOf(answer: { body: Record<string, unknown> } | undefined): Record<string, unknown> {
  return (answer?.body.output ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('the multi-step request, end to end', () => {
  it('walks open -> read -> search -> verify -> open the result', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    // 1. The user asks. A task opens, carrying their words as its goal.
    h.say('open YouTube, search for AssemblyAI Voice Agent, and open the first result');
    const taskId = h.orchestrator.tasks.activeTaskId;
    expect(taskId).not.toBeNull();

    // 2. STEP ONE — navigate, and verify from Axon's own reading.
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const opened = h.answers.at(-1);
    expect(opened?.body.ok).toBe(true);
    expect((outputOf(opened).navigation as { status: string }).status).toBe('SUCCESS');
    expect(outputOf(opened).url).toBe('https://www.youtube.com/');

    // 3. STEP TWO — type into a field Axon found, by a reference Axon minted.
    //    The model has no other vocabulary: there is no selector here.
    const searchBox = elementsOf(opened).find((element) => element.label === 'Search' && element.role === 'textbox');
    expect(searchBox).toBeDefined();
    if (!searchBox) return;

    // SUBMITTING SENDS SOMETHING, so a person is asked — even for a search.
    // The call is answered immediately and truthfully as "not run yet", and
    // the approval proceeds on Axon's clock rather than on the socket's.
    await h.propose('browser.type', { ref: searchBox.ref, text: 'AssemblyAI Voice Agent', submit: true });
    const deferred = h.answers.at(-1);
    expect(deferred?.body.status).toBe('pending_user_approval');
    expect(deferred?.body.executed).toBe(false);

    await h.settle(60);
    expect(h.approvals).toHaveLength(1);
    // The dialog names the text that is about to be sent, and where.
    expect(JSON.stringify(h.approvals[0]?.parameters)).toContain('AssemblyAI Voice Agent');
    expect(JSON.stringify(h.approvals[0]?.parameters)).toContain('youtube.com');

    // 4. THE JOINT THAT MATTERS. The search is not assumed to have worked —
    //    the outcome Axon speaks is built from a reading taken afterwards.
    expect(h.spoken.at(-1)).toMatch(/approved it and Axon carried it out/i);
    // And the outcome is built from a result, not from optimism: the page
    // Axon read afterwards is the results page, which the next step proves.

    // 5. STEP THREE — read the page the search produced, then open a result
    //    named by a reference from THAT reading. A reference from before the
    //    search would be refused, which is the point of them being
    //    per-reading.
    await h.propose('browser.read', {});
    const results = h.answers.at(-1);
    expect(results?.body.ok).toBe(true);
    expect(String(outputOf(results).url)).toContain('/results');

    const result = elementsOf(results).find((element) => element.label.startsWith('AssemblyAI Voice Agent'));
    expect(result).toBeDefined();
    if (!result) return;

    await h.propose('browser.click', { ref: result.ref });
    const watched = h.answers.at(-1);
    expect(watched?.body.ok).toBe(true);
    expect(String(outputOf(watched).url)).toContain('/watch');
    expect((outputOf(watched).verified as { changed: boolean }).changed).toBe(true);

    // 6. Four steps, ONE task, and every one of them recorded against it.
    expect(h.orchestrator.tasks.activeTaskId).toBe(taskId);
    expect(h.orchestrator.tasks.stepsOf(taskId!)).toBe(4);
  });

  it('asks about the one act that sends something, and about nothing else', async () => {
    // Opening a page, reading it and following a link are things a person does
    // without thinking, and a pipeline that asked about them would be one
    // whose dialogs stop being read — which is a security failure, not a
    // usability one. Submitting is different: it leaves the machine.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    expect(h.approvals).toEqual([]);

    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    await h.settle(60);
    expect(h.approvals).toHaveLength(1);

    await h.propose('browser.read', {});
    const link = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));
    await h.propose('browser.click', { ref: link!.ref });

    // Still one. Reading and clicking a link added nothing.
    expect(h.approvals).toHaveLength(1);
  });

  it('refuses a reference from before the page changed', async () => {
    // THE FAILURE THIS PREVENTS: clicking "the first result" using a reference
    // minted when the page was the home page. The number would resolve; it
    // would resolve to something else.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const beforeSearch = elementsOf(h.answers.at(-1));
    const homeLink = beforeSearch.find((element) => element.label === 'Home');
    expect(homeLink).toBeDefined();

    const box = beforeSearch.find((element) => element.role === 'textbox');
    // Filled, not submitted: the property under test is the REFERENCE, and an
    // approval in the middle would be testing something else.
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: false });

    // The page moves for a reason Axon did not cause. That reference now
    // describes a document that is not there.
    site.driftTo('/results');
    const stale = await h.propose('browser.click', { ref: homeLink!.ref });
    void stale;

    const answer = h.answers.at(-1);
    // Either recovered by identity onto the current page, or refused. What it
    // must never be is a click on whatever now occupies that position.
    if (answer?.body.ok === false) {
      expect(['STALE_REFERENCE', 'EXECUTION_ERROR', 'CLARIFICATION_NEEDED']).toContain(answer.body.errorKind);
    } else {
      const url = String(outputOf(answer).url);
      expect(url).not.toContain('/watch');
    }
  });

  it('does not wander into signing in on the way', async () => {
    // The goal boundary. "Search for a video" is not permission to sign in,
    // and the sign-in link is right there on the page — which is exactly the
    // shape of the live failure this control was built for.
    const site = youtubeSite();
    const h = createDemoHarness({ site, decide: () => 'DENY' });

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.open', { url: 'https://accounts.google.com/signin' });

    // Phase 5: the pre-check now applies the goal boundary exactly as the
    // dispatch does, so the agent is told AT ONCE that this is waiting on a
    // person — rather than being held on the wire behind a dialog it had not
    // been told about. The outcome then arrives as its own spoken turn.
    const answer = h.answers.at(-1);
    expect(answer?.body.status).toBe('pending_user_approval');
    await h.settle(60);

    // The user was ASKED, with the destination named, and said no.
    expect(h.approvals.at(-1)?.detail).toMatch(/did not ask for/i);
    expect(h.spoken.join(' ')).toMatch(/denied/i);
    // And the sign-in page was never opened.
    expect(site.calls).not.toContain('open:https://accounts.google.com/signin');
  });

  it('lets the same navigation through when the user did ask for it', async () => {
    // The control case. A boundary that refused regardless would not be a
    // boundary, it would be a wall — and the user's own words are what move it.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and sign me in');
    await h.propose('browser.open', { url: 'https://accounts.google.com/signin' });

    // No dialog: the user asked for exactly this.
    expect(h.approvals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The step that should stop
// ---------------------------------------------------------------------------

describe('a step that cannot be resolved stops rather than guessing', () => {
  it('asks which result when two are indistinguishable', async () => {
    // Two links, same label, same href shape — so "open the first one" has two
    // equally good answers and Axon has no basis to choose. It asks.
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    site.driftTo('/results');
    await h.propose('browser.read', {});

    const candidate = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));
    expect(candidate).toBeDefined();

    // The page moves under Axon, so the click has to re-resolve by identity —
    // and finds two indistinguishable candidates.
    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    const answer = h.answers.at(-1);
    expect(answer?.body.ok).toBe(false);
    expect(answer?.body.errorKind).toBe('CLARIFICATION_NEEDED');
    expect(answer?.body.needsClarification).toBe(true);
    expect(String(answer?.body.error)).toMatch(/which one do you mean/i);
  });

  it('remembers the question, so the answer continues the same task', async () => {
    // THE STATE THAT MAKES CLARIFICATION USABLE. Without it, "the second one"
    // opens a NEW task — superseding the one that asked the question and
    // discarding the very context the answer is about.
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    const taskId = h.orchestrator.tasks.activeTaskId;

    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    site.driftTo('/results');
    await h.propose('browser.read', {});
    const candidate = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));
    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    expect(h.orchestrator.tasks.awaitingAnswerTo).toMatch(/which one do you mean/i);

    // The user answers. Same task, same steps, original goal intact.
    h.say('the first one');
    expect(h.orchestrator.tasks.activeTaskId).toBe(taskId);
    expect(h.orchestrator.tasks.awaitingAnswerTo).toBeNull();
    expect(h.orchestrator.tasks.context()?.goal).toContain('open YouTube and search');
    expect(h.orchestrator.tasks.context()?.goal).toContain('the first one');
  });

  it('does not let a pending question swallow a genuinely new request', async () => {
    // The other direction. A task sitting in "awaiting an answer" must not
    // absorb the next thing the user says forever — one utterance clears it,
    // and the one after that is a new request again.
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    site.driftTo('/results');
    await h.propose('browser.read', {});
    const candidate = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));
    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    const answered = h.orchestrator.tasks.activeTaskId;
    h.say('the first one');
    h.say('actually, open GitHub instead');

    expect(h.orchestrator.tasks.activeTaskId).not.toBe(answered);
    expect(h.orchestrator.tasks.statusOf(answered!)).toBe('SUPERSEDED');
  });
});

// ---------------------------------------------------------------------------
// Grounding: what Axon saw, for the next reference to resolve against
// ---------------------------------------------------------------------------

describe('the task carries what Axon observed, not what it intended', () => {
  it('records the page Axon actually read', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    expect(h.orchestrator.tasks.context()?.currentPage).toBe('https://www.youtube.com/');
  });

  it('moves the grounding as the page moves', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    expect(h.orchestrator.tasks.context()?.currentPage).toBe('https://www.youtube.com/');

    site.driftTo('/results');
    await h.propose('browser.read', {});

    // The grounding follows what Axon READ, not what it was asked to open.
    expect(h.orchestrator.tasks.context()?.currentPage).toContain('/results');
  });

  it('forgets where it was when the user stops', async () => {
    // "Open that one" after a cancellation must not resolve against a page the
    // user has already abandoned.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    expect(h.orchestrator.tasks.context()?.currentPage).not.toBeNull();

    h.say('stop');
    expect(h.orchestrator.tasks.context()).toBeNull();
  });

  it('carries no page text and no typed text into the grounding', async () => {
    // The grounding is read by the model on every answer. It says WHERE Axon
    // is, not what is written there — a page of text or a typed value has no
    // business accumulating in it.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for something private');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');
    await h.propose('browser.type', { ref: box!.ref, text: 'my private search terms', submit: false });

    const context = JSON.stringify(h.orchestrator.tasks.context());
    expect(context).not.toContain('my private search terms');
    expect(context).not.toContain('Sign in to like videos');
  });
});
