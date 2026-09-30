/**
 * Every spoken request gets its own budget.
 *
 * FOUND IN A REAL CONVERSATION. After about five minutes of talking to Axon,
 * every tool began to fail — including reading the clock:
 *
 *     12:56:55  app.open     BUDGET_EXCEEDED  "running for 444 seconds, which is the limit"
 *     12:58:04  memory.save  BUDGET_EXCEEDED  "running for 513 seconds, which is the limit"
 *     12:58:32  system.time  BUDGET_EXCEEDED  "running for 541 seconds, which is the limit"
 *
 * and the model told the user each one had "timed out". Nothing had timed
 * out. The five-minute ceiling is a bound on ONE REQUEST converging, and the
 * voice path opened it once per SESSION: `beginConversation()` at connect,
 * and nothing after. The typed path has always opened one per message.
 *
 * These run a real VoiceAgentSession against a scripted provider over a real
 * local socket, so the requests arrive the way AssemblyAI delivers them. Time
 * is moved with a faked `Date` only — the socket and the tool bridge keep
 * their real timers.
 *
 * WHAT IS DELIBERATELY UNCHANGED, and asserted here so it stays that way: the
 * limits themselves (24 calls, five minutes, three identical attempts), which
 * are now measured against the request they were written for. The per-session
 * cap on tool calls and the per-task step cap are separate, deliberate bounds
 * on a runaway conversation, and are not touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AGENT_LOOP_LIMITS, defineTool, type JsonValue, type RegisteredTool, type ToolExecutionContext } from '@axon/core';
import { createSystemTimeTool } from '../src/main/tools/executors/system-time.js';
import { createHarness } from './support/agent-harness.js';
import { githubIssueSite } from './support/fake-site.js';
import { ScriptedBrain } from './support/scripted-brain.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

const MINUTE = 60_000;

/** A SAFE tool whose every call is distinct unless the test says otherwise. */
function probe(execute?: (input: { n: number }, ctx: ToolExecutionContext) => Promise<JsonValue>): RegisteredTool {
  return defineTool<{ n: number }, JsonValue>({
    name: 'test.probe',
    title: 'Probe',
    description: 'A test tool that does nothing.',
    inputSchema: z.object({ n: z.number().int() }).strict(),
    resolveRisk: () => ({ level: 'SAFE', reason: 'A test probe has no effect.' }),
    summarize: () => ({ title: 'Probe', parameters: [] }),
    sideEffect: () => 'NONE',
    execute: (input, ctx) => (execute ? execute(input, ctx) : Promise.resolve({ n: input.n })),
  });
}

const rigs: VoiceRig[] = [];
async function rig(tools: readonly RegisteredTool[]): Promise<VoiceRig> {
  const r = await voiceRig({ tools });
  rigs.push(r);
  await r.start();
  return r;
}

beforeEach(() => {
  // Date only. `shouldAdvanceTime` keeps the faked clock moving with real
  // time, so every deadline in the rig still passes; `setSystemTime` then
  // jumps it forward to cross the five-minute boundary on demand.
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
});

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
  vi.useRealTimers();
});

const jump = (ms: number): void => {
  vi.setSystemTime(new Date(Date.now() + ms));
};

describe('a voice conversation longer than five minutes', () => {
  it('can still read the clock after six minutes of talking', async () => {
    const r = await rig([createSystemTimeTool()]);

    await r.say('What time is it?');
    expect(await r.call('system.time', {})).toMatchObject({ ok: true });

    // The conversation goes on. Six minutes later the user asks again: the
    // exact request that failed in the real log at 541 seconds.
    jump(6 * MINUTE);
    await r.say('And what time is it now?');
    const later = await r.call('system.time', {});

    expect(later).toMatchObject({ ok: true });
    expect(later.errorKind).toBeUndefined();
  });

  it('gives a new request a fresh budget rather than the one before it', async () => {
    const r = await rig([probe()]);

    // Request one spends its whole allowance.
    await r.say('Do the first thing.');
    for (let n = 0; n < AGENT_LOOP_LIMITS.maxToolCalls; n += 1) {
      expect(await r.call('test.probe', { n })).toMatchObject({ ok: true });
    }
    expect(await r.call('test.probe', { n: 999 })).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });

    // Request two inherits none of that.
    await r.say('Now do something else.');
    expect(await r.call('test.probe', { n: 1_000 })).toMatchObject({ ok: true });
  });

  it('does not carry an exhausted CLOCK into the next request', async () => {
    const r = await rig([probe()]);

    await r.say('Start something slow.');
    jump(AGENT_LOOP_LIMITS.maxTurnMilliseconds + MINUTE);
    const late = await r.call('test.probe', { n: 1 });
    expect(late).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });
    expect(String(late.error)).toMatch(/running for \d+ seconds/);

    await r.say('Try again.');
    expect(await r.call('test.probe', { n: 2 })).toMatchObject({ ok: true });
  });
});

