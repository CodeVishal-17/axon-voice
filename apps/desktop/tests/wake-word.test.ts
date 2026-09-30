/**
 * The wake-word detector's behaviour.
 *
 * The phrase MATCHER is tested in `agent-voice-security.test.ts`, beside the
 * privacy rules it exists to serve. What is tested here is the DETECTOR: its
 * lifecycle, and specifically that every path out of "armed" closes the
 * recognizer.
 *
 * That is the property worth spending a test file on. A detector that can be
 * disarmed while its recognizer keeps running is a microphone the user
 * believes is off, and there is no worse bug in this product.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CaptureCommand, SpeechToText, SpeechToTextSession, TranscriptChunk } from '@axon/core';
import { WakeWordDetector, decideWake, WAKE_ACTIVITY_OPTIONS, WAKE_MIN_CONFIDENCE } from '../src/main/wake/wake-word.js';
import { VoiceActivityDetector } from '../src/main/voice/vad.js';

/** The activity detector the runtime hands the wake word, configured the same way. */
const activity = (): VoiceActivityDetector => new VoiceActivityDetector(WAKE_ACTIVITY_OPTIONS);
import { MicGate } from '../src/main/voice/mic-gate.js';
import { CaptureTransport } from '../src/main/voice/capture-transport.js';

/** A recognizer that records what it was asked to do. */
function fakeStt(options: { available?: boolean; failStart?: boolean } = {}) {
  const sessions: { pushed: number; ended: boolean; closed: boolean }[] = [];
  let emit: ((chunk: TranscriptChunk) => void) | null = null;

  const stt: SpeechToText = {
    name: 'fake',
    sampleRate: 16_000,
    isAvailable: () => options.available ?? true,
    start: (onChunk) => {
      if (options.failStart) return Promise.reject(new Error('no recognizer'));
      emit = onChunk;

      const record = { pushed: 0, ended: false, closed: false };
      sessions.push(record);

      const session: SpeechToTextSession = {
        push: () => {
          record.pushed += 1;
        },
        end: () => {
          record.ended = true;
          return Promise.resolve();
        },
        close: () => {
          record.closed = true;
        },
      };
      return Promise.resolve(session);
    },
  };

  return {
    stt,
    sessions,
    /** Feed a transcript as the recognizer would. */
    hear: (text: string, isFinal = true): void => {
      emit?.({ text, isFinal, confidence: null });
    },
  };
}

/** A frame of speech-loud audio: a 220Hz tone at a normal speaking level. */
function tone(samples = 1024): Int16Array {
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) frame[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 8_000);
  return frame;
}

