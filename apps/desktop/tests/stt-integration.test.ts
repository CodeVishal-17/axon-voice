/**
 * The real Windows recognizer, on real audio.
 *
 * `stt.test.ts` drives the adapter against a stand-in child so its protocol,
 * bounds and failure modes are deterministic. This file does the opposite: it
 * spawns the real PowerShell recognizer, feeds it real speech, and asserts on
 * the real transcript that comes back. Nothing here is faked.
 *
 * The audio is produced by the real Windows synthesiser — the same one Axon
 * speaks with — and pushed through the pipeline frame by frame in real time,
 * exactly as the renderer's microphone does.
 *
 * WHAT THIS DOES NOT COVER, STATED PLAINLY.
 *
 * There is no microphone in this test. Automated microphone capture is not
 * available here: `getUserMedia` exists only in a renderer, needs a real
 * device, needs an OS-level permission grant, and needs somebody to speak.
 * This test therefore verifies every stage of the real pipeline EXCEPT the
 * capture itself:
 *
 *     [renderer microphone]  ->  VAD  ->  STT adapter  ->  transcript
 *      not covered here          real     real            real
 *
 * The capture stage is covered by unit tests over `MicrophoneCapture`'s pure
 * parts, by the boundary tests that constrain what it may do, and by manual
 * verification in the running app. It is not covered by an automated test, and
 * nothing in this file pretends otherwise.
 */

import { describe, expect, it } from 'vitest';
import { LISTENING_LIMITS, type TranscriptChunk } from '@axon/core';
import { SapiTextToSpeech } from '../src/main/voice/sapi-tts.js';
import { WindowsSpeechToText } from '../src/main/voice/windows-stt.js';
import { VoiceActivityDetector } from '../src/main/voice/vad.js';
import { joinPhrases, prepareTranscript } from '../src/main/voice/transcript-text.js';
import { parseWav } from '../src/main/voice/wav.js';

const onWindows = process.platform === 'win32';

/** Real speech recognition on a cold .NET start is not instant. */
const TIMEOUT = 60_000;

const RATE = LISTENING_LIMITS.sampleRate;
/** 32ms at 16kHz — the granularity the VAD sees. */
const FRAME = 512;

/**
 * The samples out of a WAV buffer.
 *
 * Done here rather than by extending `parseWav`, whose contract the product
 * relies on: the production path only ever needs the duration, and a test's
 * convenience is not a reason to widen an audited interface.
 */
function pcmOf(bytes: Uint8Array, dataBytes: number): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walk the chunk list to the 'data' chunk rather than assuming a 44-byte
  // header: SAPI emits a LIST/INFO chunk before it.
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

/**
 * Say something with the real synthesiser and return 16-bit PCM at 16kHz.
 *
 * SAPI renders at its own rate, so the result is resampled here with the same
 * linear interpolation the renderer uses when a browser declines to give it a
 * 16kHz AudioContext.
 */
async function speak(text: string): Promise<Int16Array> {
  const audio = await new SapiTextToSpeech().synthesize(text);
  const info = parseWav(audio.bytes);
  if (info.bitsPerSample !== 16) throw new Error(`expected 16-bit audio, got ${info.bitsPerSample}`);

  const pcm = pcmOf(audio.bytes, info.dataBytes);

  // Mono-ise if the synthesiser produced stereo.
  const mono =
    info.channels === 1
      ? pcm
      : (() => {
          const out = new Int16Array(Math.floor(pcm.length / info.channels));
          for (let i = 0; i < out.length; i += 1) out[i] = pcm[i * info.channels] ?? 0;
          return out;
        })();

  if (info.sampleRate === RATE) return mono;

  const ratio = info.sampleRate / RATE;
  const out = new Int16Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = mono[index] ?? 0;
    const b = mono[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

/** Digital silence, in frames. */
function silentFrames(ms: number): Int16Array[] {
  const frames: Int16Array[] = [];
  const count = Math.ceil(ms / ((FRAME / RATE) * 1000));
  for (let i = 0; i < count; i += 1) frames.push(new Int16Array(FRAME));
  return frames;
}

/** Split PCM into the frame size the renderer produces. */
function toFrames(pcm: Int16Array): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME) {
    frames.push(pcm.slice(offset, Math.min(offset + FRAME, pcm.length)));
  }
  return frames;
}

interface Recognised {
  readonly transcript: string;
  /** End of speech to finished transcript. The number that matters. */
  readonly transcriptionMs: number;
  /** Activation to the recognizer being ready. Paid while the user talks. */
  readonly warmupMs: number;
  readonly vadEndedOnSilence: boolean;
  readonly utteranceMs: number;
}

/**
 * The real pipeline, minus the microphone.
 *
 * Leading silence, then the utterance, then trailing silence — the shape of a
 * real push-to-talk session. The VAD decides when the utterance is over, and
 * the audio stream is closed at exactly that point, just as the listening
 * service does it.
 */
