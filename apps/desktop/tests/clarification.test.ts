/**
 * ASK, DO NOT GUESS.
 *
 * WHY THIS NEEDED A TYPE RATHER THAN BETTER WORDING.
 *
 * "There are two Notepad windows open" and "Notepad could not be opened" used
 * to reach the model identically: both were `EXECUTION_ERROR` with a sentence
 * attached. A model that cannot tell those apart apologises for a failure when
 * the correct response is a question — and "I could not do that" for something
 * Axon could easily have done, if only it knew which one, is the difference
 * between an assistant and an obstacle.
 *
 * So ambiguity has its own failure kind. It travels from the executor that
 * refused, through the dispatcher, into the tool result, and out to the
 * instruction the agent reads before it speaks. These tests walk that whole
 * path, because a distinction that is lost at any point in it is a distinction
 * that does not exist.
 *
 * The other half of "ask, do not guess" is refusing to invent. An application
 * Axon does not have is not the nearest application it does have; "send this"
 * with no recipient is not a guess at a recipient. Those are asserted here
 * too, at the schema, where they are structural rather than advisory.
 */

import { describe, expect, it } from 'vitest';
import {
  ClarificationRequired,
  defineTool,
  isClarificationRequired,
  type JsonObject,
  type RiskAssessment,
  type ToolSummary,
} from '@axon/core';
import { z } from 'zod';
import { EventBus } from '../src/main/bus/event-bus.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { Policy } from '../src/main/safety/policy.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { toAgentResult } from '../src/main/agent/tool-bridge.js';
import { serializeToolResult } from '../src/main/brain/tool-result-view.js';
import { APP_KEYS, listApps } from '../src/main/tools/executors/app-registry.js';
import { createAppOpenTool } from '../src/main/tools/executors/app-open.js';
import type { AxonEvent } from '@axon/core';

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

/** A tool that cannot tell which of two things the user meant. */
function ambiguousTool(name: string, question: string) {
  return defineTool<Record<string, never>, JsonObject>({
    name,
    title: 'An ambiguous thing',
    description: 'Cannot tell which one you meant.',
    inputSchema: z.object({}),
    resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'Reading only.' }),
    summarize: (): ToolSummary => ({ title: 'Axon wants to do a thing', parameters: [] }),
    execute: () => {
      throw new ClarificationRequired(question);
    },
  });
}

/** A tool that genuinely failed, for contrast. */
function brokenTool(name: string) {
  return defineTool<Record<string, never>, JsonObject>({
    name,
    title: 'A broken thing',
    description: 'Fails.',
    inputSchema: z.object({}),
    resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'Reading only.' }),
    summarize: (): ToolSummary => ({ title: 'Axon wants to do a thing', parameters: [] }),
    execute: () => {
      throw new Error('the thing is broken');
    },
  });
}

function harness() {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const registry = new ToolRegistry();
  registry.register(ambiguousTool('thing.ambiguous', 'There are two Notepad windows. Which one do you mean?'));
  registry.register(brokenTool('thing.broken'));

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
    run: (tool: string) => dispatcher.dispatch({ callId: newCallId(), tool, input: {} }),
  };
}

// ---------------------------------------------------------------------------
// The signal itself
// ---------------------------------------------------------------------------

