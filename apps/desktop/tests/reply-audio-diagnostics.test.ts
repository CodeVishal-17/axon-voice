/**
 * Every hop of the voice agent's reply audio can be accounted for.
 *
 * FOUND IN A REAL CONVERSATION. Axon replied in Hindi — "मैं भी ठीक हूँ,
 * धन्यवाद।" — and the words appeared on screen but were never heard, while
 * English replies played. The words and the sound are separate protocol
 * messages (`transcript.agent`, `reply.audio`), and the sound was handled by
 * three silent `return`s. Nothing could say whether the provider sent audio,
 * whether Axon threw it away, or whether the window failed to play it.
 *
 * These do not claim to FIX that. They make each question answerable, and
 * prove it by reproducing the shapes the failure could take:
 *
 *   provider sent audio?    "provider audio: 0 message(s) ... PROVIDER SENT NO AUDIO"
 *   Axon accepted it?       accepted counts; a line per REJECTED payload, with its reason
 *   a window received it?   delivered / dropped, from the transport's own answer
 *   it played?              the window's report: received, started, ended, FAILED
 *
 * And the rule the brief set: none of it ever contains audio, a payload, or
 * a word anyone said.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { VOICE_AGENT_LIMITS, type SpeechChunk } from '@axon/core';
import { ReplyLedger, classifyReplyAudio, scriptOf } from '../src/main/agent/reply-audio.js';
import { SpeechTransport } from '../src/main/voice/speech-transport.js';
import { VoiceDiagnostics } from '../src/main/voice/voice-diagnostics.js';
import { validPlaybackDiagnostics } from '../src/main/bus/renderer-bridge.js';
import { PlaybackTracker } from '../src/renderer/audio/playback-diagnostics.js';
import { createSystemTimeTool } from '../src/main/tools/executors/system-time.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

const HINDI = 'मैं भी ठीक हूँ, धन्यवाद।';
const ENGLISH = 'I am fine, thank you.';
const MAX = VOICE_AGENT_LIMITS.maxInboundAudioBytes;

/** 100 ms of silence at the agent's rate, base64 — a well-formed audio payload. */
const PCM_100MS = Buffer.alloc((VOICE_AGENT_LIMITS.sampleRate / 10) * 2).toString('base64');

describe('each reply.audio payload is accepted or rejected, never silently dropped', () => {
  it('accepts well-formed base64 PCM', () => {
    const result = classifyReplyAudio(PCM_100MS, MAX);
    expect(result.accepted).toBe(true);
    expect(result.accepted && result.pcm.byteLength).toBe(4_800);
  });

  it('rejects empty audio', () => {
    expect(classifyReplyAudio('', MAX)).toMatchObject({ accepted: false, reason: 'empty' });
  });

  it.each([
    [123, 'number'],
    [null, 'null'],
    [{ data: 'x' }, 'object'],
    [undefined, 'undefined'],
  ])('rejects a payload that is not a string (%s) and says what it was', (payload, type) => {
    expect(classifyReplyAudio(payload, MAX)).toMatchObject({ accepted: false, reason: 'not-a-string', payloadType: type });
  });

  it('rejects a payload that is not base64, rather than playing whatever survives decoding', () => {
    expect(classifyReplyAudio('this is not audio!', MAX)).toMatchObject({ accepted: false, reason: 'not-base64' });
  });

  it('rejects a payload that decodes to nothing', () => {
    expect(classifyReplyAudio('====', MAX)).toMatchObject({ accepted: false, reason: 'decoded-empty' });
  });

  it('rejects an oversized payload', () => {
    const big = Buffer.alloc(MAX + 2).toString('base64');
    expect(classifyReplyAudio(big, MAX)).toMatchObject({ accepted: false, reason: 'oversized' });
  });
});

