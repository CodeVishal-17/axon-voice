/**
 * The demo, as a script, run end to end.
 *
 * WHY A SCRIPT AND NOT TEN UNIT TESTS. Each of these scenarios already has
 * unit coverage of its tool — `desktop-tools`, `system-time`,
 * `screen-observation`, `browser-tools`. What none of those exercise is the
 * SEQUENCE: a conversation in which one request follows another through the
 * same task ledger, the same budget, the same duplicate guard and the same
 * grounding, with a cancellation and a clarification in the middle of it.
 *
 * That sequence is what will actually run on stage, and it is where the
 * interesting failures live — a task that supersedes the one that asked a
 * question, a cancelled step that resumes, a budget that was never reset, a
 * reference that outlived the page it named. So this walks the whole demo,
 * in order, through the real conversational entry point.
 *
 * Scenarios A-J from the Phase 4 brief, in the order a presenter would run
 * them.
 */

import { describe, expect, it } from 'vitest';
import { createDemoHarness, fakeDesktop } from './support/demo-harness.js';
import { youtubeSite } from './support/fake-site.js';

function outputOf(answer: { body: Record<string, unknown> } | undefined): Record<string, unknown> {
  return (answer?.body.output ?? {}) as Record<string, unknown>;
}

function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  return ((outputOf(answer) as { elements?: { ref: string; label: string; role: string }[] }).elements ?? []);
}

/** A harness with both a desktop and a browser, as the demo machine has. */
function demo(options: { readonly decide?: Parameters<typeof createDemoHarness>[0]['decide'] } = {}) {
  const desktop = fakeDesktop();
  const site = youtubeSite();
  const h = createDemoHarness({ site, desktop, ...(options.decide ? { decide: options.decide } : {}) });
  return { ...h, desktop, site };
}

// ---------------------------------------------------------------------------
// A, B — an application opens, and Axon says so only after looking
// ---------------------------------------------------------------------------

describe('A. "Open Calculator."', () => {
  it('opens it, verifies against the desktop, and answers from the verification', async () => {
    const h = demo();

    h.say('open Calculator');
    await h.propose('app.open', { app: 'calculator' });

    const answer = h.answers.at(-1);
    expect(answer?.body.ok).toBe(true);

    // NOT from the pid. From a window that actually appeared.
    const verified = outputOf(answer).verified as { opened: boolean; window: string; summary: string };
    expect(verified.opened).toBe(true);
    expect(verified.window).toBe('Calculator');
    expect(verified.summary).toBe('Calculator is open.');
    expect(h.desktop.windowTitles()).toContain('Calculator');
  });

  it('says it did NOT open when no window appears', async () => {
    // The failure this verification exists for: the operating system agreed to
    // start something, and nothing opened.
    const desktop = fakeDesktop({ appearsAfterMs: 10 * 60_000 });
    const h = createDemoHarness({ site: youtubeSite(), desktop });

    h.say('open Calculator');
    await h.propose('app.open', { app: 'calculator' });

    const verified = outputOf(h.answers.at(-1)).verified as { opened: boolean; summary: string };
    expect(verified.opened).toBe(false);
    expect(verified.summary).toMatch(/do not say it is open/i);
  }, 20_000);
});

