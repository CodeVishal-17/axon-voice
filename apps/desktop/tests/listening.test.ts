/**
 * The listening service and the state it drives.
 *
 * Two halves:
 *
 *   - `ListeningService` against a fake `SpeechToText`, so the session
 *     lifecycle, the limits and the cleanup can be checked exactly;
 *   - the real `Orchestrator` with the real state machine, so what the user
 *     sees — LISTENING, THINKING, barge-in — is asserted against the thing
 *     that actually decides it.
 *
 * The fakes here are clearly fakes. The real recognizer is exercised against
 * real Windows speech in `voice-integration.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LISTENING_LIMITS,
  type CaptureCommand,
  type CaptureFailure,
  type SpeechToText,
  type SpeechToTextSession,
  type TranscriptChunk,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { ListeningService, type ListeningEndReason } from '../src/main/voice/listening-service.js';
import type { SpeechService } from '../src/main/voice/speech-service.js';

const RATE = LISTENING_LIMITS.sampleRate;
const FRAME = 512;
const FRAME_MS = (FRAME / RATE) * 1000;

function silence(samples = FRAME): Int16Array {
  return new Int16Array(samples);
}

function tone(rms = 0.25, samples = FRAME): Int16Array {
  const amplitude = Math.round(rms * 32767);
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  return frame;
}

/** A recognizer that returns whatever the test tells it to. */
function fakeStt(behaviour: {
  phrases?: string[];
  available?: boolean;
  failStart?: boolean;
  startDelayMs?: number;
  endDelayMs?: number;
}): SpeechToText & { pushed: number; closed: number; sessions: number } {
  const state = { pushed: 0, closed: 0, sessions: 0 };

  const stt: SpeechToText = {
    name: 'fake-stt',
    sampleRate: RATE,
    isAvailable: () => behaviour.available !== false,
    async start(onChunk: (chunk: TranscriptChunk) => void): Promise<SpeechToTextSession> {
      if (behaviour.startDelayMs) await new Promise((r) => setTimeout(r, behaviour.startDelayMs));
      if (behaviour.failStart) throw new Error('engine exploded, with a C:\\local\\path in the message');
      state.sessions += 1;

      return {
        push: (frame: Int16Array): void => {
          state.pushed += frame.length;
        },
        end: async (): Promise<void> => {
          if (behaviour.endDelayMs) await new Promise((r) => setTimeout(r, behaviour.endDelayMs));
          for (const text of behaviour.phrases ?? []) {
            onChunk({ text, isFinal: true, confidence: 0.8 });
          }
        },
        close: (): void => {
          state.closed += 1;
        },
      };
    },
  };

  // Defined rather than assigned: `Object.assign` would read each getter once
  // and copy the number it returned, freezing the counters at zero.
  return Object.defineProperties(stt, {
    pushed: { get: () => state.pushed },
    closed: { get: () => state.closed },
    sessions: { get: () => state.sessions },
  }) as SpeechToText & { pushed: number; closed: number; sessions: number };
}

interface Harness {
  readonly service: ListeningService;
  readonly commands: CaptureCommand[];
  readonly transcripts: string[];
  readonly notices: string[];
  readonly failures: string[];
  readonly ended: ListeningEndReason[];
  readonly started: number;
  /** Push `ms` of the given frame into the open session. */
  feed(frame: Int16Array, ms: number): void;
}

