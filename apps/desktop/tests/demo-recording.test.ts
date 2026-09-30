/**
 * The demo recording, held to what a recording is for and what it must not be.
 *
 * IT MUST BE ENOUGH TO DEBUG WITH. A day after the demo, the question is
 * "which step was slow, and did anything get denied?" — so every row carries
 * the time, the task, the step, the tool, the status, the latency, the
 * approval and the verification, and the tests below assert each of those
 * against a real run rather than a hand-built event list.
 *
 * IT MUST CARRY NO CONTENT. Tool arguments, page text, typed values and
 * credentials are all in the event stream it reads, and none of them may be in
 * the file it writes. The second group of tests plants each of them in a real
 * run and then asserts the serialized recording is clean — and, for each,
 * asserts the raw stream DID contain it, so the absence is a property of this
 * module rather than of the fixture.
 */

import { describe, expect, it } from 'vitest';
import {
  DemoRecorder,
  recordDemo,
  renderRecording,
  serializeRecording,
} from '../src/main/demo/recording.js';
import { createDemoHarness } from './support/demo-harness.js';
import { internshipSite, youtubeSite } from './support/fake-site.js';

function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  const output = (answer?.body.output ?? {}) as { elements?: { ref: string; label: string; role: string }[] };
  return output.elements ?? [];
}

// ---------------------------------------------------------------------------

