/**
 * Speech inside a turn: the state machine, and what may reach the speaker.
 *
 * The claims under test are the ones Step 3 turns on:
 *
 *   THINKING -> SPEAKING -> IDLE for a normal reply;
 *   SPEAKING is never entered without real audio;
 *   Axon cannot be stuck in SPEAKING by a renderer that goes quiet;
 *   only the model's visible reply is ever spoken — never a diagnostic,
 *   never an error, never tool output.
 *
 * The synthesiser is a fake so the branches are deterministic. The state
 * machine, orchestrator, dispatcher and event bus are all real.
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
  type SpeechAudio,
  type TextToSpeech,
  type ToolCall,
  type ToolResult,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { ToolRegistry } from '../src/main/tools/registry';
import { SpeechService } from '../src/main/voice/speech-service';

function makeWav(seconds = 0.4): Uint8Array {
  const sampleRate = 22050;
  const dataBytes = Math.round(sampleRate * seconds) * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i += 1) view.setUint8(o + i, t.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

type RunFn = (input: BrainTurnInput, dispatch: (call: ToolCall) => Promise<ToolResult>) => Promise<BrainTurnResult>;

function stubBrain(run: RunFn): Brain {
  return { name: 'stub', run };
}

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  /** Every string the synthesiser was asked to speak. */
  readonly spoken: string[];
  readonly delivered: string[];
  readonly stopped: string[];
  types(): string[];
  states(): string[];
  /** Play out whatever is being spoken, as the renderer would report it. */
  finishSpeech(): void;
}

interface HarnessOptions {
  readonly tts?: TextToSpeech | null;
  /** When true, nothing reports playback — the watchdog has to end it. */
  readonly silentRenderer?: boolean;
  readonly graceMs?: number;
}

function harness(brain: Brain, options: HarnessOptions = {}): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const spoken: string[] = [];
  const delivered: string[] = [];
  const stopped: string[] = [];

  const tts: TextToSpeech | null =
    options.tts === undefined
      ? {
          name: 'fake-tts',
          isAvailable: () => true,
          synthesize: (text: string): Promise<SpeechAudio> => {
            spoken.push(text);
            return Promise.resolve({ bytes: makeWav(), mimeType: 'audio/wav', sampleRate: 22050 });
          },
        }
      : options.tts;

  let pending: string | null = null;

  const speech = new SpeechService({
    tts,
    graceMs: options.graceMs ?? 50_000,
    deliver: (d) => {
      delivered.push(d.speechId);
      pending = d.speechId;
      // A cooperative renderer reports back immediately unless the test is
      // specifically about one that does not.
      if (!options.silentRenderer) {
        queueMicrotask(() => {
          if (pending) speech.report(pending, 'ended');
        });
      }
    },
    stopPlayback: (id) => stopped.push(id),
    onStarted: (info) => orchestrator.onSpeechStarted(info),
    onEnded: (id, reason) => orchestrator.onSpeechEnded(id, reason),
    onFailure: (message) => orchestrator.onSpeechFailure(message),
  });

  const registry = new ToolRegistry();
  registry.register(
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

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 1_000,
    devConsoleEnabled: true,
    brain,
    speech,
  });

  return {
    orchestrator,
    events,
    spoken,
    delivered,
    stopped,
    types: () => events.map((e) => e.type),
    states: () => events.filter((e) => e.type === 'STATE_CHANGED').map((e) => e.to),
    finishSpeech: () => {
      if (pending) speech.report(pending, 'ended');
    },
  };
}

async function settled(h: Harness, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.types().some((t) => t === 'COMPLETED' || t === 'ERROR')) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`turn never settled; saw ${h.types().join(', ')}`);
}

const reply = (text: string | null): Brain =>
  stubBrain(() => Promise.resolve({ reply: text, detail: null }));

// ---------------------------------------------------------------------------