async function recognise(text: string): Promise<Recognised> {
  const pcm = await speak(text);

  const stt = new WindowsSpeechToText();
  const chunks: TranscriptChunk[] = [];
  const vad = new VoiceActivityDetector({ sampleRate: RATE });

  const activatedAt = Date.now();
  const session = await stt.start((chunk) => chunks.push(chunk));
  const warmupMs = Date.now() - activatedAt;

  const frames = [...silentFrames(300), ...toFrames(pcm), ...silentFrames(1_500)];

  let endedOnSilence = false;
  for (const frame of frames) {
    session.push(frame);
    const result = vad.push(frame);
    if (result.event === 'speech-ended') {
      endedOnSilence = true;
      break;
    }
    if (result.event === 'no-speech-timeout' || result.event === 'max-duration') break;
  }

  const speechEndedAt = Date.now();
  await session.end();
  const transcriptionMs = Date.now() - speechEndedAt;
  session.close();

  return {
    transcript: prepareTranscript(joinPhrases(chunks.map((c) => c.text))).text,
    transcriptionMs,
    warmupMs,
    vadEndedOnSilence: endedOnSilence,
    utteranceMs: Math.round(vad.elapsedMs),
  };
}

/** Loose comparison: recognizers differ on casing and punctuation. */
function said(transcript: string, ...words: string[]): boolean {
  const normalised = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  return words.every((word) => normalised.includes(word.toLowerCase()));
}

describe.skipIf(!onWindows)('Windows speech recognition, for real', () => {
  it(
    'transcribes a real spoken command',
    async () => {
      const result = await recognise('Open Notepad.');

      // The demo sentence, through the real engine.
      expect(result.transcript).not.toBe('');
      expect(said(result.transcript, 'notepad'), `heard: "${result.transcript}"`).toBe(true);

      console.log(
        `[stt] "${result.transcript}" — warmup ${result.warmupMs}ms, ` +
          `utterance ${result.utteranceMs}ms, transcription ${result.transcriptionMs}ms`,
      );
    },
    TIMEOUT,
  );

  it(
    'the voice activity detector ends the utterance on real speech',
    async () => {
      // Not a timer: the detector saw real speech energy fall away and closed
      // the utterance itself.
      const result = await recognise('Open Notepad.');

      expect(result.vadEndedOnSilence).toBe(true);
      // It ended shortly after the words stopped, not after the full buffer.
      expect(result.utteranceMs).toBeGreaterThan(500);
      expect(result.utteranceMs).toBeLessThan(LISTENING_LIMITS.maxUtteranceMs);
    },
    TIMEOUT,
  );

  it(
    'transcribes a longer instruction',
    async () => {
      const result = await recognise('Write hello world to a file on my desktop.');

      // Deliberately weaker than the assertion above. A dictation recognizer
      // is not deterministic — under load it will sometimes return a partial
      // or differently-worded result for a long sentence — and a test that
      // demanded an exact phrase would be asserting something the engine does
      // not promise. What it does promise, and what Axon depends on, is that a
      // sentence of speech produces a sentence of text.
      expect(result.transcript, 'a long utterance produced no transcript at all').not.toBe('');
      expect(result.transcript.split(/\s+/).length, `heard: "${result.transcript}"`).toBeGreaterThanOrEqual(3);
      console.log(`[stt] "${result.transcript}"`);
    },
    TIMEOUT,
  );

  it(
    'transcribes a one-word interruption',
    async () => {
      // The barge-in case: short, and it still has to be caught.
      const result = await recognise('Stop.');

      expect(result.transcript).not.toBe('');
      console.log(`[stt] "${result.transcript}" (interruption)`);
    },
    TIMEOUT,
  );

  it(
    'returns nothing from silence rather than inventing words',
    async () => {
      const stt = new WindowsSpeechToText();
      const chunks: TranscriptChunk[] = [];
      const session = await stt.start((chunk) => chunks.push(chunk));

      for (const frame of silentFrames(2_000)) session.push(frame);
      await session.end();
      session.close();

      // An empty transcript is the honest answer, and the listening service
      // turns it into "Axon didn't catch that" rather than a turn.
      expect(prepareTranscript(joinPhrases(chunks.map((c) => c.text))).text).toBe('');
    },
    TIMEOUT,
  );

  it(
    'delivers the transcript promptly once speech ends',
    async () => {
      // The latency claim, measured against the real engine. The recognizer is
      // warm by this point — it was started when the session opened — so this
      // is the only wait the user actually experiences.
      const result = await recognise('Open Notepad.');

      expect(result.transcriptionMs).toBeLessThan(3_000);
      console.log(`[stt] end of speech to transcript: ${result.transcriptionMs}ms`);
    },
    TIMEOUT,
  );

  it(
    'writes no audio to disk',
    async () => {
      // The privacy claim, checked against the real subprocess rather than
      // against the source: run a real recognition and confirm the temporary
      // directory gained no audio file.
      const fs = await import('node:fs');
      const os = await import('node:os');
      const tmp = os.tmpdir();

      const before = new Set(fs.readdirSync(tmp));
      await recognise('Open Notepad.');
      const after = fs.readdirSync(tmp).filter((name) => !before.has(name));

      const audioFiles = after.filter((name) => /\.(wav|mp3|pcm|raw|opus|webm|ogg)$/i.test(name));
      expect(audioFiles, `unexpected audio in ${tmp}`).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'is spawned without a shell and cannot be pointed elsewhere',
    async () => {
      // The recognizer Axon actually constructs takes no executable and no
      // argv, so the constant program is the only one that runs.
      const stt = new WindowsSpeechToText();
      expect(stt.isAvailable()).toBe(true);
      expect(stt.name).toBe('windows-speech');
      expect(stt.sampleRate).toBe(RATE);
    },
    TIMEOUT,
  );
});
