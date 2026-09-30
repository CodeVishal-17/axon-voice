/**
 * The Windows speech-to-text adapter.
 *
 * These drive the real `WindowsSpeechToText` against a FAKE recognizer
 * process — a small Node script standing in for PowerShell — so the adapter's
 * protocol handling, bounds, timeouts and failure modes are exercised
 * deterministically and on any platform.
 *
 * What this deliberately does not cover is whether Windows can actually
 * transcribe speech. That is a claim about a real engine, and it is checked
 * against the real engine in `voice-integration.test.ts`, which synthesises
 * audio and recognises it end to end. Nothing here pretends to be that.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptChunk } from '@axon/core';
import { WindowsSpeechToText, SpeechRecognitionError } from '../src/main/voice/windows-stt.js';

/**
 * A stand-in for the recognizer child.
 *
 * Speaks the same line protocol the real PowerShell program does, and takes
 * its behaviour from its last argument so each test can ask for a different
 * failure.
 */
const FAKE_RECOGNIZER = String.raw`
const mode = process.argv[process.argv.length - 1];

if (mode === 'never-ready') {
  setInterval(() => {}, 1000);
} else if (mode === 'die-before-ready') {
  process.stderr.write('C:\\Users\\someone\\Axon\\secret: no recognizer for this language\n');
  process.exit(1);
} else {
  process.stdout.write('READY\n');

  let bytes = 0;
  process.stdin.on('data', (chunk) => { bytes += chunk.length; });

  const phrase = (confidence, text) =>
    'PHRASE ' + confidence + ' ' + Buffer.from(text, 'utf8').toString('base64') + '\n';

  process.stdin.on('end', () => {
    if (mode === 'silence') {
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'hang') {
      setInterval(() => {}, 1000);
    } else if (mode === 'crash') {
      process.stderr.write('C:\\Users\\someone\\stack trace with a local path\n');
      process.exit(3);
    } else if (mode === 'garbage') {
      process.stdout.write('WAT something\n');
      process.stdout.write('PHRASE\n');
      process.stdout.write('PHRASE notanumber\n');
      process.stdout.write('AUDIO 12345\n');
      process.stdout.write(phrase('0.900', 'survived the noise'));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'two-phrases') {
      process.stdout.write(phrase('0.812', 'open notepad'));
      process.stdout.write(phrase('0.640', 'and say hello'));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'huge') {
      process.stdout.write(phrase('1.000', 'x'.repeat(200000)));
      process.stdout.write(phrase('0.900', 'the next phrase still arrives'));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'report-bytes') {
      process.stdout.write(phrase('1.000', String(bytes)));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'out-of-range') {
      process.stdout.write(phrase('7.500', 'too confident'));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'wake-grammar') {
      const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
      process.stdout.write('GRAMMAR wake\n');
      process.stdout.write('GRAMMAR near-miss\n');
      process.stdout.write('RECOGNIZER en-US ' + b64('MS-1033-80-DESK') + '\n');
      process.stdout.write('FORMAT 16000 16 mono\n');
      process.stdout.write('SPEECH\n');
      process.stdout.write('NEAR 0.910 ' + b64('hey jackson') + '\n');
      process.stdout.write('REJECTED 0.120 ' + b64('but who') + '\n');
      process.stdout.write('WAKE 0.870 ' + b64('hey axon') + ' 460 940\n');
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'report-env') {
      const secrets = Object.keys(process.env).filter((name) => /KEY|TOKEN|SECRET|PASSWORD|ASSEMBLY|ANTHROPIC/i.test(name));
      process.stdout.write(phrase('1.000', secrets.length === 0 ? 'none' : secrets.join(',')));
      process.stdout.write('END\n');
      process.exit(0);
    } else if (mode === 'wake-phrase') {
      process.stdout.write('WAKE 0.830 ' + Buffer.from('hey axon', 'utf8').toString('base64') + '\n');
      process.stdout.write(phrase('0.400', 'i was talking about axon yesterday'));
      process.stdout.write('END\n');
      process.exit(0);
    } else {
      process.stdout.write(phrase('0.700', 'open notepad'));
      process.stdout.write('END\n');
      process.exit(0);
    }
  });
}
`;

let scriptDir: string;
let scriptPath: string;

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-stt-test-'));
  scriptPath = path.join(scriptDir, 'fake-recognizer.cjs');
  fs.writeFileSync(scriptPath, FAKE_RECOGNIZER, 'utf8');
});

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

/** A recognizer wired to the fake child in the given mode. */
function recognizer(mode: string, options: Record<string, unknown> = {}): WindowsSpeechToText {
  return new WindowsSpeechToText({
    executable: process.execPath,
    args: [scriptPath, mode],
    platform: 'win32',
    warmupTimeoutMs: 5_000,
    transcriptionTimeoutMs: 5_000,
    ...options,
  });
}

/** Collect the chunks a session produces. */
function collector(): { chunks: TranscriptChunk[]; onChunk: (chunk: TranscriptChunk) => void } {
  const chunks: TranscriptChunk[] = [];
  return { chunks, onChunk: (chunk) => chunks.push(chunk) };
}