describe('a reply is summarised: what the provider sent, against what it said', () => {
  it('names the writing system of a transcript, never its words', () => {
    expect(scriptOf(HINDI)).toBe('devanagari');
    expect(scriptOf(ENGLISH)).toBe('latin');
    expect(scriptOf(`${ENGLISH} ${HINDI}`)).toBe('mixed');
    expect(scriptOf('123 !?')).toBe('none');
  });

  it('counts audio, bytes, duration and the delay to the first chunk', () => {
    let now = 1_000;
    const ledger = new ReplyLedger(VOICE_AGENT_LIMITS.sampleRate, () => now);
    ledger.begin('speech-1');
    ledger.transcript(ENGLISH);
    now = 1_300;
    ledger.audio(classifyReplyAudio(PCM_100MS, MAX), 'speech-1', 1);
    ledger.audio(classifyReplyAudio(PCM_100MS, MAX), 'speech-1', 2);
    ledger.audio(classifyReplyAudio('', MAX), 'speech-1', null);

    expect(ledger.done('completed')).toMatchObject({
      speechId: 'speech-1',
      transcriptChars: ENGLISH.length,
      script: 'latin',
      audioMessages: 3,
      acceptedChunks: 2,
      acceptedBytes: 9_600,
      audioMs: 200,
      rejected: { empty: 1 },
      firstAudioAfterMs: 300,
    });
  });
});

describe('delivery to a window is reported by the transport, not assumed', () => {
  const chunk: SpeechChunk = { speechId: 's', pcm: new Uint8Array(4), sampleRate: 24_000, sequence: 1, final: false };

  it('false with no window attached', () => {
    expect(new SpeechTransport().chunk(chunk)).toBe(false);
  });

  it('true when a live window took it; false when the window was gone', () => {
    const transport = new SpeechTransport();
    let alive = true;
    transport.attach({ deliver: () => {}, stop: () => {}, chunk: () => alive });
    expect(transport.chunk(chunk)).toBe(true);
    alive = false;
    expect(transport.chunk(chunk)).toBe(false);
  });
});

