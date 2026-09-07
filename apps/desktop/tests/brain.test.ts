/**
 * Agent loop tests.
 *
 * The loop is exercised against a *scripted* model client: a queue of
 * pre-built Anthropic `Message` objects, handed out one per iteration. No
 * network, no API key, no SDK beta surface — which means every branch that
 * matters (a denied tool, an unknown tool, malformed arguments, several tools
 * in sequence, an API failure) is reachable deterministically rather than
 * "usually, if the model cooperates".
 *
 * The dispatcher, policy, approval broker, registry and event bus are all the
 * real ones. Only the model and the tools themselves are fakes, and the tools
 * only so a test can force a branch a real tool would not.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import {
  defineTool,
  type AxonEvent,
  type Memory,
  type RiskAssessment,
  type ToolSchema,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Dispatcher, type StateController } from '../src/main/safety/dispatcher';
import { ApprovalBroker } from '../src/main/safety/approval-broker';
import { Policy } from '../src/main/safety/policy';
import { ToolRegistry } from '../src/main/tools/registry';
import { toToolSchemas } from '../src/main/tools/schema-view';
import { ClaudeBrain, toAnthropicTools } from '../src/main/brain/claude-brain';
import { ConversationMemory } from '../src/main/brain/conversation-memory';
import { ModelError, type ModelClient, type ModelTurnRequest } from '../src/main/brain/model-client';
import { toModelToolResult } from '../src/main/brain/tool-result-view';
import { buildSystemPrompt } from '../src/main/brain/system-prompt';

// --- scripted model --------------------------------------------------------

let blockId = 0;

function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null } as Anthropic.TextBlock;
}

function toolBlock(name: string, input: unknown, id = `tu-${++blockId}`): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock;
}

function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: `msg-${++blockId}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

interface ScriptedClient extends ModelClient {
  readonly requests: ModelTurnRequest[];
}

/** Hands out one scripted reply per call; throws if the script runs dry. */
function scriptedClient(script: readonly (Anthropic.Message | Error)[]): ScriptedClient {
  const queue = [...script];
  const requests: ModelTurnRequest[] = [];

  return {
    model: 'test-model',
    requests,
    createTurn(request: ModelTurnRequest): Promise<Anthropic.Message> {
      // Snapshot the messages: the loop mutates its array in place, so keeping
      // the reference would make every recorded request look identical.
      requests.push({ ...request, messages: [...request.messages] });
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted — the loop asked for more turns than expected');
      if (next instanceof Error) throw next;
      return Promise.resolve(next);
    },
  };
}

// --- harness ---------------------------------------------------------------

interface Harness {
  readonly brain: ClaudeBrain;
  readonly bus: EventBus;
  readonly events: AxonEvent[];
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly dispatcher: Dispatcher;
  readonly client: ScriptedClient;
  readonly memory: Memory;
  readonly executed: string[];
  run(utterance: string, signal?: AbortSignal): Promise<{ reply: string | null }>;
  /** Same as `run`, but under a caller-chosen session id. */
  runAs(sessionId: string, utterance: string): Promise<{ reply: string | null }>;
  tools(): readonly ToolSchema[];
}

const noopController: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

interface HarnessOptions {
  readonly script: readonly (Anthropic.Message | Error)[];
  readonly approvalTimeoutMs?: number;
  readonly memory?: Memory;
}

