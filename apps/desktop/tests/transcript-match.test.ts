/**
 * Scoring a human voice test: forgiving of formatting, strict about meaning.
 */

import { describe, expect, it } from 'vitest';
import { matchTranscript, normalizeTranscript } from '../src/main/voice/transcript-match.js';

describe('normalising a transcript', () => {
  it('ignores case and punctuation', () => {
    expect(normalizeTranscript('Open Calculator.')).toEqual(['open', 'calculator']);
    expect(normalizeTranscript('What time is it?')).toEqual(['what', 'time', 'is', 'it']);
  });

  it('turns number words into digits, and digits stay digits', () => {
    expect(normalizeTranscript('Calculate one hundred twenty five times forty eight')).toEqual(['calculate', '125', 'times', '48']);
    expect(normalizeTranscript('calculate one hundred and twenty-five times forty-eight')).toEqual(['calculate', '125', 'times', '48']);
    expect(normalizeTranscript('Calculate 125 × 48')).toEqual(['calculate', '125', 'times', '48']);
    expect(normalizeTranscript('calculate 125 x 48')).toEqual(['calculate', '125', 'times', '48']);
  });

  it('joins "you tube" into one word', () => {
    expect(normalizeTranscript('Open You Tube')).toEqual(['open', 'youtube']);
  });
});

describe('scoring a recognition', () => {
  it('passes harmless formatting differences', () => {
    expect(matchTranscript('Open Calculator', 'open calculator.').verdict).toBe('PASS');
    expect(matchTranscript('Calculate 125 times 48', 'Calculate one hundred twenty-five times 48.').verdict).toBe('PASS');
    expect(matchTranscript('Hello Axon', 'Hello, Axon!').verdict).toBe('PASS');
  });

  it('fails severe corruption', () => {
    expect(matchTranscript('Open Calculator', 'I have a cold later').verdict).toBe('FAIL');
    expect(matchTranscript('What time is it?', 'But who').verdict).toBe('FAIL');
  });

  it('calls a half-right recognition CLOSE, not PASS', () => {
    expect(matchTranscript('Calculate 125 times 48', 'calculate 125 dimes 40').verdict).toBe('CLOSE');
  });

  it('fails when nothing was heard', () => {
    expect(matchTranscript('Open YouTube', null).verdict).toBe('FAIL');
    expect(matchTranscript('Open YouTube', '').verdict).toBe('FAIL');
  });

  it('reports a word error rate', () => {
    expect(matchTranscript('open calculator', 'open calculator').wordErrorRate).toBe(0);
    expect(matchTranscript('open calculator', 'open').wordErrorRate).toBe(0.5);
  });
});