/** One frame of audio. Contents are irrelevant to the fake; size is not. */
function frame(samples = 512): Int16Array {
  return new Int16Array(samples);
}

describe('availability', () => {
  it('is unavailable off Windows, and says why', () => {
    const stt = new WindowsSpeechToText({ platform: 'darwin' });
    expect(stt.isAvailable()).toBe(false);
    expect(stt.unavailableReason()).toContain('Windows');
  });

  it('reports its contract: 16kHz, named, no credential', () => {
    const stt = new WindowsSpeechToText({ platform: 'win32' });
    expect(stt.sampleRate).toBe(16_000);
    expect(stt.name).toBe('windows-speech');
    // The whole point of a local recognizer: there is nothing to leak.
    expect(JSON.stringify(stt)).not.toMatch(/key|secret|token|password/i);
  });

  it('refuses to start when unavailable', async () => {
    const stt = new WindowsSpeechToText({ platform: 'linux' });
    await expect(stt.start(() => {})).rejects.toBeInstanceOf(SpeechRecognitionError);
  });
});

describe('transcribing', () => {
  it('waits for the engine before accepting audio', async () => {
    // `start` resolving means READY arrived. Audio pushed before that would go
    // into a pipe nothing is reading yet.
    const { onChunk } = collector();
    const session = await recognizer('ok').start(onChunk);
    expect(session).toBeDefined();
    session.close();
  });

  it('produces a transcript from one phrase', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('ok').start(onChunk);

    session.push(frame());
    await session.end();

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('open notepad');
    expect(chunks[0]?.isFinal).toBe(true);
    expect(chunks[0]?.confidence).toBeCloseTo(0.7, 3);
    session.close();
  });

  it('delivers every phrase, so a pause mid-sentence is not a lost clause', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('two-phrases').start(onChunk);

    session.push(frame());
    await session.end();

    expect(chunks.map((c) => c.text)).toEqual(['open notepad', 'and say hello']);
    session.close();
  });

  it('produces nothing at all from silence', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('silence').start(onChunk);

    session.push(frame());
    await session.end();

    // An empty transcript is a normal outcome, not a failure. The listening
    // service turns this into "Axon didn't catch that".
    expect(chunks).toEqual([]);
    session.close();
  });

  it('forwards the audio it is given, and only that', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('report-bytes').start(onChunk);

    session.push(frame(512));
    session.push(frame(512));
    await session.end();

    // 2 frames x 512 samples x 2 bytes.
    expect(chunks[0]?.text).toBe('2048');
    session.close();
  });
});

describe('untrusted output from the child', () => {
  it('ignores anything that is not a well-formed phrase', async () => {
    // The child is a subprocess, not a trusted peer. Unknown verbs, malformed
    // payloads and unparseable base64 are dropped rather than interpreted.
    const { chunks, onChunk } = collector();
    const session = await recognizer('garbage').start(onChunk);

    session.push(frame());
    await session.end();

    expect(chunks.map((c) => c.text)).toEqual(['survived the noise']);
    session.close();
  });

  it('clamps a confidence outside 0..1', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('out-of-range').start(onChunk);

    session.push(frame());
    await session.end();

    expect(chunks[0]?.confidence).toBe(1);
    session.close();
  });

  it('drops an absurdly long line whole, and recovers on the next one', async () => {
    // Nothing 64KB long on this channel is a phrase somebody said. The line is
    // abandoned rather than trimmed — trimming would chop the verb off the
    // front and leave a fragment to be parsed as something else — and the
    // reader resynchronises at the next newline rather than losing the rest of
    // the utterance with it.
    const { chunks, onChunk } = collector();
    const session = await recognizer('huge').start(onChunk);

    session.push(frame());
    await session.end();

    expect(chunks.map((c) => c.text)).toEqual(['the next phrase still arrives']);
    session.close();
  });
});

describe('bounds', () => {
  it('stops forwarding audio past the byte ceiling', async () => {
    const { chunks, onChunk } = collector();
    // 4096 bytes = 2048 samples.
    const session = await recognizer('report-bytes', { maxAudioBytes: 4_096 }).start(onChunk);

    for (let i = 0; i < 20; i += 1) session.push(frame(1_024));
    await session.end();

    expect(Number(chunks[0]?.text)).toBeLessThanOrEqual(4_096);
    session.close();
  });

  it('ignores audio pushed after the stream is closed', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('report-bytes').start(onChunk);

    session.push(frame(512));
    const ended = session.end();
    // A frame in flight when the utterance ended. It must not extend it.
    session.push(frame(512));
    await ended;

    expect(chunks[0]?.text).toBe('1024');
    session.close();
  });

  it('ignores audio pushed after close', async () => {
    const session = await recognizer('ok').start(() => {});
    session.close();
    // Must not throw: a late frame is an ordinary race, not an error.
    expect(() => session.push(frame())).not.toThrow();
  });
});