describe('the whole path, on a real voice session', () => {
  const rigs: VoiceRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.dispose();
  });

  async function session(options: { window: 'live' | 'none' } = { window: 'live' }) {
    const lines: string[] = [];
    const delivered: SpeechChunk[] = [];
    const speech = new SpeechTransport();
    if (options.window === 'live') {
      speech.attach({ deliver: () => {}, stop: () => {}, chunk: (c) => (delivered.push(c), true) });
    }
    const r = await voiceRig({
      tools: [createSystemTimeTool()],
      orchestrator: { diagnostics: new VoiceDiagnostics({ log: (line) => lines.push(line) }), speechChunks: speech },
    });
    rigs.push(r);
    await r.start();
    return { r, lines, delivered };
  }

  /** The provider replies: started, the words, some audio, done. */
  async function reply(r: VoiceRig, text: string, audio: readonly unknown[]): Promise<void> {
    await r.provider.send({ type: 'reply.started' });
    await r.provider.send({ type: 'transcript.agent', text });
    for (const data of audio) await r.provider.send({ type: 'reply.audio', data });
    await r.endReply();
  }

  /** A reply SUMMARY line — "[voice] reply 3 (...)" — not a per-payload rejection line. */
  const isSummary = (line: string): boolean => /^\[voice\] reply \d+ \(/.test(line);
  const replyLine = (lines: string[]): string | undefined => lines.find(isSummary);

  it('THE HINDI CASE: words, and no audio — named as the provider sending none', async () => {
    const { r, lines } = await session();
    await reply(r, HINDI, []);

    expect(await until(() => replyLine(lines) !== undefined)).toBe(true);
    const line = replyLine(lines)!;
    expect(line).toMatch(/transcript \d+ chars \[devanagari\]/);
    expect(line).toMatch(/provider audio: 0 message\(s\)/);
    expect(line).toMatch(/PROVIDER SENT NO AUDIO FOR THIS REPLY/);
  });

  it('an English reply with audio: every chunk accepted, delivered, correlated by speechId', async () => {
    const { r, lines, delivered } = await session();
    await reply(r, ENGLISH, [PCM_100MS, PCM_100MS, PCM_100MS]);

    expect(await until(() => replyLine(lines) !== undefined)).toBe(true);
    const line = replyLine(lines)!;
    expect(line).toMatch(/\[latin\]/);
    expect(line).toMatch(/3 message\(s\), 3 accepted \(300 ms, 14400 bytes\)/);
    expect(line).toMatch(/to window: 3 delivered, 0 dropped/);
    expect(line).not.toMatch(/PROVIDER SENT NO AUDIO|REJECTED ALL|NO WINDOW/);

    // Correlation: one speechId across every chunk and the summary, sequenced.
    const audio = delivered.filter((chunk) => !chunk.final);
    expect(new Set(audio.map((chunk) => chunk.speechId)).size).toBe(1);
    expect(audio.map((chunk) => chunk.sequence)).toEqual([1, 2, 3]);
    expect(line).toContain(audio[0]!.speechId.slice(0, 8));
  });

  it('rejected payloads are named one by one, and the reply says Axon kept none', async () => {
    const { r, lines, delivered } = await session();
    await reply(r, ENGLISH, ['', 42, 'not audio at all!', '====']);

    expect(await until(() => replyLine(lines) !== undefined)).toBe(true);
    expect(lines.filter((line) => line.includes('REJECTED ('))).toHaveLength(4);
    expect(lines.some((line) => /REJECTED \(empty\)/.test(line))).toBe(true);
    expect(lines.some((line) => /REJECTED \(not-a-string\): number payload/.test(line))).toBe(true);
    expect(lines.some((line) => /REJECTED \(not-base64\)/.test(line))).toBe(true);
    expect(lines.some((line) => /REJECTED \(decoded-empty\)/.test(line))).toBe(true);
    expect(replyLine(lines)).toMatch(/AXON REJECTED ALL OF IT/);
    // Nothing rejected ever reached a window.
    expect(delivered.filter((chunk) => !chunk.final)).toEqual([]);
  });

  it('audio that no window received is named as such', async () => {
    const { r, lines } = await session({ window: 'none' });
    await reply(r, ENGLISH, [PCM_100MS, PCM_100MS]);

    expect(await until(() => replyLine(lines) !== undefined)).toBe(true);
    expect(replyLine(lines)).toMatch(/to window: 0 delivered, 2 dropped -- NO WINDOW RECEIVED IT/);
  });

  it('the window’s own report is printed: received, started, ended, failed', async () => {
    const { r, lines } = await session();
    r.orchestrator.reportPlaybackDiagnostics({ speechId: 'abcdef123456', event: 'started', chunks: 2, bytes: 9_600, reason: null });
    r.orchestrator.reportPlaybackDiagnostics({
      speechId: 'abcdef123456',
      event: 'failed',
      chunks: 3,
      bytes: 14_400,
      reason: 'AudioContext could not start',
    });
    expect(lines).toContain('[voice] playback (speech abcdef12): started -- 2 chunks, 9600 bytes received');
    expect(lines).toContain('[voice] playback (speech abcdef12): FAILED: AudioContext could not start -- 3 chunks, 14400 bytes received');
  });

  it('never logs audio, a payload, or a word Axon said', async () => {
    const { r, lines } = await session();
    await reply(r, HINDI, [PCM_100MS, 'not audio at all!']);
    await reply(r, ENGLISH, [PCM_100MS]);
    expect(await until(() => lines.filter(isSummary).length >= 2)).toBe(true);

    // Every reply line: the summaries AND the per-payload rejections.
    const replyLines = lines.filter((line) => line.startsWith('[voice] reply'));
    expect(replyLines.length).toBeGreaterThanOrEqual(3);
    for (const line of replyLines) {
      expect(line).not.toContain(HINDI);
      expect(line).not.toContain('धन्यवाद');
      expect(line).not.toContain(ENGLISH);
      expect(line).not.toContain(PCM_100MS.slice(0, 16));
      expect(line).not.toContain('not audio at all');
    }
  });

  it('with diagnostics off, the session still plays and nothing is printed', async () => {
    const delivered: SpeechChunk[] = [];
    const speech = new SpeechTransport();
    speech.attach({ deliver: () => {}, stop: () => {}, chunk: (c) => (delivered.push(c), true) });
    const r = await voiceRig({ tools: [], orchestrator: { speechChunks: speech } });
    rigs.push(r);
    await r.start();
    await reply(r, ENGLISH, [PCM_100MS]);
    expect(await until(() => delivered.some((chunk) => !chunk.final))).toBe(true);
  });
});

