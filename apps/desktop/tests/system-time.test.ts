/**
 * The clock is a tool, and the model cannot reach around it.
 *
 * Two properties are being asserted, and the second is the interesting one:
 *
 * 1. `system.time` reports what the computer's clock actually says.
 * 2. There is NO PATH from anything the model produces into that answer. Not
 *    through an argument, not through a prompt value, not through a cached
 *    string in the tool surface. A model that asserts the time is being
 *    ignored, mechanically, rather than being asked politely not to.
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/main/bus/event-bus.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { Policy } from '../src/main/safety/policy.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { createSystemTimeTool, readSystemTime } from '../src/main/tools/executors/system-time.js';
import { buildAgentSystemPrompt } from '../src/main/agent/agent-tool-surface.js';
import type { AxonEvent } from '@axon/core';

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

function harness(now?: () => Date) {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const registry = new ToolRegistry();
  registry.register(createSystemTimeTool(now ? { now } : {}));

  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals: new ApprovalBroker(),
    bus,
    states: noopStates,
    approvalTimeoutMs: 1_000,
  });

  return {
    events,
    run: (input: unknown) => dispatcher.dispatch({ callId: newCallId(), tool: 'system.time', input: input as never }),
  };
}

// ---------------------------------------------------------------------------

describe('system.time reads the real clock', () => {
  it('agrees with this machine, to the second', async () => {
    // Deliberately against the REAL system clock rather than an injected one.
    // A test that only proves the tool returns whatever it was handed proves
    // nothing about the thing this tool exists for.
    const before = Date.now();
    const result = await harness().run({});
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as { epochMs: number; utc: string; date: string; time: string };
    expect(output.epochMs).toBeGreaterThanOrEqual(before);
    expect(output.epochMs).toBeLessThanOrEqual(after);
    // And the derived fields describe that same instant.
    expect(new Date(output.utc).getTime()).toBe(output.epochMs);
    expect(output.date).toBe(
      `${new Date(output.epochMs).getFullYear()}-${String(new Date(output.epochMs).getMonth() + 1).padStart(2, '0')}-${String(
        new Date(output.epochMs).getDate(),
      ).padStart(2, '0')}`,
    );
  });

  it('reports the local timezone and offset this machine is actually in', async () => {
    const result = await harness().run({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as { timezone: string | null; utcOffsetMinutes: number; utcOffset: string };
    expect(output.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset());
    expect(output.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    // Null is a legitimate answer on a runtime without Intl data — what is not
    // legitimate is a made-up zone.
    if (output.timezone !== null) {
      expect(output.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
  });

  it('runs with no approval and records what it read', async () => {
    const { run, events } = harness();
    await run({});

    expect(events.some((event) => event.type === 'APPROVAL_REQUIRED')).toBe(false);
    expect(events.find((event) => event.type === 'TOOL_CALL')).toMatchObject({ risk: 'SAFE' });
    expect(events.find((event) => event.type === 'OBSERVATION')).toMatchObject({
      summary: expect.stringContaining('system clock'),
    });
  });

  it('gets the offset sign right, which is the classic bug here', () => {
    // `getTimezoneOffset` returns minutes to ADD to local time to reach UTC,
    // so its sign is the opposite of the one in "+05:30".
    const reading = readSystemTime(new Date());
    const expectedSign = -new Date().getTimezoneOffset() >= 0 ? '+' : '-';
    expect(reading.utcOffset.startsWith(expectedSign)).toBe(true);
  });
});

describe('the model cannot supply the time', () => {
  it('ignores a time the caller tried to pass in', async () => {
    // The schema takes nothing, and Zod strips unknown keys — so a model that
    // asserts "now" gets its assertion discarded before the executor runs.
    const real = await harness().run({});
    const injected = await harness().run({
      now: '1999-01-01T00:00:00.000Z',
      time: '03:00',
      date: '1999-01-01',
      timezone: 'Pacific/Kiritimati',
      epochMs: 0,
    });

    expect(real.ok && injected.ok).toBe(true);
    if (!real.ok || !injected.ok) return;

    const output = injected.output as { date: string; timezone: string | null; epochMs: number };
    expect(output.date).not.toBe('1999-01-01');
    expect(output.timezone).not.toBe('Pacific/Kiritimati');
    expect(output.epochMs).toBeGreaterThan(1_700_000_000_000);
  });

  it('derives every field from the clock alone', async () => {
    // With the clock pinned, the whole answer is a function of that one value.
    // There is no other input it could be reading.
    const pinned = new Date('2026-03-04T09:05:06.000Z');
    const result = await harness(() => pinned).run({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual(readSystemTime(pinned));
  });

  it('leaves no timestamp in the voice prompt for the model to answer from', () => {
    // The prompt used to carry the session's start time. A voice session runs
    // for as long as somebody keeps talking, so that value was wrong within
    // minutes — and the model answered "what time is it?" from it, confidently.
    const prompt = buildAgentSystemPrompt({
      tools: [{ name: 'system.time', title: 'Check the time', description: 'Reads the clock.', inputSchema: {} }],
      platform: 'win32',
      workspaceRoot: 'C:/Axon/workspace',
    });

    // No ISO timestamp anywhere in it.
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // And it says where the answer does come from.
    expect(prompt).toMatch(/call system\.time/i);
  });
});
