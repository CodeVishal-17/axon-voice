/**
 * The wake word, on the real Windows recognizer.
 *
 * `wake-word.test.ts` drives the detector against a fake recognizer, so its
 * segmentation and lifecycle are deterministic. This file runs the REAL
 * detector, the REAL voice activity detector and the REAL PowerShell
 * recognizer with the wake grammar and its near-miss competitor, and asserts
 * on whether Axon actually wakes.
 *
 * The negatives include every sound-alike the product brief names, and the
 * three phrases the human microphone test produced when the old design failed
 * ("But who", "And who", "New song"). They are tested here as speech that must
 * not wake Axon — never added to what the recognizer accepts.
 *
 * WHAT THIS DOES NOT COVER, STATED PLAINLY.
 *
 * There is no microphone and no human voice here. The speech is produced by
 * the Windows synthesiser and handed to the detector frame by frame, exactly
 * as the renderer's capture would. A synthesised voice is not a person in a
 * room: it is cleaner, and it is also the voice free dictation mis-heard as
 * "A Exxon". What this proves is that the local pipeline — segmentation, the
 * wake grammar, the decision — wakes on the three phrases and does not wake on
 * speech that merely mentions the name. The microphone is checked by a person
 * with `npm run wake:live`.
 */

import { describe, expect, it } from 'vitest';
import { LISTENING_LIMITS } from '@axon/core';
import { SapiTextToSpeech } from '../src/main/voice/sapi-tts.js';
import { WindowsSpeechToText } from '../src/main/voice/windows-stt.js';
import { VoiceActivityDetector } from '../src/main/voice/vad.js';
import { parseWav } from '../src/main/voice/wav.js';
import { WakeWordDetector, WAKE_ACTIVITY_OPTIONS } from '../src/main/wake/wake-word.js';

const onWindows = process.platform === 'win32';
const RATE = LISTENING_LIMITS.sampleRate;
const FRAME = 1024;
const TIMEOUT = 90_000;

function pcmOf(bytes: Uint8Array, dataBytes: number): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x64617461) {
      const start = bytes.byteOffset + offset + 8;
      const length = Math.min(size, dataBytes);
      return new Int16Array(bytes.buffer.slice(start, start + length - (length % 2)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Synthesise, mono-ise, and resample to the capture rate. */
async function speak(text: string): Promise<Int16Array> {
  const audio = await new SapiTextToSpeech().synthesize(text);
  const info = parseWav(audio.bytes);
  const pcm = pcmOf(audio.bytes, info.dataBytes);
  const mono =
    info.channels === 1
      ? pcm
      : Int16Array.from({ length: Math.floor(pcm.length / info.channels) }, (_, i) => pcm[i * info.channels] ?? 0);
  if (info.sampleRate === RATE) return mono;
  const ratio = info.sampleRate / RATE;
  return Int16Array.from({ length: Math.floor(mono.length / ratio) }, (_, i) => {
    const position = i * ratio;
    const index = Math.floor(position);
    const a = mono[index] ?? 0;
    const b = mono[index + 1] ?? a;
    return Math.round(a + (b - a) * (position - index));
  });
}

function frames(pcm: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME) {
    const frame = new Int16Array(FRAME);
    frame.set(pcm.subarray(offset, Math.min(offset + FRAME, pcm.length)));
    out.push(frame);
  }
  return out;
}

function silence(ms: number): Int16Array[] {
  return Array.from({ length: Math.ceil((ms / 1000) * (RATE / FRAME)) }, () => new Int16Array(FRAME));
}

interface Heard {
  readonly woke: boolean;
  readonly lines: readonly string[];
}

/**
 * Say something to a real, armed wake word and see whether it wakes.
 *
 * The room is quiet for a moment first, as the detector calibrates against it;
 * then the phrase; then the pause a person leaves. Frames are handed over in
 * small bursts so the recognizer's own process can run in between.
 */
async function sayToWakeWord(text: string): Promise<Heard> {
  const pcm = await speak(text);
  const lines: string[] = [];
  let woke = false;

  const detector = new WakeWordDetector({
    stt: new WindowsSpeechToText(),
    activity: () => new VoiceActivityDetector(WAKE_ACTIVITY_OPTIONS),
    onWake: () => {
      woke = true;
    },
    onArmedChanged: () => {},
    onNotice: (message) => lines.push(`notice: ${message}`),
    debug: (line) => lines.push(line),
  });

  expect(await detector.arm()).toBe(true);

  const all = [...silence(600), ...frames(pcm), ...silence(1_200)];
  for (let i = 0; i < all.length; i += 1) {
    detector.pushFrame(all[i]!);
    if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Recognition of a short utterance on a warm engine is well under this.
  const deadline = Date.now() + 20_000;
  while (!woke && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!woke && lines.some((line) => line.startsWith('heard ') || line === 'local recognizer finished the utterance')) {
      // The recognizer has reported; give it a moment for a second phrase.
      await new Promise((resolve) => setTimeout(resolve, 500));
      break;
    }
  }

  detector.disarm();
  return { woke, lines };
}

describe.skipIf(!onWindows)('the wake word, on the real Windows recognizer (synthesised voice)', () => {
  for (const phrase of ['Hey Axon.', 'Hello Axon.', 'Hi Axon.']) {
    it(
      `wakes on "${phrase}"`,
      async () => {
        const heard = await sayToWakeWord(phrase);
        expect(heard.woke, heard.lines.join('\n')).toBe(true);
      },
      TIMEOUT,
    );
  }

  for (const sentence of [
    'I was talking about Axon yesterday.',
    'Axon.',
    'Hey.',
    'Hello.',
    'Hi.',
    'Axon is a company.',
    'Action.',
    'Exon.',
    'Eight.',
    'Song.',
    'But who.',
    'And who.',
    'New song.',
  ]) {
    it(
      `does not wake on "${sentence}"`,
      async () => {
        const heard = await sayToWakeWord(sentence);
        expect(heard.woke, heard.lines.join('\n')).toBe(false);
      },
      TIMEOUT,
    );
  }
});