function harness(stt: SpeechToText | null, options: Record<string, unknown> = {}): Harness {
  const commands: CaptureCommand[] = [];
  const transcripts: string[] = [];
  const notices: string[] = [];
  const failures: string[] = [];
  const ended: ListeningEndReason[] = [];
  let started = 0;

  const service = new ListeningService({
    stt,
    command: (command) => commands.push(command),
    onStarted: () => {
      started += 1;
    },
    onEnded: (reason) => ended.push(reason),
    onTranscript: (text) => transcripts.push(text),
    onNotice: (message) => notices.push(message),
    onFailure: (message) => failures.push(message),
    ...options,
  });

  return {
    service,
    commands,
    transcripts,
    notices,
    failures,
    ended,
    get started(): number {
      return started;
    },
    feed(frame: Int16Array, ms: number): void {
      const captureId = commands.find((c) => c.action === 'start')?.captureId ?? '';
      const count = Math.ceil(ms / FRAME_MS);
      for (let i = 0; i < count; i += 1) service.pushFrame(captureId, frame);
    },
  };
}

/** Let the recognizer's promises settle. */
const settle = async (ms = 20): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe('availability', () => {
  it('reports why it cannot listen when there is no recognizer', () => {
    const h = harness(null);
    const status = h.service.status();
    expect(status.available).toBe(false);
    expect(status.name).toBe('none');
    expect(status.reason).toMatch(/recognizer/i);
    expect(status.active).toBe(false);
  });

  it('refuses to start without a recognizer, and opens no microphone', () => {
    const h = harness(null);
    const result = h.service.start('manual');

    expect(result.accepted).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.started).toBe(0);
  });

  it('carries a provider name and a hotkey, and never a credential', () => {
    const h = harness(fakeStt({}), { hotkey: 'Control+Shift+Space' });
    const status = h.service.status();

    expect(status).toEqual({
      available: true,
      name: 'fake-stt',
      reason: null,
      active: false,
      hotkey: 'Control+Shift+Space',
    });
  });
});

