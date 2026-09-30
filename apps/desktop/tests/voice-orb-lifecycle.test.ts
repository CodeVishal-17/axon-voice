/**
 * The orb stays with the work for the whole of a spoken request.
 *
 * FOUND IN A REAL CONVERSATION. Asked to play a song, Axon searched YouTube,
 * found it and played it — and the orb went dim in the middle, three times:
 *
 *     12:50:10.450  CALL   browser.read
 *     12:50:10.462  STATE  EXECUTING -> IDLE      "Done"
 *     12:50:10.718  STATE  IDLE -> LISTENING
 *
 * The dispatcher settles after every tool, and `settle()` chose its resting
 * state from `activeTurn` — which only a TYPED turn ever sets. On the voice
 * path it was always null, so every step ended in IDLE, the near-still orb.
 * That was not only a visual glitch; it was a false statement. Axon was not
 * idle between the steps of a request it was in the middle of carrying out.
 *
 * These drive a real VoiceAgentSession against a scripted provider, in the
 * order the real provider sends things, and read the state machine's own
 * STATE_CHANGED events — the same events the orb renders.
 *
 * WHAT IS STILL SUPPOSED TO HAPPEN, and is asserted: LISTENING between steps
 * is legitimate (the provider ends its reply turn and the microphone is
 * open), SPEAKING is never cut short by a tool finishing in the background,
 * and a conversation that ENDS still lands in IDLE — see
 * `voice-session-end.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type AxonEvent, type JsonValue, type RegisteredTool, type ToolResult } from '@axon/core';
import {
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
} from '../src/main/tools/executors/browser.js';
import { createSystemTimeTool } from '../src/main/tools/executors/system-time.js';
import { youtubeSite, type FakeSite } from './support/fake-site.js';
import { refFor } from './support/scripted-brain.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

const rigs: VoiceRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});

function probe(execute: (input: { n: number }) => Promise<JsonValue>): RegisteredTool {
  return defineTool<{ n: number }, JsonValue>({
    name: 'test.probe',
    title: 'Probe',
    description: 'A test tool.',
    inputSchema: z.object({ n: z.number().int() }).strict(),
    resolveRisk: () => ({ level: 'SAFE', reason: 'A test probe has no effect.' }),
    summarize: () => ({ title: 'Probe', parameters: [] }),
    sideEffect: () => 'NONE',
    execute,
  });
}

function browserTools(site: FakeSite): RegisteredTool[] {
  return [createBrowserOpenTool(site), createBrowserReadTool(site), createBrowserTypeTool(site), createBrowserClickTool(site)];
}

async function conversation(tools: readonly RegisteredTool[], site?: FakeSite): Promise<VoiceRig> {
  const r = await voiceRig({ tools, ...(site ? { orchestrator: { browser: site } } : {}) });
  rigs.push(r);
  // Anything that needs a person is allowed, on a later tick, as a person
  // would — so the approval state is genuinely entered and left.
  r.orchestrator.bus.subscribe((event) => {
    if (event.type !== 'APPROVAL_REQUIRED') return;
    setTimeout(() => {
      r.orchestrator.resolveApproval(event.request.callId, 'ALLOW', event.request.binding.fingerprint);
    }, 0);
  });
  await r.start();
  return r;
}

/** Where the request begins in `states`: everything after this is one request. */
function mark(r: VoiceRig): number {
  return r.states.length;
}

/** The user finishes speaking and the provider transcribes it. */
async function request(r: VoiceRig, text: string): Promise<void> {
  await r.provider.send({ type: 'input.speech.stopped' });
  await r.say(text);
}

const results = (r: VoiceRig): Extract<AxonEvent, { type: 'TOOL_RESULT' }>[] =>
  r.events.filter((event): event is Extract<AxonEvent, { type: 'TOOL_RESULT' }> => event.type === 'TOOL_RESULT');

let ordinal = 0;
/** One step, as the provider does it: propose, wait for the outcome, end the reply. */
async function step(r: VoiceRig, name: string, args: JsonValue): Promise<Extract<AxonEvent, { type: 'TOOL_RESULT' }>> {
  ordinal += 1;
  const before = results(r).length;
  await r.provider.send({ type: 'tool.call', call_id: `orb_${ordinal}`, name, arguments: args });
  expect(await until(() => results(r).length > before, 8_000)).toBe(true);
  const result = results(r).at(-1)!;
  await r.endReply();
  return result;
}

/** The provider speaks its answer and finishes. */
async function answer(r: VoiceRig): Promise<void> {
  await r.provider.send({ type: 'reply.started' });
  await until(() => r.orchestrator.state === 'SPEAKING');
  await r.endReply();
  await until(() => r.orchestrator.state === 'LISTENING');
}

function asToolResult(event: Extract<AxonEvent, { type: 'TOOL_RESULT' }>): ToolResult {
  return event.ok
    ? { callId: event.callId, tool: event.tool, ok: true, output: event.output ?? null, durationMs: event.durationMs }
    : { callId: event.callId, tool: event.tool, ok: false, failure: event.failure!, durationMs: event.durationMs };
}

/** The assertion this whole file exists for. */
function expectNoIdle(r: VoiceRig, from: number): void {
  const during = r.states.slice(from);
  expect(during, `states during the request: ${during.join(' -> ')}`).not.toContain('IDLE');
}