describe('the limits still hold, per request', () => {
  it('maxToolCalls stops a single request that will not converge', async () => {
    const r = await rig([probe()]);
    await r.say('Keep going.');

    const results: Record<string, unknown>[] = [];
    for (let n = 0; n <= AGENT_LOOP_LIMITS.maxToolCalls; n += 1) results.push(await r.call('test.probe', { n }));

    expect(results.slice(0, AGENT_LOOP_LIMITS.maxToolCalls).every((result) => result.ok === true)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });
    expect(String(results.at(-1)?.error)).toMatch(/tool calls for this request/);
  });

  it('maxTurnMilliseconds stops a single request that runs too long', async () => {
    const r = await rig([probe()]);
    await r.say('Keep going.');

    expect(await r.call('test.probe', { n: 1 })).toMatchObject({ ok: true });
    jump(AGENT_LOOP_LIMITS.maxTurnMilliseconds + 1_000);
    expect(await r.call('test.probe', { n: 2 })).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });
  });

  it('repeated-attempt protection still refuses the same call over and over, within a request', async () => {
    const r = await rig([probe()]);
    await r.say('Read it.');

    for (let attempt = 0; attempt < AGENT_LOOP_LIMITS.maxRepeatedAttempts; attempt += 1) {
      expect(await r.call('test.probe', { n: 7 })).toMatchObject({ ok: true });
    }
    const refused = await r.call('test.probe', { n: 7 });
    expect(refused).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });
    expect(String(refused.error)).toMatch(/exact arguments/);

    // A new request is a new question, even if it is the same words.
    await r.say('Read it again.');
    expect(await r.call('test.probe', { n: 7 })).toMatchObject({ ok: true });
  });

  it('an ANSWER to Axon is not a new request, so it does not reset the budget', async () => {
    // The task ledger continues a task when the user answers a question Axon
    // asked. Opening a fresh budget there would let a model reset its own
    // limits by asking a question — so an answer must keep the accounting.
    const r = await rig([probe()]);
    await r.say('Do it.');
    for (let n = 0; n < AGENT_LOOP_LIMITS.maxToolCalls; n += 1) await r.call('test.probe', { n });

    // Mark the task as waiting on the user, then answer it.
    r.orchestrator.tasks.awaitClarification('Which one?');
    await r.say('The second one.');

    expect(await r.call('test.probe', { n: 500 })).toMatchObject({ ok: false, errorKind: 'BUDGET_EXCEEDED' });
  });
});

describe('cancellation still works', () => {
  it('"stop" aborts the tool that is running, and the next request runs', async () => {
    let started = false;
    let sawAbort = false;
    const slow = probe(
      (_input, ctx) =>
        new Promise<JsonValue>((resolve, reject) => {
          started = true;
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
          // Never resolves by itself: only a cancellation ends it.
          void resolve;
        }),
    );
    const r = await rig([slow]);

    await r.say('Do the slow thing.');
    await r.provider.send({ type: 'tool.call', call_id: 'slow_1', name: 'test.probe', arguments: { n: 1 } });
    expect(await until(() => started)).toBe(true);

    await r.say('Stop.');
    expect(await until(() => sawAbort)).toBe(true);
    const cancelled = r.events.find(
      (event) => event.type === 'TOOL_RESULT' && !event.ok && event.failure?.kind === 'CANCELLED',
    );
    expect(cancelled).toBeDefined();

    // And Axon is still usable: a new request gets a budget and runs.
    r.orchestrator.dispatcher.setTurnSignal(null);
    await r.say('Now do something quick.');
    started = false;
    await r.provider.send({ type: 'tool.call', call_id: 'slow_2', name: 'test.probe', arguments: { n: 2 } });
    expect(await until(() => started)).toBe(true);
  });
});

describe('the typed path is unchanged', () => {
  it('still opens one budget per typed message', async () => {
    // Four identical reads: the fourth is the repeat bound. If the second
    // message inherited the first message's accounting, its first read would
    // be refused too.
    const read = { kind: 'call' as const, tool: 'browser.read', input: {} };
    const brain = new ScriptedBrain({
      steps: [{ kind: 'call', tool: 'browser.open', input: { url: 'https://github.com/axon/demo/issues/41' } }, read, read, read, read],
    });
    const h = createHarness({ site: githubIssueSite(), brain });

    await h.send('read the issue');
    const first = brain.results.slice();
    expect(first.filter((result) => result.tool === 'browser.read' && result.ok)).toHaveLength(
      AGENT_LOOP_LIMITS.maxRepeatedAttempts,
    );
    expect(first.at(-1)).toMatchObject({ ok: false, failure: { kind: 'BUDGET_EXCEEDED' } });

    await h.send('read it again');
    const second = brain.results.slice(first.length);
    expect(second.find((result) => result.tool === 'browser.read')).toMatchObject({ ok: true });
  });
});
