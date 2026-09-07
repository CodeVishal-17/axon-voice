/**
 * The API key must not escape the main process.
 *
 * `architecture.test.ts` checks this statically — which files may name the
 * environment variable, which layers may import the SDK. This file checks it
 * dynamically: build a brain with a sentinel key, run a turn that fails,
 * succeeds and gets denied, then scan everything that crosses a boundary for
 * the sentinel.
 *
 * A static check catches the import; only a runtime check catches a key that
 * reaches the renderer inside an error message.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  serializeEvent,
  type AxonEvent,
  type Brain,
  type RiskAssessment,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { ToolRegistry } from '../src/main/tools/registry';
import { createBrain } from '../src/main/brain/create-brain';
import { ConversationMemory } from '../src/main/brain/conversation-memory';
import { describeModelError, redactSecrets, toBrainErrorDetail } from '../src/main/brain/brain-errors';
import { ModelError } from '../src/main/brain/model-client';

/** Distinctive enough that a substring search cannot produce a false negative. */
const SENTINEL = 'sk-ant-SENTINEL-DO-NOT-LEAK-3f9a2c';

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    defineTool<{ app: string }, { opened: string }>({
      name: 'app.open',
      title: 'Open an application',
      description: 'Open a permitted app.',
      inputSchema: z.object({ app: z.enum(['notepad']) }),
      resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'allowlisted' }),
      summarize: () => ({ title: 'Open Notepad', parameters: [] }),
      execute: (input) => Promise.resolve({ opened: input.app }),
    }),
  );
  return reg;
}