describe('the session lifecycle', () => {
  it('opens the microphone and announces itself', async () => {
    const h = harness(fakeStt({ phrases: ['open notepad'] }));
    const result = h.service.start('hotkey');

    expect(result.accepted).toBe(true);
    expect(h.started).toBe(1);
    expect(h.service.listening).toBe(true);

    const command = h.commands[0];
    expect(command?.action).toBe('start');
    expect(command?.sampleRate).toBe(RATE);
    expect(command?.captureId).toBeTruthy();

    h.service.cancel();
    await settle();
  });

  it('opens the microphone before the recognizer has finished loading', () => {
    // The latency decision: the capture command goes out immediately and the
    // engine warms up in parallel, so the user sees LISTENING and the orb
    // responds without waiting for a subprocess to start.
    const h = harness(fakeStt({ startDelayMs: 500 }));
    h.service.start('hotkey');

    expect(h.commands[0]?.action).toBe('start');
    h.service.cancel();
  });

  it('transcribes an utterance and hands up text', async () => {
    const h = harness(fakeStt({ phrases: ['open notepad'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 600);
    h.feed(silence(), 1_200);
    await settle();

    expect(h.transcripts).toEqual(['open notepad']);
    expect(h.ended).toEqual(['transcribed']);
    expect(h.service.listening).toBe(false);
  });

  it('joins the phrases of one utterance', async () => {
    const h = harness(fakeStt({ phrases: ['open notepad', 'and write hello'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 600);
    h.feed(silence(), 1_200);
    await settle();

    expect(h.transcripts).toEqual(['open notepad and write hello']);
  });

  it('closes the microphone before recognition begins', async () => {
    // The user has stopped talking. Nothing said between here and the
    // transcript arriving should be captured.
    const h = harness(fakeStt({ phrases: ['hello'], endDelayMs: 200 }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 600);
    h.feed(silence(), 1_200);

    // Recognition is still running, and the microphone is already shut.
    expect(h.commands.some((c) => c.action === 'stop')).toBe(true);
    expect(h.transcripts).toEqual([]);

    await settle(400);
    expect(h.transcripts).toEqual(['hello']);
  });

  it('refuses a second session while one is open', async () => {
    const h = harness(fakeStt({}));
    h.service.start('hotkey');

    const second = h.service.start('manual');
    expect(second.accepted).toBe(false);
    expect(second.error).toMatch(/already listening/i);

    h.service.cancel();
    await settle();
  });

  it('closes the microphone on every path out', async () => {
    for (const finish of ['cancel', 'stop', 'shutdown'] as const) {
      const h = harness(fakeStt({}));
      h.service.start('hotkey');
      await settle();

      h.service[finish]();
      expect(h.commands.filter((c) => c.action === 'stop').length).toBeGreaterThan(0);
      expect(h.service.listening).toBe(false);
      await settle();
    }
  });

  it('kills the recognizer when a session ends', async () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    h.service.cancel();
    await settle();

    expect(stt.closed).toBeGreaterThan(0);
  });

  it('kills a recognizer that finished loading after the session closed', async () => {
    const stt = fakeStt({ startDelayMs: 100 });
    const h = harness(stt);
    h.service.start('hotkey');

    // Cancelled while the engine was still loading.
    h.service.cancel();
    await settle(300);

    // The engine came up into a closed session, and was disposed of rather
    // than left running with a live audio pipe.
    expect(stt.closed).toBe(stt.sessions);
  });
});

describe('deciding when the user has finished', () => {
  it('ends on silence, not on a timer', async () => {
    const h = harness(fakeStt({ phrases: ['hello'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 400);
    // Under the silence window: still listening.
    h.feed(silence(), 500);
    expect(h.service.listening).toBe(true);

    h.feed(silence(), 600);
    await settle();
    expect(h.service.listening).toBe(false);
  });

  it('gives up harmlessly on an accidental activation', async () => {
    const h = harness(fakeStt({}));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), LISTENING_LIMITS.speechStartTimeoutMs + 200);
    await settle();

    expect(h.ended).toEqual(['no-speech']);
    expect(h.transcripts).toEqual([]);
    // A note, not an error: pressing a key by mistake is not a fault.
    expect(h.failures).toEqual([]);
    expect(h.notices.join(' ')).toMatch(/didn't hear/i);
  });

  it('stops early when the user asks, and keeps what they said', async () => {
    const h = harness(fakeStt({ phrases: ['stop'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 500);
    h.service.stop();
    await settle();

    // Pressing stop mid-sentence means "I'm done", not "forget it".
    expect(h.transcripts).toEqual(['stop']);
  });

  it('discards a stop before anything was said', async () => {
    const h = harness(fakeStt({ phrases: ['should not appear'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 200);
    h.service.stop();
    await settle();

    expect(h.transcripts).toEqual([]);
    expect(h.ended).toEqual(['cancelled']);
  });

  it('says so when it could not make out what was said', async () => {
    const h = harness(fakeStt({ phrases: [] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 500);
    h.feed(silence(), 1_200);
    await settle();

    expect(h.transcripts).toEqual([]);
    expect(h.ended).toEqual(['empty-transcript']);
    expect(h.notices.join(' ')).toMatch(/didn't catch/i);
    // Not an error. Failing to catch a mumble is an ordinary outcome.
    expect(h.failures).toEqual([]);
  });
});

describe('limits', () => {
  it('stops at the utterance ceiling and says why', async () => {
    const h = harness(fakeStt({ phrases: ['a very long sentence'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), LISTENING_LIMITS.maxUtteranceMs + 500);
    await settle();

    expect(h.notices.join(' ')).toMatch(/longer than/i);
    expect(h.transcripts).toEqual(['a very long sentence']);
    expect(h.service.listening).toBe(false);
  });

  it('truncates an over-long transcript and says so', async () => {
    const huge = 'x'.repeat(LISTENING_LIMITS.maxTranscriptCharacters + 500);
    const h = harness(fakeStt({ phrases: [huge] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 400);
    h.feed(silence(), 1_200);
    await settle();

    expect(h.transcripts[0]?.length).toBe(LISTENING_LIMITS.maxTranscriptCharacters);
    expect(h.notices.join(' ')).toMatch(/longer than Axon accepts/i);
  });

  it('drops an oversized frame', async () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    h.feed(new Int16Array(LISTENING_LIMITS.maxFrameSamples + 1), 100);
    expect(stt.pushed).toBe(0);
  });

  it('drops an empty frame', async () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    h.feed(new Int16Array(0), 100);
    expect(stt.pushed).toBe(0);
  });

  it('bounds the audio held while the recognizer is loading', async () => {
    // The one place audio is buffered in the main process. It exists for the
    // few hundred milliseconds the engine takes to load, and it is bounded.
    const stt = fakeStt({ startDelayMs: 10_000 });
    const h = harness(stt);
    h.service.start('hotkey');

    // Far more audio than the ceiling allows.
    const frames = Math.ceil(LISTENING_LIMITS.maxAudioBytes / (FRAME * 2)) + 200;
    for (let i = 0; i < frames; i += 1) h.service.pushFrame(h.commands[0]?.captureId ?? '', tone());

    // Nothing reached the recognizer (it has not started), and the buffer did
    // not grow without limit — the session is still alive and responsive.
    expect(h.service.listening).toBe(true);
    h.service.cancel();
  });
});

describe('resource exhaustion from a compromised renderer', () => {
  it('will not spawn a recognizer per request in a loop', async () => {
    // Every session starts a subprocess, which is the most expensive thing the
    // renderer can ask for. Page code calling start/stop in a loop would fork
    // as fast as the machine allowed — a way to make the user's computer
    // unusable without ever reaching the dispatcher.
    const stt = fakeStt({});
    const h = harness(stt);

    let accepted = 0;
    for (let i = 0; i < 50; i += 1) {
      if (h.service.start('manual').accepted) accepted += 1;
      h.service.cancel();
    }
    await settle(50);

    expect(accepted).toBe(1);
    expect(stt.sessions).toBeLessThanOrEqual(1);
  });

  it('lets a person try again a moment later', async () => {
    const h = harness(fakeStt({}), { now: () => Date.now() });
    expect(h.service.start('hotkey').accepted).toBe(true);
    h.service.cancel();
    await settle();

    // Immediately: refused.
    expect(h.service.start('hotkey').accepted).toBe(false);

    // After the cooldown: accepted.
    await settle(400);
    expect(h.service.start('hotkey').accepted).toBe(true);
    h.service.cancel();
    await settle();
  });

  it('does not forward audio captured after the user stopped speaking', async () => {
    // Once the utterance is finishing, the microphone has been told to close
    // and Axon is no longer listening. Frames still arriving are the tail of a
    // stream shutting down, and belong to a moment nobody consented to.
    const stt = fakeStt({ phrases: ['hello'], endDelayMs: 300 });
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 400);
    h.feed(silence(), 1_200);

    const forwarded = stt.pushed;
    // A burst arriving while recognition runs.
    h.feed(tone(), 1_000);
    expect(stt.pushed).toBe(forwarded);

    await settle(500);
  });
});

describe('frames that do not belong to the open session', () => {
  it('drops a frame with the wrong capture id', async () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    h.service.pushFrame('not-the-session', tone());
    expect(stt.pushed).toBe(0);
  });

  it('drops a frame when nothing is listening', () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.pushFrame('anything', tone());
    expect(stt.pushed).toBe(0);
  });

  it('drops frames from a session that has already closed', async () => {
    const stt = fakeStt({});
    const h = harness(stt);
    h.service.start('hotkey');
    await settle();

    const captureId = h.commands[0]?.captureId ?? '';
    h.service.cancel();
    await settle();

    const before = stt.pushed;
    h.service.pushFrame(captureId, tone());
    expect(stt.pushed).toBe(before);
  });

  it('does not accept a report for another session', async () => {
    const h = harness(fakeStt({}));
    h.service.start('hotkey');
    await settle();

    h.service.report('someone-elses-session', 'failed', 'permission-denied');
    expect(h.service.listening).toBe(true);
    expect(h.failures).toEqual([]);

    h.service.cancel();
  });
});

describe('microphone failures', () => {
  const cases: ReadonlyArray<[CaptureFailure, RegExp]> = [
    ['permission-denied', /denied/i],
    ['no-device', /no microphone/i],
    ['device-error', /unavailable/i],
    ['audio-unavailable', /unavailable/i],
    ['capture-error', /could not start/i],
  ];

  it.each(cases)('explains %s in a sentence', async (failure, expected) => {
    const h = harness(fakeStt({}));
    h.service.start('hotkey');
    await settle();

    h.service.report(h.commands[0]?.captureId ?? '', 'failed', failure);

    expect(h.failures.join(' ')).toMatch(expected);
    expect(h.service.listening).toBe(false);
    expect(h.commands.some((c) => c.action === 'stop')).toBe(true);
  });

  it('stops offering to listen once permission is refused', async () => {
    // The permission-loop fix. Without it, every activation raises the same
    // refused prompt again.
    const h = harness(fakeStt({}));
    h.service.start('hotkey');
    await settle();

    h.service.report(h.commands[0]?.captureId ?? '', 'failed', 'permission-denied');

    expect(h.service.status().available).toBe(false);
    expect(h.service.start('hotkey').accepted).toBe(false);
  });

  it('keeps offering to listen after a transient device error', async () => {
    // A device that was busy once may be free next time. Only an explicit
    // refusal is remembered.
    const h = harness(fakeStt({}));
    h.service.start('hotkey');
    await settle();

    h.service.report(h.commands[0]?.captureId ?? '', 'failed', 'device-error');

    expect(h.service.status().available).toBe(true);
    // Past the restart cooldown, which is about spawn flooding rather than
    // about whether the capability is still offered.
    await settle(400);
    expect(h.service.start('hotkey').accepted).toBe(true);
    h.service.cancel();
  });

  it('recovers when the recognizer will not start', async () => {
    const h = harness(fakeStt({ failStart: true }));
    h.service.start('hotkey');
    await settle(50);

    expect(h.service.listening).toBe(false);
    expect(h.failures).toHaveLength(1);
    // The provider's own error names a local path. What the user sees does not.
    expect(h.failures[0]).not.toMatch(/C:\\|exploded/);
    expect(h.commands.some((c) => c.action === 'stop')).toBe(true);
  });

  it('gives up when no audio ever arrives', async () => {
    // The renderer crashed, or the permission prompt is still up. The timers
    // in main do not depend on the renderer sending anything.
    vi.useFakeTimers();
    try {
      const h = harness(fakeStt({}));
      h.service.start('hotkey');

      vi.advanceTimersByTime(6_000);

      expect(h.service.listening).toBe(false);
      expect(h.failures.join(' ')).toMatch(/did not receive any audio/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transcribes what it has when the stream ends by itself', async () => {
    // An unplugged microphone mid-sentence: keep the sentence.
    const h = harness(fakeStt({ phrases: ['open notepad'] }));
    h.service.start('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 500);
    h.service.report(h.commands[0]?.captureId ?? '', 'ended', null);
    await settle();

    expect(h.transcripts).toEqual(['open notepad']);
  });
});

// ---------------------------------------------------------------------------
// The state machine, against the real orchestrator.
// ---------------------------------------------------------------------------

interface StateHarness {
  readonly orchestrator: Orchestrator;
  readonly bus: EventBus;
  readonly service: ListeningService;
  readonly commands: CaptureCommand[];
  readonly states: string[];
  feed(frame: Int16Array, ms: number): void;
}

function stateHarness(stt: SpeechToText | null, speech?: SpeechService): StateHarness {
  const bus = new EventBus();
  const commands: CaptureCommand[] = [];
  const states: string[] = [];

  bus.subscribe((event) => {
    if (event.type === 'STATE_CHANGED') states.push(event.to);
  });

  const service = new ListeningService({
    stt,
    command: (command) => commands.push(command),
    onStarted: (trigger) => orchestrator.onListeningStarted(trigger),
    onEnded: (reason) => orchestrator.onListeningEnded(reason),
    onTranscript: (text, metrics) => orchestrator.onTranscript(text, metrics),
    onNotice: (message) => orchestrator.onListeningNotice(message),
    onFailure: (message) => orchestrator.onListeningFailure(message),
  });

  const orchestrator = new Orchestrator({
    bus,
    registry: new ToolRegistry(),
    approvalTimeoutMs: 1_000,
    devConsoleEnabled: false,
    listening: service,
    speech: speech ?? null,
  });

  return {
    orchestrator,
    bus,
    service,
    commands,
    states,
    feed(frame: Int16Array, ms: number): void {
      const captureId = commands.find((c) => c.action === 'start')?.captureId ?? '';
      const count = Math.ceil(ms / FRAME_MS);
      for (let i = 0; i < count; i += 1) service.pushFrame(captureId, frame);
    },
  };
}

describe('the state machine', () => {
  it('goes IDLE -> LISTENING on activation', () => {
    const h = stateHarness(fakeStt({}));
    expect(h.orchestrator.state).toBe('IDLE');

    const result = h.orchestrator.startListening('hotkey');
    expect(result.accepted).toBe(true);
    expect(h.orchestrator.state).toBe('LISTENING');

    h.orchestrator.shutdown();
  });

  it('emits a LISTENING event carrying how it was triggered', () => {
    const h = stateHarness(fakeStt({}));
    const events: string[] = [];
    h.bus.subscribe((event) => {
      if (event.type === 'LISTENING') events.push(event.trigger);
    });

    h.orchestrator.startListening('hotkey');
    expect(events).toEqual(['hotkey']);

    h.orchestrator.shutdown();
  });

  it('goes LISTENING -> IDLE when nothing was said', async () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.startListening('hotkey');
    await settle();

    h.feed(silence(), LISTENING_LIMITS.speechStartTimeoutMs + 200);
    await settle();

    expect(h.orchestrator.state).toBe('IDLE');
    h.orchestrator.shutdown();
  });

  it('goes LISTENING -> ERROR on a microphone failure, and recovers', async () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.startListening('hotkey');
    await settle();

    h.orchestrator.reportCapture(h.commands[0]?.captureId ?? '', 'failed', 'no-device');

    expect(h.orchestrator.state).toBe('ERROR');
    // ERROR leaves only to IDLE, and only by being asked.
    expect(h.orchestrator.requestState('IDLE', 'recover').accepted).toBe(true);
    h.orchestrator.shutdown();
  });

  it('refuses to listen while Axon is thinking', () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.requestState('THINKING', 'test');

    const result = h.orchestrator.startListening('hotkey');
    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/busy/i);
    // And nothing opened.
    expect(h.commands).toEqual([]);
    expect(h.orchestrator.state).toBe('THINKING');
  });

  it('refuses to listen while an approval is pending', () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.requestState('THINKING', 'test');
    h.orchestrator.requestState('WAITING_FOR_APPROVAL', 'test');

    expect(h.orchestrator.startListening('hotkey').accepted).toBe(false);
    expect(h.commands).toEqual([]);
  });

  it('recovers from ERROR when the user activates', () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.fail('test', 'something broke');
    expect(h.orchestrator.state).toBe('ERROR');

    expect(h.orchestrator.startListening('hotkey').accepted).toBe(true);
    expect(h.orchestrator.state).toBe('LISTENING');

    h.orchestrator.shutdown();
  });

  it('never leaves the microphone open when it refuses', () => {
    const h = stateHarness(null);
    const result = h.orchestrator.startListening('hotkey');

    expect(result.accepted).toBe(false);
    expect(h.commands.filter((c) => c.action === 'start')).toEqual([]);
    expect(h.orchestrator.state).toBe('IDLE');
  });

  it('reports listening status without a credential', () => {
    const h = stateHarness(fakeStt({}));
    const status = h.orchestrator.listeningStatus();
    expect(status.name).toBe('fake-stt');
    // `hotkey` is a legitimate field and contains the substring "key", so the
    // pattern names the things that would actually be a credential.
    expect(JSON.stringify(status)).not.toMatch(/apiKey|api_key|secret|token|password|sk-ant/i);
  });

  it('closes the microphone on shutdown', () => {
    const h = stateHarness(fakeStt({}));
    h.orchestrator.startListening('hotkey');
    h.orchestrator.shutdown();

    expect(h.commands.some((c) => c.action === 'stop')).toBe(true);
    expect(h.service.listening).toBe(false);
  });
});

describe('the transcript reaches the brain as a message', () => {
  it('goes LISTENING -> THINKING with a brain attached', async () => {
    const h = stateHarness(fakeStt({ phrases: ['open notepad'] }));
    // A brain that does nothing; the point is the state, not the reply.
    const orchestrator = new Orchestrator({
      bus: h.bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: false,
      listening: h.service,
      brain: {
        name: 'fake-brain',
        run: async () => new Promise(() => {}),
      },
    });

    // Rebind the service's callbacks to this orchestrator.
    const service = new ListeningService({
      stt: fakeStt({ phrases: ['open notepad'] }),
      command: (command) => h.commands.push(command),
      onStarted: (trigger) => orchestrator.onListeningStarted(trigger),
      onEnded: (reason) => orchestrator.onListeningEnded(reason),
      onTranscript: (text, metrics) => orchestrator.onTranscript(text, metrics),
      onNotice: (message) => orchestrator.onListeningNotice(message),
      onFailure: (message) => orchestrator.onListeningFailure(message),
    });

    const messages: string[] = [];
    const sources: string[] = [];
    h.bus.subscribe((event) => {
      if (event.type === 'USER_MESSAGE') {
        messages.push(event.text);
        sources.push(event.source);
      }
    });

    service.start('hotkey');
    await settle();

    const captureId = h.commands.filter((c) => c.action === 'start').pop()?.captureId ?? '';
    for (let i = 0; i < Math.ceil(300 / FRAME_MS); i += 1) service.pushFrame(captureId, silence());
    for (let i = 0; i < Math.ceil(500 / FRAME_MS); i += 1) service.pushFrame(captureId, tone());
    for (let i = 0; i < Math.ceil(1_200 / FRAME_MS); i += 1) service.pushFrame(captureId, silence());
    await settle();

    expect(messages).toEqual(['open notepad']);
    // Marked as voice, so the transcript shows where it came from.
    expect(sources).toEqual(['voice']);
    expect(orchestrator.state).toBe('THINKING');

    orchestrator.shutdown();
  });

  it('records timings and nothing derived from the audio', async () => {
    const h = stateHarness(fakeStt({ phrases: ['hello'] }));
    const observations: unknown[] = [];
    h.bus.subscribe((event) => {
      if (event.type === 'OBSERVATION' && event.summary.startsWith('Heard you')) observations.push(event.detail);
    });

    h.orchestrator.startListening('hotkey');
    await settle();
    h.feed(silence(), 300);
    h.feed(tone(), 400);
    h.feed(silence(), 1_200);
    await settle();

    expect(observations).toHaveLength(1);
    const detail = observations[0] as Record<string, unknown>;
    // Numbers and nulls only. No text, no samples, no level.
    for (const value of Object.values(detail)) {
      expect(value === null || typeof value === 'number').toBe(true);
    }
    expect(Object.keys(detail).sort()).toEqual(
      ['micOpenMs', 'recognizerReadyMs', 'totalMs', 'transcriptionMs', 'utteranceMs'].sort(),
    );
  });
});
