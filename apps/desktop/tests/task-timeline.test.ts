/**
 * The developer timeline: one task, reconstructed, readable in four seconds.
 *
 * WHEN A DEMO GOES WRONG ON STAGE the question is always the same — which step
 * was it, and which gate did it stop at? The event stream already contains the
 * answer, as forty flat events interleaved with audio phases and speech
 * markers, which is not a form anybody can read while people are watching.
 *
 * So the timeline projects the stream into the shape the decisions actually
 * have. These tests hold it to two things:
 *
 *   it is COMPLETE ENOUGH — the proposal, the policy verdict, the approval,
 *   the re-bind, the observations, the verification and the outcome are all
 *   there, joined to the right step;
 *
 *   and it is EMPTY of everything else. A `TOOL_CALL` event carries the
 *   arguments the model proposed, which is where a typed password or a tokened
 *   URL would be. The renderer never reads that field, and the last group of
 *   tests is the one that keeps it that way.
 */

import { describe, expect, it } from 'vitest';
import { reconstructTasks, renderTaskTimeline } from '../src/main/bus/task-timeline.js';
import { createDemoHarness } from './support/demo-harness.js';
import { internshipSite, youtubeSite } from './support/fake-site.js';

function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  const output = (answer?.body.output ?? {}) as { elements?: { ref: string; label: string; role: string }[] };
  return output.elements ?? [];
}

// ---------------------------------------------------------------------------

describe('a task can be read back off the stream', () => {
  it('shows the steps of a multi-step request, in order, under one task', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.read', {});

    const timeline = renderTaskTimeline(h.events);

    expect(timeline).toContain('TASK task-');
    expect(timeline).toContain('"open YouTube and search for AssemblyAI"');
    expect(timeline).toContain('STEP step-');
    expect(timeline).toContain('browser.open');
    expect(timeline).toContain('browser.read');
    expect(timeline).toContain('SUCCEEDED');
  });

  it('shows the policy verdict, and what it meant', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).toContain('policy: SAFE — allowed without asking');
  });

  it('shows the approval and the re-bind for an act that needed one', async () => {
    // "Was it re-checked before it ran?" is exactly the question somebody
    // auditing a demo asks, and the answer has to be visible rather than
    // inferred from the absence of a problem.
    const site = internshipSite();
    const h = createDemoHarness({ site, decide: () => 'ALLOW' });

    h.say('fill in the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).toMatch(/policy: (REQUIRES_APPROVAL|HIGH_RISK) — a human was asked/);
    expect(timeline).toContain('approval: ALLOW by user');
    expect(timeline).toContain('re-bind: fingerprint re-checked before execution');
  });

  it('shows a denial as a denial', async () => {
    const site = internshipSite();
    const h = createDemoHarness({ site, decide: () => 'DENY' });

    h.say('fill in the application but do not submit');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).toContain('approval: DENY by user');
    expect(timeline).toContain('DENIED');
    // And no re-bind line, because nothing was re-bound: it never ran.
    expect(timeline).not.toContain('re-bind');
  });

  it('shows a cancelled task as cancelled, with its steps intact', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for AssemblyAI');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    h.say('stop');
    await h.propose('browser.read', {});

    const timeline = renderTaskTimeline(h.events);
    // The step that ran is still there, and the task carries how it ended.
    // The proposal AFTER the stop never became a step at all — there was no
    // active task to open one against — which is the refusal working, and is
    // why it does not appear as a step here.
    expect(timeline).toContain('browser.open');
    expect(timeline).toMatch(/\[CANCELLED\]/);
  });

  it('keeps two tasks apart', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    h.say('now read the page');
    await h.propose('browser.read', {});

    const tasks = reconstructTasks(h.events);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks[0]?.steps.map((step) => step.tool)).toEqual(['browser.open']);
    expect(tasks[1]?.steps.map((step) => step.tool)).toEqual(['browser.read']);
  });

  it('says so plainly when there is nothing to show', () => {
    expect(renderTaskTimeline([])).toBe('No tasks.');
  });

  it('joins each step to its own call, rather than guessing from ordering', async () => {
    // Under load, two steps of the same tool are in flight at once, and a
    // timeline that attributed by ordering would put one step's approval under
    // the other. The trace carries the call id, so the join is exact.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube then read it');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.read', {});

    const tasks = reconstructTasks(h.events);
    const steps = tasks.flatMap((task) => task.steps);
    const calls = steps.map((step) => step.callId).filter((callId): callId is string => callId !== null);

    expect(calls.length).toBe(steps.length);
    expect(new Set(calls).size).toBe(calls.length);
  });
});

// ---------------------------------------------------------------------------
// What it must never contain
// ---------------------------------------------------------------------------

describe('the timeline carries no content, only decisions', () => {
  it('does not print what was typed', async () => {
    // THE ONE THAT MATTERS. `TOOL_CALL` carries the arguments the model
    // proposed, and that is where a typed value lives. The renderer reads the
    // tool name, the risk level and the outcome — never the input.
    const site = internshipSite();
    const h = createDemoHarness({ site });

    h.say('fill in my details');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const cover = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('Why do you want'));
    await h.propose('browser.type', {
      ref: cover!.ref,
      text: 'a private sentence nobody should find in a log',
      submit: false,
    });

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).not.toContain('a private sentence');
    // And the raw stream DOES contain it, which is what makes the absence
    // above a property of the renderer rather than of the fixture.
    expect(JSON.stringify(h.events)).toContain('a private sentence');
  });

  it('does not print page text', async () => {
    const site = internshipSite();
    const h = createDemoHarness({ site });

    h.say('open the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).not.toContain('national insurance number');
    expect(timeline).not.toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('does not print a URL with whatever is in its query string', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/?session=super-secret-token' });

    const timeline = renderTaskTimeline(h.events);
    expect(timeline).not.toContain('super-secret-token');
  });

  it('prints no credential even when one was refused', async () => {
    // A refusal message must not echo the thing it refused, and neither must
    // the timeline that records the refusal.
    const site = internshipSite();
    const h = createDemoHarness({ site, decide: () => 'ALLOW' });

    h.say('fill in my details');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const cover = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('Why do you want'));
    await h.propose('browser.type', {
      ref: cover!.ref,
      text: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      submit: false,
    });

    expect(renderTaskTimeline(h.events)).not.toContain('ghp_AAAA');
  });

  it('reads only the fields it is allowed to, asserted over the source', () => {
    // A property of every run, not of this one. The renderer must not grow a
    // line that prints `event.input`.
    const source = renderTaskTimeline.toString();
    expect(source).not.toContain('.input');
  });
});