function harness(options: HarnessOptions): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const executed: string[] = [];
  const registry = new ToolRegistry();

  // Safe: runs immediately.
  registry.register(
    defineTool<{ app: string }, { opened: string }>({
      name: 'app.open',
      title: 'Open an application',
      description: 'Open a permitted app.',
      inputSchema: z.object({ app: z.enum(['notepad', 'calculator']) }),
      resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'allowlisted app' }),
      summarize: (input) => ({ title: `Open ${input.app}`, parameters: [] }),
      execute: (input) => {
        executed.push(`app.open:${input.app}`);
        return Promise.resolve({ opened: input.app });
      },
    }),
  );

  // Requires approval: the human gate.
  registry.register(
    defineTool<{ path: string; content: string }, { path: string }>({
      name: 'fs.write',
      title: 'Write a file',
      description: 'Write text to a file.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      resolveRisk: (): RiskAssessment => ({ level: 'REQUIRES_APPROVAL', reason: 'outside the workspace' }),
      summarize: (input) => ({
        title: 'Axon wants to write a file',
        parameters: [{ label: 'Path', value: input.path }],
      }),
      execute: (input) => {
        executed.push(`fs.write:${input.path}`);
        return Promise.resolve({ path: input.path });
      },
    }),
  );

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus,
    states: noopController,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 50_000,
  });

  const client = scriptedClient(options.script);
  const memory = options.memory ?? new ConversationMemory();

  let callSeq = 0;
  const brain = new ClaudeBrain({
    client,
    memory,
    workspaceRoot: 'C:/Users/test/Axon/workspace',
    platform: 'win32',
    newCallId: () => `call-${++callSeq}`,
  });

  const tools = (): readonly ToolSchema[] => toToolSchemas(registry.list());

  return {
    brain,
    bus,
    events,
    registry,
    approvals,
    dispatcher,
    client,
    memory,
    executed,
    tools,
    run: (utterance, signal) =>
      brain.run(
        {
          sessionId: bus.sessionId,
          utterance,
          tools: tools(),
          signal: signal ?? new AbortController().signal,
          emit: (event) => bus.emit(event),
        },
        (call) => dispatcher.dispatch(call),
      ),

    runAs: (sessionId, utterance) =>
      brain.run(
        {
          sessionId,
          utterance,
          tools: tools(),
          signal: new AbortController().signal,
          emit: (event) => bus.emit(event),
        },
        (call) => dispatcher.dispatch(call),
      ),
  };
}

const typesOf = (events: readonly AxonEvent[]): string[] => events.map((event) => event.type);

/** Settle the pending approval once the dispatcher has raised it. */
async function answerApproval(h: Harness, decision: 'ALLOW' | 'DENY'): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = h.approvals.list()[0];
    if (pending) {
      h.approvals.settle(pending.callId, decision, 'user');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('no approval was ever requested');
}

// ---------------------------------------------------------------------------

describe('brain initialization', () => {
  it('names itself after the model it is driving', () => {
    const h = harness({ script: [message([textBlock('hi')])] });
    expect(h.brain.name).toBe('claude(test-model)');
  });
});

describe('the tool surface handed to the model', () => {
  it('is code-free — schemas only, no executors', () => {
    const h = harness({ script: [message([textBlock('hi')])] });
    const definitions = toAnthropicTools(h.tools());

    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(definition.input_schema).toBeTypeOf('object');
      // Nothing on a model-facing tool may be invocable.
      for (const value of Object.values(definition)) {
        expect(typeof value).not.toBe('function');
      }
      expect(JSON.stringify(definition)).not.toContain('execute');
    }
  });

  it('reaches the model as the tools argument on every request', async () => {
    const h = harness({ script: [message([textBlock('done')])] });
    await h.run('hello');

    const names = h.client.requests[0]?.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['app.open', 'fs.write']);
  });

  it('never leaks an executor through the system prompt', () => {
    const h = harness({ script: [message([textBlock('hi')])] });
    const prompt = buildSystemPrompt({
      tools: h.tools(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
    });
    expect(prompt).toContain('app.open');
    expect(prompt).not.toContain('function');
    expect(prompt).not.toContain('=>');
  });
});

