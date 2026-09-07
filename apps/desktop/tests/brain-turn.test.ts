/**
 * The orchestrator's half of a turn.
 *
 * `brain.test.ts` covers the loop; this covers what the orchestrator does
 * around it — accepting or refusing a message, keeping the state machine
 * honest while tools run, emitting COMPLETED, surviving a brain that throws,
 * and never letting a failure escape as an unhandled rejection.
 *
 * The brain here is a stub, so these tests say nothing about Claude and
 * everything about the wiring, which is the part that would take the app down.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  type AxonEvent,
  type Brain,
  type BrainTurnInput,
  type BrainTurnResult,
  type RiskAssessment,
  type ToolCall,
  type ToolResult,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { ToolRegistry } from '../src/main/tools/registry';
import { ModelError } from '../src/main/brain/model-client';

type RunFn = (input: BrainTurnInput, dispatch: (call: ToolCall) => Promise<ToolResult>) => Promise<BrainTurnResult>;

function stubBrain(run: RunFn, name = 'stub'): Brain {
  return { name, run };
}

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  readonly executed: string[];
  types(): string[];
}

function harness(brain: Brain | null, unavailableReason: string | null = null): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const executed: string[] = [];
  const registry = new ToolRegistry();
  registry.register(
    defineTool<{ app: string }, { opened: string }>({
      name: 'app.open',
      title: 'Open an application',
      description: 'Open a permitted app.',
      inputSchema: z.object({ app: z.enum(['notepad']) }),
      resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'allowlisted' }),
      summarize: () => ({ title: 'Open Notepad', parameters: [] }),
      execute: (input) => {
        executed.push(input.app);
        return Promise.resolve({ opened: input.app });
      },
    }),
  );

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 1_000,
    devConsoleEnabled: true,
    brain,
    brainUnavailableReason: unavailableReason,
  });

  return { orchestrator, events, executed, types: () => events.map((event) => event.type) };
}

/** Wait until the turn settles, i.e. COMPLETED or ERROR has been emitted. */
async function settled(h: Harness): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (h.types().some((type) => type === 'COMPLETED' || type === 'ERROR')) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`turn never settled; saw ${h.types().join(', ')}`);
}

// ---------------------------------------------------------------------------

describe('accepting a message', () => {
  it('accepts a normal message and reports the turn as busy', () => {
    const h = harness(stubBrain(() => new Promise(() => {})));

    const result = h.orchestrator.sendUserMessage('open notepad');

    expect(result).toEqual({ accepted: true, error: null });
    expect(h.orchestrator.snapshot().busy).toBe(true);
    expect(h.orchestrator.state).toBe('THINKING');
  });

  it('records the utterance on the event stream', () => {
    const h = harness(stubBrain(() => new Promise(() => {})));
    h.orchestrator.sendUserMessage('open notepad');

    const first = h.events.find((event) => event.type === 'USER_MESSAGE');
    expect(first).toMatchObject({ text: 'open notepad', source: 'text' });
  });

  it('trims surrounding whitespace', () => {
    const h = harness(stubBrain(() => new Promise(() => {})));
    h.orchestrator.sendUserMessage('  open notepad \n');
    expect(h.events.find((e) => e.type === 'USER_MESSAGE')).toMatchObject({ text: 'open notepad' });
  });

  it.each([
    ['an empty message', '', 'Message was empty.'],
    ['whitespace only', '   \n  ', 'Message was empty.'],
  ])('refuses %s', (_label, text, error) => {
    const h = harness(stubBrain(() => Promise.resolve({ reply: null, detail: null })));
    expect(h.orchestrator.sendUserMessage(text)).toEqual({ accepted: false, error });
    expect(h.orchestrator.snapshot().busy).toBe(false);
  });

  it('refuses an over-long message', () => {
    const h = harness(stubBrain(() => Promise.resolve({ reply: null, detail: null })));
    const result = h.orchestrator.sendUserMessage('x'.repeat(4001));
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('too long');
  });

  it('refuses a second message while a turn is running', () => {
    const h = harness(stubBrain(() => new Promise(() => {})));
    h.orchestrator.sendUserMessage('first');

    const second = h.orchestrator.sendUserMessage('second');
    expect(second.accepted).toBe(false);
    expect(second.error).toContain('already working');
  });
});