/** Let promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function detector(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  return makeOptions(overrides);
}

function makeOptions(options: {
  stt?: SpeechToText | null;
  windowMs?: number;
}) {
  const wakes: number[] = [];
  const armedChanges: boolean[] = [];
  const notices: string[] = [];

  const instance = new WakeWordDetector({
    stt: options.stt ?? null,
    activity,
    windowMs: options.windowMs,
    onWake: () => wakes.push(Date.now()),
    onArmedChanged: (armed) => armedChanges.push(armed),
    onNotice: (message) => notices.push(message),
  });

  return { instance, wakes, armedChanges, notices };
}

describe('arming and disarming', () => {
  it('opens a local recognizer when armed', async () => {
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });

    expect(await d.instance.arm()).toBe(true);
    expect(d.instance.isArmed).toBe(true);
    expect(fake.sessions).toHaveLength(1);
    expect(d.armedChanges).toEqual([true]);
  });

  it('closes the recognizer when disarmed', async () => {
    // The assertion this file exists for. "Disarmed" must mean the recognizer
    // is closed, not merely that a flag flipped.
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    d.instance.disarm();

    expect(d.instance.isArmed).toBe(false);
    expect(fake.sessions[0]?.closed).toBe(true);
    expect(d.armedChanges).toEqual([true, false]);
  });

  it('is idempotent in both directions', async () => {
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });

    await d.instance.arm();
    await d.instance.arm();
    expect(fake.sessions).toHaveLength(1);

    d.instance.disarm();
    d.instance.disarm();
    expect(d.armedChanges).toEqual([true, false]);
  });

  it('refuses to arm with no local recognizer, and says why', async () => {
    const d = detector({ stt: null });

    expect(await d.instance.arm()).toBe(false);
    expect(d.instance.isArmed).toBe(false);
    expect(d.notices[0]).toMatch(/no local recognizer/i);
  });

  it('refuses to arm when the recognizer is unavailable on this system', async () => {
    const fake = fakeStt({ available: false });
    const d = detector({ stt: fake.stt });

    expect(await d.instance.arm()).toBe(false);
    expect(fake.sessions).toHaveLength(0);
  });

  it('reports a recognizer that will not start, once, and stays disarmed', async () => {
    // An assistant that complains every sixty seconds is worse than one that
    // is quietly not listening and says so in the UI.
    const fake = fakeStt({ failStart: true });
    const d = detector({ stt: fake.stt });

    await d.instance.arm();

    expect(d.instance.isArmed).toBe(false);
    expect(d.notices).toHaveLength(1);
    expect(d.armedChanges).toEqual([true, false]);
  });
});

describe('hearing the phrase', () => {
  it('fires once on the wake phrase', async () => {
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    fake.hear('Hey Axon');
    expect(d.wakes).toHaveLength(1);
  });

  it('ignores anything that is not the phrase', async () => {
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    for (const heard of ['what time is it', 'the axon terminal', 'hello there', 'hi how are you']) {
      fake.hear(heard);
    }
    expect(d.wakes).toHaveLength(0);
  });

  it('ignores interim results', async () => {
    // A phrase the recognizer is still revising is not a phrase somebody said,
    // and waking on one would open a socket on a guess.
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    fake.hear('hey axon', false);
    expect(d.wakes).toHaveLength(0);

    fake.hear('hey axon', true);
    expect(d.wakes).toHaveLength(1);
  });

  it('does not fire after being disarmed', async () => {
    // The race that matters: a transcript already in flight when the user
    // turned the wake word off must not start a session.
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    d.instance.disarm();
    fake.hear('hey axon');

    expect(d.wakes).toHaveLength(0);
  });
});

describe('audio handling', () => {
  it('forwards frames to the local recognizer only', async () => {
    // Speech, not silence: since the wake word segments utterances, silence
    // reaches no recognizer at all (see "segmenting speech" below). What this
    // still asserts is the destination — the recognizer the detector owns,
    // and nothing else.
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    for (let i = 0; i < 6; i += 1) d.instance.pushFrame(new Int16Array(1024));
    for (let i = 0; i < 8; i += 1) d.instance.pushFrame(tone());
    await settle();

    expect(fake.sessions[0]?.pushed).toBeGreaterThan(0);
  });

  it('drops a frame when not armed', async () => {
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();
    d.instance.disarm();

    d.instance.pushFrame(new Int16Array(1024));
    expect(fake.sessions[0]?.pushed).toBe(0);
  });

  it('drops an oversized frame rather than clamping it', async () => {
    // A clamp teaches a caller that an out-of-range value is acceptable.
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    d.instance.pushFrame(new Int16Array(0));
    d.instance.pushFrame(new Int16Array(100_000));

    expect(fake.sessions[0]?.pushed).toBe(0);
  });
});

describe('recycling the recognition window', () => {
  it('opens a fresh window and closes the old one', async () => {
    // A long-lived engine accumulates state; a bounded window means one that
    // wedges recovers on its own rather than leaving Axon silently deaf.
    vi.useFakeTimers();
    try {
      const fake = fakeStt();
      const d = detector({ stt: fake.stt, windowMs: 1_000 });
      await d.instance.arm();

      await vi.advanceTimersByTimeAsync(1_100);
      // Let the async recycle settle.
      await vi.advanceTimersByTimeAsync(10);

      expect(fake.sessions.length).toBeGreaterThanOrEqual(2);
      expect(fake.sessions[0]?.closed).toBe(true);
      d.instance.disarm();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recycle after being disarmed', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeStt();
      const d = detector({ stt: fake.stt, windowMs: 1_000 });
      await d.instance.arm();
      d.instance.disarm();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(fake.sessions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});


// ---------------------------------------------------------------------------
// Segmenting speech — the fix for a wake word that did not work.
// ---------------------------------------------------------------------------

/** A detector on a controllable clock, collecting everything it reports. */
async function clocked(options: { debug?: boolean } = {}) {
  const fake = fakeStt();
  let t = 1_000;
  const wakes: number[] = [];
  const lines: string[] = [];
  const instance = new WakeWordDetector({
    stt: fake.stt,
    activity,
    onWake: () => wakes.push(t),
    onArmedChanged: () => {},
    onNotice: () => {},
    now: () => t,
    ...(options.debug ? { debug: (line: string) => lines.push(line) } : {}),
  });
  await instance.arm();
  const push = (frame: Int16Array, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      t += 64;
      instance.pushFrame(frame);
    }
  };
  return { fake, instance, wakes, lines, push, advance: (ms: number) => { t += ms; } };
}