describe('ambiguity is its own signal, not a failure', () => {
  it('is recognised structurally, not by identity', () => {
    // An executor and the dispatcher can hold different copies of the class —
    // two bundles, a re-export, a test double — and an `instanceof` that
    // silently failed would turn every clarification back into the generic
    // failure this type exists to escape.
    const error: unknown = new ClarificationRequired('Which one?');
    expect(isClarificationRequired(error)).toBe(true);
    expect(isClarificationRequired(new Error('Which one?'))).toBe(false);
    expect(isClarificationRequired(null)).toBe(false);
    expect(isClarificationRequired('Which one?')).toBe(false);

    // Even a look-alike from another realm.
    const foreign = new Error('Which one?');
    foreign.name = 'ClarificationRequired';
    expect(isClarificationRequired(foreign)).toBe(true);
  });

  it('reaches the dispatcher as CLARIFICATION_NEEDED', async () => {
    const h = harness();
    const result = await h.run('thing.ambiguous');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('CLARIFICATION_NEEDED');
    expect(result.failure.message).toMatch(/which one do you mean/i);
  });

  it('stays distinct from a real failure', async () => {
    const h = harness();
    const broken = await h.run('thing.broken');

    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.failure.kind).toBe('EXECUTION_ERROR');
  });

  it('carries no internal error shape into the result', async () => {
    // The message is a question meant to be read aloud. A stack, a cause and
    // an error's own fields add nothing to it and are dropped.
    const h = harness();
    const result = await h.run('thing.ambiguous');
    if (result.ok) return;
    expect(result.failure.detail).toBeNull();
  });

  it('is still a refusal: nothing ran', async () => {
    // The important half. Asking is not a softer kind of acting — the executor
    // that threw this DID NOT DO ANYTHING, and could not have.
    const h = harness();
    const result = await h.run('thing.ambiguous');
    expect(result.ok).toBe(false);
    expect(h.events.filter((event) => event.type === 'TOOL_RESULT' && event.ok)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What each consumer is told
// ---------------------------------------------------------------------------

describe('every consumer is told to ask rather than apologise', () => {
  it('tells the voice agent to ask the question and wait', async () => {
    const h = harness();
    const result = await h.run('thing.ambiguous');
    const encoded = JSON.parse(toAgentResult(result)) as {
      needsClarification?: boolean;
      instruction?: string;
      retryable: boolean;
      error: string;
    };

    expect(encoded.needsClarification).toBe(true);
    expect(encoded.instruction).toMatch(/do not apologise and do not say you failed/i);
    expect(encoded.error).toMatch(/which one do you mean/i);
  });

  it('does not mark it retryable, because the same call is equally ambiguous', async () => {
    // The ambiguity is in the REQUEST. Retrying the identical call would be
    // exactly as ambiguous, and marking it retryable would invite the model to
    // try again with the same words.
    const h = harness();
    const result = await h.run('thing.ambiguous');
    expect((JSON.parse(toAgentResult(result)) as { retryable: boolean }).retryable).toBe(false);
  });

  it('tells the typed brain the same thing', async () => {
    // Two consumers, one meaning. A distinction that survived to the voice
    // agent and was lost on the way to the brain would be half a fix.
    const h = harness();
    const result = await h.run('thing.ambiguous');
    const view = JSON.stringify(serializeToolResult(result));

    expect(view).toMatch(/ask the user this question/i);
    expect(view).toMatch(/do not guess/i);
    expect(view).toMatch(/do not report this as a failure/i);
  });

  it('gives an ordinary failure no such instruction', async () => {
    const h = harness();
    const result = await h.run('thing.broken');
    const encoded = JSON.parse(toAgentResult(result)) as { needsClarification?: boolean };
    expect(encoded.needsClarification).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Refusing to invent
// ---------------------------------------------------------------------------

describe('an application Axon does not have is not the nearest one it does', () => {
  it('cannot express "Chrome" at all', () => {
    // Structural rather than advisory. The input is an enum indexing a
    // constant table, so "open Chrome" cannot be answered by opening
    // something similar — there is no value that would carry it.
    for (const invented of ['chrome', 'Chrome', 'edge', 'firefox', 'dia', 'chrome.exe']) {
      expect(APP_KEYS as readonly string[], invented).not.toContain(invented);
    }
  });

  it('publishes the complete list, so the model can say what IS available', () => {
    // The other half of not guessing: a refusal that names the alternative is
    // useful, and one that does not is a dead end.
    const keys = listApps().map((entry) => entry.key);
    expect(keys).toEqual([...APP_KEYS]);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('says in the tool description not to open something similar', () => {
    // The description is what the model reads before it decides. Saying the
    // list is exhaustive is not enough on its own — a helpful model will
    // reach for the closest match unless it is told not to.
    const tool = createAppOpenTool({
      launchExecutable: () => Promise.resolve({ pid: 1 }),
      openUri: () => Promise.resolve(),
    });

    expect(tool.description).toMatch(/nothing here will open something merely similar/i);
    expect(tool.description).toMatch(/this is the complete list/i);
    // AND says where a website goes instead. A live test caught the cost of
    // omitting that: told only that the list was exhaustive, the model refused
    // "open GitHub" outright — naming the five installed programs it could
    // open — rather than reaching for the browser it also has. A refusal for
    // something Axon can do is as wrong as a claim about something it cannot.
    expect(tool.description).toMatch(/a website .* is not an\s+application and is opened with the browser/i);
    // And it names what IS available, so the refusal can be useful.
    for (const entry of listApps()) expect(tool.description).toContain(entry.label);
  });

  it('will not claim an application opened without checking', () => {
    const tool = createAppOpenTool({
      launchExecutable: () => Promise.resolve({ pid: 1 }),
      openUri: () => Promise.resolve(),
    });
    expect(tool.description).toMatch(/only say the application is open when that says so/i);
  });
});
