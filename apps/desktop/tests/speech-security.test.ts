/**
 * Security properties of the voice subsystem.
 *
 * Step 3 adds three things worth attacking: a subprocess, untrusted text
 * arriving at it, and audio heading for the renderer. The assertions here are
 * the ones that would actually catch a regression in each.
 *
 * Several are source-level rather than behavioural. That is deliberate: "the
 * renderer cannot ask to play an arbitrary file" is a claim about what the API
 * *is*, and the honest way to test it is to show the capability does not
 * exist — a behavioural test can only show that one particular attempt failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, SPEECH_LIMITS, isSpeechMimeType, serializeEvent, type AxonEvent } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { ToolRegistry } from '../src/main/tools/registry';
import { SpeechService } from '../src/main/voice/speech-service';
import { prepareSpeech } from '../src/main/voice/speech-text';
import { parseWav } from '../src/main/voice/wav';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CORE_SRC = path.resolve(HERE, '../../../packages/core/src');

const read = (relative: string): string => fs.readFileSync(path.resolve(SRC, relative), 'utf8');

function wav(seconds = 0.3): Uint8Array {
  const rate = 22050;
  const dataBytes = Math.round(rate * seconds) * 2;
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
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------

describe('the renderer cannot play arbitrary audio', () => {
  it('has no bridge method that accepts a location', () => {
    // The whole renderer-facing API is one interface. If a "play this" verb
    // existed, it would be in it.
    const ipc = fs.readFileSync(path.resolve(CORE_SRC, 'ipc.ts'), 'utf8');
    const bridge = ipc.slice(ipc.indexOf('export interface AxonBridge'));

    expect(bridge).not.toMatch(/play\s*\(/i);
    expect(bridge).not.toMatch(/\b(filePath|audioPath|src|url|filename)\b/i);
  });

  it('delivers audio in one direction only, main -> renderer', () => {
    // `onSpeech` is a subscription. There is no inbound counterpart, so the
    // renderer has no way to nominate what plays.
    const ipc = fs.readFileSync(path.resolve(CORE_SRC, 'ipc.ts'), 'utf8');
    expect(ipc).toMatch(/onSpeech\(/);
    expect(ipc).not.toMatch(/sendSpeech\(|playAudio\(|speak\(/);
  });

  it('carries bytes, not a location, in the delivery payload', () => {
    const speech = fs.readFileSync(path.resolve(CORE_SRC, 'speech.ts'), 'utf8');
    const delivery = speech.slice(
      speech.indexOf('export interface SpeechDelivery'),
      speech.indexOf('export const SPEECH_END_REASONS'),
    );

    expect(delivery).toMatch(/bytes:\s*Uint8Array/);
    expect(delivery).not.toMatch(/^\s*(readonly\s+)?\w*(path|url|file|src)\w*\s*[?:]/im);
  });

  it('never constructs an object URL or fetches anything in the player', () => {
    const player = read('renderer/audio/speech-player.ts');
    expect(player).not.toMatch(/createObjectURL|URL\.create|fetch\(|XMLHttpRequest|new Audio\(/);
    // Decoding a buffer it was handed is the only way audio enters.
    expect(player).toMatch(/decodeAudioData/);
  });

  it('accepts only media types on the allowlist', () => {
    expect(isSpeechMimeType('audio/wav')).toBe(true);
    for (const bad of ['audio/x-any', 'text/html', 'application/octet-stream', '', 'audio/wav; codecs=x']) {
      expect(isSpeechMimeType(bad)).toBe(false);
    }
  });
});

describe('the renderer cannot extend or forge speech', () => {
  it('reports with an id and a status, and nothing else', () => {
    const bridge = read('main/bus/renderer-bridge.ts');
    const schema = bridge.slice(bridge.indexOf('const speechReportPayload'), bridge.indexOf('const stateRequestPayload'));

    expect(schema).toMatch(/speechId/);
    expect(schema).toMatch(/status/);
    // No duration, no bytes, no path — nothing that could lengthen or
    // substitute what Axon believes it is playing.
    expect(schema).not.toMatch(/duration|bytes|path|url|text/i);
  });

  it('bounds the id it will accept', () => {
    const bridge = read('main/bus/renderer-bridge.ts');
    expect(bridge).toMatch(/speechId:\s*z\.string\(\)\.min\(1\)\.max\(\d+\)/);
  });

  it('takes no argument at all for cancellation', () => {
    // A parameterless verb is one that cannot be pointed at something else.
    const bridge = read('main/bus/renderer-bridge.ts');
    const handler = bridge.slice(bridge.indexOf('IPC_CHANNELS.SPEECH_CANCEL'));
    expect(handler.slice(0, 200)).toMatch(/\(\):\s*void/);
  });

  it('cannot end an utterance by naming a different one', async () => {
    const ended: string[] = [];
    const service = new SpeechService({
      tts: { name: 'f', isAvailable: () => true, synthesize: () => Promise.resolve({ bytes: wav(), mimeType: 'audio/wav', sampleRate: 22050 }) },
      newSpeechId: () => 'real-id',
      deliver: () => {},
      stopPlayback: () => {},
      onStarted: () => {},
      onEnded: (id) => ended.push(id),
      onFailure: () => {},
    });

    await service.speak('Hello.');
    service.report('../../etc/passwd', 'ended');
    service.report('real-id-guessed', 'ended');

    expect(ended).toEqual([]);
    expect(service.speaking).toBe(true);
  });

  it('uses only namespaced channels a caller cannot invent', () => {
    // Every channel is a constant on one object. The renderer names channels
    // through that object, so model output can never become a channel name.
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).toMatch(/^axon:[a-z:]+$/);
    }
    expect(new Set(Object.values(IPC_CHANNELS)).size).toBe(Object.values(IPC_CHANNELS).length);
  });
});

describe('untrusted model text stays data', () => {
  it.each([
    '$(Invoke-Expression "calc")',
    '`whoami`',
    '; rm -rf / ;',
    '../../../../windows/system32/config/sam',
    '<script>fetch("http://evil")</script>',
    'axon:speech:audio',
    'file:///C:/Windows/System32/drivers/etc/hosts',
  ])('passes %s through as words', (payload) => {
    // Nothing is escaped, stripped or rewritten: it is content, and the
    // architecture is what makes that safe (stdin, no shell, no parser).
    expect(prepareSpeech(payload).text).toBe(payload);
  });

  it('removes only control characters, which are a subprocess hazard', () => {
    expect(prepareSpeech('a\u0000b\u001Fc').text).toBe('a b c');
  });

  it('bounds how much of a hostile reply is ever synthesised', () => {
    // Unbounded text would mean unbounded synthesis time and buffer.
    const enormous = 'x'.repeat(5_000_000);
    const prepared = prepareSpeech(enormous);
    expect(prepared.characters).toBeLessThanOrEqual(SPEECH_LIMITS.maxCharacters);
    expect(prepared.truncated).toBe(true);
  });
});

describe('audio is validated before the renderer sees it', () => {
  it.each([
    ['a truncated header', new Uint8Array(20)],
    ['random bytes', Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 256)],
    ['an empty buffer', new Uint8Array(0)],
  ])('refuses %s', (_label, bytes) => {
    expect(() => parseWav(bytes)).toThrow();
  });

  it('refuses a WAV declaring a compressed codec', () => {
    const bytes = wav();
    new DataView(bytes.buffer).setUint16(20, 0x0055, true); // MP3 in a RIFF wrapper
    expect(() => parseWav(bytes)).toThrow(/not linear PCM/);
  });

  it('never delivers audio it could not parse', async () => {
    const delivered: unknown[] = [];
    const service = new SpeechService({
      tts: {
        name: 'hostile',
        isAvailable: () => true,
        // A provider returning something that is not audio at all.
        synthesize: () => Promise.resolve({ bytes: new Uint8Array(500), mimeType: 'audio/wav', sampleRate: 22050 }),
      },
      deliver: (d) => delivered.push(d),
      stopPlayback: () => {},
      onStarted: () => {},
      onEnded: () => {},
      onFailure: () => {},
    });

    expect(await service.speak('Hello.')).toBe(false);
    expect(delivered).toEqual([]);
  });
});

describe('nothing sensitive reaches the renderer or the log', () => {
  const SENTINEL = 'sk-ant-SPEECH-SENTINEL-9f3a';

  it('keeps a credential out of every event a speaking turn produces', async () => {
    const bus = new EventBus();
    const events: AxonEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const orchestrator = new Orchestrator({
      bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
      brain: null,
      brainUnavailableReason: 'No key configured.',
      speech: new SpeechService({
        tts: {
          name: 'fake',
          isAvailable: () => true,
          // A provider that fails while quoting a credential, as a badly
          // written one might.
          synthesize: () => Promise.reject(Object.assign(new Error(`auth ${SENTINEL} refused`), { kind: 'PROVIDER' })),
        },
        deliver: () => {},
        stopPlayback: () => {},
        onStarted: (info) => orchestrator.onSpeechStarted(info),
        onEnded: (id, reason) => orchestrator.onSpeechEnded(id, reason),
        onFailure: (message) => orchestrator.onSpeechFailure(message),
      }),
    });

    orchestrator.onSpeechFailure('Axon could not speak that reply.');

    for (const event of events) {
      expect(serializeEvent(event)).not.toContain(SENTINEL);
    }
  });

  it('keeps local paths out of what a speech failure tells the user', async () => {
    const failures: string[] = [];
    const service = new SpeechService({
      tts: {
        name: 'fake',
        isAvailable: () => true,
        synthesize: () =>
          Promise.reject(
            Object.assign(new Error('C:\\Users\\someone\\AppData\\secret.ps1 failed'), { kind: 'PROVIDER' }),
          ),
      },
      deliver: () => {},
      stopPlayback: () => {},
      onStarted: () => {},
      onEnded: () => {},
      onFailure: (message) => failures.push(message),
    });

    await service.speak('Hello.');

    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toMatch(/C:\\|AppData|\.ps1/);
  });

  it('describes the synthesiser with a name and a boolean only', () => {
    const service = new SpeechService({
      tts: { name: 'windows-sapi', isAvailable: () => true, synthesize: () => Promise.reject(new Error('x')) },
      deliver: () => {},
      stopPlayback: () => {},
      onStarted: () => {},
      onEnded: () => {},
      onFailure: () => {},
    });

    expect(Object.keys(service.status()).sort()).toEqual(['available', 'name', 'reason']);
  });
});

describe('resource bounds', () => {
  it('caps synthesis time, audio size and text length', () => {
    // Each of these is what stops one hostile reply becoming an unbounded job.
    expect(SPEECH_LIMITS.synthesisTimeoutMs).toBeGreaterThan(0);
    expect(SPEECH_LIMITS.synthesisTimeoutMs).toBeLessThanOrEqual(60_000);
    expect(SPEECH_LIMITS.maxCharacters).toBeLessThanOrEqual(10_000);
    expect(SPEECH_LIMITS.maxAudioBytes).toBeLessThanOrEqual(50_000_000);
  });

  it('enforces the audio ceiling in the adapter, before decoding', () => {
    const sapi = read('main/voice/sapi-tts.ts');
    // Bounded while the bytes stream in, not after they have been buffered.
    expect(sapi).toMatch(/stdoutBytes\s*>\s*this\.maxAudioBytes/);
  });

  it('bounds what it keeps from the provider stderr', () => {
    const sapi = read('main/voice/sapi-tts.ts');
    expect(sapi).toMatch(/stderr\.length\s*<\s*\d+/);
  });

  it('releases audio nodes on every exit from playback', () => {
    const player = read('renderer/audio/speech-player.ts');
    expect(player).toMatch(/disconnect\(\)/);
    expect(player).toMatch(/close\(\)/);
    // One shared context, not one per utterance.
    expect((player.match(/new AudioContext\(/g) ?? []).length).toBe(1);
  });
});
