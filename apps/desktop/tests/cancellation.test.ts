/**
 * "Stop." — and what that has to reach.
 *
 * A cancellation is only real if it reaches every place the work is. Stopping
 * the model loop is the easy part and the least of it; a request that is still
 * loading a page, still holding a dialog on screen, still about to act on a
 * target reference, or still going to speak when its result arrives has not
 * been cancelled in any sense the user means.
 *
 * So each test here picks one moment in the lifecycle and stops Axon in it:
 *
 *   while planning                nothing has run yet
 *   while a tool is executing     an executor is mid-flight
 *   while an approval is pending  a dialog is on screen
 *   partway through a multi-step  one step done, more proposed
 *   while waiting to observe      a reference has been minted
 *   while waiting on the provider a result is travelling back
 *
 * And asserts the same two things every time: nothing further happens, and the
 * security boundaries are exactly where they were. Cancellation is a way to
 * do LESS. A cancellation path that could do anything an ordinary path could
 * not would be a second door, which is the one thing Axon does not have.
 */

import { describe, expect, it, vi } from 'vitest';
import { defineTool, type JsonObject, type RiskAssessment, type ToolSummary } from '@axon/core';
import { z } from 'zod';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { ToolBridge } from '../src/main/agent/tool-bridge.js';
import { TaskLedger } from '../src/main/agent/task-ledger.js';
import type { AxonEvent, ToolResult, ToolSchema } from '@axon/core';

// ---------------------------------------------------------------------------
// A tool that can be held open, and that notices being aborted
// ---------------------------------------------------------------------------

interface SlowToolProbe {
  readonly started: () => boolean;
  readonly aborted: () => boolean;
  readonly release: () => void;
}

/**
 * A tool that waits until the test lets it finish, or until it is aborted.
 *
 * The abort branch is the interesting one: an executor that ignored its signal
 * would keep running after a cancellation, and the whole point of threading a
 * signal down to executors is that it does not.
 */
function slowTool(name: string): { tool: ReturnType<typeof defineTool>; probe: SlowToolProbe } {
  let began = false;
  let wasAborted = false;
  let release: (() => void) | null = null;

  const tool = defineTool<Record<string, never>, JsonObject>({
    name,
    title: 'A slow thing',
    description: 'Waits.',
    inputSchema: z.object({}),
    resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'It waits.' }),
    summarize: (): ToolSummary => ({ title: 'Axon wants to wait', parameters: [] }),
    execute: (_input, ctx) =>
      new Promise<JsonObject>((resolve, reject) => {
        began = true;
        release = (): void => resolve({ finished: true });
        ctx.signal.addEventListener(
          'abort',
          () => {
            wasAborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  });

  return {
    tool,
    probe: {
      started: () => began,
      aborted: () => wasAborted,
      release: () => release?.(),
    },
  };
}

/** An approval-gated tool, so a dialog can be left on screen. */
function gatedTool(name: string) {
  return defineTool<Record<string, never>, JsonObject>({
    name,
    title: 'A gated thing',
    description: 'Needs a human.',
    inputSchema: z.object({}),
    resolveRisk: (): RiskAssessment => ({ level: 'REQUIRES_APPROVAL', reason: 'It is consequential.' }),
    summarize: (): ToolSummary => ({ title: 'Axon wants to do a gated thing', parameters: [] }),
    execute: () => Promise.resolve({ done: true }),
  });
}

function orchestrator(tools: readonly ReturnType<typeof defineTool>[]) {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);

  const observations = { cleared: 0, clear(): void { this.cleared += 1; } };
  const browser = {
    cancelled: 0,
    cancel(): void {
      this.cancelled += 1;
    },
    beginTurn(): void {},
    // The dispatcher reads this when it raises an approval, to name the page
    // the act would happen on. Nothing here has a page.
    lastObservation: (): null => null,
  };

  const instance = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 30_000,
    devConsoleEnabled: true,
    observations,
    // Only the two methods cancellation uses. A fuller stand-in would test the
    // stand-in; what matters here is that cancellation reaches them.
    browser: browser as never,
  });

  return { instance, events, observations, browser };
}

// ---------------------------------------------------------------------------
// Cancelling at each moment
// ---------------------------------------------------------------------------

describe('cancelling while Axon is still planning', () => {
  it('reports that something was stopped, and refuses the next step', () => {
    const h = orchestrator([]);
    h.instance.tasks.begin('open github and search for something', 'voice');

    expect(h.instance.cancelWork()).toBe(true);
    // Nothing had run — but the task is gone, so nothing will.
    expect(h.instance.tasks.beginStep('browser.open')).toBeNull();
  });

  it('says nothing when there was nothing to stop', () => {
    // The difference between "Stopped." and staying quiet. A user who says
    // stop into silence should not be told something was stopped.
    const h = orchestrator([]);
    expect(h.instance.cancelWork()).toBe(false);
  });
});