describe('a turn with no tools', () => {
  it('returns the reply and announces it', async () => {
    const h = harness({ script: [message([textBlock('Hello there.')])] });

    const result = await h.run('hi');

    expect(result.reply).toBe('Hello there.');
    expect(typesOf(h.events)).toEqual(['THINKING', 'ASSISTANT_MESSAGE']);
  });

  it('records both sides of the exchange in memory', async () => {
    const h = harness({ script: [message([textBlock('Hello there.')])] });
    await h.run('hi');

    const records = await h.memory.recent({ sessionId: h.bus.sessionId });
    expect(records.map((record) => [record.kind, record.text])).toEqual([
      ['utterance', 'hi'],
      ['reply', 'Hello there.'],
    ]);
  });

  it('replays earlier turns as context on the next one', async () => {
    // One shared memory and one shared session id: two turns of the same
    // conversation, which is what makes the replay meaningful.
    const memory = new ConversationMemory();
    const sessionId = 'shared-session';

    const first = harness({ script: [message([textBlock('Opened it.')])], memory });
    await first.runAs(sessionId, 'open notepad');

    const second = harness({ script: [message([textBlock('It is Notepad.')])], memory });
    await second.runAs(sessionId, 'what did you open?');

    const sent = second.client.requests[0]?.messages ?? [];
    expect(sent.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[0]?.content).toBe('open notepad');
    expect(sent[1]?.content).toBe('Opened it.');
    expect(sent[2]?.content).toBe('what did you open?');
  });
});

describe('a successful tool call', () => {
  it('dispatches it, executes it, and feeds the result back', async () => {
    const h = harness({
      script: [
        message([textBlock('Opening Notepad.'), toolBlock('app.open', { app: 'notepad' })], 'tool_use'),
        message([textBlock('Notepad is open.')]),
      ],
    });

    const result = await h.run('open notepad');

    expect(h.executed).toEqual(['app.open:notepad']);
    expect(result.reply).toBe('Notepad is open.');
    expect(typesOf(h.events)).toEqual([
      'THINKING',
      'PLANNING',
      'TOOL_CALL',
      'TOOL_RESULT',
      'ASSISTANT_MESSAGE',
    ]);
  });

  it('sends the result back as a tool_result in a single user message', async () => {
    const h = harness({
      script: [
        message([toolBlock('app.open', { app: 'notepad' })], 'tool_use'),
        message([textBlock('Done.')]),
      ],
    });
    await h.run('open notepad');

    const second = h.client.requests[1]?.messages ?? [];
    const last = second[second.length - 1];
    expect(last?.role).toBe('user');

    const blocks = last?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('tool_result');
    expect(blocks[0]?.is_error).toBe(false);
    expect(JSON.parse(String(blocks[0]?.content))).toMatchObject({ success: true });
  });

  it('echoes the assistant turn back verbatim so thinking blocks survive', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' } as Anthropic.ContentBlock;
    const assistant = [thinking, toolBlock('app.open', { app: 'notepad' })];

    const h = harness({
      script: [message(assistant, 'tool_use'), message([textBlock('Done.')])],
    });
    await h.run('open notepad');

    const second = h.client.requests[1]?.messages ?? [];
    // Identity, not equality: the loop must not rebuild the message.
    expect(second[1]?.content).toBe(assistant);
  });

  it('returns two tool results in one message when the model asks for two tools', async () => {
    const h = harness({
      script: [
        message(
          [toolBlock('app.open', { app: 'notepad' }), toolBlock('app.open', { app: 'calculator' })],
          'tool_use',
        ),
        message([textBlock('Both open.')]),
      ],
    });

    await h.run('open both');

    expect(h.executed).toEqual(['app.open:notepad', 'app.open:calculator']);
    const second = h.client.requests[1]?.messages ?? [];
    expect((second[second.length - 1]?.content as unknown[]).length).toBe(2);
  });
});

describe('sequential tool calls', () => {
  it('runs several tools across several iterations of one turn', async () => {
    const h = harness({
      script: [
        message([toolBlock('app.open', { app: 'notepad' })], 'tool_use'),
        message([toolBlock('fs.write', { path: 'C:/note.txt', content: 'hi' })], 'tool_use'),
        message([textBlock('Opened Notepad and wrote the file.')]),
      ],
    });

    const run = h.run('open notepad then write a file');
    await answerApproval(h, 'ALLOW');
    const result = await run;

    expect(h.executed).toEqual(['app.open:notepad', 'fs.write:C:/note.txt']);
    expect(result.reply).toBe('Opened Notepad and wrote the file.');
    expect(h.client.requests).toHaveLength(3);
  });
});