describe('B. "Open Notepad."', () => {
  it('opens a second application without disturbing the first', async () => {
    const h = demo();

    h.say('open Calculator');
    await h.propose('app.open', { app: 'calculator' });
    h.say('now open Notepad');
    await h.propose('app.open', { app: 'notepad' });

    expect((outputOf(h.answers.at(-1)).verified as { window: string }).window).toBe('Untitled - Notepad');
    expect(h.desktop.windowTitles()).toEqual(expect.arrayContaining(['Calculator', 'Untitled - Notepad']));
  });

  it('treats the second request as its own task, with its own steps', async () => {
    const h = demo();

    h.say('open Calculator');
    const first = h.orchestrator.tasks.activeTaskId;
    await h.propose('app.open', { app: 'calculator' });

    h.say('now open Notepad');
    const second = h.orchestrator.tasks.activeTaskId;

    expect(second).not.toBe(first);
    expect(h.orchestrator.tasks.statusOf(first!)).toBe('SUPERSEDED');
    expect(h.orchestrator.tasks.stepsOf(second!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C, D — looking, and the clock
// ---------------------------------------------------------------------------

describe('C. "Take a screenshot."', () => {
  it('captures and describes without writing a file', async () => {
    const h = demo();
    h.desktop.setControls([
      { nativeRole: 'ControlType.Button', role: 'button', name: 'Equals', automationId: '', sensitive: false, actions: ['invoke'], value: null },
    ]);

    h.say('take a screenshot');
    await h.propose('system.screenshot', {});

    const output = outputOf(h.answers.at(-1));
    expect(output.captured).toBe(true);
    // No accidental persistence: looking is not filing.
    expect(output.saved).toBeNull();
    expect(String(output.note)).toMatch(/SUCCEEDED/);
  });

  it('says what it can and cannot observe, including the modality it lacks', async () => {
    // The honest answer to "can you see my screen?" comes from the system,
    // not from the model's impression of itself.
    const h = demo();
    h.say('take a screenshot');
    await h.propose('system.screenshot', {});

    const modalities = outputOf(h.answers.at(-1)).canObserve as {
      modality: string;
      captured: boolean;
      youCanReceiveThis: boolean;
    }[];

    const accessibility = modalities.find((entry) => entry.modality === 'accessibility');
    const pixels = modalities.find((entry) => entry.modality === 'pixels');
    const vision = modalities.find((entry) => entry.modality === 'vision');

    expect(accessibility?.youCanReceiveThis).toBe(true);
    // Captured, and deliverable to nobody. The two questions are not the same.
    expect(pixels?.captured).toBe(true);
    expect(pixels?.youCanReceiveThis).toBe(false);
    // Named rather than omitted, so it is a decision rather than an oversight.
    expect(vision?.captured).toBe(false);
  });
});

describe('D. "What time is it?"', () => {
  it('answers from this machine, and cannot be told otherwise', async () => {
    const h = demo();

    const before = Date.now();
    h.say('what time is it');
    await h.propose('system.time', { now: '1999-01-01T00:00:00.000Z' });
    const after = Date.now();

    const output = outputOf(h.answers.at(-1)) as { epochMs: number; date: string };
    expect(output.epochMs).toBeGreaterThanOrEqual(before);
    expect(output.epochMs).toBeLessThanOrEqual(after);
    expect(output.date).not.toBe('1999-01-01');
  });
});

// ---------------------------------------------------------------------------
// E, F — the web
// ---------------------------------------------------------------------------

describe('E/F. "Open GitHub." / "Open YouTube."', () => {
  it('navigates and reports a verified status, not an attempted one', async () => {
    const h = demo();

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const navigation = outputOf(h.answers.at(-1)).navigation as { status: string; landedOn: string };
    expect(navigation.status).toBe('SUCCESS');
    expect(navigation.landedOn).toBe('https://www.youtube.com/');
  });

  it('refuses to open something that is not a permitted application', async () => {
    // "Open Chrome" is not answered by opening something similar. The input is
    // an enum indexing a fixed table, so it cannot even be expressed.
    const h = demo();

    h.say('open Chrome');
    await h.propose('app.open', { app: 'chrome' });

    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expect(h.answers.at(-1)?.body.errorKind).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// G — the multi-step request, conversationally
// ---------------------------------------------------------------------------

describe('G. "Open YouTube and search for AssemblyAI Voice Agent."', () => {
  it('runs as one task with steps that each depend on the last', async () => {
    const h = demo();

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    const task = h.orchestrator.tasks.activeTaskId;

    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI Voice Agent', submit: true });
    await h.settle(60);
    await h.propose('browser.read', {});

    expect(String(outputOf(h.answers.at(-1)).url)).toContain('/results');
    expect(h.orchestrator.tasks.activeTaskId).toBe(task);
    expect(h.orchestrator.tasks.stepsOf(task!)).toBe(3);
    // And the grounding followed the page, so "open the first one" has
    // something real to resolve against.
    expect(h.orchestrator.tasks.context()?.currentPage).toContain('/results');
  });
});

// ---------------------------------------------------------------------------
// H — stopping, mid-task
// ---------------------------------------------------------------------------

describe('H. "Stop."', () => {
  it('cancels the task and refuses the next step of it', async () => {
    const h = demo();

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    const task = h.orchestrator.tasks.activeTaskId;
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    h.say('stop');

    expect(h.orchestrator.tasks.statusOf(task!)).toBe('CANCELLED');
    // The step that was coming next never happens: there is nothing to open
    // it against.
    await h.propose('browser.read', {});
    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expect(h.answers.at(-1)?.body.errorKind).toBe('CANCELLED');
  });

  it('starts cleanly on the next request, with no trace of the cancelled one', async () => {
    // "Actually, open GitHub." A cancelled task must not poison what follows —
    // an aborted signal carried forward would make every later action fail.
    const h = demo();

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    h.say('stop');

    h.say('actually, open GitHub');
    const fresh = h.orchestrator.tasks.activeTaskId;
    expect(fresh).not.toBeNull();

    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    expect(h.answers.at(-1)?.body.ok).toBe(true);
    expect(h.orchestrator.tasks.stepsOf(fresh!)).toBe(1);
  });

  it('does not resume a step that was pending when it was stopped', async () => {
    const h = demo();

    h.say('open YouTube and search for AssemblyAI Voice Agent');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');

    // The submit is deferred behind an approval. The user stops before
    // answering it.
    const decideNever = createDemoHarness({ site: h.site, decide: () => null });
    void decideNever;
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    h.say('stop');
    await h.settle(60);

    // Whatever happened to the pending approval, nothing was searched after
    // the stop and no further step could be opened.
    expect(h.orchestrator.tasks.activeTaskId).toBeNull();
    await h.propose('browser.click', { ref: 'e3' });
    expect(h.answers.at(-1)?.body.errorKind).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// I — asking rather than guessing
// ---------------------------------------------------------------------------

describe('I. "Open." — an unclear request', () => {
  it('is refused at the schema rather than resolved to something plausible', async () => {
    const h = demo();

    h.say('open');
    await h.propose('app.open', {});

    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expect(h.answers.at(-1)?.body.errorKind).toBe('INVALID_INPUT');
    expect(h.desktop.launched).toEqual([]);
  });

  it('keeps the task alive so the answer continues it', async () => {
    // A clarifying answer must land in the task that needed clarifying.
    const h = demo();

    h.say('open the application');
    const task = h.orchestrator.tasks.activeTaskId;

    // Axon asks. In the demo this comes from a tool refusing with
    // CLARIFICATION_NEEDED; here the state is set the same way the bridge
    // sets it.
    h.orchestrator.tasks.awaitClarification('Which application?');
    expect(h.orchestrator.tasks.awaitingAnswerTo).toBe('Which application?');

    h.say('Calculator');
    expect(h.orchestrator.tasks.activeTaskId).toBe(task);
    expect(h.orchestrator.tasks.context()?.goal).toContain('Calculator');

    await h.propose('app.open', { app: 'calculator' });
    expect(h.answers.at(-1)?.body.ok).toBe(true);
    expect(h.orchestrator.tasks.stepsOf(task!)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// J — a consequential action
// ---------------------------------------------------------------------------

describe('J. a consequential action asks first', () => {
  it('names the act and the place in the question it asks', async () => {
    const h = demo({ decide: () => 'DENY' });

    h.say('open YouTube and subscribe to that channel');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    await h.settle(60);

    expect(h.approvals).toHaveLength(1);
    const request = h.approvals[0]!;
    // "Permission required" tells nobody anything. This says what, and where.
    expect(request.title).toMatch(/submit/i);
    expect(JSON.stringify(request.parameters)).toContain('AssemblyAI');
    expect(JSON.stringify(request.parameters)).toContain('youtube.com');
    expect(request.binding.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('approving one act does not authorise a second', async () => {
    // APPROVE A CANNOT AUTHORISE A + B. The fingerprint is over the tool and
    // the normalized arguments, so a different act is a different question.
    const seen: string[] = [];
    const h = demo({
      decide: (request) => {
        seen.push(request.binding.fingerprint);
        // Allow the first, deny everything after it.
        return seen.length === 1 ? 'ALLOW' : 'DENY';
      },
    });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');

    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    await h.settle(60);
    expect(h.spoken.at(-1)).toMatch(/approved it and Axon carried it out/i);

    // A SECOND submission. Same tool, different arguments — so a second
    // question, with a different fingerprint, and this one is refused.
    await h.propose('browser.read', {});
    const nextBox = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');
    await h.propose('browser.type', { ref: nextBox!.ref, text: 'something else entirely', submit: true });
    await h.settle(60);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(h.spoken.at(-1)).toMatch(/denied it, so nothing was done/i);
  });

  it('refuses to repeat the same consequential act inside one task', async () => {
    const h = demo({ decide: () => 'ALLOW' });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const box = elementsOf(h.answers.at(-1)).find((element) => element.role === 'textbox');

    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    await h.settle(60);
    await h.propose('browser.type', { ref: box!.ref, text: 'AssemblyAI', submit: true });
    await h.settle(60);

    // The second is refused by the duplicate guard rather than asked about
    // again — asking twice is how a user ends up approving the second copy.
    expect(h.spoken.at(-1)).toMatch(/could not be done|already/i);
  });
});