describe('with no brain attached', () => {
  it('reports the brain as unavailable with a reason', () => {
    const h = harness(null, 'No ANTHROPIC_API_KEY is configured.');
    expect(h.orchestrator.brainStatus()).toEqual({
      available: false,
      name: 'none',
      reason: 'No ANTHROPIC_API_KEY is configured.',
    });
  });

  it('refuses the message but still records what the user said', () => {
    const h = harness(null, 'No ANTHROPIC_API_KEY is configured.');

    const result = h.orchestrator.sendUserMessage('open notepad');

    expect(result.accepted).toBe(false);
    expect(h.types()).toContain('USER_MESSAGE');
    expect(h.types()).toContain('ERROR');
    expect(h.orchestrator.state).toBe('ERROR');
  });

  it('reports available with the brain name when one is attached', () => {
    const h = harness(stubBrain(() => Promise.resolve({ reply: null, detail: null }), 'claude(test)'));
    expect(h.orchestrator.brainStatus()).toEqual({ available: true, name: 'claude(test)', reason: null });
  });
});

describe('completing a turn', () => {
  it('emits COMPLETED and returns to IDLE', async () => {
    const h = harness(stubBrain(() => Promise.resolve({ reply: 'All done.', detail: null })));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    expect(h.events.find((event) => event.type === 'COMPLETED')).toMatchObject({ summary: 'All done.' });
    expect(h.orchestrator.state).toBe('IDLE');
    expect(h.orchestrator.snapshot().busy).toBe(false);
  });

  it('accepts a new message once the turn has finished', async () => {
    const h = harness(stubBrain(() => Promise.resolve({ reply: 'done', detail: null })));

    h.orchestrator.sendUserMessage('first');
    await settled(h);

    expect(h.orchestrator.sendUserMessage('second').accepted).toBe(true);
  });
});

describe('state while tools run', () => {
  it('stays in THINKING between tool calls rather than dropping to IDLE', async () => {
    const h = harness(
      stubBrain(async (_input, dispatch) => {
        await dispatch({ callId: 'c1', tool: 'app.open', input: { app: 'notepad' } });
        // Between the two calls the machine must not have rested at IDLE:
        // the turn is still running.
        await dispatch({ callId: 'c2', tool: 'app.open', input: { app: 'notepad' } });
        return { reply: 'done', detail: null };
      }),
    );

    h.orchestrator.sendUserMessage('open notepad twice');
    await settled(h);

    const states = h.events.filter((event) => event.type === 'STATE_CHANGED').map((event) => event.to);

    // IDLE appears exactly once, at the very end.
    expect(states.filter((state) => state === 'IDLE')).toHaveLength(1);
    expect(states[states.length - 1]).toBe('IDLE');
    expect(h.executed).toEqual(['notepad', 'notepad']);
  });

  it('routes the brain through the dispatcher, so tool events are emitted', async () => {
    const h = harness(
      stubBrain(async (_input, dispatch) => {
        await dispatch({ callId: 'c1', tool: 'app.open', input: { app: 'notepad' } });
        return { reply: 'done', detail: null };
      }),
    );

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    expect(h.types()).toContain('TOOL_CALL');
    expect(h.types()).toContain('TOOL_RESULT');
  });
});

describe('the brain receives only what it is allowed', () => {
  it('gets code-free schemas and a dispatch callback, nothing else', async () => {
    let captured: BrainTurnInput | null = null;
    const h = harness(
      stubBrain((input) => {
        captured = input;
        return Promise.resolve({ reply: 'ok', detail: null });
      }),
    );

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const input = captured as unknown as BrainTurnInput;
    expect(input.tools.map((tool) => tool.name)).toEqual(['app.open']);
    for (const tool of input.tools) {
      expect(JSON.stringify(tool)).not.toContain('execute');
      expect(Object.values(tool).every((value) => typeof value !== 'function')).toBe(true);
    }
  });

  it('cannot forge a TOOL_CALL through its emitter', async () => {
    const h = harness(
      stubBrain((input) => {
        // The type system refuses this; the cast proves the runtime does too.
        const forge = input.emit as unknown as (event: { type: string; [k: string]: unknown }) => void;
        expect(() =>
          forge({ type: 'TOOL_CALL', callId: 'x', tool: 'app.open', input: {}, risk: 'SAFE', riskReason: 'forged' }),
        ).toThrow();
        return Promise.resolve({ reply: 'ok', detail: null });
      }),
    );

    h.orchestrator.sendUserMessage('hello');
    await settled(h);
  });
});