describe('approval', () => {
  it('runs the tool when the user allows it', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' })], 'tool_use'),
        message([textBlock('Written.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'ALLOW');
    await run;

    expect(h.executed).toEqual(['fs.write:C:/x.txt']);
    expect(typesOf(h.events)).toContain('APPROVAL_REQUIRED');
    expect(typesOf(h.events)).toContain('APPROVAL_RESOLVED');
  });

  it('does not execute the tool when the user denies it', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' })], 'tool_use'),
        message([textBlock('I did not write the file — you declined.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'DENY');
    const result = await run;

    expect(h.executed).toEqual([]);
    expect(result.reply).toBe('I did not write the file — you declined.');
  });

  it('returns a structured failure to the model rather than ending the turn', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' })], 'tool_use'),
        message([textBlock('Understood.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'DENY');
    await run;

    // The turn continued: the model got a second request.
    expect(h.client.requests).toHaveLength(2);

    const second = h.client.requests[1]?.messages ?? [];
    const blocks = second[second.length - 1]?.content as Anthropic.ToolResultBlockParam[];
    const body = JSON.parse(String(blocks[0]?.content)) as Record<string, unknown>;

    expect(blocks[0]?.is_error).toBe(true);
    expect(body).toMatchObject({ success: false, errorKind: 'DENIED', retryable: false });
    expect(String(body.error)).toContain('denied');
  });

  it('denies by default when the approval is never answered', async () => {
    const h = harness({
      approvalTimeoutMs: 10,
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' })], 'tool_use'),
        message([textBlock('That timed out.')]),
      ],
    });

    await h.run('write a file');

    expect(h.executed).toEqual([]);
    const second = h.client.requests[1]?.messages ?? [];
    const blocks = second[second.length - 1]?.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.parse(String(blocks[0]?.content))).toMatchObject({
      errorKind: 'APPROVAL_TIMEOUT',
      retryable: false,
    });
  });

  it('suppresses an identical retry of a denied call without re-prompting', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' }, 'tu-a')], 'tool_use'),
        // The model tries the exact same thing again.
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' }, 'tu-b')], 'tool_use'),
        message([textBlock('I will stop asking.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'DENY');
    await run;

    // Exactly one approval was ever raised, and the second attempt never
    // reached the dispatcher at all.
    expect(typesOf(h.events).filter((type) => type === 'APPROVAL_REQUIRED')).toHaveLength(1);
    expect(typesOf(h.events).filter((type) => type === 'TOOL_CALL')).toHaveLength(1);

    const third = h.client.requests[2]?.messages ?? [];
    const blocks = third[third.length - 1]?.content as Anthropic.ToolResultBlockParam[];
    expect(String(blocks[0]?.content)).toContain('already made this exact request');
  });

  it('treats a reordered but identical argument object as the same call', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' }, 'tu-a')], 'tool_use'),
        message([toolBlock('fs.write', { content: 'hi', path: 'C:/x.txt' }, 'tu-b')], 'tool_use'),
        message([textBlock('Stopping.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'DENY');
    await run;

    expect(typesOf(h.events).filter((type) => type === 'APPROVAL_REQUIRED')).toHaveLength(1);
  });

  it('still allows a genuinely different call after a denial', async () => {
    const h = harness({
      script: [
        message([toolBlock('fs.write', { path: 'C:/x.txt', content: 'hi' }, 'tu-a')], 'tool_use'),
        // Different path — a real change of approach, not a repeat.
        message([toolBlock('fs.write', { path: 'C:/y.txt', content: 'hi' }, 'tu-b')], 'tool_use'),
        message([textBlock('Wrote it elsewhere.')]),
      ],
    });

    const run = h.run('write a file');
    await answerApproval(h, 'DENY');
    await answerApproval(h, 'ALLOW');
    await run;

    expect(h.executed).toEqual(['fs.write:C:/y.txt']);
    expect(typesOf(h.events).filter((type) => type === 'APPROVAL_REQUIRED')).toHaveLength(2);
  });
});

describe('bad tool calls from the model', () => {
  it('reports an unknown tool without ending the turn', async () => {
    const h = harness({
      script: [
        message([toolBlock('shell.run', { cmd: 'rm -rf /' })], 'tool_use'),
        message([textBlock('I cannot do that.')]),
      ],
    });

    const result = await h.run('delete everything');

    expect(h.executed).toEqual([]);
    expect(result.reply).toBe('I cannot do that.');

    const second = h.client.requests[1]?.messages ?? [];
    const blocks = second[second.length - 1]?.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.parse(String(blocks[0]?.content))).toMatchObject({
      success: false,
      errorKind: 'UNKNOWN_TOOL',
      retryable: false,
    });
  });

  it('reports malformed arguments so the model can correct them', async () => {
    const h = harness({
      script: [
        // `app` is not in the enum.
        message([toolBlock('app.open', { app: 'chrome' })], 'tool_use'),
        message([textBlock('That app is not available.')]),
      ],
    });

    await h.run('open chrome');

    expect(h.executed).toEqual([]);
    const second = h.client.requests[1]?.messages ?? [];
    const blocks = second[second.length - 1]?.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.parse(String(blocks[0]?.content))).toMatchObject({ errorKind: 'INVALID_INPUT' });
  });

  it('survives a tool call with no input at all', async () => {
    const h = harness({
      script: [
        message([toolBlock('app.open', undefined)], 'tool_use'),
        message([textBlock('I need to know which app.')]),
      ],
    });

    const result = await h.run('open something');
    expect(result.reply).toBe('I need to know which app.');
  });
});

describe('loop bounds', () => {
  it('stops after the iteration cap rather than looping forever', async () => {
    // A model that only ever asks for another tool.
    const script = Array.from({ length: 40 }, () =>
      message([toolBlock('app.open', { app: 'notepad' })], 'tool_use'),
    );
    const h = harness({ script });

    const result = await h.run('loop forever');

    expect(h.client.requests.length).toBeLessThanOrEqual(12);
    expect(result.reply).toContain('too many steps');
  });
});

describe('model failures', () => {
  it('propagates an authentication failure as a ModelError', async () => {
    const h = harness({ script: [new ModelError('AUTH', 'bad key')] });
    await expect(h.run('hello')).rejects.toBeInstanceOf(ModelError);
  });

  it('propagates a rate limit as a ModelError', async () => {
    const h = harness({ script: [new ModelError('RATE_LIMIT', 'slow down', { retryable: true })] });
    await expect(h.run('hello')).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
  });

  it('flags a truncated reply instead of presenting it as complete', async () => {
    const h = harness({ script: [message([textBlock('It was a dark and')], 'max_tokens')] });
    const result = await h.run('tell me a story');
    expect(result.reply).toContain('cut short');
  });

  it('says something when the model refuses', async () => {
    const h = harness({ script: [message([], 'refusal')] });
    const result = await h.run('something disallowed');
    expect(result.reply).toBe('I am not able to help with that.');
  });
});

describe('cancellation', () => {
  it('stops before calling the model when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ script: [message([textBlock('should not be reached')])] });

    await h.run('hello', controller.signal);

    expect(h.client.requests).toHaveLength(0);
  });

  it('passes the signal through to the model client', async () => {
    const controller = new AbortController();
    const h = harness({ script: [message([textBlock('ok')])] });

    await h.run('hello', controller.signal);

    expect(h.client.requests[0]?.signal).toBe(controller.signal);
  });
});

describe('the brain cannot forge tool events', () => {
  it('only ever emits narration types', async () => {
    const h = harness({
      script: [
        message([textBlock('Opening.'), toolBlock('app.open', { app: 'notepad' })], 'tool_use'),
        message([textBlock('Done.')]),
      ],
    });

    const emitted: string[] = [];
    await h.brain.run(
      {
        sessionId: h.bus.sessionId,
        utterance: 'open notepad',
        tools: h.tools(),
        signal: new AbortController().signal,
        emit: (event) => {
          emitted.push(event.type);
        },
      },
      (call) => h.dispatcher.dispatch(call),
    );

    // TOOL_CALL and TOOL_RESULT appear on the bus (the dispatcher emitted
    // them) but never through the brain's own emitter.
    expect(new Set(emitted)).toEqual(new Set(['THINKING', 'PLANNING', 'ASSISTANT_MESSAGE']));
  });
});

describe('tool result translation', () => {
  it.each([
    ['DENIED', false],
    ['APPROVAL_TIMEOUT', false],
    ['FORBIDDEN', false],
    ['UNKNOWN_TOOL', false],
    ['INVALID_INPUT', false],
    ['CANCELLED', false],
    ['EXECUTION_ERROR', true],
  ] as const)('marks %s retryable=%s', (kind, retryable) => {
    const body = toModelToolResult({
      callId: 'c',
      tool: 't',
      ok: false,
      durationMs: 1,
      failure: { kind, message: 'because', detail: null },
    });
    expect(body).toMatchObject({ success: false, errorKind: kind, retryable });
  });
});

describe('conversation memory', () => {
  it('keeps sessions apart', async () => {
    const memory = new ConversationMemory();
    await memory.append({ sessionId: 'a', at: 'now', kind: 'utterance', text: 'one', detail: null });
    await memory.append({ sessionId: 'b', at: 'now', kind: 'utterance', text: 'two', detail: null });

    expect((await memory.recent({ sessionId: 'a' })).map((r) => r.text)).toEqual(['one']);
    expect((await memory.recent({ sessionId: 'b' })).map((r) => r.text)).toEqual(['two']);
  });

  it('returns the newest records in the order they happened', async () => {
    const memory = new ConversationMemory();
    for (const text of ['1', '2', '3', '4']) {
      await memory.append({ sessionId: 's', at: 'now', kind: 'utterance', text, detail: null });
    }
    expect((await memory.recent({ sessionId: 's', limit: 2 })).map((r) => r.text)).toEqual(['3', '4']);
  });

  it('evicts the oldest records past the cap', async () => {
    const memory = new ConversationMemory({ maxRecordsPerSession: 3 });
    for (const text of ['1', '2', '3', '4', '5']) {
      await memory.append({ sessionId: 's', at: 'now', kind: 'utterance', text, detail: null });
    }
    expect((await memory.recent({ sessionId: 's' })).map((r) => r.text)).toEqual(['3', '4', '5']);
  });

  it('clears one session without touching another', async () => {
    const memory = new ConversationMemory();
    await memory.append({ sessionId: 'a', at: 'now', kind: 'utterance', text: 'one', detail: null });
    await memory.append({ sessionId: 'b', at: 'now', kind: 'utterance', text: 'two', detail: null });
    await memory.clear('a');

    expect(await memory.recent({ sessionId: 'a' })).toEqual([]);
    expect((await memory.recent({ sessionId: 'b' })).map((r) => r.text)).toEqual(['two']);
  });

  it('never starts replayed history with an assistant turn', async () => {
    // A reply with no preceding utterance is possible after trimming; the API
    // rejects a message list that does not begin with a user turn.
    const memory = new ConversationMemory();
    await memory.append({ sessionId: 's', at: 'now', kind: 'reply', text: 'orphan', detail: null });

    const h = harness({ script: [message([textBlock('ok')])], memory });
    await h.runAs('s', 'hello');

    expect(h.client.requests[0]?.messages[0]?.role).toBe('user');
  });
});

describe('the loop does not depend on a real API key', () => {
  it('never reads the environment', async () => {
    const spy = vi.spyOn(process, 'env', 'get');
    const h = harness({ script: [message([textBlock('ok')])] });
    await h.run('hello');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
