/**
 * The YouTube request that worked, kept working — and kept safe.
 *
 * A REAL SUCCESS, from the event log of a live conversation:
 *
 *     USER    "Can you play One Sun One Moon by Anirudh Ravi Chandran ..."
 *     CALL    browser.open   https://www.youtube.com/            (earlier in the session)
 *     CALL    browser.read                                       refs for the page
 *     CALL    browser.type   { ref: "e4", text: "...", submit: true }
 *     STATE   EXECUTING -> WAITING_FOR_APPROVAL   "Axon wants to submit this text on www.youtube.com"
 *     RESULT  url: https://www.youtube.com/results?search_query=One+Sun+...
 *     CALL    browser.read                                       refs for the results
 *     CALL    browser.click  { ref: "e25" }
 *     RESULT  url: https://www.youtube.com/watch?v=Tn8-UEQnazA&list=...
 *     AXON    "One Sun One Moon is playing."
 *
 * This replays that shape against the YouTube fixture on the REAL voice path
 * (session, bridge, dispatcher, approval broker, browser tools), and pins the
 * four things that made it safe as well as successful:
 *
 *   element refs        every act names a ref taken from a read, never a
 *                       coordinate, and no coordinate tool exists
 *   approval            submitting a search waits for a person, and a "no"
 *                       means no search happens
 *   verification        the result reports where the page actually went
 *   honesty on refusal  a denied submit is reported as not done
 *
 * The one thing it cannot replay is the real YouTube: its markup changes, so
 * a live run is still the proof that it works today.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AxonEvent, ToolResult } from '@axon/core';
import {
  createBrowserClickTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
} from '../src/main/tools/executors/browser.js';
import { youtubeSite, type FakeSite } from './support/fake-site.js';
import { refFor } from './support/scripted-brain.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

type ToolResultEvent = Extract<AxonEvent, { type: 'TOOL_RESULT' }>;

const rigs: VoiceRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});

async function conversation(decision: 'ALLOW' | 'DENY'): Promise<{ r: VoiceRig; site: FakeSite }> {
  const site = youtubeSite();
  const r = await voiceRig({
    tools: [createBrowserOpenTool(site), createBrowserReadTool(site), createBrowserTypeTool(site), createBrowserClickTool(site)],
    orchestrator: { browser: site },
  });
  rigs.push(r);
  r.orchestrator.bus.subscribe((event) => {
    if (event.type !== 'APPROVAL_REQUIRED') return;
    setTimeout(() => r.orchestrator.resolveApproval(event.request.callId, decision, event.request.binding.fingerprint), 0);
  });
  await r.start();
  return { r, site };
}

const results = (r: VoiceRig): ToolResultEvent[] =>
  r.events.filter((event): event is ToolResultEvent => event.type === 'TOOL_RESULT');

let ordinal = 0;
async function step(r: VoiceRig, name: string, args: Record<string, unknown>): Promise<ToolResultEvent> {
  ordinal += 1;
  const before = results(r).length;
  await r.provider.send({ type: 'tool.call', call_id: `yt_${ordinal}`, name, arguments: args });
  expect(await until(() => results(r).length > before, 8_000)).toBe(true);
  await r.endReply();
  return results(r).at(-1)!;
}

const asResult = (event: ToolResultEvent): ToolResult =>
  event.ok
    ? { callId: event.callId, tool: event.tool, ok: true, output: event.output ?? null, durationMs: event.durationMs }
    : { callId: event.callId, tool: event.tool, ok: false, failure: event.failure!, durationMs: event.durationMs };

const urlOf = (event: ToolResultEvent): string => String((event.output as { url?: unknown } | null)?.url ?? '');

describe('"play the AssemblyAI voice agent video on YouTube"', () => {
  it('searches, waits for approval, opens the result, and verifies where it landed', async () => {
    const { r, site } = await conversation('ALLOW');

    await r.say('Play the AssemblyAI voice agent video on YouTube.');
    expect((await step(r, 'browser.open', { url: 'https://www.youtube.com/' })).ok).toBe(true);

    // REFS FROM A READ — the search box is found by its label, not assumed.
    const home = await step(r, 'browser.read', {});
    const box = refFor(asResult(home), 'Search', 'textbox');
    expect(box).toMatch(/^e\d+$/);

    // SUBMITTING WAITS FOR A PERSON.
    const typed = await step(r, 'browser.type', { ref: box!, text: 'AssemblyAI voice agent', submit: true });
    const asked = r.events.filter((event) => event.type === 'APPROVAL_REQUIRED');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ request: { tool: 'browser.type' } });
    expect(typed.ok).toBe(true);

    // VERIFIED: the result says where the page went.
    expect(await until(() => site.url.endsWith('/results'), 8_000)).toBe(true);
    expect(urlOf(typed)).toMatch(/\/results/);

    const found = await step(r, 'browser.read', {});
    const video = refFor(asResult(found), 'AssemblyAI Voice Agent', 'link');
    expect(video).toMatch(/^e\d+$/);

    const clicked = await step(r, 'browser.click', { ref: video! });
    expect(clicked.ok).toBe(true);
    expect(site.url.endsWith('/watch')).toBe(true);
    expect(urlOf(clicked)).toMatch(/\/watch/);
  });

  it('acts only by reference: no call carries a coordinate, and no coordinate tool exists', async () => {
    const { r } = await conversation('ALLOW');
    await r.say('Search YouTube for voice agents.');
    await step(r, 'browser.open', { url: 'https://www.youtube.com/' });
    const home = await step(r, 'browser.read', {});
    await step(r, 'browser.type', { ref: refFor(asResult(home), 'Search', 'textbox')!, text: 'voice agents', submit: true });

    // Every act that reached the dispatcher named a reference, and nothing else.
    const acts = r.events.filter(
      (event): event is Extract<AxonEvent, { type: 'TOOL_CALL' }> =>
        event.type === 'TOOL_CALL' && (event.tool === 'browser.type' || event.tool === 'browser.click'),
    );
    expect(acts.length).toBeGreaterThan(0);
    for (const act of acts) {
      expect(act.input).toMatchObject({ ref: expect.stringMatching(/^e\d+$/) });
      expect(JSON.stringify(act.input)).not.toMatch(/"(x|y|clientX|clientY|screenX|screenY)"/);
    }

    const tools = r.orchestrator.listTools().map((tool) => tool.name);
    expect(tools.filter((name) => /mouse|coordinate|cursor|click_at|xy/i.test(name))).toEqual([]);
    for (const tool of r.orchestrator.listTools()) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/"(x|y|clientX|clientY|screenX|screenY)"/);
    }
  });

  it('a "no" at the approval means no search happens — and it is not reported as done', async () => {
    const { r, site } = await conversation('DENY');
    await r.say('Search YouTube for voice agents.');
    await step(r, 'browser.open', { url: 'https://www.youtube.com/' });
    const home = await step(r, 'browser.read', {});
    const denied = await step(r, 'browser.type', { ref: refFor(asResult(home), 'Search', 'textbox')!, text: 'voice agents', submit: true });

    expect(denied.ok).toBe(false);
    expect(denied.failure?.kind).toBe('DENIED');
    // The page never moved.
    expect(site.url.endsWith('/results')).toBe(false);
  });

  it('a stale reference is refused, not guessed at', async () => {
    // The real log's first attempt: browser.type with ref "1".
    const { r } = await conversation('ALLOW');
    await r.say('Search YouTube for voice agents.');
    await step(r, 'browser.open', { url: 'https://www.youtube.com/' });
    const wrong = await step(r, 'browser.type', { ref: '1', text: 'voice agents', submit: true });
    expect(wrong.ok).toBe(false);
    expect(['INVALID_INPUT', 'STALE_REFERENCE', 'NOT_FOUND']).toContain(wrong.failure?.kind);
  });
});