describe('a brain that fails', () => {
  it('turns a model error into an ERROR event instead of a crash', async () => {
    const h = harness(stubBrain(() => Promise.reject(new ModelError('AUTH', 'bad key'))));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const error = h.events.find((event) => event.type === 'ERROR');
    expect(error).toBeDefined();
    expect(error).toMatchObject({ scope: 'brain' });
    expect(String((error as { message: string }).message)).toContain('ANTHROPIC_API_KEY');
    expect(h.orchestrator.state).toBe('ERROR');
  });

  it('clears busy after a failure so the user can try again', async () => {
    const h = harness(stubBrain(() => Promise.reject(new Error('boom'))));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    expect(h.orchestrator.snapshot().busy).toBe(false);
  });

  it('does not raise an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const h = harness(stubBrain(() => Promise.reject(new Error('boom'))));
    h.orchestrator.sendUserMessage('hello');
    await settled(h);
    // Give the microtask queue a chance to surface one.
    await new Promise((resolve) => setTimeout(resolve, 20));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('survives a brain that throws synchronously', async () => {
    const h = harness(
      stubBrain(() => {
        throw new Error('immediate');
      }),
    );

    expect(() => h.orchestrator.sendUserMessage('hello')).not.toThrow();
    await settled(h);
    expect(h.orchestrator.state).toBe('ERROR');
  });
});

describe('cancellation and shutdown', () => {
  it('aborts the in-flight turn on shutdown', async () => {
    let signal: AbortSignal | null = null;
    const h = harness(
      stubBrain((input) => {
        signal = input.signal;
        return new Promise(() => {});
      }),
    );

    h.orchestrator.sendUserMessage('hello');
    h.orchestrator.shutdown();

    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(h.orchestrator.snapshot().busy).toBe(false);
  });

  it('reports whether there was a turn to cancel', () => {
    const h = harness(stubBrain(() => new Promise(() => {})));

    expect(h.orchestrator.cancelTurn()).toBe(false);
    h.orchestrator.sendUserMessage('hello');
    expect(h.orchestrator.cancelTurn()).toBe(true);
  });

  it('does not emit COMPLETED for a cancelled turn', async () => {
    let resolveTurn: ((result: BrainTurnResult) => void) | null = null;
    const h = harness(
      stubBrain(
        () =>
          new Promise<BrainTurnResult>((resolve) => {
            resolveTurn = resolve;
          }),
      ),
    );

    h.orchestrator.sendUserMessage('hello');
    h.orchestrator.cancelTurn('user cancelled');
    (resolveTurn as unknown as (result: BrainTurnResult) => void)({ reply: 'late', detail: null });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.types()).not.toContain('COMPLETED');
  });
});

describe('recovering from ERROR', () => {
  it('clears ERROR when a new message starts a turn', async () => {
    // ERROR leaves only to IDLE, so without an explicit reset the machine
    // would stay there for the whole of the next turn — the orb reading
    // "Something went wrong" while Axon worked perfectly well.
    let shouldFail = true;
    const h = harness(
      stubBrain(() => (shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve({ reply: 'ok', detail: null }))),
    );

    h.orchestrator.sendUserMessage('first');
    await settled(h);
    expect(h.orchestrator.state).toBe('ERROR');

    shouldFail = false;
    h.orchestrator.sendUserMessage('second');

    // The turn is under way and the machine is no longer reporting a failure.
    expect(h.orchestrator.state).toBe('THINKING');
  });

  it('records the reset on the event stream rather than doing it silently', async () => {
    const h = harness(
      stubBrain(() => Promise.reject(new Error('boom'))),
    );

    h.orchestrator.sendUserMessage('first');
    await settled(h);
    h.orchestrator.sendUserMessage('second');

    const transitions = h.events
      .filter((event) => event.type === 'STATE_CHANGED')
      .map((event) => `${String(event.from)}->${event.to}`);

    expect(transitions).toContain('ERROR->IDLE');
  });
});
