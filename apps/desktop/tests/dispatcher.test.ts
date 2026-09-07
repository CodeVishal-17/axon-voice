/**
 * Dispatcher tests — the safety layer's behaviour under every branch.
 *
 * These are the most important tests in the repository. Every guarantee the
 * architecture claims (validated input, dynamic risk, human gating,
 * deny-by-default, structured failure, paired events) is asserted here against
 * the real Dispatcher, Policy, ApprovalBroker, ToolRegistry and EventBus. Only
 * the tools and the state controller are fakes, and only so a test can force a
 * branch that a real tool would not.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type AxonEvent, type RiskAssessment, type ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher';
import { ApprovalBroker } from '../src/main/safety/approval-broker';
import { Policy } from '../src/main/safety/policy';
import { ToolRegistry } from '../src/main/tools/registry';

function recordingController(): StateController & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enterExecuting: () => calls.push('EXECUTING'),
    enterAwaitingApproval: () => calls.push('WAITING_FOR_APPROVAL'),
    settle: () => calls.push('SETTLE'),
  };
}

interface Harness {
  readonly dispatcher: Dispatcher;
  readonly bus: EventBus;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly states: StateController & { calls: string[] };
  readonly events: AxonEvent[];
}

function harness(approvalTimeoutMs = 50_000): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const registry = new ToolRegistry();
  const approvals = new ApprovalBroker();
  const states = recordingController();

  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus,
    states,
    approvalTimeoutMs,
  });

  return { dispatcher, bus, registry, approvals, states, events };
}

/** A tool whose risk and behaviour a test can dictate. */
function fakeTool(options: {
  name?: string;
  risk?: RiskAssessment | (() => RiskAssessment);
  execute?: () => Promise<string> | string;
  schema?: z.ZodType<{ value: string }>;
}) {
  const schema = options.schema ?? z.object({ value: z.string().min(1) });
  return defineTool<{ value: string }, string>({
    name: options.name ?? 'test.tool',
    title: 'Test tool',
    description: 'A tool that exists only inside the test suite.',
    inputSchema: schema,
    resolveRisk: () => {
      const risk = options.risk ?? { level: 'SAFE' as const, reason: 'test tool is safe' };
      return typeof risk === 'function' ? risk() : risk;
    },
    summarize: (input) => ({
      title: 'Axon wants to run the test tool',
      parameters: [{ label: 'value', value: input.value }],
    }),
    execute: async () => (options.execute ? await options.execute() : 'executed'),
  });
}

const call = (tool: string, input: unknown): { callId: string; tool: string; input: never } => ({
  callId: newCallId(),
  tool,
  input: input as never,
});