describe('segmenting speech', () => {
  it('sends silence to no recognizer at all', async () => {
    const r = await clocked();
    r.push(new Int16Array(1024), 60);
    await settle();
    expect(r.fake.sessions.every((session) => session.pushed === 0)).toBe(true);
  });

  it('hands one spoken utterance, with the moment before it, to a warm recognizer and ends it', async () => {
    // THE BUG THIS REPLACES: audio went into a sixty-second window that was
    // only recognised when it closed, and was dropped after twenty-five
    // seconds. Now an utterance is recognised as soon as the speaker pauses.
    const r = await clocked();
    r.push(new Int16Array(1024), 8); // the room
    r.push(tone(), 12); // "hey axon"
    r.push(new Int16Array(1024), 12); // a pause
    await settle();

    const used = r.fake.sessions[0];
    expect(used?.pushed).toBeGreaterThan(12); // the speech, plus the pre-roll before its onset
    expect(used?.ended).toBe(true);
  });

  it('warms the next recognizer while the first is busy', async () => {
    const r = await clocked();
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 12);
    await settle();
    expect(r.fake.sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('cuts continuous sound at the utterance ceiling rather than listening forever', async () => {
    const r = await clocked();
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 60); // ~3.8s of sound with no pause
    await settle();
    expect(r.fake.sessions[0]?.ended).toBe(true);
  });

  it('never joins audio across a gap in the capture', async () => {
    // The microphone was lent to a conversation and given back: the half an
    // utterance before the gap and the audio after it are not one phrase.
    const r = await clocked();
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 6);
    await settle();
    r.advance(5_000);
    r.push(new Int16Array(1024), 2);
    await settle();
    expect(r.fake.sessions[0]?.closed).toBe(true);
    expect(r.fake.sessions[0]?.ended).toBe(false);
  });

  it('asks the recognizer for the wake grammar, not free dictation', async () => {
    const modes: (string | undefined)[] = [];
    const stt: SpeechToText = {
      name: 'mode-recorder',
      sampleRate: 16_000,
      isAvailable: () => true,
      start: (_onChunk, options) => {
        modes.push(options?.mode);
        return Promise.resolve({ push: () => {}, end: () => Promise.resolve(), close: () => {} });
      },
    };
    const instance = new WakeWordDetector({ stt, activity, onWake: () => {}, onArmedChanged: () => {}, onNotice: () => {} });
    await instance.arm();
    expect(modes).toEqual(['wake']);
    instance.disarm();
  });

  it('closes every recognizer it opened when disarmed, including the busy one', async () => {
    const r = await clocked();
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 6);
    await settle();
    r.instance.disarm();
    await settle();
    expect(r.fake.sessions.every((session) => session.closed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deciding — only the wake grammar, confidently, wakes Axon.
// ---------------------------------------------------------------------------

describe('deciding whether a result wakes Axon', () => {
  const chunk = (text: string, source: TranscriptChunk['source'], confidence: number | null = 0.8) => ({
    text,
    isFinal: true,
    confidence,
    ...(source ? { source } : {}),
  });

  it('wakes on each wake phrase from the wake grammar', () => {
    for (const phrase of ['hey axon', 'hello axon', 'hi axon']) {
      expect(decideWake(chunk(phrase, 'wake-phrase')).wake, phrase).toBe(true);
    }
  });

  it('does not wake on a wake-grammar result below the confidence floor', () => {
    expect(decideWake(chunk('hey axon', 'wake-phrase', WAKE_MIN_CONFIDENCE - 0.01)).wake).toBe(false);
    expect(decideWake(chunk('hey axon', 'wake-phrase', WAKE_MIN_CONFIDENCE)).wake).toBe(true);
  });

  it('never wakes on ordinary dictated speech that mentions the name', () => {
    for (const heard of [
      'I was talking about axon yesterday',
      'axon',
      'hey',
      'hello',
      'hi',
      'hey axon how are you', // a sentence, not the phrase
      'a exxon', // what dictation made of "Hey Axon" — the grammar handles that, not a looser match
      'hey axin',
      'hey axton',
    ]) {
      expect(decideWake(chunk(heard, 'dictation')).wake, heard).toBe(false);
    }
  });

  it('wakes on dictation only when the whole utterance is exactly a wake phrase', () => {
    expect(decideWake(chunk('Hey, Axon!', 'dictation')).wake).toBe(true);
    expect(decideWake(chunk('hello axon', 'dictation', 0.2)).wake).toBe(false);
  });

  it('never wakes on an interim result, whatever it says', () => {
    expect(decideWake({ text: 'hey axon', isFinal: false, confidence: 0.99, source: 'wake-phrase' }).wake).toBe(false);
  });

  it('rejects a wake-grammar result that is not one of the three phrases', () => {
    expect(decideWake(chunk('hey there', 'wake-phrase')).wake).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Debug mode — enough to answer "what did Windows hear?", and nothing more.
// ---------------------------------------------------------------------------

describe('wake-word debug mode', () => {
  it('says nothing unless it was asked to', async () => {
    const r = await clocked();
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 12);
    r.push(new Int16Array(1024), 12);
    r.fake.hear('hey axon');
    await settle();
    expect(r.lines).toEqual([]);
  });

  it('reports the microphone, the utterance, what was heard and the decision', async () => {
    const r = await clocked({ debug: true });
    r.push(new Int16Array(1024), 8);
    r.push(tone(), 12);
    r.push(new Int16Array(1024), 12);
    await settle();
    r.fake.hear('Hey, Axon!');
    await settle();

    const log = r.lines.join('\n');
    expect(log).toMatch(/local recognizer ready/);
    expect(log).toMatch(/microphone audio is arriving/);
    expect(log).toMatch(/speech started/);
    expect(log).toMatch(/utterance of \d+ms handed to the local recognizer/);
    expect(log).toMatch(/heard \[text \?\] "Hey, Axon!" -> "hey axon" -> ACTIVATE/);
    expect(r.wakes).toHaveLength(1);
  });

  it('never prints audio', async () => {
    const r = await clocked({ debug: true });
    r.push(tone(), 100);
    await settle();
    // No run of sample values, and no line long enough to be carrying a buffer.
    for (const line of r.lines) {
      expect(line).not.toMatch(/-?\d{3,}\s*,\s*-?\d{3,}\s*,/);
      expect(line.length).toBeLessThan(300);
    }
  });
});


// ---------------------------------------------------------------------------
// The microphone permission window.
// ---------------------------------------------------------------------------

describe('MicGate', () => {
  it('is shut until main asks for a capture', () => {
    // The resting state, and the one that matters: page code calling
    // getUserMedia unprompted is refused because nothing opened a window.
    const gate = new MicGate();
    expect(gate.open).toBe(false);
    expect(gate.expecting).toBeNull();
  });

  it('opens for a capture main minted, and closes when it is reported', () => {
    const gate = new MicGate();
    gate.expect('capture-1');
    expect(gate.open).toBe(true);
    expect(gate.expecting).toBe('capture-1');

    gate.settle('capture-1');
    expect(gate.open).toBe(false);
  });

  it('closes on its own deadline, whatever the renderer does', () => {
    // The bound that makes the wake word safe. A renderer that never reports —
    // crashed, hung, or lying — cannot hold the permission open.
    let now = 0;
    const gate = new MicGate({ windowMs: 1_000, now: () => now });
    gate.expect('capture-1');
    expect(gate.open).toBe(true);

    now = 1_500;
    expect(gate.open).toBe(false);
  });

  it('ignores a report about some other capture', () => {
    // A stale, replayed or invented report must not close a window main just
    // opened — and must not open one either.
    const gate = new MicGate();
    gate.expect('capture-1');

    gate.settle('capture-someone-else-made-up');
    expect(gate.open).toBe(true);
    expect(gate.expecting).toBe('capture-1');
  });

  it('cannot be opened by settling an id nobody asked for', () => {
    const gate = new MicGate();
    gate.settle('capture-1');
    expect(gate.open).toBe(false);
  });

  it('shuts unconditionally on shutdown', () => {
    const gate = new MicGate();
    gate.expect('capture-1');
    gate.closeAll();
    expect(gate.open).toBe(false);
  });

  it('stays open across a long wake-word session only in short bursts', () => {
    // The property the whole design turns on. Arming opens one window; hours
    // of listening later, the gate is still shut, because Chromium checks
    // permission at getUserMedia time and not continuously.
    let now = 0;
    const gate = new MicGate({ windowMs: 5_000, now: () => now });

    gate.expect('wake-capture');
    expect(gate.open).toBe(true);

    // The renderer opens the device and reports, a few hundred ms later.
    now = 300;
    gate.settle('wake-capture');

    // Two hours of listening.
    now = 2 * 60 * 60 * 1000;
    expect(gate.open).toBe(false);
  });
});

describe('every capture command opens the permission window', () => {
  it('opens on start and closes on stop, through the one transport', () => {
    // The transport is the single choke point for capture commands, which is
    // why the window is opened there. A command that did not open the gate
    // would ask the renderer for a microphone it would then be refused.
    const gate = new MicGate();
    const transport = new CaptureTransport(gate);
    const sent: CaptureCommand[] = [];
    transport.attach({ command: (command) => sent.push(command) });

    transport.command({ action: 'start', captureId: 'c1', sampleRate: 24_000 });
    expect(gate.open).toBe(true);

    transport.command({ action: 'stop', captureId: 'c1', sampleRate: 24_000 });
    expect(gate.open).toBe(false);

    expect(sent.map((c) => c.action)).toEqual(['start', 'stop']);
  });

  it('works with no gate at all, for tests that do not need one', () => {
    const transport = new CaptureTransport();
    const sent: CaptureCommand[] = [];
    transport.attach({ command: (command) => sent.push(command) });
    transport.command({ action: 'start', captureId: 'c1', sampleRate: 16_000 });
    expect(sent).toHaveLength(1);
  });
});