describe('cancelling while a tool is executing', () => {
  it('aborts the executor rather than letting it finish', async () => {
    const slow = slowTool('slow.thing');
    const h = orchestrator([slow.tool]);
    h.instance.tasks.begin('do the slow thing', 'voice');

    // A voice session installs a turn signal per utterance. This is the same
    // path, exercised directly.
    const work = new AbortController();
    h.instance.dispatcher.setTurnSignal(work.signal);

    const dispatch = h.instance.invokeTool('slow.thing', {});
    await vi.waitFor(() => expect(slow.probe.started()).toBe(true));

    work.abort();
    h.instance.cancelWork();

    const result = await dispatch;
    expect(slow.probe.aborted()).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('CANCELLED');
  });

  it('abandons a navigation in flight and forgets what it had looked at', () => {
    const h = orchestrator([]);
    h.instance.tasks.begin('open github', 'voice');

    h.instance.cancelWork();

    // A reference minted for cancelled work must not survive it, and a page
    // still loading for it must not keep loading.
    expect(h.browser.cancelled).toBeGreaterThan(0);
    expect(h.observations.cleared).toBeGreaterThan(0);
  });
});

describe('cancelling while an approval is on screen', () => {
  it('takes the dialog down rather than leaving the user to answer it', async () => {
    // A dialog for work the user has just abandoned is worse than useless:
    // answering it would authorise an act nobody wants any more.
    const h = orchestrator([gatedTool('gated.thing')]);
    h.instance.tasks.begin('do the gated thing', 'voice');

    const dispatch = h.instance.invokeTool('gated.thing', {});
    await vi.waitFor(() => expect(h.instance.approvals.list()).toHaveLength(1));

    h.instance.cancelWork();

    const result = await dispatch;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('DENIED');
    expect(h.instance.approvals.list()).toHaveLength(0);
  });

  it('records the denial as the user’s, because it was', async () => {
    const h = orchestrator([gatedTool('gated.thing')]);
    h.instance.tasks.begin('do the gated thing', 'voice');

    const dispatch = h.instance.invokeTool('gated.thing', {});
    await vi.waitFor(() => expect(h.instance.approvals.list()).toHaveLength(1));
    h.instance.cancelWork();
    await dispatch;

    const resolved = h.events.find((event) => event.type === 'APPROVAL_RESOLVED');
    expect(resolved).toMatchObject({ decision: 'DENY', resolvedBy: 'user' });
  });
});

