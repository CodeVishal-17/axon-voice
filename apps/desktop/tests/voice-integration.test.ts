/**
 * The real Windows synthesiser.
 *
 * Everything else in the voice suite uses a fake so the branches are
 * deterministic. This file uses SAPI itself — it spawns PowerShell, renders
 * actual speech, and asserts against the actual bytes that come back.
 *
 * It needs no API key and no network, so it runs by default. Off Windows it
 * skips: SAPI is a Windows facility and pretending otherwise would be the kind
 * of fake this milestone was explicit about avoiding.
 *
 * These are slow by unit-test standards (a second or so each) because they are
 * doing real work. That is the point of them.
 */

import { describe, expect, it } from 'vitest';
import { SapiTextToSpeech, SpeechSynthesisError } from '../src/main/voice/sapi-tts';
import { SpeechService } from '../src/main/voice/speech-service';
import { parseWav } from '../src/main/voice/wav';
import type { SpeechDelivery, SpeechEndReason } from '@axon/core';

const onWindows = process.platform === 'win32';

/** Generous: a cold PowerShell start plus assembly load is not instant. */
const TIMEOUT = 45_000;

describe.skipIf(!onWindows)('Windows SAPI, for real', () => {
  it(
    'renders speech to a valid PCM WAV',
    async () => {
      const tts = new SapiTextToSpeech();
      expect(tts.isAvailable()).toBe(true);

      const audio = await tts.synthesize('Axon is ready.');

      expect(audio.mimeType).toBe('audio/wav');
      expect(audio.bytes.byteLength).toBeGreaterThan(1000);

      // Real bytes, parsed by the real parser.
      const info = parseWav(audio.bytes);
      expect(info.channels).toBeGreaterThanOrEqual(1);
      expect(info.bitsPerSample).toBe(16);
      expect(info.durationMs).toBeGreaterThan(300);
      expect(audio.sampleRate).toBe(info.sampleRate);
    },
    TIMEOUT,
  );

  it(
    'produces audio whose length tracks the text',
    async () => {
      const tts = new SapiTextToSpeech();

      const short = await tts.synthesize('Yes.');
      const long = await tts.synthesize(
        'Yes, I opened Notepad for you, and I also wrote the file you asked about to your desktop.',
      );

      expect(parseWav(long.bytes).durationMs).toBeGreaterThan(parseWav(short.bytes).durationMs * 2);
    },
    TIMEOUT,
  );

  it(
    'produces audio that is not silence',
    async () => {
      // A synthesiser that returned a correctly-formed buffer of zeros would
      // pass every structural check and drive the orb to a flat line.
      const tts = new SapiTextToSpeech();
      const audio = await tts.synthesize('Testing, one, two, three.');
      const info = parseWav(audio.bytes);

      const samples = new Int16Array(
        audio.bytes.buffer.slice(audio.bytes.byteOffset + 44, audio.bytes.byteOffset + 44 + info.dataBytes),
      );
      let sumSquares = 0;
      for (const sample of samples) sumSquares += (sample / 32768) * (sample / 32768);
      const rms = Math.sqrt(sumSquares / samples.length);

      expect(rms).toBeGreaterThan(0.005);
    },
    TIMEOUT,
  );

  it(
    'speaks injection-shaped text instead of executing it',
    async () => {
      // The security property, tested against the real subprocess: this text
      // is spoken word by word. If any of it were interpreted, the child would
      // fail or behave differently — instead it renders normally.
      const payload = '$(Write-Output PWNED); rm -rf /; & calc.exe';
      const tts = new SapiTextToSpeech();

      const audio = await tts.synthesize(payload);

      expect(parseWav(audio.bytes).durationMs).toBeGreaterThan(1000);
    },
    TIMEOUT,
  );

  it(
    'handles text with quotes, newlines and non-ASCII',
    async () => {
      const tts = new SapiTextToSpeech();
      const audio = await tts.synthesize('She said "hello" —\nthen \'goodbye\'. Café; 100% done.');
      expect(parseWav(audio.bytes).durationMs).toBeGreaterThan(500);
    },
    TIMEOUT,
  );

  it(
    'refuses empty text without spawning anything',
    async () => {
      const tts = new SapiTextToSpeech();
      await expect(tts.synthesize('   ')).rejects.toMatchObject({ kind: 'EMPTY' });
    },
    TIMEOUT,
  );

  it(
    'cancels a synthesis in flight',
    async () => {
      const tts = new SapiTextToSpeech();
      const controller = new AbortController();

      const pending = tts.synthesize('A reasonably long sentence to give us time to cancel it.', controller.signal);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ kind: 'CANCELLED' });
    },
    TIMEOUT,
  );

  it(
    'refuses to start when already aborted',
    async () => {
      const tts = new SapiTextToSpeech();
      const controller = new AbortController();
      controller.abort();

      await expect(tts.synthesize('Hello.', controller.signal)).rejects.toBeInstanceOf(SpeechSynthesisError);
    },
    TIMEOUT,
  );

  it(
    'reports a failure rather than hanging when the provider cannot start',
    async () => {
      const tts = new SapiTextToSpeech({ executable: 'definitely-not-a-real-program-xyz.exe' });
      await expect(tts.synthesize('Hello.')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    },
    TIMEOUT,
  );

  it(
    'abandons synthesis that takes too long',
    async () => {
      // 1ms is never enough to start PowerShell, so this exercises the real
      // timeout path including killing the child.
      const tts = new SapiTextToSpeech({ timeoutMs: 1 });
      await expect(tts.synthesize('Hello.')).rejects.toMatchObject({ kind: 'TIMEOUT' });
    },
    TIMEOUT,
  );

  it(
    'refuses audio larger than the limit',
    async () => {
      const tts = new SapiTextToSpeech({ maxAudioBytes: 500 });
      await expect(tts.synthesize('This sentence will comfortably exceed five hundred bytes of audio.')).rejects.toMatchObject(
        { kind: 'TOO_LARGE' },
      );
    },
    TIMEOUT,
  );
});