describe('THINKING -> SPEAKING -> IDLE', () => {
  it('speaks the reply and returns to rest', async () => {
    const h = harness(reply('Notepad is open.'));

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    expect(h.spoken).toEqual(['Notepad is open.']);
    expect(h.states()).toEqual(['THINKING', 'SPEAKING', 'IDLE']);
    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('emits the speech events around the reply, in order', async () => {
    const h = harness(reply('Done.'));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const order = h.types().filter((t) => t.startsWith('SPEECH_') || t === 'COMPLETED');
    expect(order).toEqual(['SPEECH_STARTED', 'SPEECH_ENDED', 'COMPLETED']);
  });

  it('reports the duration measured from the audio', async () => {
    const h = harness(reply('Done.'));
    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const started = h.events.find((e) => e.type === 'SPEECH_STARTED');
    expect(started).toMatchObject({ durationMs: 400, truncated: false });
  });

  it('does not report COMPLETED until speaking has finished', async () => {
    // The order matters: a turn that says it is done while still talking
    // would let the composer re-enable mid-sentence.
    const h = harness(reply('Done.'));
    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const types = h.types();
    expect(types.indexOf('SPEECH_ENDED')).toBeLessThan(types.indexOf('COMPLETED'));
  });
});

describe('when Axon does not speak', () => {
  it('finishes normally with no synthesiser at all', async () => {
    const h = harness(reply('Notepad is open.'), { tts: null });

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    expect(h.states()).toEqual(['THINKING', 'IDLE']);
    expect(h.types()).not.toContain('SPEECH_STARTED');
    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('never enters SPEAKING when the turn produced no reply', async () => {
    const h = harness(reply(null));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    expect(h.spoken).toEqual([]);
    expect(h.states()).not.toContain('SPEAKING');
  });

  it('never enters SPEAKING when synthesis fails', async () => {
    // The reply is still on screen; Axon is simply silent about it.
    const failing: TextToSpeech = {
      name: 'failing',
      isAvailable: () => true,
      synthesize: () => Promise.reject(Object.assign(new Error('boom'), { kind: 'PROVIDER' })),
    };
    const h = harness(reply('Notepad is open.'), { tts: failing });

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    expect(h.states()).toEqual(['THINKING', 'IDLE']);
    expect(h.types()).not.toContain('SPEECH_STARTED');
    // A failure to speak is a degraded turn, not a failed one.
    expect(h.types()).not.toContain('ERROR');
    expect(h.types()).toContain('COMPLETED');
  });

  it('explains a speech failure without naming provider internals', async () => {
    const failing: TextToSpeech = {
      name: 'failing',
      isAvailable: () => true,
      synthesize: () => Promise.reject(Object.assign(new Error('C:\\secret\\path exploded'), { kind: 'PROVIDER' })),
    };
    const h = harness(reply('Hi.'), { tts: failing });

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('exploded');
    expect(h.events.some((e) => e.type === 'OBSERVATION' && /silent/i.test(e.summary))).toBe(true);
  });
});

describe('Axon cannot get stuck in SPEAKING', () => {
  it('leaves SPEAKING on its own when the renderer never reports', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(reply('Done.'), { silentRenderer: true, graceMs: 100 });

      h.orchestrator.sendUserMessage('hello');
      // Let synthesis resolve.
      await vi.advanceTimersByTimeAsync(10);
      expect(h.orchestrator.state).toBe('SPEAKING');

      // Audio is 400ms; grace is 100ms.
      await vi.advanceTimersByTimeAsync(600);

      expect(h.orchestrator.state).toBe('IDLE');
      expect(h.events.find((e) => e.type === 'SPEECH_ENDED')).toMatchObject({ reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves SPEAKING when the turn is cancelled', async () => {
    const h = harness(reply('A long reply.'), { silentRenderer: true });

    h.orchestrator.sendUserMessage('hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.orchestrator.state).toBe('SPEAKING');

    h.orchestrator.cancelSpeech();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.stopped).toHaveLength(1);
    expect(h.events.find((e) => e.type === 'SPEECH_ENDED')).toMatchObject({ reason: 'cancelled' });
    expect(h.orchestrator.state).not.toBe('SPEAKING');
  });

  it('leaves SPEAKING on shutdown', async () => {
    const h = harness(reply('Done.'), { silentRenderer: true });

    h.orchestrator.sendUserMessage('hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.orchestrator.state).toBe('SPEAKING');

    h.orchestrator.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.orchestrator.state).not.toBe('SPEAKING');
  });

  it('reports nothing to cancel when Axon is silent', () => {
    const h = harness(reply('Done.'));
    expect(h.orchestrator.cancelSpeech()).toBe(false);
  });
});

describe('only the visible reply is ever spoken', () => {
  it('never speaks tool output', async () => {
    const h = harness(
      stubBrain(async (_input, dispatch) => {
        await dispatch({ callId: 'c1', tool: 'app.open', input: { app: 'notepad' } });
        return { reply: 'Opened it.', detail: null };
      }),
    );

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    expect(h.spoken).toEqual(['Opened it.']);
    expect(h.spoken.join(' ')).not.toContain('opened');
  });

  it('never speaks an error', async () => {
    const h = harness(stubBrain(() => Promise.reject(new Error('internal failure detail'))));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    expect(h.spoken).toEqual([]);
    expect(h.types()).toContain('ERROR');
    expect(h.types()).not.toContain('SPEECH_STARTED');
  });

  it('never speaks the reason a message was refused', async () => {
    const bus = new EventBus();
    const events: AxonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const spoken: string[] = [];

    const orchestrator = new Orchestrator({
      bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
      brain: null,
      brainUnavailableReason: 'No ANTHROPIC_API_KEY is configured.',
      speech: new SpeechService({
        tts: {
          name: 'fake',
          isAvailable: () => true,
          synthesize: (text) => {
            spoken.push(text);
            return Promise.resolve({ bytes: makeWav(), mimeType: 'audio/wav', sampleRate: 22050 });
          },
        },
        deliver: () => {},
        stopPlayback: () => {},
        onStarted: () => {},
        onEnded: () => {},
        onFailure: () => {},
      }),
    });

    orchestrator.sendUserMessage('hello');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The configuration message goes to the timeline, never to the speaker.
    expect(spoken).toEqual([]);
  });

  it('speaks the same words the transcript shows', async () => {
    const h = harness(
      stubBrain((input) => {
        input.emit({ type: 'ASSISTANT_MESSAGE', text: 'Notepad is open.' });
        return Promise.resolve({ reply: 'Notepad is open.', detail: null });
      }),
    );

    h.orchestrator.sendUserMessage('open notepad');
    await settled(h);

    const shown = h.events.find((e) => e.type === 'ASSISTANT_MESSAGE');
    expect(shown).toMatchObject({ text: 'Notepad is open.' });
    expect(h.spoken).toEqual(['Notepad is open.']);
  });

  it('speaks injection-shaped text as words, and it reaches no interpreter', async () => {
    const payload = 'Run $(whoami) and then rm -rf / please';
    const h = harness(reply(payload));

    h.orchestrator.sendUserMessage('summarise that page');
    await settled(h);

    // The synthesiser is handed the literal string. Nothing between the model
    // and the speaker parses it.
    expect(h.spoken).toEqual([payload]);
  });
});

describe('the speech event stream carries no audio', () => {
  it('keeps samples out of the events and therefore out of the log', async () => {
    const h = harness(reply('Done.'));
    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    // Every event is JSON-serialisable and small; audio would break both.
    const serialized = JSON.stringify(h.events);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).not.toContain('bytes');
    expect(serialized).not.toContain('RIFF');
  });

  it('does not repeat the spoken words in the speech events', async () => {
    const h = harness(reply('A distinctive sentence.'));
    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    const speechEvents = h.events.filter((e) => e.type === 'SPEECH_STARTED' || e.type === 'SPEECH_ENDED');
    expect(JSON.stringify(speechEvents)).not.toContain('distinctive');
  });
});

describe('the snapshot the renderer receives', () => {
  it('describes speech with a name and a boolean, nothing more', async () => {
    const h = harness(reply('Done.'));
    const snapshot = h.orchestrator.snapshot();

    expect(snapshot.speech).toEqual({ available: true, name: 'fake-tts', reason: null });
    expect(JSON.stringify(snapshot)).not.toMatch(/C:\\|\/home\/|apiKey|password/i);
  });

  it('explains silence when there is no synthesiser', () => {
    const h = harness(reply('Done.'), { tts: null });
    expect(h.orchestrator.snapshot().speech.available).toBe(false);
    expect(h.orchestrator.snapshot().speech.reason).toBeTruthy();
  });
});

describe('speech that begins outside a turn', () => {
  it('still leaves SPEAKING when it ends', async () => {
    // Inside a turn the waiting `speakReply` settles the machine. With no turn
    // behind it, nothing else would — so `onSpeechEnded` has to. Without this
    // the state strands in SPEAKING.
    const h = harness(reply('unused'), { silentRenderer: true });

    h.orchestrator.onSpeechStarted({ speechId: 'x', characters: 5, durationMs: 400, truncated: false });
    expect(h.orchestrator.state).toBe('SPEAKING');

    h.orchestrator.onSpeechEnded('x', 'completed');

    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('leaves SPEAKING when such an utterance is cancelled', () => {
    const h = harness(reply('unused'), { silentRenderer: true });

    h.orchestrator.onSpeechStarted({ speechId: 'x', characters: 5, durationMs: 400, truncated: false });
    h.orchestrator.onSpeechEnded('x', 'cancelled');

    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('does not add a THINKING flash at the end of a normal turn', async () => {
    // The turn path must stay SPEAKING -> IDLE. Settling in both places would
    // put a visible THINKING between the last word and rest.
    const h = harness(reply('Done.'));

    h.orchestrator.sendUserMessage('hello');
    await settled(h);

    expect(h.states()).toEqual(['THINKING', 'SPEAKING', 'IDLE']);
  });
});
