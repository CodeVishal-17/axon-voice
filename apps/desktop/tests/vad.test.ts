/**
 * Voice activity detection.
 *
 * The detector decides when an utterance is over, which makes it the thing
 * that decides when Axon stops listening. These tests drive it with
 * synthesised frames rather than a microphone, because the property being
 * checked is the decision rule, not the audio hardware — the real microphone
 * path is exercised in `voice-integration.test.ts`.
 *
 * Every threshold in the detector is expressed in milliseconds of AUDIO, so
 * these tests are deterministic: no timers, no waiting, no flake.
 */

import { describe, expect, it } from 'vitest';
import { LISTENING_LIMITS } from '@axon/core';
import { frameRms, VoiceActivityDetector, type VadEvent } from '../src/main/voice/vad.js';

const RATE = LISTENING_LIMITS.sampleRate;
/** 32ms at 16kHz. Small enough to resolve the silence window precisely. */
const FRAME = 512;

/** A frame of digital silence. */
function silence(samples = FRAME): Int16Array {
  return new Int16Array(samples);
}

/**
 * A frame of noise at a given RMS, 0..1.
 *
 * Alternating +/- rather than random, so a test that fails fails for a reason
 * and not because a seed happened to be unlucky.
 */
function tone(rms: number, samples = FRAME): Int16Array {
  const amplitude = Math.round(rms * 32767);
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  return frame;
}

/** Push `ms` of the given frame and collect every event the detector emitted. */
function pushFor(vad: VoiceActivityDetector, frame: Int16Array, ms: number): VadEvent[] {
  const events: VadEvent[] = [];
  const frameMs = (frame.length / RATE) * 1000;
  const count = Math.ceil(ms / frameMs);
  for (let i = 0; i < count; i += 1) {
    const result = vad.push(frame);
    if (result.event !== 'none') events.push(result.event);
  }
  return events;
}

describe('frameRms', () => {
  it('reads digital silence as zero', () => {
    expect(frameRms(silence())).toBe(0);
  });

  it('reads a full-scale square wave as one', () => {
    expect(frameRms(tone(1))).toBeCloseTo(1, 2);
  });

  it('is proportional to amplitude', () => {
    expect(frameRms(tone(0.5))).toBeCloseTo(0.5, 2);
    expect(frameRms(tone(0.1))).toBeCloseTo(0.1, 2);
  });

  it('does not divide by zero on an empty frame', () => {
    expect(frameRms(new Int16Array(0))).toBe(0);
  });
});

describe('detecting speech', () => {
  it('says nothing while the room is quiet', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    expect(pushFor(vad, silence(), 2_000)).toEqual([]);
  });

  it('reports speech once, at the onset', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    const events = pushFor(vad, tone(0.2), 1_000);
    expect(events).toEqual(['speech-started']);
  });

  it('does not open on a single-frame spike', () => {
    // A key click or a chair creak. One loud frame is not speech, and treating
    // it as such would open the microphone and then wait out the full silence
    // window before closing it again.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, onsetMs: 120 });
    vad.push(tone(0.4));
    const events = pushFor(vad, silence(), 500);
    expect(events).toEqual([]);
  });

  it('needs sustained audio before it calls it speech', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, onsetMs: 200, calibrationMs: 200 });
    // The room is measured first — the gap between pressing the hotkey and
    // starting to speak.
    pushFor(vad, silence(), 300);

    // 100ms is under the onset window.
    expect(pushFor(vad, tone(0.2), 100)).toEqual([]);
    // Continuing past it opens the utterance.
    expect(pushFor(vad, tone(0.2), 200)).toEqual(['speech-started']);
  });

  it('ignores quiet background hiss', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    expect(pushFor(vad, tone(0.003), 3_000)).toEqual([]);
  });
});

describe('ending an utterance', () => {
  it('ends after the silence window and not before', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 900 });
    expect(pushFor(vad, tone(0.2), 500)).toEqual(['speech-started']);

    // Most of the way through the window: still listening.
    expect(pushFor(vad, silence(), 800)).toEqual([]);
    // Past it: finished.
    expect(pushFor(vad, silence(), 200)).toEqual(['speech-ended']);
  });

  it('survives a pause between words', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 900 });
    pushFor(vad, tone(0.2), 400);
    // "open... notepad" — half a second of thinking, well inside the window.
    expect(pushFor(vad, silence(), 500)).toEqual([]);
    expect(pushFor(vad, tone(0.2), 400)).toEqual([]);
    // And the silence budget resets, so the end is measured from the last word.
    expect(pushFor(vad, silence(), 800)).toEqual([]);
    expect(pushFor(vad, silence(), 200)).toEqual(['speech-ended']);
  });

  it('holds through a quiet consonant', () => {
    // Hysteresis: sustaining speech takes less energy than starting it, so an
    // unvoiced sound in the middle of a word does not read as a pause.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 900 });
    pushFor(vad, tone(0.3), 400);
    const threshold = vad.threshold;
    // Below the speech threshold, above the release threshold.
    expect(pushFor(vad, tone(threshold * 0.8), 600)).toEqual([]);
  });

  it('transcribes a very short utterance', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 900, onsetMs: 120 });
    pushFor(vad, silence(), 300);
    // "Stop." — a fifth of a second.
    expect(pushFor(vad, tone(0.25), 200)).toEqual(['speech-started']);
    expect(pushFor(vad, silence(), 1_000)).toEqual(['speech-ended']);
    expect(vad.heardSpeech).toBe(true);
  });

  it('emits exactly one ending, whatever arrives afterwards', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 500 });
    pushFor(vad, tone(0.2), 400);
    expect(pushFor(vad, silence(), 700)).toEqual(['speech-ended']);
    // A late frame must not reopen a closed utterance.
    expect(pushFor(vad, tone(0.5), 2_000)).toEqual([]);
  });
});