describe('failures', () => {
  it('gives up on an engine that never loads', async () => {
    const stt = recognizer('never-ready', { warmupTimeoutMs: 300 });
    await expect(stt.start(() => {})).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('marks itself unavailable when the engine is missing', async () => {
    const stt = recognizer('die-before-ready');
    await expect(stt.start(() => {})).rejects.toBeInstanceOf(SpeechRecognitionError);

    // The permission-loop fix, in the provider: a machine with no recognizer
    // stops being offered one rather than failing on every activation.
    expect(stt.isAvailable()).toBe(false);
    expect(stt.unavailableReason()).toMatch(/Windows Settings|not available/i);
  });

  it('never puts the child stderr in the reason it reports', async () => {
    const stt = recognizer('die-before-ready');
    await stt.start(() => {}).catch(() => {});

    const reason = stt.unavailableReason() ?? '';
    // The fake writes a local path to stderr. A user-facing sentence must not
    // carry it — nor a stack trace, nor a user account name.
    expect(reason).not.toMatch(/C:\\|secret|someone/);
  });

  it('stops waiting for a recognizer that hangs', async () => {
    const { onChunk } = collector();
    const session = await recognizer('hang', { transcriptionTimeoutMs: 300 }).start(onChunk);

    session.push(frame());
    const startedAt = Date.now();
    await session.end();

    // The deadline is what stops a wedged recognizer holding Axon in
    // LISTENING. It resolves rather than rejecting: whatever arrived before
    // the deadline is the transcript.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    session.close();
  });

  it('resolves end() when the child dies mid-utterance', async () => {
    const { onChunk } = collector();
    const session = await recognizer('crash').start(onChunk);

    session.push(frame());
    // Must not hang: a dead child ends the utterance like any other ending.
    await expect(session.end()).resolves.toBeUndefined();
    session.close();
  });

  it('is safe to close twice', async () => {
    const session = await recognizer('ok').start(() => {});
    session.close();
    expect(() => session.close()).not.toThrow();
  });

  it('is safe to end twice', async () => {
    const session = await recognizer('ok').start(() => {});
    session.push(frame());
    await session.end();
    await expect(session.end()).resolves.toBeUndefined();
    session.close();
  });
});

describe('the wake grammar result', () => {
  it('reports which grammar produced each phrase', async () => {
    // WAKE is the wake grammar matching; PHRASE is dictation. The detector
    // wakes only on the first, so the distinction has to survive the pipe.
    const { chunks, onChunk } = collector();
    const session = await recognizer('wake-phrase').start(onChunk, { mode: 'wake' });

    session.push(frame());
    await session.end();

    expect(chunks.map((chunk) => [chunk.source, chunk.text])).toEqual([
      ['wake-phrase', 'hey axon'],
      ['dictation', 'i was talking about axon yesterday'],
    ]);
    expect(chunks[0]?.confidence).toBeCloseTo(0.83, 3);
    session.close();
  });

  it('tags ordinary dictation as dictation', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('ok').start(onChunk);
    session.push(frame());
    await session.end();
    expect(chunks[0]?.source).toBe('dictation');
    session.close();
  });

  it('tags a near-miss as a near-miss, and never turns a diagnostic into a transcript', async () => {
    const { chunks, onChunk } = collector();
    const diagnostics: string[] = [];
    const session = await recognizer('wake-grammar').start(onChunk, {
      mode: 'wake',
      onDiagnostic: (line) => diagnostics.push(line),
    });

    session.push(frame());
    await session.end();

    expect(chunks.map((chunk) => [chunk.source, chunk.text])).toEqual([
      ['near-miss', 'hey jackson'],
      ['wake-phrase', 'hey axon'],
    ]);
    expect(diagnostics).toEqual([
      'grammar loaded: wake',
      'grammar loaded: near-miss',
      'recognizer initialized: MS-1033-80-DESK, culture en-US',
      'audio format: 16000 Hz, 16-bit, mono',
      'recognizer detected speech',
      '[REJECTED] 0.120 "but who" (below the engine\'s rejection threshold)',
    ]);
    // Timing travels with a result when the recognizer gives it, and is
    // simply absent when it does not.
    expect(chunks[0]?.span).toBeUndefined();
    expect(chunks[1]?.span).toEqual({ startMs: 460, durationMs: 940 });
    session.close();
  });

  it('reports nothing to a session that did not ask for diagnostics', async () => {
    const { chunks, onChunk } = collector();
    const session = await recognizer('wake-grammar').start(onChunk, { mode: 'wake' });
    session.push(frame());
    await session.end();
    expect(chunks).toHaveLength(2);
    session.close();
  });
});

describe('the recognizer process environment', () => {
  it('does not inherit the voice agent credential', async () => {
    const previous = process.env.ASSEMBLYAI_API_KEY;
    process.env.ASSEMBLYAI_API_KEY = 'sentinel-credential-for-this-test';
    try {
      const { chunks, onChunk } = collector();
      const session = await recognizer('report-env').start(onChunk);
      session.push(frame());
      await session.end();
      // Windows adds a few variables of its own to any child, so the property
      // is not a count: it is that nothing shaped like a credential arrives.
      expect(chunks[0]?.text).toBe('none');
      session.close();
    } finally {
      if (previous === undefined) delete process.env.ASSEMBLYAI_API_KEY;
      else process.env.ASSEMBLYAI_API_KEY = previous;
    }
  });
});