function eventTypes(events: readonly AxonEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------

describe('dispatcher — the happy path', () => {
  it('validates, classifies, executes and reports', async () => {
    const h = harness();
    h.registry.register(fakeTool({ execute: () => 'done' }));

    const result = await h.dispatcher.dispatch(call('test.tool', { value: 'hello' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('done');
    expect(h.states.calls).toEqual(['EXECUTING', 'SETTLE']);
  });

  it('emits exactly one TOOL_CALL and one TOOL_RESULT', async () => {
    const h = harness();
    h.registry.register(fakeTool({}));
    await h.dispatcher.dispatch(call('test.tool', { value: 'x' }));

    expect(eventTypes(h.events).filter((t) => t === 'TOOL_CALL')).toHaveLength(1);
    expect(eventTypes(h.events).filter((t) => t === 'TOOL_RESULT')).toHaveLength(1);
  });

  it('records the risk verdict and its reason on the TOOL_CALL', async () => {
    const h = harness();
    h.registry.register(fakeTool({ risk: { level: 'SAFE', reason: 'nothing leaves the machine' } }));
    await h.dispatcher.dispatch(call('test.tool', { value: 'x' }));

    const toolCall = h.events.find((e) => e.type === 'TOOL_CALL');
    expect(toolCall).toMatchObject({ risk: 'SAFE', riskReason: 'nothing leaves the machine' });
  });

  it('surfaces executor observations as OBSERVATION events', async () => {
    const h = harness();
    h.registry.register(
      defineTool<{ value: string }, string>({
        name: 'observing.tool',
        title: 'Observer',
        description: 'Emits an observation.',
        inputSchema: z.object({ value: z.string() }),
        resolveRisk: () => ({ level: 'SAFE', reason: 'safe' }),
        summarize: () => ({ title: 'observe', parameters: [] }),
        execute: (_input, ctx) => {
          ctx.observe('halfway through');
          return Promise.resolve('ok');
        },
      }),
    );

    await h.dispatcher.dispatch(call('observing.tool', { value: 'x' }));
    expect(h.events.find((e) => e.type === 'OBSERVATION')).toMatchObject({ summary: 'halfway through' });
  });
});

describe('dispatcher — deny by default', () => {
  it('refuses an unknown tool and names what is registered', async () => {
    const h = harness();
    h.registry.register(fakeTool({ name: 'known.tool' }));

    const result = await h.dispatcher.dispatch(call('shell.execute', { command: 'whoami' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('UNKNOWN_TOOL');
      expect(result.failure.detail).toEqual({ registered: ['known.tool'] });
    }
    // Still a complete pair, so the timeline cannot show a hanging call.
    expect(eventTypes(h.events)).toEqual(['TOOL_CALL', 'TOOL_RESULT']);
  });

  it('never executes an unknown tool', async () => {
    const h = harness();
    const execute = vi.fn(() => 'should not run');
    h.registry.register(fakeTool({ name: 'real.tool', execute }));

    await h.dispatcher.dispatch(call('other.tool', { value: 'x' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects input that does not match the schema, before risk resolution', async () => {
    const h = harness();
    const resolveRisk = vi.fn((): RiskAssessment => ({ level: 'SAFE', reason: 'safe' }));
    h.registry.register(
      defineTool<{ value: string }, string>({
        name: 'strict.tool',
        title: 'Strict',
        description: 'Requires a non-empty string.',
        inputSchema: z.object({ value: z.string().min(1) }),
        resolveRisk,
        summarize: () => ({ title: 'x', parameters: [] }),
        execute: () => Promise.resolve('ok'),
      }),
    );

    const result = await h.dispatcher.dispatch(call('strict.tool', { value: 42 }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('INVALID_INPUT');
    expect(resolveRisk).not.toHaveBeenCalled();
  });

  it('escalates to approval when resolveRisk throws, rather than assuming safety', async () => {
    const h = harness();
    h.registry.register(
      fakeTool({
        risk: () => {
          throw new Error('cannot classify');
        },
      }),
    );

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));

    const pending = h.approvals.list()[0];
    expect(pending?.risk).toBe('REQUIRES_APPROVAL');

    h.approvals.settle(pending!.callId, 'DENY', 'user');
    const result = await dispatch;
    expect(result.ok).toBe(false);
  });

  it('escalates when resolveRisk returns something malformed', async () => {
    const h = harness();
    h.registry.register(fakeTool({ risk: () => undefined as unknown as RiskAssessment }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    h.approvals.settle(h.approvals.list()[0]!.callId, 'DENY', 'user');

    expect((await dispatch).ok).toBe(false);
  });
});

describe('dispatcher — forbidden', () => {
  it('refuses without ever offering an approval', async () => {
    const h = harness();
    const execute = vi.fn(() => 'nope');
    h.registry.register(fakeTool({ risk: { level: 'FORBIDDEN', reason: 'protected location' }, execute }));

    const result = await h.dispatcher.dispatch(call('test.tool', { value: 'x' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('FORBIDDEN');
      expect(result.failure.message).toBe('protected location');
    }
    expect(execute).not.toHaveBeenCalled();
    expect(h.approvals.list()).toHaveLength(0);
    expect(eventTypes(h.events)).not.toContain('APPROVAL_REQUIRED');
  });
});

describe('dispatcher — the human gate', () => {
  it('waits for approval and runs the tool once allowed', async () => {
    const h = harness();
    const execute = vi.fn(() => 'ran');
    h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'outside workspace' }, execute }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));

    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    expect(execute).not.toHaveBeenCalled();
    expect(h.states.calls).toContain('WAITING_FOR_APPROVAL');

    h.approvals.settle(h.approvals.list()[0]!.callId, 'ALLOW', 'user');
    const result = await dispatch;

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(eventTypes(h.events)).toEqual([
      'TOOL_CALL',
      'APPROVAL_REQUIRED',
      'APPROVAL_RESOLVED',
      'TOOL_RESULT',
    ]);
  });

  it('does not run the tool when the user denies', async () => {
    const h = harness();
    const execute = vi.fn(() => 'ran');
    h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'outside workspace' }, execute }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    h.approvals.settle(h.approvals.list()[0]!.callId, 'DENY', 'user');

    const result = await dispatch;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('DENIED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns to a resting state after a denial', async () => {
    // Regression: without an explicit settle on the denial path the UI stays
    // stuck showing WAITING_FOR_APPROVAL after the user clicks Deny.
    const h = harness();
    h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'outside' } }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    h.approvals.settle(h.approvals.list()[0]!.callId, 'DENY', 'user');
    await dispatch;

    expect(h.states.calls).toEqual(['WAITING_FOR_APPROVAL', 'SETTLE']);
  });

  it('denies an unanswered approval when the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(1_000);
      const execute = vi.fn(() => 'ran');
      h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'outside' }, execute }));

      const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
      await vi.advanceTimersByTimeAsync(1_100);

      const result = await dispatch;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('APPROVAL_TIMEOUT');
      expect(execute).not.toHaveBeenCalled();

      const resolved = h.events.find((e) => e.type === 'APPROVAL_RESOLVED');
      expect(resolved).toMatchObject({ decision: 'DENY', resolvedBy: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the tool summary into the approval request', async () => {
    const h = harness();
    h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'needs a human' } }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'the-argument' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));

    const request = h.approvals.list()[0]!;
    expect(request.title).toBe('Axon wants to run the test tool');
    expect(request.detail).toBe('needs a human');
    expect(request.parameters).toEqual([{ label: 'value', value: 'the-argument' }]);
    expect(new Date(request.expiresAt).getTime()).toBeGreaterThan(new Date(request.requestedAt).getTime());

    h.approvals.settle(request.callId, 'DENY', 'user');
    await dispatch;
  });
});

