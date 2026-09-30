/**
 * How Axon sounds.
 *
 * Most of what Axon says is composed by the model, which this suite cannot
 * pin down sentence by sentence. What it CAN pin is everything Axon itself
 * supplies — the progress lines, the questions, the approval descriptions, the
 * cancellation — and the rules the model is given for the rest.
 *
 * The standard is the one in the phase brief: "Calculator is open.",
 * "Stopped.", "Which one?" — and never "Certainly! I would be happy to assist
 * you with that request." Short, plain, and about the world rather than about
 * the machinery.
 */

import { describe, expect, it } from 'vitest';
import { describeProgress } from '@axon/core';
import { buildAgentSystemPrompt } from '../src/main/agent/agent-tool-surface.js';
import { createDemoHarness } from './support/demo-harness.js';
import { internshipSite, youtubeSite } from './support/fake-site.js';

const FILLER = /certainly|happy to|great question|as an ai|i will now|let me go ahead/i;
const MACHINERY = /\b(dispatcher|observation|policy|fingerprint|ref(erence)?\s+e\d+|browser\.\w+|app\.\w+|system\.\w+)\b/i;

const PROMPT = buildAgentSystemPrompt({
  tools: [{ name: 'app.open', title: 'Open an application', description: '', inputSchema: {} } as never],
  platform: 'Windows',
  workspaceRoot: 'C:/Users/me/Axon/workspace',
});

describe('the rules the model is given', () => {
  it('shows it the short answers to copy', () => {
    for (const example of ['"Calculator is open."', '"Screenshot captured."', '"GitHub is open."']) {
      expect(PROMPT).toContain(example);
    }
  });

  it('forbids the filler that makes an assistant sound like a call centre', () => {
    expect(PROMPT).toMatch(/no "Certainly!"/);
    expect(PROMPT).toMatch(/Never repeat the request back/);
  });

  it('forbids reading the machinery out loud', () => {
    expect(PROMPT).toMatch(/Never say the name of a tool, a reference like e12/);
  });

  it('says what to say when told to stop', () => {
    expect(PROMPT).toContain('say "Stopped." and nothing else');
  });

  it('asks the shortest question there is', () => {
    expect(PROMPT).toContain('"Which one?"');
    expect(PROMPT).toContain('"Open what?"');
  });
});

describe('what Axon supplies in its own words', () => {
  it('announces slow work in a few words, and names things the way people do', () => {
    const lines = [
      describeProgress('browser.open', { url: 'https://www.youtube.com/' }),
      describeProgress('app.open', { app: 'calculator' }),
      describeProgress('system.screenshot', {}),
      describeProgress('browser.read', {}),
      describeProgress('ui.read', { app: 'Spotify' }),
      describeProgress('ui.read', {}),
      describeProgress('app.launch', { app: 'Spotify' }),
      describeProgress('web.open', { url: 'https://www.youtube.com/results?search_query=lofi' }),
      describeProgress('web.open', {}),
    ];

    expect(lines).toEqual([
      'Opening YouTube',
      'Opening Calculator',
      'Looking at the screen',
      'Reading the page',
      'Looking at Spotify',
      'Looking at the screen',
      'Opening Spotify',
      'Opening YouTube',
      'Opening your browser',
    ]);
    for (const line of lines) {
      expect(line!.split(' ').length).toBeLessThanOrEqual(4);
      expect(line).not.toMatch(FILLER);
      expect(line).not.toMatch(MACHINERY);
    }
  });

  it('has nothing to announce for work that is instant', () => {
    expect(describeProgress('system.time', {})).toBeNull();
  });

  it('describes an approval as an act and a place, not as a mechanism', () => {
    const h = createDemoHarness({ site: youtubeSite() });
    const line = h.orchestrator.dispatcher.describeApproval('browser.open', { url: 'https://www.youtube.com/' }) ?? '';
    expect(line).toBe('Axon wants to open www.youtube.com');
    expect(line).not.toMatch(FILLER);
    expect(line).not.toMatch(/browser\.open/);
  });

  it('asks a clarifying question as a question', async () => {
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open the AssemblyAI one');
    await h.propose('browser.open', { url: 'https://www.youtube.com/results' });
    const output = h.answers.at(-1)?.body.output as { elements: { ref: string; label: string }[] };
    const candidate = output.elements.find((element) => element.label.startsWith('AssemblyAI'));
    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    const question = h.orchestrator.tasks.awaitingAnswerTo ?? '';
    expect(question).toMatch(/\?$/);
    expect(question).not.toMatch(FILLER);
  });

  it('refuses a credential in one plain sentence that does not repeat it', async () => {
    const h = createDemoHarness({ site: internshipSite() });

    h.say('fill in my password');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const output = h.answers.at(-1)?.body.output as { elements: { ref: string; label: string }[] };
    const password = output.elements.find((element) => element.label.startsWith('Create a password'));
    await h.propose('browser.type', { ref: password!.ref, text: 'hunter2-not-real', submit: false });

    const message = String(h.answers.at(-1)?.body.error ?? h.answers.at(-1)?.body.message ?? '');
    expect(message).not.toContain('hunter2');
    expect(message).not.toMatch(FILLER);
    expect(message.length).toBeLessThan(220);
  });
});

describe('the caption under the orb', () => {
  it('never shows a tool name, whatever happens', async () => {
    // The line under the orb is the reason on each STATE_CHANGED event, and
    // the audience reads it. It used to say "Running browser.open" and
    // "browser.click was not approved" — the machinery showing through.
    const site = internshipSite();
    const h = createDemoHarness({ site, decide: () => 'DENY' });

    h.say('open the application and submit it');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const output = h.answers.at(-1)?.body.output as { elements: { ref: string; label: string }[] };
    const submit = output.elements.find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(80);

    const captions = h.events
      .filter((event) => event.type === 'STATE_CHANGED')
      .map((event) => (event as { reason: string }).reason);

    expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) {
      expect(caption).not.toMatch(/\b(browser|app|system|window|memory|fs|ui|keyboard)\.[a-z]+/);
    }
    // And the words it does use are the human ones.
    // A site name a person would say (see `friendlySite`), not a host.
    expect(captions).toContain('Opening Careers');
    expect(captions).toContain('Not approved');
  });
});