describe.skipIf(!onWindows)('the full path from reply to deliverable audio', () => {
  it(
    'synthesises, verifies and delivers real speech, then ends cleanly',
    async () => {
      const delivered: SpeechDelivery[] = [];
      const ended: { speechId: string; reason: SpeechEndReason }[] = [];
      const started: { durationMs: number }[] = [];

      const service = new SpeechService({
        tts: new SapiTextToSpeech(),
        deliver: (d) => delivered.push(d),
        stopPlayback: () => {},
        onStarted: (info) => started.push({ durationMs: info.durationMs }),
        onEnded: (speechId, reason) => ended.push({ speechId, reason }),
        onFailure: () => {},
      });

      expect(service.status()).toMatchObject({ available: true, name: 'windows-sapi' });

      const spoke = await service.speak('Notepad is open.');
      expect(spoke).toBe(true);

      // One real utterance, carrying real audio and a real measured duration.
      expect(delivered).toHaveLength(1);
      const delivery = delivered[0]!;
      expect(delivery.mimeType).toBe('audio/wav');
      expect(delivery.bytes.byteLength).toBeGreaterThan(1000);
      expect(delivery.durationMs).toBeGreaterThan(300);
      expect(started[0]?.durationMs).toBe(delivery.durationMs);

      // What the renderer would report once playback finishes.
      service.report(delivery.speechId, 'ended');

      expect(ended).toEqual([{ speechId: delivery.speechId, reason: 'completed' }]);
      expect(service.speaking).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'truncates and still speaks an enormous reply',
    async () => {
      const delivered: SpeechDelivery[] = [];
      const started: { truncated: boolean }[] = [];

      const service = new SpeechService({
        tts: new SapiTextToSpeech(),
        deliver: (d) => delivered.push(d),
        stopPlayback: () => {},
        onStarted: (info) => started.push({ truncated: info.truncated }),
        onEnded: () => {},
        onFailure: () => {},
      });

      // A hostile-length reply. It must be bounded, not refused outright.
      await service.speak('This is a sentence. '.repeat(1000));

      expect(started[0]?.truncated).toBe(true);
      expect(delivered).toHaveLength(1);
      // Bounded by the character cap, so bounded in audio too.
      expect(delivered[0]!.durationMs).toBeLessThan(4 * 60 * 1000);

      service.shutdown();
    },
    TIMEOUT,
  );
});

describe.skipIf(onWindows)('off Windows', () => {
  it('reports that it cannot speak, rather than pretending', async () => {
    const tts = new SapiTextToSpeech();
    expect(tts.isAvailable()).toBe(false);
    await expect(tts.synthesize('Hello.')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });
});