describe('createBrain', () => {
  it('builds a brain when a key is present', () => {
    const created = createBrain({
      apiKey: SENTINEL,
      model: 'claude-opus-5',
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });

    expect(created.brain).not.toBeNull();
    expect(created.unavailableReason).toBeNull();
    expect(created.brain?.name).toBe('claude(claude-opus-5)');
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('returns no brain and an actionable reason when the key is %s', (_label, apiKey) => {
    const created = createBrain({
      apiKey,
      model: undefined,
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });

    expect(created.brain).toBeNull();
    expect(created.unavailableReason).toContain('ANTHROPIC_API_KEY');
    // A missing key is a configuration state, not a crash.
    expect(created.model).toBe('claude-opus-5');
  });

  it('falls back to the default model when none is configured', () => {
    const created = createBrain({
      apiKey: SENTINEL,
      model: '  ',
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });
    expect(created.model).toBe('claude-opus-5');
  });

  it('never returns the key on the result object', () => {
    const created = createBrain({
      apiKey: SENTINEL,
      model: 'claude-opus-5',
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });

    // The brain is a live object holding a client; a shallow serialization
    // would miss a key stored deeper, so walk it.
    expect(deepFind(created, SENTINEL)).toBe(false);
  });
});

describe('the key never reaches the renderer', () => {
  it('is absent from BrainStatus', () => {
    const created = createBrain({
      apiKey: SENTINEL,
      model: 'claude-opus-5',
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });

    const orchestrator = new Orchestrator({
      bus: new EventBus(),
      registry: registry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
      brain: created.brain,
      brainUnavailableReason: created.unavailableReason,
    });

    expect(JSON.stringify(orchestrator.brainStatus())).not.toContain(SENTINEL);
    expect(JSON.stringify(orchestrator.brainStatus())).not.toContain('sk-ant');
  });

  it('is absent from the snapshot the renderer receives', () => {
    const created = createBrain({
      apiKey: SENTINEL,
      model: 'claude-opus-5',
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/ws',
      platform: 'win32',
      newCallId: () => 'call-1',
    });

    const orchestrator = new Orchestrator({
      bus: new EventBus(),
      registry: registry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
      brain: created.brain,
      brainUnavailableReason: created.unavailableReason,
    });

    // The snapshot is structured-cloned across IPC, so JSON is a fair proxy.
    expect(JSON.stringify(orchestrator.snapshot())).not.toContain(SENTINEL);
  });

  it('is absent from every event a failing turn produces', async () => {
    const bus = new EventBus();
    const events: AxonEvent[] = [];
    bus.subscribe((event) => events.push(event));

    // A brain that fails the way a bad key really would.
    const brain: Brain = {
      name: 'claude(test)',
      run: () => Promise.reject(new ModelError('AUTH', `Invalid key ${SENTINEL} rejected`)),
    };

    const orchestrator = new Orchestrator({
      bus,
      registry: registry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
      brain,
    });

    orchestrator.sendUserMessage('hello');
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'ERROR'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(events.some((event) => event.type === 'ERROR')).toBe(true);
    // Every event, exactly as it would be written to JSONL and pushed to the
    // renderer.
    for (const event of events) {
      expect(serializeEvent(event)).not.toContain(SENTINEL);
    }
  });

  it('is absent from the message shown for an auth failure', () => {
    const message = describeModelError(new ModelError('AUTH', `key ${SENTINEL} is invalid`));
    expect(message).not.toContain(SENTINEL);
    // It names the variable so the user knows what to fix.
    expect(message).toContain('ANTHROPIC_API_KEY');
  });
});

describe('error descriptions stay user-facing', () => {
  it.each([
    ['AUTH', 'ANTHROPIC_API_KEY'],
    ['RATE_LIMIT', 'rate limit'],
    ['NETWORK', 'network'],
    ['ABORTED', 'cancelled'],
  ] as const)('describes %s in plain language', (kind, expected) => {
    const message = describeModelError(new ModelError(kind, 'raw internal detail'));
    expect(message.toLowerCase()).toContain(expected.toLowerCase());
  });

  it('falls back to the raw message for an unclassified failure', () => {
    expect(describeModelError(new Error('something odd'))).toBe('something odd');
  });

  it('handles a non-Error being thrown', () => {
    expect(describeModelError('a string')).toBe('a string');
  });

  it('redacts a key that reached a pass-through message', () => {
    // BAD_REQUEST passes the provider's own text through. If that text ever
    // quotes the credential, this is what catches it.
    const message = describeModelError(new ModelError('BAD_REQUEST', `rejected key ${SENTINEL}`));
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('[redacted]');
  });

  it.each([
    ['x-api-key: sk-ant-abc123def456', 'sk-ant-abc123def456'],
    ['Authorization=Bearer sk-ant-zzz999yyy', 'sk-ant-zzz999yyy'],
  ])('redacts %s', (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
  });

  it('leaves an ordinary message untouched', () => {
    expect(redactSecrets('Could not reach Anthropic.')).toBe('Could not reach Anthropic.');
  });
});

describe('the detail on a brain ERROR event', () => {
  it('carries a classification, never the raw error', () => {
    const detail = toBrainErrorDetail(new ModelError('RATE_LIMIT', `secret ${SENTINEL}`, { retryable: true }));
    expect(detail).toEqual({ kind: 'RATE_LIMIT', status: null, retryable: true });
    expect(JSON.stringify(detail)).not.toContain(SENTINEL);
  });

  it('degrades safely for an unclassified throw', () => {
    expect(toBrainErrorDetail(new TypeError('boom'))).toEqual({ kind: 'UNKNOWN', name: 'TypeError' });
    expect(toBrainErrorDetail('a string')).toEqual({ kind: 'UNKNOWN', name: 'string' });
  });
});

/**
 * Walk an object graph looking for a string.
 *
 * `JSON.stringify` would miss a key held on a class instance behind a closure
 * or a non-enumerable property, and would throw on the circular references a
 * live SDK client contains.
 */
function deepFind(root: unknown, needle: string, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof root === 'string') return root.includes(needle);
  if (root === null || typeof root !== 'object') return false;
  if (seen.has(root)) return false;
  seen.add(root);

  for (const value of Object.values(root)) {
    if (deepFind(value, needle, seen, depth + 1)) return true;
  }
  return false;
}
