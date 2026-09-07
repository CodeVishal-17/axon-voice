/**
 * The voice subsystem: WAV validation, text preparation, and the speech
 * service's lifecycle.
 *
 * The synthesiser here is a fake — deterministic, instant, and with no
 * subprocess — so every branch (failure, cancellation, timeout, oversize,
 * malformed audio) is reachable without SAPI and without a machine that can
 * make a sound. The *real* SAPI adapter is exercised separately, in
 * `voice-integration.test.ts`, which is skipped off Windows.
 *
 * The fakes here are clearly fakes. Nothing in this file pretends to be
 * production audio behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SpeechAudio, SpeechEndReason, TextToSpeech } from '@axon/core';
import { SPEECH_LIMITS } from '@axon/core';
import { parseWav, InvalidWavError } from '../src/main/voice/wav';
import { prepareSpeech } from '../src/main/voice/speech-text';
import { SpeechService, describeSynthesisFailure } from '../src/main/voice/speech-service';
import { SpeechTransport } from '../src/main/voice/speech-transport';
import { createTextToSpeech } from '../src/main/voice/create-tts';

// --- helpers ---------------------------------------------------------------

/**
 * Build a real, well-formed PCM WAV.
 *
 * Genuine bytes with a genuine header, so `parseWav` is doing real work rather
 * than being handed something pre-blessed.
 */
function makeWav(options: { seconds?: number; sampleRate?: number; channels?: number; bits?: number } = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 22050;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const seconds = options.seconds ?? 1;

  const bytesPerFrame = channels * (bits / 8);
  const dataBytes = Math.round(sampleRate * seconds) * bytesPerFrame;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}

/** A synthesiser under the caller's complete control. */
function fakeTts(behaviour: {
  audio?: Uint8Array;
  fail?: Error;
  delayMs?: number;
  available?: boolean;
}): TextToSpeech & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'fake-tts',
    calls,
    isAvailable: () => behaviour.available ?? true,
    synthesize(text: string, signal?: AbortSignal): Promise<SpeechAudio> {
      calls.push(text);
      return new Promise<SpeechAudio>((resolve, reject) => {
        const finish = (): void => {
          if (behaviour.fail) reject(behaviour.fail);
          else
            resolve({
              bytes: behaviour.audio ?? makeWav({ seconds: 0.5 }),
              mimeType: 'audio/wav',
              sampleRate: 22050,
            });
        };
        if (!behaviour.delayMs) return finish();
        const timer = setTimeout(finish, behaviour.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('cancelled');
          (error as unknown as { kind: string }).kind = 'CANCELLED';
          reject(error);
        });
      });
    },
  };
}

interface Harness {
  readonly service: SpeechService;
  readonly delivered: { speechId: string; bytes: Uint8Array; durationMs: number }[];
  readonly stopped: string[];
  readonly started: { speechId: string; characters: number; truncated: boolean }[];
  readonly ended: { speechId: string; reason: SpeechEndReason }[];
  readonly failures: string[];
}

function harness(tts: TextToSpeech | null, graceMs = 50_000): Harness {
  const delivered: Harness['delivered'] = [];
  const stopped: string[] = [];
  const started: Harness['started'] = [];
  const ended: Harness['ended'] = [];
  const failures: string[] = [];

  let seq = 0;
  const service = new SpeechService({
    tts,
    graceMs,
    newSpeechId: () => `sp-${++seq}`,
    deliver: (d) => delivered.push({ speechId: d.speechId, bytes: d.bytes, durationMs: d.durationMs }),
    stopPlayback: (id) => stopped.push(id),
    onStarted: (info) => started.push({ speechId: info.speechId, characters: info.characters, truncated: info.truncated }),
    onEnded: (speechId, reason) => ended.push({ speechId, reason }),
    onFailure: (message) => failures.push(message),
  });

  return { service, delivered, stopped, started, ended, failures };
}

// ---------------------------------------------------------------------------