describe('cancelling partway through a multi-step request', () => {
  it('stops the steps that had not happened yet', () => {
    const h = orchestrator([]);
    h.instance.tasks.begin('open youtube, search, and open the first result', 'voice');

    // Step one happened.
    const first = h.instance.tasks.beginStep('browser.open');
    expect(first).not.toBeNull();
    if (first) h.instance.tasks.endStep(first, 'SUCCEEDED');

    h.instance.cancelWork();

    // Steps two and three do not. There is no queue to drain, because Axon
    // does not hold one — each step is proposed afresh, and there is now
    // nothing to propose it against.
    expect(h.instance.tasks.beginStep('browser.type')).toBeNull();
    expect(h.instance.tasks.beginStep('browser.click')).toBeNull();
  });

  it('leaves the next request able to start normally', () => {
    // Cancelling must not poison the conversation. An aborted signal that was
    // carried forward would make every later action fail as cancelled.
    const h = orchestrator([]);
    h.instance.tasks.begin('open youtube', 'voice');
    h.instance.cancelWork();

    h.instance.tasks.begin('what time is it', 'voice');
    expect(h.instance.tasks.beginStep('system.time')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancelling while a result is on its way back
// ---------------------------------------------------------------------------

describe('a result that arrives after the user said stop', () => {
  const schema: ToolSchema = {
    name: 'browser.open',
    title: 'Open a page',
    description: 'Opens a page.',
    inputSchema: { type: 'object' },
  };

  function bridge(tasks: TaskLedger) {
    const spoken: string[] = [];
    const notices: string[] = [];
    const late: { callId: string; result: string }[] = [];
    let release: (() => void) | null = null;

    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => false,
      onDeferredOutcome: (summary) => spoken.push(summary),
      onNotice: (summary) => notices.push(summary),
      onLateResult: (entry) => late.push(entry),
      tasks,
      inlineBudgetMs: 5,
      dispatch: (call) =>
        new Promise<ToolResult>((resolve) => {
          release = (): void =>
            resolve({ callId: call.callId, tool: call.tool, ok: true, output: { opened: true }, durationMs: 9_000 });
        }),
    });

    return {
      instance,
      spoken,
      notices,
      late,
      finish: async (): Promise<void> => {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    };
  }

  it('never speaks, however well it went', async () => {
    // THE FAILURE THIS CLOSES. A page that finished loading after the user
    // said stop is not good news to deliver — it is Axon acting on an
    // intention that no longer exists.
    const tasks = new TaskLedger();
    tasks.begin('open github', 'voice');
    const h = bridge(tasks);

    const call = h.instance.handleToolCall('p1', 'browser.open', { url: 'https://github.com/' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.instance.flush('completed');

    tasks.cancelActive();
    await h.finish();
    await call;

    expect(h.spoken).toEqual([]);
    expect(h.late).toEqual([]);
  });

  it('says in the timeline that it was dropped, and why', async () => {
    // Silent discarding would be its own problem: somebody reading the log has
    // to be able to see that a result arrived and was deliberately not used.
    const tasks = new TaskLedger();
    tasks.begin('open github', 'voice');
    const h = bridge(tasks);

    const call = h.instance.handleToolCall('p1', 'browser.open', { url: 'https://github.com/' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.instance.flush('completed');
    tasks.cancelActive();
    await h.finish();
    await call;

    expect(h.notices.some((notice) => /after you stopped it/i.test(notice))).toBe(true);
  });

  it('cannot trigger the next step of the work that was stopped', async () => {
    // The dangerous version of the same bug. A delivered result is not just
    // something said out loud — it is something the model reasons from, and a
    // cancelled task's result could justify carrying on.
    const tasks = new TaskLedger();
    tasks.begin('open youtube then search', 'voice');
    const h = bridge(tasks);

    const call = h.instance.handleToolCall('p1', 'browser.open', { url: 'https://youtube.com/' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.instance.flush('completed');
    tasks.cancelActive();
    await h.finish();
    await call;

    // Nothing to reason from, and nowhere to put a next step even if there
    // were: a new call is refused outright.
    expect(h.spoken).toEqual([]);
    await h.instance.handleToolCall('p2', 'browser.open', { url: 'https://youtube.com/results' });
    const refusal = JSON.parse(h.instance.flush('completed')[0]!.result) as { ok: boolean; errorKind: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.errorKind).toBe('CANCELLED');
  });

  it('still delivers when the user did not cancel', async () => {
    // The control case. Without it, all of the above would pass on a bridge
    // that simply never delivered anything.
    const tasks = new TaskLedger();
    tasks.begin('open github', 'voice');
    const h = bridge(tasks);

    const call = h.instance.handleToolCall('p1', 'browser.open', { url: 'https://github.com/' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.instance.flush('completed');
    await h.finish();
    await call;

    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).toMatch(/SUCCEEDED/);
  });
});

// ---------------------------------------------------------------------------
// Cancellation grants nothing
// ---------------------------------------------------------------------------

describe('cancellation is a way to do less, never more', () => {
  it('does not let a gated action through', async () => {
    // The shape of the question: is there anything a cancelled path can do
    // that an ordinary one cannot? There must not be.
    const h = orchestrator([gatedTool('gated.thing')]);
    h.instance.tasks.begin('do the gated thing', 'voice');
    h.instance.cancelWork();

    // A dispatch after cancelling still meets the same gate.
    const dispatch = h.instance.invokeTool('gated.thing', {});
    await vi.waitFor(() => expect(h.instance.approvals.list()).toHaveLength(1));
    h.instance.approvals.settle(h.instance.approvals.list()[0]!.callId, 'DENY', 'user');

    const result = await dispatch;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('DENIED');
  });

  it('leaves no approval standing that could be reused', () => {
    const h = orchestrator([gatedTool('gated.thing')]);
    h.instance.tasks.begin('do the gated thing', 'voice');
    h.instance.cancelWork();
    expect(h.instance.approvals.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A slow call whose reply turn closed before the inline budget ran out
// ---------------------------------------------------------------------------

describe('a slow tool call after the reply has already finished', () => {
  // FOUND LIVE. The agent's reply ended (reply.done, the flush) 0.2 s after it
  // asked to read Spotify; the read took 17 s. The in-progress answer was then
  // queued for a flush that was never coming, the provider heard nothing, and
  // at its 15 s tool timeout the agent told the user Axon "could not read the
  // controls in Spotify" — three seconds before Axon read them.
  it('sends the in-progress answer straight away instead of queueing it for no flush', async () => {
    const schema: ToolSchema = { name: 'ui.read', title: 'Read controls', description: 'Reads.', inputSchema: { type: 'object' } };
    const tasks = new TaskLedger();
    tasks.begin('what do you see in spotify', 'voice');
    const late: { callId: string; result: string }[] = [];
    const spoken: string[] = [];
    let release: (() => void) | null = null;
    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => false,
      onDeferredOutcome: (summary) => spoken.push(summary),
      onNotice: () => {},
      onLateResult: (entry) => late.push(entry),
      tasks,
      inlineBudgetMs: 20,
      dispatch: (call) =>
        new Promise<ToolResult>((resolve) => {
          release = (): void => resolve({ callId: call.callId, tool: call.tool, ok: true, output: { read: true }, durationMs: 17_000 });
        }),
    });

    const call = instance.handleToolCall('p1', 'ui.read', { app: 'Spotify' });
    // The reply finishes BEFORE the budget does.
    expect(instance.flush('completed')).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(late).toHaveLength(1);
    expect(late[0]!.callId).toBe('p1');
    expect(JSON.parse(late[0]!.result)).toMatchObject({ status: 'in_progress' });

    release!();
    await call;
    // The outcome still follows, as its own turn.
    expect(spoken).toHaveLength(1);
  });
});