describe('the window reports playback, and main accepts only numbers and fixed words', () => {
  it('reports the first chunk as received, then started and ended, with totals', () => {
    const reports: unknown[] = [];
    const tracker = new PlaybackTracker((report) => reports.push(report));
    tracker.chunk('s1', 4_800, false);
    tracker.chunk('s1', 4_800, false);
    tracker.started('s1');
    tracker.chunk('s1', 4_800, false);
    tracker.chunk('s1', 0, true); // the drain marker is not audio
    tracker.ended('s1');

    expect(reports).toEqual([
      { speechId: 's1', event: 'received', chunks: 1, bytes: 4_800, reason: null },
      { speechId: 's1', event: 'started', chunks: 2, bytes: 9_600, reason: null },
      { speechId: 's1', event: 'ended', chunks: 3, bytes: 14_400, reason: null },
    ]);
  });

  it('reports a failure with the player’s reason', () => {
    const reports: unknown[] = [];
    const tracker = new PlaybackTracker((report) => reports.push(report));
    tracker.chunk('s2', 100, false);
    tracker.failed('s2', 'AudioContext could not start');
    expect(reports.at(-1)).toEqual({ speechId: 's2', event: 'failed', chunks: 1, bytes: 100, reason: 'AudioContext could not start' });
  });

  it('never lets a diagnostic stop the audio', () => {
    const tracker = new PlaybackTracker(() => {
      throw new Error('bridge gone');
    });
    expect(() => tracker.chunk('s3', 10, false)).not.toThrow();
    expect(() => tracker.started('s3')).not.toThrow();
  });

  it('main accepts a well-formed report', () => {
    expect(validPlaybackDiagnostics({ speechId: 's', event: 'ended', chunks: 3, bytes: 14_400, reason: null })).not.toBeNull();
  });

  it.each([
    ['an extra field', { speechId: 's', event: 'ended', chunks: 1, bytes: 1, reason: null, pcm: 'AAAA' }],
    ['an unknown event', { speechId: 's', event: 'played-something-else', chunks: 1, bytes: 1, reason: null }],
    ['a negative count', { speechId: 's', event: 'ended', chunks: -1, bytes: 1, reason: null }],
    ['a fractional count', { speechId: 's', event: 'ended', chunks: 1.5, bytes: 1, reason: null }],
    ['an over-long reason', { speechId: 's', event: 'failed', chunks: 1, bytes: 1, reason: 'x'.repeat(500) }],
    ['an over-long id', { speechId: 'x'.repeat(200), event: 'ended', chunks: 1, bytes: 1, reason: null }],
    ['no id', { speechId: '', event: 'ended', chunks: 1, bytes: 1, reason: null }],
  ])('main refuses a report with %s', (_why, raw) => {
    expect(validPlaybackDiagnostics(raw)).toBeNull();
  });
});

describe('the new bridge member grants nothing', () => {
  it('is fire-and-forget from the preload, with no reply to learn from', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const preload = readFileSync(path.resolve(__dirname, '../src/preload/index.ts'), 'utf8');
    const member = preload.slice(preload.indexOf('reportPlaybackDiagnostics('), preload.indexOf('async cancelSpeech('));
    expect(member).toMatch(/ipcRenderer\.send\(IPC_CHANNELS\.SPEECH_PLAYBACK_DIAGNOSTICS/);
    expect(member).not.toMatch(/ipcRenderer\.invoke/);
    // Values only from the channel constants: the preload stays the small
    // audited bridge, and does not pull core's runtime in with it.
    expect(preload).not.toMatch(/import \{[^}]*PLAYBACK_EVENTS[^}]*\} from '@axon\/core'/);
  });

  it('is accepted only from the live voice surface, and only after strict parsing', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const bridge = readFileSync(path.resolve(__dirname, '../src/main/bus/renderer-bridge.ts'), 'utf8');
    const handler = bridge.slice(bridge.indexOf('IPC_CHANNELS.SPEECH_PLAYBACK_DIAGNOSTICS,'), bridge.indexOf('// Numeric capture diagnostics'));
    expect(handler).toMatch(/if \(!fromVoice\(event\.sender\)\) return;/);
    expect(handler.indexOf('fromVoice')).toBeLessThan(handler.indexOf('validPlaybackDiagnostics'));
  });
});
