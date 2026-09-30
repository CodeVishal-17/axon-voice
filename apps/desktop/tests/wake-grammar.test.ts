/**
 * The wake grammar, asserted against the program Axon actually runs.
 *
 * `wake-integration.test.ts` shows what the real engine does with a
 * synthesised voice. This file pins the properties that must hold whatever
 * any voice sounds like:
 *
 * - the wake recognizer has NO free dictation, which a real microphone test
 *   showed out-competing the wake phrase ("Hey Axon" -> "But who");
 * - its competitor is a list of near misses that never contains a wake phrase,
 *   and never contains a real mishearing of one — that would teach the
 *   recognizer to reject the person it is meant to hear;
 * - a near-miss result never wakes Axon, however confident;
 * - the process that listens while Axon is idle can reach no network, no file,
 *   no microphone of its own, and holds no credential.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recognizerEnvironment } from '../src/main/voice/windows-stt.js';
import {
  decideWake,
  judgePhraseCoverage,
  matchesWakePhrase,
  MAX_PHRASE_SPAN_MS,
  MAX_SPEECH_OUTSIDE_PHRASE_MS,
  speechOutsidePhraseMs,
  WAKE_PHRASES,
  type VoicedStretch,
} from '../src/main/wake/wake-word.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '../src/main/voice/windows-stt.ts'), 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function block(start: string, end: string): string {
  const from = CODE.indexOf(start);
  const to = CODE.indexOf(end, from);
  expect(from, `${start} exists`).toBeGreaterThanOrEqual(0);
  expect(to, `${end} follows ${start}`).toBeGreaterThan(from);
  return CODE.slice(from, to);
}

const WAKE_GRAMMAR = block('const WAKE_GRAMMAR', 'const WAKE_BODY');
const WAKE_BODY = block('const WAKE_BODY', 'const SCRIPT');
const NEAR_MISSES = [...block('$nearBuilder.Append', '$near = New-Object').matchAll(/'([a-z ]+)'/g)].map((m) => m[1]);

describe('the wake recognizer program', () => {
  it('listens with no free dictation', () => {
    expect(WAKE_GRAMMAR + WAKE_BODY).not.toMatch(/DictationGrammar|DICTATION_GRAMMAR/);
    expect(CODE).toMatch(/const WAKE_SCRIPT = \[\.\.\.HEADER, \.\.\.WAKE_GRAMMAR, \.\.\.WAKE_BODY\]\.join/);
  });

  it('loads exactly two grammars, the phrase and its near misses', () => {
    expect(WAKE_GRAMMAR.match(/LoadGrammar\(/g)).toHaveLength(2);
    expect(WAKE_GRAMMAR).toContain("$wake.Name = 'wake'");
    expect(WAKE_GRAMMAR).toContain("$near.Name = 'near-miss'");
    expect(WAKE_GRAMMAR).toContain("Choices([string[]]@('hey', 'hello', 'hi'))");
    expect(WAKE_GRAMMAR).toContain("$wakeBuilder.Append('axon')");
  });

  it('competes against the sound-alikes the brief names', () => {
    for (const word of ['axon', 'hey', 'hello', 'hi', 'action', 'exon', 'eight', 'song', 'who', 'own']) {
      expect(NEAR_MISSES, word).toContain(word);
    }
  });

  it('never lists a wake phrase as a near miss', () => {
    for (const phrase of WAKE_PHRASES) expect(NEAR_MISSES).not.toContain(phrase);
    // No entry pairs the name with anything else: "axon" on its own is a near
    // miss, "hey axon" never is. (Word boundaries, so "taxon" is not the name.)
    expect(NEAR_MISSES.filter((entry) => /\baxon\b/.test(entry ?? '') && entry !== 'axon')).toEqual([]);
  });

  it('never lists a real mishearing of the wake phrase, which would teach it to reject the user', () => {
    for (const heard of ['but who', 'and who', 'new song']) expect(NEAR_MISSES).not.toContain(heard);
  });

  it('reports results by grammar, and rejections separately', () => {
    expect(WAKE_BODY).toContain("if ($r.Grammar.Name -eq 'wake') { $verb = 'WAKE ' }");
    expect(WAKE_BODY).toContain("$verb = 'NEAR '");
    expect(WAKE_BODY).toContain("'REJECTED '");
  });

  it('reaches no network, no file and no microphone of its own', () => {
    for (const forbidden of [
      /System\.Net/,
      /WebClient/,
      /Invoke-WebRequest/,
      /Invoke-RestMethod/,
      /Start-Process/,
      /Out-File/,
      /Set-Content/,
      /Add-Content/,
      /FileStream/,
      /SetInputToWaveFile/,
      /SetInputToDefaultAudioDevice/,
    ]) {
      expect(CODE, forbidden.source).not.toMatch(forbidden);
    }
    // Audio arrives on stdin, from Axon, and from nowhere else.
    expect(WAKE_BODY).toContain('[Console]::OpenStandardInput().CopyTo($audio)');
  });

  it('is spawned with the credential-free environment', () => {
    expect(CODE).toMatch(/env: recognizerEnvironment\(\)/);
  });
});

describe('the recognizer environment', () => {
  it('keeps only what PowerShell needs to start', () => {
    const env = recognizerEnvironment({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      SystemDrive: 'C:',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      PATH: 'C:\\Windows\\System32',
      ASSEMBLYAI_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      USERPROFILE: 'C:\\Users\\someone',
      AXON_HOME: 'C:\\Users\\someone\\Axon',
    });
    expect(Object.keys(env).sort()).toEqual(['Path', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'windir'].sort());
    expect(Object.values(env)).not.toContain('secret');
  });

  it('omits what is not set rather than inventing it', () => {
    expect(recognizerEnvironment({ SystemRoot: 'C:\\Windows', TEMP: '' })).toEqual({ SystemRoot: 'C:\\Windows' });
  });
});

describe('deciding on a wake grammar result', () => {
  const result = (text: string, source: 'wake-phrase' | 'near-miss' | 'dictation' | undefined, confidence = 0.95) => ({
    text,
    isFinal: true,
    confidence,
    source,
  });

  it('wakes on a confident wake-grammar match', () => {
    expect(decideWake(result('hey axon', 'wake-phrase')).wake).toBe(true);
  });

  it('never wakes on a near miss, however confident or however it is spelt', () => {
    for (const text of ['hey axon', 'axon', 'hey jackson', 'action']) {
      expect(decideWake(result(text, 'near-miss', 1)).wake, text).toBe(false);
    }
  });

  it('refuses a wake-grammar match below the confidence floor', () => {
    expect(decideWake(result('hey axon', 'wake-phrase', 0.2)).wake).toBe(false);
  });

  it('never wakes on the phrases the human microphone test produced, from any source', () => {
    for (const text of ['But who', 'And who', 'New song']) {
      for (const source of ['wake-phrase', 'near-miss', 'dictation', undefined] as const) {
        expect(decideWake(result(text, source)).wake, `${text} from ${source ?? 'text'}`).toBe(false);
      }
    }
  });

  it('never wakes on the sound-alikes the brief names, by text', () => {
    for (const text of [
      'Axon',
      'Hey',
      'Hello',
      'Hi',
      'I was talking about Axon yesterday',
      'Axon is a company',
      'action',
      'exon',
      'eight',
      'song',
      'who',
      'own',
    ]) {
      expect(matchesWakePhrase(text), text).toBe(false);
    }
  });
});

describe('the phrase must be the utterance', () => {
  // Timelines are lengths and voiced flags — exactly, and only, what the
  // detector keeps. The spans are the ones measured on the Windows recognizer.
  const samples = (ms: number): number => Math.round((ms / 1000) * 16_000);
  const quiet = (ms: number): VoicedStretch => ({ samples: samples(ms), voiced: false });
  const speech = (ms: number): VoicedStretch => ({ samples: samples(ms), voiced: true });

  it('accepts "Hey Axon" said on its own (measured span 460+940ms)', () => {
    const verdict = judgePhraseCoverage([quiet(420), speech(1000), quiet(600)], { startMs: 460, durationMs: 940 });
    expect(verdict.ok, verdict.note).toBe(true);
  });

  it('refuses a match stretched across a sentence (measured: "I was talking about Axon yesterday" as "hi axon", 470+1890ms)', () => {
    const verdict = judgePhraseCoverage([quiet(400), speech(2500), quiet(500)], { startMs: 470, durationMs: 1890 });
    expect(verdict.ok).toBe(false);
    expect(MAX_PHRASE_SPAN_MS).toBeGreaterThan(1110);
    expect(MAX_PHRASE_SPAN_MS).toBeLessThan(1890);
  });

  it('refuses the name followed by a request in one breath (measured: "Hey Axon, open calculator", 460+960ms)', () => {
    const timeline = [quiet(400), speech(1000), quiet(150), speech(1300), quiet(500)];
    const span = { startMs: 460, durationMs: 960 };
    expect(speechOutsidePhraseMs(timeline, span)).toBeGreaterThan(MAX_SPEECH_OUTSIDE_PHRASE_MS);
    expect(judgePhraseCoverage(timeline, span).ok).toBe(false);
  });

  it('allows the recognizer a little alignment slack at either edge', () => {
    expect(judgePhraseCoverage([quiet(250), speech(1300), quiet(500)], { startMs: 400, durationMs: 1000 }).ok).toBe(true);
  });

  it('falls back to the length of the speech when the recognizer gives no timing', () => {
    expect(judgePhraseCoverage([quiet(400), speech(900)], undefined).ok).toBe(true);
    expect(judgePhraseCoverage([quiet(400), speech(2400)], undefined).ok).toBe(false);
  });
});
