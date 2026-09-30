/**
 * Multi-step work, and the ways it could quietly become more than was asked.
 *
 * A task that runs several actions is where an agent stops being a tool caller
 * and starts being something a person delegates to. It is also where the
 * interesting failures live, because every one of them looks like helpfulness:
 *
 *   - one approval covering the action after it, because they were "part of
 *     the same thing";
 *   - a second act bundled into an approved one, so the dialog described half
 *     of what ran;
 *   - a step nobody asked for, because it was the obvious next thing;
 *   - the same consequential act running twice because the provider retried;
 *   - a result from work the user stopped becoming the reason to keep going.
 *
 * Axon's answer is structural rather than behavioural, and these tests hold it
 * to that. There is no queue of approved future actions anywhere in the system.
 * A task is a THREAD steps are strung on, not a permission that covers them.
 * Every step is proposed, schema-checked, precheck-ed, budgeted, risk-resolved,
 * policy-decided, duplicate-checked, approved and verified on its own, and the
 * approval is bound to one fingerprint of one set of arguments.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  type ApprovalRequest,
  type AxonEvent,
  type JsonObject,
  type RiskAssessment,
  type ToolResult,
  type ToolSchema,
  type ToolSummary,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { ToolBridge } from '../src/main/agent/tool-bridge.js';
import { TaskLedger } from '../src/main/agent/task-ledger.js';
import { buildAgentSystemPrompt } from '../src/main/agent/agent-tool-surface.js';

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

/** A tool whose risk depends on its arguments, as a real one's does. */
function formTool() {
  const performed: { field: string; submit: boolean }[] = [];
  const tool = defineTool<{ field: string; submit: boolean }, JsonObject>({
    name: 'form.fill',
    title: 'Fill in a form field',
    description: 'Fills a field, and optionally submits.',
    inputSchema: z.object({ field: z.string(), submit: z.boolean().default(false) }),
    // Filling is ordinary. Submitting sends something to a stranger, and only
    // the ARGUMENTS can tell those apart — which is why risk is resolved per
    // call rather than declared per tool.
    resolveRisk: (input): RiskAssessment =>
      input.submit
        ? { level: 'REQUIRES_APPROVAL', reason: 'Submitting sends the form.' }
        : { level: 'SAFE', reason: 'Filling a visible field sends nothing.' },
    summarize: (input): ToolSummary => ({
      title: input.submit ? 'Axon wants to submit this form' : 'Axon wants to fill in a field',
      parameters: [{ label: 'Field', value: input.field }],
    }),
    sideEffect: (input) => (input.submit ? 'EXTERNAL' : 'LOCAL'),
    execute: (input) => {
      performed.push({ field: input.field, submit: input.submit });
      return Promise.resolve({ filled: input.field, submitted: input.submit });
    },
  });
  return { tool, performed };
}

function rig(options: { decide?: (request: ApprovalRequest) => 'ALLOW' | 'DENY' | null } = {}) {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  const seen: ApprovalRequest[] = [];

  const form = formTool();
  const registry = new ToolRegistry();
  registry.register(form.tool);

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus,
    states: noopStates,
    approvalTimeoutMs: 2_000,
  });
  dispatcher.beginTurn(new TurnBudget(), 'fill in my application but do not submit it');

  bus.subscribe((event) => {
    events.push(event);
    if (event.type !== 'APPROVAL_REQUIRED') return;
    seen.push(event.request);
    const decision = options.decide === undefined ? 'ALLOW' : options.decide(event.request);
    if (decision) setTimeout(() => approvals.settle(event.request.callId, decision, 'user'), 0);
  });

  return {
    events,
    seen,
    performed: form.performed,
    approvals,
    run: (input: unknown): Promise<ToolResult> =>
      dispatcher.dispatch({ callId: newCallId(), tool: 'form.fill', input: input as never }),
  };
}

// ---------------------------------------------------------------------------
// Approval is scoped to one act
// ---------------------------------------------------------------------------