describe('limits', () => {
  it('gives up when nothing is ever said', () => {
    // An accidental activation: press the hotkey, say nothing, and the
    // microphone closes on its own.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, speechStartTimeoutMs: 2_000 });
    expect(pushFor(vad, silence(), 1_900)).toEqual([]);
    expect(pushFor(vad, silence(), 200)).toEqual(['no-speech-timeout']);
  });

  it('does not give up once speech has started', () => {
    const vad = new VoiceActivityDetector({
      sampleRate: RATE,
      speechStartTimeoutMs: 1_000,
      silenceMs: 900,
      maxUtteranceMs: 30_000,
    });
    pushFor(vad, silence(), 300);
    pushFor(vad, tone(0.2), 300);
    // Well past the start timeout, but someone is talking.
    expect(pushFor(vad, tone(0.2), 4_000)).toEqual([]);
  });

  it('closes an utterance at the duration ceiling', () => {
    const vad = new VoiceActivityDetector({
      sampleRate: RATE,
      maxUtteranceMs: 3_000,
      silenceMs: 5_000,
      speechStartTimeoutMs: 10_000,
    });
    pushFor(vad, silence(), 300);
    pushFor(vad, tone(0.2), 200);
    expect(pushFor(vad, tone(0.2), 3_200)).toEqual(['max-duration']);
  });

  it('measures time from the audio, not from the clock', () => {
    // A renderer sending frames faster than real time cannot stretch an
    // utterance past its limit: 3 seconds of audio is 3 seconds of audio
    // however quickly it arrives.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, maxUtteranceMs: 3_000, silenceMs: 5_000 });
    pushFor(vad, tone(0.2), 200);
    expect(Math.round(vad.elapsedMs)).toBeLessThanOrEqual(300);
    pushFor(vad, tone(0.2), 3_200);
    expect(vad.elapsedMs).toBeGreaterThanOrEqual(3_000);
  });
});

describe('measuring the room before judging it', () => {
  it('does not mistake a noisy room for speech', () => {
    // The regression this window exists for. A fan at 0.02 RMS sits above the
    // absolute threshold, so without calibration it is declared speech within
    // two frames — the microphone then stays open on nothing until a timeout,
    // and the transcript comes back empty.
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    expect(pushFor(vad, tone(0.02), 4_000)).toEqual([]);
  });

  it('declares nothing at all while it is still measuring', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE, calibrationMs: 400, onsetMs: 50 });
    expect(pushFor(vad, tone(0.3), 380)).toEqual([]);
    expect(vad.calibrating).toBe(true);
    // And opens promptly once the window is over.
    expect(pushFor(vad, tone(0.3), 200)).toEqual(['speech-started']);
  });

  it('still hears someone who starts talking immediately', () => {
    // The cost of the window has to be bounded: the measured floor is capped,
    // so even a session that opens onto a voice reaches a threshold below it.
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    expect(pushFor(vad, tone(0.25), 1_000)).toEqual(['speech-started']);
  });
});

describe('adapting to the room', () => {
  it('raises its threshold in a noisy room', () => {
    const quiet = new VoiceActivityDetector({ sampleRate: RATE });
    const noisy = new VoiceActivityDetector({ sampleRate: RATE });

    pushFor(quiet, tone(0.001), 2_000);
    pushFor(noisy, tone(0.02), 2_000);

    expect(noisy.threshold).toBeGreaterThan(quiet.threshold);
  });

  it('still hears a voice over that noise', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    // A fan running for two seconds, then someone speaking over it.
    pushFor(vad, tone(0.02), 2_000);
    expect(pushFor(vad, tone(0.25), 500)).toEqual(['speech-started']);
  });

  it('never drops its threshold below the absolute floor', () => {
    // In a silent room the adaptive floor tends to zero. Without an absolute
    // minimum, the threshold would follow it and the detector would open on
    // dither.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, absoluteThreshold: 0.012 });
    pushFor(vad, silence(), 5_000);
    expect(vad.threshold).toBeGreaterThanOrEqual(0.012);
  });

  it('does not chase the voice while someone is speaking', () => {
    // Adapting during speech would raise the floor to meet the voice and then
    // treat the voice as background — the utterance would end mid-sentence.
    const vad = new VoiceActivityDetector({ sampleRate: RATE, silenceMs: 900 });
    pushFor(vad, tone(0.3), 300);
    const thresholdAtOnset = vad.threshold;
    pushFor(vad, tone(0.3), 5_000);
    expect(vad.threshold).toBe(thresholdAtOnset);
  });
});
