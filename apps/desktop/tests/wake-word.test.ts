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
import { WakeWordDetector } from '../src/main/wake/wake-word.js';
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
    const fake = fakeStt();
    const d = detector({ stt: fake.stt });
    await d.instance.arm();

    d.instance.pushFrame(new Int16Array(1024));
    d.instance.pushFrame(new Int16Array(1024));

    expect(fake.sessions[0]?.pushed).toBe(2);
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
