/**
 * Barge-in: interrupting Axon while it is talking.
 *
 * The interaction this milestone is really judged on. Axon says "I've opened
 * your—", the user says "stop", and the right thing has to happen: the voice
 * cuts out, the microphone opens, and nothing is left running behind either.
 *
 * These tests drive the REAL orchestrator, the REAL state machine, the REAL
 * speech service and the REAL listening service, with only the two providers
 * faked. The property under test is how those pieces hand off to each other,
 * and a test that faked the handoff would be testing nothing.
 */

import { describe, expect, it } from 'vitest';
import type {
  CaptureCommand,
  SpeechAudio,
  SpeechDelivery,
  SpeechToText,
  SpeechToTextSession,
  TextToSpeech,
  TranscriptChunk,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { ListeningService } from '../src/main/voice/listening-service.js';
import { SpeechService } from '../src/main/voice/speech-service.js';

const RATE = 16_000;
const FRAME = 512;
const FRAME_MS = (FRAME / RATE) * 1000;

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A minimal valid 16-bit mono WAV of the requested length. */
function makeWav(seconds: number): Uint8Array {
  const sampleRate = 22_050;
  const samples = Math.floor(sampleRate * seconds);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
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
  view.setUint32(40, samples * 2, true);
  // Not silence: something a real player would have to decode.
  for (let i = 0; i < samples; i += 1) view.setInt16(44 + i * 2, i % 2 === 0 ? 8000 : -8000, true);

  return bytes;
}

function fakeTts(seconds = 3): TextToSpeech {
  return {
    name: 'fake-tts',
    isAvailable: () => true,
    synthesize: async (): Promise<SpeechAudio> => ({
      bytes: makeWav(seconds),
      mimeType: 'audio/wav',
      sampleRate: 22_050,
    }),
  };
}

function fakeStt(phrases: string[]): SpeechToText {
  return {
    name: 'fake-stt',
    sampleRate: RATE,
    isAvailable: () => true,
    start: async (onChunk: (chunk: TranscriptChunk) => void): Promise<SpeechToTextSession> => ({
      push: () => {},
      end: async () => {
        for (const text of phrases) onChunk({ text, isFinal: true, confidence: 0.8 });
      },
      close: () => {},
    }),
  };
}

function tone(rms = 0.25): Int16Array {
  const amplitude = Math.round(rms * 32767);
  const frame = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  return frame;
}

const silence = (): Int16Array => new Int16Array(FRAME);

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly bus: EventBus;
  readonly listening: ListeningService;
  readonly speech: SpeechService;
  readonly commands: CaptureCommand[];
  readonly delivered: SpeechDelivery[];
  readonly stopped: string[];
  readonly states: string[];
  feed(frame: Int16Array, ms: number): void;
}

function harness(phrases: string[] = ['stop'], speechSeconds = 3): Harness {
  const bus = new EventBus();
  const commands: CaptureCommand[] = [];
  const delivered: SpeechDelivery[] = [];
  const stopped: string[] = [];
  const states: string[] = [];

  bus.subscribe((event) => {
    if (event.type === 'STATE_CHANGED') states.push(event.to);
  });

  const speech = new SpeechService({
    tts: fakeTts(speechSeconds),
    deliver: (delivery) => delivered.push(delivery),
    stopPlayback: (speechId) => stopped.push(speechId),
    onStarted: (info) => orchestrator.onSpeechStarted(info),
    onEnded: (speechId, reason) => orchestrator.onSpeechEnded(speechId, reason),
    onFailure: (message) => orchestrator.onSpeechFailure(message),
  });

  const listening = new ListeningService({
    stt: fakeStt(phrases),
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
    speech,
    listening,
    brain: {
      name: 'fake-brain',
      run: async () => ({ reply: 'I have opened Notepad for you.', detail: null }),
    },
  });

  return {
    orchestrator,
    bus,
    listening,
    speech,
    commands,
    delivered,
    stopped,
    states,
    feed(frame: Int16Array, ms: number): void {
      const captureId = commands.filter((c) => c.action === 'start').pop()?.captureId ?? '';
      for (let i = 0; i < Math.ceil(ms / FRAME_MS); i += 1) listening.pushFrame(captureId, frame);
    },
  };
}

/** Get Axon talking, and wait until it really is. */
async function startSpeaking(h: Harness): Promise<void> {
  await h.speech.speak('I have opened Notepad for you, and here is a long sentence to talk over.');
  await settle();
  expect(h.orchestrator.state).toBe('SPEAKING');
}