describe('WAV validation', () => {
  it('measures a real file', () => {
    const info = parseWav(makeWav({ seconds: 2, sampleRate: 22050 }));
    expect(info).toMatchObject({ sampleRate: 22050, channels: 1, bitsPerSample: 16 });
    expect(info.durationMs).toBe(2000);
  });

  it.each([
    [8000, 1],
    [44100, 2],
    [48000, 1],
  ])('handles %iHz with %i channel(s)', (sampleRate, channels) => {
    const info = parseWav(makeWav({ seconds: 1, sampleRate, channels }));
    expect(info.durationMs).toBe(1000);
    expect(info.channels).toBe(channels);
  });

  it('skips an unrecognised chunk before the data', () => {
    // SAPI may emit a LIST or fact chunk; assuming the canonical 44-byte
    // layout would mis-measure the duration when it does.
    const base = makeWav({ seconds: 1 });
    const extra = 16;
    const withChunk = new Uint8Array(base.byteLength + 8 + extra);
    withChunk.set(base.subarray(0, 36), 0);
    const view = new DataView(withChunk.buffer);
    const ascii = (o: number, t: string): void => {
      for (let i = 0; i < t.length; i += 1) view.setUint8(o + i, t.charCodeAt(i));
    };
    ascii(36, 'LIST');
    view.setUint32(40, extra, true);
    withChunk.set(base.subarray(36), 44 + extra);

    expect(parseWav(withChunk).durationMs).toBe(1000);
  });

  it.each([
    ['too short', new Uint8Array(10)],
    ['not RIFF', new Uint8Array(64)],
  ])('rejects audio that is %s', (_label, bytes) => {
    expect(() => parseWav(bytes)).toThrow(InvalidWavError);
  });

  it('rejects non-PCM audio', () => {
    const bytes = makeWav({ seconds: 1 });
    new DataView(bytes.buffer).setUint16(20, 3, true); // IEEE float
    expect(() => parseWav(bytes)).toThrow(/not linear PCM/);
  });

  it('rejects an implausible sample rate', () => {
    const bytes = makeWav({ seconds: 1 });
    new DataView(bytes.buffer).setUint32(24, 1_000_000, true);
    expect(() => parseWav(bytes)).toThrow(/sample rate/);
  });

  it('reports a truncated file as its real length, not its declared one', () => {
    const full = makeWav({ seconds: 2 });
    const cut = full.subarray(0, 44 + Math.floor((full.byteLength - 44) / 2));
    // The header still claims 2s; only half the samples are present.
    expect(parseWav(cut).durationMs).toBeLessThan(1200);
  });
});

describe('preparing text for speech', () => {
  it('passes ordinary text through', () => {
    expect(prepareSpeech('Opened Notepad.')).toMatchObject({ text: 'Opened Notepad.', truncated: false });
  });

  it('treats empty and whitespace-only text as nothing to say', () => {
    expect(prepareSpeech('').text).toBe('');
    expect(prepareSpeech('   \n\t ').text).toBe('');
  });

  it('collapses whitespace runs', () => {
    expect(prepareSpeech('a\n\n\nb   c').text).toBe('a b c');
  });

  it('strips control characters', () => {
    expect(prepareSpeech('safe\u0000text\u0007here').text).toBe('safe text here');
  });

  it('strips bidirectional overrides', () => {
    // A transcript and a spoken sentence must agree about what was said.
    expect(prepareSpeech('hello\u202Eworld').text).toBe('hello world');
  });

  it('truncates an over-long reply', () => {
    const long = 'word '.repeat(2000);
    const prepared = prepareSpeech(long);
    expect(prepared.truncated).toBe(true);
    expect(prepared.characters).toBeLessThanOrEqual(SPEECH_LIMITS.maxCharacters);
  });

  it('prefers a sentence boundary when truncating', () => {
    const text = `${'a'.repeat(90)}. ${'b'.repeat(90)}`;
    expect(prepareSpeech(text, 100).text.endsWith('.')).toBe(true);
  });

  it('does not treat injection-shaped text as anything but words', () => {
    // Nothing here is escaped or removed: it is spoken, because it is content.
    const payload = '$(rm -rf /); DROP TABLE users; <script>x</script>';
    expect(prepareSpeech(payload).text).toBe(payload);
  });
});