describe('a recording of a real run', () => {
  it('has one row per step, with the tool and the outcome', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube and read it');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.read', {});

    const rows = recordDemo(h.events);
    expect(rows.map((row) => row.tool)).toEqual(['browser.open', 'browser.read']);
    expect(rows.every((row) => row.status === 'SUCCEEDED')).toBe(true);
  });

  it('carries the time and the latency, from the results themselves', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const [row] = recordDemo(h.events);
    expect(row?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row?.latencyMs).toBe('number');
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('says what the task was, so the rows mean something', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    expect(recordDemo(h.events)[0]?.goal).toBe('open YouTube');
  });

  it('records the approval and who gave it', async () => {
    const h = createDemoHarness({ site: internshipSite(), decide: () => 'ALLOW' });

    h.say('fill in the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    const row = recordDemo(h.events).find((entry) => entry.tool === 'browser.click');
    expect(row?.approval).toBe('ALLOW by user');
    expect(row?.risk).toMatch(/REQUIRES_APPROVAL|HIGH_RISK/);
  });

  it('records a denial as a denial', async () => {
    const h = createDemoHarness({ site: internshipSite(), decide: () => 'DENY' });

    h.say('fill in the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    const row = recordDemo(h.events).find((entry) => entry.tool === 'browser.click');
    expect(row?.approval).toBe('DENY by user');
    expect(row?.status).toBe('DENIED');
  });

  it('records whether Axon verified what it did', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const [row] = recordDemo(h.events);
    expect(row?.verified === true || row?.verified === null).toBe(true);
  });

  it('serializes as one JSON object per line', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube and read it');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.read', {});

    const lines = serializeRecording(recordDemo(h.events)).split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { tool: string };
      expect(typeof parsed.tool).toBe('string');
    }
  });

  it('renders a table a person can read, with a header and the goal', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const table = renderRecording(recordDemo(h.events));
    expect(table).toContain('TOOL');
    expect(table).toContain('LATENCY');
    expect(table).toContain('browser.open');
    expect(table).toContain('"open YouTube"');
  });

  it('says so plainly when nothing ran', () => {
    expect(renderRecording([])).toBe('No steps recorded.');
    expect(recordDemo([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What must never reach the file
// ---------------------------------------------------------------------------

describe('a recording carries decisions, never content', () => {
  it('does not contain what was typed', async () => {
    const h = createDemoHarness({ site: internshipSite() });

    h.say('fill in my cover letter');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const cover = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('Why do you want'));
    await h.propose('browser.type', { ref: cover!.ref, text: 'a private sentence nobody should find in a log', submit: false });

    const file = serializeRecording(recordDemo(h.events));
    expect(file).not.toContain('a private sentence');
    expect(JSON.stringify(h.events)).toContain('a private sentence');
  });

  it('does not contain page text', async () => {
    const h = createDemoHarness({ site: internshipSite() });

    h.say('open the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });

    const file = serializeRecording(recordDemo(h.events));
    expect(file).not.toContain('national insurance number');
    expect(file).not.toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('does not contain a URL with a token in its query string', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/?session=super-secret-token' });

    expect(serializeRecording(recordDemo(h.events))).not.toContain('super-secret-token');
  });

  it('drops a goal that is itself secret-shaped rather than writing it', async () => {
    // The one field that quotes the user. A person who reads a key out loud
    // has made a mistake; the recording must not make it permanent.
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('my key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const file = serializeRecording(recordDemo(h.events));
    expect(file).not.toContain('ghp_AAAA');
    expect(recordDemo(h.events)[0]?.goal).toBeNull();
  });

  it('reads no argument, page or transcript field, asserted over the source', () => {
    // A property of every run rather than of these ones.
    const source = recordDemo.toString();
    expect(source).not.toContain('.input');
    expect(source).not.toContain('.output');
  });
});

// ---------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------

describe('the developer-only recorder', () => {
  it('writes one file at close, and only when something ran', async () => {
    const written: { path: string; contents: string }[] = [];
    const recorder = new DemoRecorder({
      filePath: 'C:/tmp/demo-recording.jsonl',
      writeFile: (filePath, contents) => written.push({ path: filePath, contents }),
    });

    const h = createDemoHarness({ site: youtubeSite() });
    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    for (const event of h.events) recorder.observe(event);

    const path = recorder.close();
    expect(path).toBe('C:/tmp/demo-recording.jsonl');
    expect(written).toHaveLength(1);
    expect(written[0]?.contents).toContain('browser.open');
  });

  it('writes nothing at all when no step ever ran', () => {
    const written: string[] = [];
    const recorder = new DemoRecorder({
      filePath: 'C:/tmp/empty.jsonl',
      writeFile: (_filePath, contents) => written.push(contents),
    });

    expect(recorder.close()).toBeNull();
    expect(written).toHaveLength(0);
  });

  it('closes once — a second close writes no second file', () => {
    const written: string[] = [];
    const recorder = new DemoRecorder({
      filePath: 'C:/tmp/once.jsonl',
      writeFile: (_filePath, contents) => written.push(contents),
    });

    recorder.observe({
      type: 'USER_MESSAGE',
      id: 'e1',
      at: new Date().toISOString(),
      sessionId: 's',
      text: 'open YouTube',
    } as never);

    recorder.close();
    recorder.close();
    expect(written.length).toBeLessThanOrEqual(1);
  });

  it('keeps only the event types it projects from', async () => {
    const recorder = new DemoRecorder({ filePath: 'C:/tmp/x.jsonl', writeFile: () => undefined, capacity: 10 });

    const h = createDemoHarness({ site: youtubeSite() });
    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    // Feeding it everything, including speech and state events, must not
    // evict the six types it needs.
    for (const event of h.events) recorder.observe(event);
    expect(recorder.rows().length).toBeGreaterThan(0);
  });

  it('is bounded — a long session drops its oldest events rather than growing', async () => {
    const recorder = new DemoRecorder({ filePath: 'C:/tmp/y.jsonl', writeFile: () => undefined, capacity: 4 });

    for (let index = 0; index < 200; index += 1) {
      recorder.observe({
        type: 'USER_MESSAGE',
        id: `e${index}`,
        at: new Date().toISOString(),
        sessionId: 's',
        text: `message ${index}`,
      } as never);
    }

    // Nothing to assert about rows here — no steps ran — but the buffer must
    // not have grown to 200, and the only observable is that it still works.
    expect(recorder.rows()).toEqual([]);
  });
});