describe('dispatcher — failure handling', () => {
  it('returns a structured failure instead of throwing when an executor crashes', async () => {
    const h = harness();
    h.registry.register(
      fakeTool({
        execute: () => {
          throw new Error('the disk is on fire');
        },
      }),
    );

    const result: ToolResult = await h.dispatcher.dispatch(call('test.tool', { value: 'x' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('EXECUTION_ERROR');
      expect(result.failure.message).toBe('the disk is on fire');
    }
    // Still settles: a crash must not strand the UI mid-execution.
    expect(h.states.calls).toEqual(['EXECUTING', 'SETTLE']);
  });

  it('reports a duration on every result, success or failure', async () => {
    const h = harness();
    h.registry.register(fakeTool({}));
    const ok = await h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    const bad = await h.dispatcher.dispatch(call('nope', {}));

    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(bad.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('denies everything outstanding on shutdown', async () => {
    const h = harness();
    h.registry.register(fakeTool({ risk: { level: 'REQUIRES_APPROVAL', reason: 'outside' } }));

    const dispatch = h.dispatcher.dispatch(call('test.tool', { value: 'x' }));
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));

    h.dispatcher.abortAll();

    const result = await dispatch;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('DENIED');
  });
});

describe('tool registry', () => {
  it('refuses to shadow an existing tool', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool({ name: 'dup.tool' }));
    expect(() => registry.register(fakeTool({ name: 'dup.tool' }))).toThrow(/already registered/);
  });

  it('lists names in a stable order', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool({ name: 'z.tool' }));
    registry.register(fakeTool({ name: 'a.tool' }));
    expect(registry.names()).toEqual(['a.tool', 'z.tool']);
  });
});

describe('policy', () => {
  it('maps each risk level to its action', () => {
    const policy = new Policy();
    expect(policy.decide({ level: 'SAFE', reason: '' }).action).toBe('ALLOW');
    expect(policy.decide({ level: 'REQUIRES_APPROVAL', reason: '' }).action).toBe('REQUIRE_APPROVAL');
    expect(policy.decide({ level: 'FORBIDDEN', reason: '' }).action).toBe('REFUSE');
  });

  it('refuses a risk level it does not recognize', () => {
    const policy = new Policy();
    const decision = policy.decide({ level: 'PROBABLY_FINE' as never, reason: '' });
    expect(decision.action).toBe('REFUSE');
  });
});