describe('one spoken request, start to finish', () => {
  it('one tool: never drops to IDLE, rests at THINKING, ends LISTENING', async () => {
    const r = await conversation([createSystemTimeTool()]);
    const from = mark(r);

    await request(r, 'What time is it?');
    expect((await step(r, 'system.time', {})).ok).toBe(true);
    await answer(r);

    expectNoIdle(r, from);
    // The resting state after the tool is the honest one: working out what
    // to say about the result.
    const settled = r.events.find(
      (event) => event.type === 'STATE_CHANGED' && event.from === 'EXECUTING' && event.reason === 'Done',
    );
    expect(settled).toMatchObject({ to: 'THINKING' });
    expect(r.orchestrator.state).toBe('LISTENING');
  });

  it('several tools in a row: no IDLE between any of them', async () => {
    const r = await conversation([probe(({ n }) => Promise.resolve({ n }))]);
    const from = mark(r);

    await request(r, 'Do three things.');
    for (const n of [1, 2, 3]) expect((await step(r, 'test.probe', { n })).ok).toBe(true);
    await answer(r);

    expectNoIdle(r, from);
    expect(r.orchestrator.state).toBe('LISTENING');
  });

  it('browser.open -> browser.read -> browser.type -> browser.click: the YouTube shape', async () => {
    const site = youtubeSite();
    const r = await conversation(browserTools(site), site);
    const from = mark(r);

    await request(r, 'Play the AssemblyAI voice agent video on YouTube.');
    expect((await step(r, 'browser.open', { url: 'https://www.youtube.com/' })).ok).toBe(true);

    const home = await step(r, 'browser.read', {});
    const search = refFor(asToolResult(home), 'Search', 'textbox');
    expect(search).not.toBeNull();

    // Submitting is consequential, so it waits for a person — and the orb
    // must stay present through the approval as well.
    await step(r, 'browser.type', { ref: search!, text: 'AssemblyAI voice agent', submit: true });
    expect(await until(() => site.url.endsWith('/results'), 8_000)).toBe(true);

    const found = await step(r, 'browser.read', {});
    const video = refFor(asToolResult(found), 'AssemblyAI Voice Agent', 'link');
    expect(video).not.toBeNull();
    expect((await step(r, 'browser.click', { ref: video! })).ok).toBe(true);
    await answer(r);

    expect(site.url.endsWith('/watch')).toBe(true);
    expectNoIdle(r, from);
    expect(r.states.slice(from)).toContain('WAITING_FOR_APPROVAL');
  });

  it('an approval-gated tool keeps the orb present before, during and after the decision', async () => {
    // Every step belongs to a request: a tool call with no user request
    // behind it is refused by the task ledger before it is ever dispatched.
    const site = youtubeSite();
    const r = await conversation(browserTools(site), site);
    const from = mark(r);

    await request(r, 'Search YouTube for voice agents.');
    await step(r, 'browser.open', { url: 'https://www.youtube.com/' });
    const home = await step(r, 'browser.read', {});
    const search = refFor(asToolResult(home), 'Search', 'textbox')!;
    await step(r, 'browser.type', { ref: search, text: 'voice agents', submit: true });
    expect(await until(() => site.url.endsWith('/results'), 8_000)).toBe(true);
    await answer(r);

    const during = r.states.slice(from);
    expect(during).toContain('WAITING_FOR_APPROVAL');
    expectNoIdle(r, from);
  });

  it('a long-running tool: SPEAKING is not cut short when it finishes, and nothing drops to IDLE', async () => {
    // Longer than the tool bridge's inline budget, so it is answered "in
    // progress" and finishes while Axon is already talking — the case where a
    // naive fix would have yanked the orb out of SPEAKING.
    let release: (() => void) | null = null;
    const slow = probe(
      ({ n }) =>
        new Promise<JsonValue>((resolve) => {
          release = () => resolve({ n });
        }),
    );
    const r = await conversation([slow]);
    const from = mark(r);

    await request(r, 'Do the slow thing.');
    await r.provider.send({ type: 'tool.call', call_id: 'slow_orb', name: 'test.probe', arguments: { n: 1 } });
    expect(await until(() => release !== null)).toBe(true);

    // The agent acknowledges and starts speaking while the tool still runs.
    await r.provider.send({ type: 'reply.started' });
    expect(await until(() => r.orchestrator.state === 'SPEAKING')).toBe(true);

    // The tool finishes mid-sentence.
    release!();
    expect(await until(() => results(r).length > 0, 8_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.orchestrator.state).toBe('SPEAKING');

    await r.endReply();
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);

    expectNoIdle(r, from);
    const cutShort = r.events.find(
      (event) => event.type === 'STATE_CHANGED' && event.from === 'SPEAKING' && event.reason === 'Done',
    );
    expect(cutShort).toBeUndefined();
  });

  it('a tool failure followed by a recovery: no IDLE in between', async () => {
    const r = await conversation([
      probe(({ n }) => (n === 1 ? Promise.reject(new Error('the first attempt failed')) : Promise.resolve({ n }))),
    ]);
    const from = mark(r);

    await request(r, 'Try it.');
    expect((await step(r, 'test.probe', { n: 1 })).ok).toBe(false);
    expect((await step(r, 'test.probe', { n: 2 })).ok).toBe(true);
    await answer(r);

    expectNoIdle(r, from);
    expect(r.orchestrator.state).toBe('LISTENING');
  });

  it('comes back to LISTENING when the request is done, ready for the next one', async () => {
    const r = await conversation([createSystemTimeTool()]);

    await request(r, 'What time is it?');
    await step(r, 'system.time', {});
    await answer(r);
    expect(r.orchestrator.state).toBe('LISTENING');

    const from = mark(r);
    await request(r, 'And the date?');
    await step(r, 'system.time', {});
    await answer(r);
    expect(r.orchestrator.state).toBe('LISTENING');
    expectNoIdle(r, from);
  });

  it('a conversation that ENDS still lands in IDLE — the fix is scoped to a live one', async () => {
    const r = await conversation([createSystemTimeTool()]);
    await request(r, 'What time is it?');
    await step(r, 'system.time', {});
    await answer(r);

    r.provider.endSession();
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);
  });
});