describe('the speech service', () => {
  it('synthesises, delivers, and reports the real duration', async () => {
    const h = harness(fakeTts({ audio: makeWav({ seconds: 1.5 }) }));

    expect(await h.service.speak('Hello.')).toBe(true);

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.durationMs).toBe(1500);
    expect(h.started[0]).toMatchObject({ speechId: 'sp-1', characters: 6, truncated: false });
    expect(h.ended).toEqual([]);
  });

  it('ends the utterance when the renderer reports completion', async () => {
    const h = harness(fakeTts({}));
    await h.service.speak('Hello.');

    h.service.report('sp-1', 'ended');

    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'completed' }]);
    expect(h.service.speaking).toBe(false);
  });

  it('ignores a report naming a different utterance', async () => {
    // A stale or fabricated id must not end the utterance in flight.
    const h = harness(fakeTts({}));
    await h.service.speak('Hello.');

    h.service.report('sp-999', 'ended');

    expect(h.ended).toEqual([]);
    expect(h.service.speaking).toBe(true);
  });

  it('ends on its own deadline when the renderer never reports', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(fakeTts({ audio: makeWav({ seconds: 1 }) }), 200);
      await h.service.speak('Hello.');
      expect(h.service.speaking).toBe(true);

      // Duration (1000ms) + grace (200ms). This is the property that makes a
      // stuck SPEAKING state impossible.
      vi.advanceTimersByTime(1201);

      expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'timeout' }]);
      expect(h.service.speaking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when there is no synthesiser', async () => {
    const h = harness(null);
    expect(await h.service.speak('Hello.')).toBe(false);
    expect(h.delivered).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it('says nothing when the synthesiser is unavailable', async () => {
    const h = harness(fakeTts({ available: false }));
    expect(await h.service.speak('Hello.')).toBe(false);
    expect(h.delivered).toEqual([]);
  });

  it('says nothing when there is nothing to say', async () => {
    const h = harness(fakeTts({}));
    expect(await h.service.speak('   ')).toBe(false);
    expect(h.delivered).toEqual([]);
  });

  it('truncates an enormous reply rather than synthesising all of it', async () => {
    const tts = fakeTts({});
    const h = harness(tts);

    await h.service.speak('word '.repeat(5000));

    expect(tts.calls[0]!.length).toBeLessThanOrEqual(SPEECH_LIMITS.maxCharacters);
    expect(h.started[0]?.truncated).toBe(true);
  });

  it('reports a synthesis failure without delivering audio', async () => {
    const failure = Object.assign(new Error('provider exploded'), { kind: 'PROVIDER' });
    const h = harness(fakeTts({ fail: failure }));

    expect(await h.service.speak('Hello.')).toBe(false);

    expect(h.delivered).toEqual([]);
    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'failed' }]);
    expect(h.failures[0]).toContain('synthesiser failed');
    // The provider's own words never reach the user.
    expect(h.failures[0]).not.toContain('exploded');
  });

  it('refuses audio it cannot verify', async () => {
    const h = harness(fakeTts({ audio: new Uint8Array(64) }));

    expect(await h.service.speak('Hello.')).toBe(false);

    expect(h.delivered).toEqual([]);
    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'failed' }]);
  });

  it('cancels cleanly during playback', async () => {
    const h = harness(fakeTts({}));
    await h.service.speak('Hello.');

    expect(h.service.cancel()).toBe(true);

    expect(h.stopped).toEqual(['sp-1']);
    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'cancelled' }]);
    expect(h.service.speaking).toBe(false);
  });

  it('cancels during synthesis without ever delivering audio', async () => {
    const h = harness(fakeTts({ delayMs: 1_000 }));

    const speaking = h.service.speak('Hello.');
    h.service.cancel();
    expect(await speaking).toBe(false);

    expect(h.delivered).toEqual([]);
    // Nothing was delivered, so nothing needed stopping in the renderer.
    expect(h.stopped).toEqual([]);
    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'cancelled' }]);
  });

  it('reports nothing to cancel when silent', () => {
    const h = harness(fakeTts({}));
    expect(h.service.cancel()).toBe(false);
  });

  it('ends each utterance exactly once, however many ways it is ended', async () => {
    const h = harness(fakeTts({}));
    await h.service.speak('Hello.');

    h.service.report('sp-1', 'ended');
    h.service.cancel();
    h.service.report('sp-1', 'ended');

    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'completed' }]);
  });

  it('replaces an utterance in flight rather than overlapping', async () => {
    const h = harness(fakeTts({}));
    await h.service.speak('First.');
    await h.service.speak('Second.');

    expect(h.ended[0]).toEqual({ speechId: 'sp-1', reason: 'cancelled' });
    expect(h.delivered.map((d) => d.speechId)).toEqual(['sp-1', 'sp-2']);
    expect(h.service.speaking).toBe(true);
  });

  it('stops speaking on shutdown', async () => {
    const h = harness(fakeTts({}));
    await h.service.speak('Hello.');

    h.service.shutdown();

    expect(h.ended).toEqual([{ speechId: 'sp-1', reason: 'cancelled' }]);
  });

  it('describes its own availability without leaking anything', () => {
    const available = harness(fakeTts({})).service.status();
    expect(available).toEqual({ available: true, name: 'fake-tts', reason: null });

    const absent = harness(null).service.status();
    expect(absent.available).toBe(false);
    expect(absent.name).toBe('none');
    expect(absent.reason).toBeTruthy();
  });
});