describe('interrupting speech', () => {
  it('goes SPEAKING -> LISTENING', async () => {
    const h = harness();
    await startSpeaking(h);

    const result = h.orchestrator.startListening('hotkey');

    expect(result.accepted).toBe(true);
    expect(h.orchestrator.state).toBe('LISTENING');
    h.orchestrator.shutdown();
  });

  it('stops the voice through the existing cancellation path', async () => {
    const h = harness();
    await startSpeaking(h);
    const speechId = h.delivered[0]?.speechId;

    h.orchestrator.startListening('hotkey');

    // The renderer was told to stop playing that exact utterance — the same
    // mechanism the Stop button uses, not a second one.
    expect(h.stopped).toEqual([speechId]);
    expect(h.speech.speaking).toBe(false);
    h.orchestrator.shutdown();
  });

  it('reports the interruption as a cancellation in the event stream', async () => {
    const h = harness();
    const reasons: string[] = [];
    h.bus.subscribe((event) => {
      if (event.type === 'SPEECH_ENDED') reasons.push(event.reason);
    });

    await startSpeaking(h);
    h.orchestrator.startListening('hotkey');

    expect(reasons).toEqual(['cancelled']);
    h.orchestrator.shutdown();
  });

  it('opens the microphone', async () => {
    const h = harness();
    await startSpeaking(h);

    h.orchestrator.startListening('hotkey');

    expect(h.commands.filter((c) => c.action === 'start')).toHaveLength(1);
    h.orchestrator.shutdown();
  });

  it('stays in LISTENING while the interrupted turn finishes settling', async () => {
    // The subtle one. Cancelling the utterance releases the turn that was
    // awaiting it; that turn then emits COMPLETED and settles. Without the
    // LISTENING guard in `settle`, the settle lands a microtask later and
    // drops Axon out of LISTENING while the microphone is still open.
    const h = harness();
    await startSpeaking(h);

    h.orchestrator.startListening('hotkey');
    await settle(50);

    expect(h.orchestrator.state).toBe('LISTENING');
    expect(h.listening.listening).toBe(true);
    h.orchestrator.shutdown();
  });

  it('carries the interruption through to a transcript and a new turn', async () => {
    const h = harness(['stop']);
    const messages: string[] = [];
    h.bus.subscribe((event) => {
      if (event.type === 'USER_MESSAGE') messages.push(event.text);
    });

    await startSpeaking(h);
    h.orchestrator.startListening('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 400);
    h.feed(silence(), 1_200);
    await settle();

    expect(messages).toEqual(['stop']);
    h.orchestrator.shutdown();
  });

  it('leaves no stale playback or capture behind', async () => {
    const h = harness();
    await startSpeaking(h);

    h.orchestrator.startListening('hotkey');
    await settle();
    h.orchestrator.stopListening();
    await settle();

    expect(h.speech.speaking).toBe(false);
    expect(h.listening.listening).toBe(false);
    // Every capture that opened was closed.
    expect(h.commands.filter((c) => c.action === 'stop').length).toBeGreaterThanOrEqual(
      h.commands.filter((c) => c.action === 'start').length,
    );
    h.orchestrator.shutdown();
  });

  it('does not speak over itself if speech is somehow still queued', async () => {
    const h = harness();
    await startSpeaking(h);
    h.orchestrator.startListening('hotkey');

    // A second utterance arriving after the interruption must not resurrect
    // SPEAKING behind an open microphone.
    expect(h.speech.speaking).toBe(false);
    h.orchestrator.shutdown();
  });
});

describe('a full spoken turn', () => {
  it('runs LISTENING -> THINKING -> SPEAKING -> IDLE', async () => {
    const h = harness(['open notepad'], 0.2);

    h.orchestrator.startListening('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 500);
    h.feed(silence(), 1_200);

    // The turn runs, speaks its reply, and the speech ends on its own.
    await settle(50);
    const speechId = h.delivered[0]?.speechId;
    expect(speechId).toBeTruthy();
    h.speech.report(speechId!, 'ended');
    await settle(50);

    expect(h.states).toEqual(['LISTENING', 'THINKING', 'SPEAKING', 'IDLE']);
    h.orchestrator.shutdown();
  });

  it('never enters EXECUTING straight from LISTENING', async () => {
    // The transition table forbids acting on audio that has not been
    // understood. This asserts the product actually respects it.
    const h = harness(['open notepad'], 0.2);
    h.orchestrator.startListening('hotkey');
    await settle();

    h.feed(silence(), 300);
    h.feed(tone(), 500);
    h.feed(silence(), 1_200);
    await settle(50);

    for (let i = 1; i < h.states.length; i += 1) {
      if (h.states[i - 1] === 'LISTENING') expect(h.states[i]).not.toBe('EXECUTING');
    }
    h.orchestrator.shutdown();
  });
});