describe('an approval covers one action and nothing adjacent to it', () => {
  it('gates the submit and lets the fill through, from the arguments alone', async () => {
    const h = rig();

    const filled = await h.run({ field: 'full name', submit: false });
    expect(filled.ok).toBe(true);
    expect(h.seen).toHaveLength(0);

    const submitted = await h.run({ field: 'full name', submit: true });
    expect(submitted.ok).toBe(true);
    expect(h.seen).toHaveLength(1);
  });

  it('does not let an approved fill authorise the submit that follows it', async () => {
    // "Fill everything you can, but don't submit." The fill is approved by
    // being SAFE; the submit is a separate act and is asked about separately.
    const h = rig({ decide: () => 'DENY' });

    await h.run({ field: 'full name', submit: false });
    await h.run({ field: 'email', submit: false });
    const submit = await h.run({ field: 'email', submit: true });

    expect(submit.ok).toBe(false);
    if (!submit.ok) expect(submit.failure.kind).toBe('DENIED');
    // Two fills happened. Nothing was submitted.
    expect(h.performed.filter((entry) => entry.submit)).toHaveLength(0);
    expect(h.performed).toHaveLength(2);
  });

  it('cannot have a second act smuggled into an approved one', async () => {
    // The fingerprint is over (tool, normalized arguments). Approving a fill
    // of "email" authorises exactly that — not a submit, not another field.
    const h = rig();
    await h.run({ field: 'email', submit: true });

    const request = h.seen[0];
    expect(request).toBeDefined();
    if (!request) return;

    // What the user was shown names the act, and the binding pins it.
    expect(request.binding.tool).toBe('form.fill');
    expect(request.binding.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // A different act has a different fingerprint, so the approval cannot
    // travel to it.
    const second = h.run({ field: 'phone', submit: true });
    await vi.waitFor(() => expect(h.seen.length).toBe(2));
    expect(h.seen[1]?.binding.fingerprint).not.toBe(request.binding.fingerprint);
    await second;
  });

  it('shows the user the field that is actually about to be sent', async () => {
    const h = rig();
    await h.run({ field: 'national insurance number', submit: true });
    expect(JSON.stringify(h.seen[0]?.parameters)).toContain('national insurance number');
  });

  it('refuses to repeat a consequential act inside one task', async () => {
    // The duplicate guard, which is the reason a retried submit does not post
    // twice. Same tool, same arguments, same turn.
    const h = rig();
    const first = await h.run({ field: 'email', submit: true });
    expect(first.ok).toBe(true);

    const second = await h.run({ field: 'email', submit: true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.kind).toBe('DUPLICATE_SIDE_EFFECT');
    expect(h.performed.filter((entry) => entry.submit)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The provider retrying must not run anything twice
// ---------------------------------------------------------------------------

describe('a repeated tool call is answered, not re-run', () => {
  const schema: ToolSchema = {
    name: 'form.fill',
    title: 'Fill a form field',
    description: 'Fills a field.',
    inputSchema: { type: 'object' },
  };

  function bridge() {
    const dispatched: unknown[] = [];
    const tasks = new TaskLedger();
    tasks.begin('fill in my application', 'voice');

    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'axon-call',
      willRequireApproval: () => false,
      onDeferredOutcome: () => {},
      onNotice: () => {},
      onLateResult: () => {},
      tasks,
      dispatch: (call) => {
        dispatched.push(call.input);
        return Promise.resolve({
          callId: call.callId,
          tool: call.tool,
          ok: true,
          output: { submitted: true },
          durationMs: 1,
        });
      },
    });

    return { instance, dispatched, tasks };
  }

  it('runs the same provider call id exactly once', async () => {
    // THE RETRY CASE. A provider that repeats a `tool.call` — a reconnect, a
    // lost result, a model emitting the same id again — must not cause a
    // second submission. Answering from the record is both safer and more
    // truthful: it succeeded once, and that is what gets reported.
    const h = bridge();

    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email', submit: true });
    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email', submit: true });
    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email', submit: true });

    expect(h.dispatched).toHaveLength(1);
  });

  it('gives the retry the same answer, not an error', async () => {
    // Re-dispatching would hit the duplicate guard and come back as a FAILURE
    // — so a retry would turn a successful submission into "that did not
    // work", which is exactly the wrong thing to tell someone.
    const h = bridge();

    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email', submit: true });
    const first = h.instance.flush('completed');
    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email', submit: true });
    const second = h.instance.flush('completed');

    expect(second[0]?.result).toBe(first[0]?.result);
    expect(JSON.parse(second[0]!.result)).toMatchObject({ ok: true });
  });

  it('does not spend the task’s step budget on a retry', async () => {
    const h = bridge();
    const task = h.tasks.activeTaskId!;

    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email' });
    const after = h.tasks.stepsOf(task);
    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email' });

    expect(h.tasks.stepsOf(task)).toBe(after);
  });

  it('treats a different call id as a different request', async () => {
    // The control case: duplicate protection keyed on the id must not swallow
    // a genuinely new request that happens to look similar.
    const h = bridge();
    await h.instance.handleToolCall('provider-1', 'form.fill', { field: 'email' });
    await h.instance.handleToolCall('provider-2', 'form.fill', { field: 'phone' });
    expect(h.dispatched).toHaveLength(2);
  });

  it('answers a retry of work still running without starting it again', async () => {
    const tasks = new TaskLedger();
    tasks.begin('fill in my application', 'voice');
    const dispatched: unknown[] = [];

    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'axon-call',
      willRequireApproval: () => false,
      onDeferredOutcome: () => {},
      onNotice: () => {},
      onLateResult: () => {},
      tasks,
      inlineBudgetMs: 5,
      dispatch: (call) => {
        dispatched.push(call.input);
        return new Promise<ToolResult>(() => {});
      },
    });

    const first = instance.handleToolCall('provider-1', 'form.fill', { field: 'email' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.handleToolCall('provider-1', 'form.fill', { field: 'email' });

    expect(dispatched).toHaveLength(1);
    const answers = instance.flush('completed').map((entry) => JSON.parse(entry.result) as { status?: string });
    expect(answers.every((answer) => answer.status === 'in_progress')).toBe(true);
    void first;
  });
});

// ---------------------------------------------------------------------------
// There is no queue, and that is the point
// ---------------------------------------------------------------------------

describe('Axon holds no plan it could execute', () => {
  it('has no method that runs a sequence of approved actions', () => {
    // Asserted about the SOURCE, because the guarantee is structural. A queue
    // of approved future actions is the shape that lets one approval authorise
    // a second act, and the way to be sure there is not one is for there to be
    // no code that could hold it.
    const ledger = new TaskLedger();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger));

    for (const forbidden of ['run', 'execute', 'dispatch', 'enqueue', 'perform', 'approve', 'allow']) {
      expect(surface, `TaskLedger must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('grants nothing: a step handle is an id, not a permission', () => {
    const ledger = new TaskLedger();
    ledger.begin('do the thing', 'voice');
    const step = ledger.beginStep('form.fill');

    expect(step).not.toBeNull();
    if (!step) return;
    // Three strings. Nothing callable, nothing that resolves to an executor,
    // nothing a holder could act with.
    expect(Object.keys(step).sort()).toEqual(['stepId', 'taskId', 'tool']);
    expect(Object.values(step).every((value) => typeof value === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the agent is told about doing several things
// ---------------------------------------------------------------------------

describe('the agent is told to do one step at a time', () => {
  const prompt = buildAgentSystemPrompt({
    tools: [{ name: 'form.fill', title: 'Fill a field', description: 'Fills.', inputSchema: {} }],
    platform: 'win32',
    workspaceRoot: 'C:/Axon/workspace',
  });

  it('says an approval covers one action only', () => {
    expect(prompt).toMatch(/approval for one\s+action is approval for that action only/i);
    expect(prompt).toMatch(/never bundle a second act into an approved one/i);
  });

  it('says to do what was asked and nothing adjacent', () => {
    expect(prompt).toMatch(/do not submit/i);
    expect(prompt).toMatch(/nothing\s+adjacent/i);
  });

  it('says to verify a step before building on it', () => {
    expect(prompt).toMatch(/check each step actually worked/i);
  });

  it('teaches what in_progress means, because nothing else can', () => {
    expect(prompt).toMatch(/"status": "in_progress"/);
    expect(prompt).toMatch(/do not say it worked\. do not say it failed\./i);
    // AXON SUPPLIES THE WORDS for the acknowledgement, so it says something
    // true about what is happening rather than being a noise the agent
    // invents. The prompt has to point at the field carrying them.
    expect(prompt).toMatch(/"doing"/);
    expect(prompt).toMatch(/Opening YouTube/);
    expect(prompt).toMatch(/Say exactly/i);
  });

  it('teaches how to use the grounding for a reference', () => {
    // "Search for AssemblyAI" after opening YouTube means search THERE, and
    // the model knows what was said but not what Axon SAW.
    expect(prompt).toMatch(/Where things stand/);
    expect(prompt).toMatch(/facts Axon observed/i);
    expect(prompt).toMatch(/could be two different things, ask instead/i);
  });

  it('asks for the shortest question that can be asked', () => {
    expect(prompt).toMatch(/"Which one\?"/);
    expect(prompt).toMatch(/Never read the mechanism out loud/i);
  });

  it('teaches that asking beats guessing', () => {
    expect(prompt).toMatch(/"needsClarification": true/);
    expect(prompt).toMatch(/ask rather than guess/i);
    expect(prompt).toMatch(/never invent a consequential intention/i);
  });

  it('does not turn "ask rather than guess" into refusing things Axon can do', () => {
    // A live test caught this exact over-correction: told to be careful about
    // applications it does not have, the model refused "open GitHub" and
    // recited the five installed programs it could open — while holding a
    // browser. A refusal for something Axon CAN do is as wrong as a claim
    // about something it cannot.
    expect(prompt).toMatch(/a WEBSITE IS NOT AN\s+APPLICATION/i);
    expect(prompt).toMatch(/you open them with the browser, not with app\.open/i);
    expect(prompt).toMatch(/do not refuse something you can actually do/i);
    // And the named-browser case from the spec: Axon has its own.
    expect(prompt).toMatch(/if the user names a different browser, say you\s+have your own/i);
  });

  it('teaches that "stop" has already happened', () => {
    expect(prompt).toMatch(/say "Stopped\." and nothing else/i);
    expect(prompt).toMatch(/do not\s+finish the thing you were part-way through/i);
  });
});