describe('failure descriptions', () => {
  it.each([
    ['UNAVAILABLE', 'stayed silent'],
    ['TIMEOUT', 'too long'],
    ['TOO_LARGE', 'too long to speak'],
    ['PROVIDER', 'synthesiser failed'],
    ['MALFORMED', 'could not verify'],
  ])('describes %s for a person', (kind, expected) => {
    const message = describeSynthesisFailure(Object.assign(new Error('internal detail'), { kind }));
    expect(message).toContain(expected);
    expect(message).not.toContain('internal detail');
  });

  it('has a safe default for an unrecognised failure', () => {
    expect(describeSynthesisFailure(new Error('C:\\Users\\someone\\secret\\path'))).toBe(
      'Axon could not speak that reply.',
    );
  });
});

describe('the speech transport', () => {
  it('drops audio when nothing is attached', () => {
    // Legitimate during shutdown; must not throw.
    const transport = new SpeechTransport();
    expect(() =>
      transport.deliver({
        speechId: 'x',
        mimeType: 'audio/wav',
        sampleRate: 22050,
        bytes: new Uint8Array(0),
        durationMs: 0,
      }),
    ).not.toThrow();
    expect(() => transport.stop('x')).not.toThrow();
  });

  it('delivers to an attached sink and stops after detach', () => {
    const transport = new SpeechTransport();
    const delivered: string[] = [];
    transport.attach({ deliver: (d) => delivered.push(d.speechId), chunk: () => {}, stop: () => {} });

    const payload = {
      speechId: 'a',
      mimeType: 'audio/wav' as const,
      sampleRate: 22050,
      bytes: new Uint8Array(0),
      durationMs: 0,
    };
    transport.deliver(payload);
    transport.detach();
    transport.deliver({ ...payload, speechId: 'b' });

    expect(delivered).toEqual(['a']);
  });
});

describe('choosing a synthesiser', () => {
  it('uses Windows SAPI on Windows', () => {
    const created = createTextToSpeech({ platform: 'win32', provider: undefined });
    expect(created.tts?.name).toBe('windows-sapi');
    expect(created.unavailableReason).toBeNull();
  });

  it.each(['darwin', 'linux'] as NodeJS.Platform[])('has no voice on %s, and says why', (platform) => {
    const created = createTextToSpeech({ platform, provider: undefined });
    expect(created.tts).toBeNull();
    expect(created.unavailableReason).toContain('unavailable');
  });

  it('can be turned off explicitly', () => {
    const created = createTextToSpeech({ platform: 'win32', provider: 'none' });
    expect(created.tts).toBeNull();
    expect(created.unavailableReason).toContain('turned off');
  });

  it('refuses an unknown provider rather than guessing', () => {
    const created = createTextToSpeech({ platform: 'win32', provider: 'elevenlabs' });
    expect(created.tts).toBeNull();
    expect(created.unavailableReason).toContain('Unknown speech provider');
  });

  it('bounds what it echoes back from configuration', () => {
    const created = createTextToSpeech({ platform: 'win32', provider: 'x'.repeat(500) });
    expect(created.unavailableReason!.length).toBeLessThan(120);
  });
});
