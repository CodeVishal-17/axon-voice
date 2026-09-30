/**
 * Where microphone audio actually goes, as numbers.
 *
 * Two human-test failures motivated this, and they looked like they were about
 * two different things: the wake detector "falling seconds behind", and the
 * voice session transcribing a person "extremely incorrectly". Both could have
 * been the recognizer. Both could equally have been the audio never arriving
 * intact. Guessing which is how the wrong thing gets fixed, so this measures
 * each hop:
 *
 *     capture page     what the AudioContext and the track really are, how
 *                      many callbacks ran, how much audio was produced, how
 *                      loud it was                      (reported by the page)
 *     main             frames that arrived, the audio they held, the largest
 *                      gap between them                 (counted here)
 *     AssemblyAI       bytes actually sent, chunks, the largest gap between
 *                      sends, the socket's own queue, audio dropped and why
 *                                                       (counted here)
 *
 * and prints them side by side every couple of seconds, so "the page produced
 * 2000 ms, main received 2000 ms, 2000 ms went to AssemblyAI" — or where that
 * chain breaks — is a line on the screen rather than a theory.
 *
 * NEVER AUDIO. Counters, maxima and loudness. The one thing here with words in
 * it is the provider's transcript, printed only in a development build with
 * AXON_VOICE_DEBUG=1, to the developer console, never to the event log.
 *
 * Imports only `@axon/core`. Output goes through an injected `log`, so it is
 * silent unless the runtime supplies one.
 */

import type { CaptureDiagnostics, PlaybackDiagnostics } from '@axon/core';

/**
 * One `reply.audio` message, as the session classified it. Declared here,
 * structurally, so this module still imports only `@axon/core`; the session's
 * own `ReplyAudioEvent` satisfies it.
 */
export interface ReplyAudioNote {
  readonly speechId: string | null;
  readonly accepted: boolean;
  readonly reason: string | null;
  readonly payloadType: string;
  readonly payloadChars: number;
}

/** One reply, summarised when it ended. The session's `ReplySummary` satisfies it. */
export interface ReplyNote {
  readonly reply: number;
  readonly speechId: string | null;
  readonly status: string;
  readonly transcriptChars: number;
  readonly script: string;
  readonly audioMessages: number;
  readonly acceptedChunks: number;
  readonly acceptedBytes: number;
  readonly audioMs: number;
  readonly rejected: Readonly<Record<string, number>>;
  readonly firstAudioAfterMs: number | null;
}

/** Replies whose delivery counts are held. A bound, not a feature. */
const MAX_TRACKED_REPLIES = 32;

const short = (speechId: string | null): string => (speechId ? speechId.slice(0, 8) : '--------');

/** Who a capture belongs to. */
export type CaptureConsumer = 'wake' | 'voice' | 'listening';

/** How often main's own counters are printed. Matches the page's report interval. */
export const MAIN_WINDOW_MS = 2_000;

interface FrameWindow {
  frames: number;
  samples: number;
  sampleRate: number;
  lastAt: number | null;
  maxGapMs: number;
}

interface SendWindow {
  chunks: number;
  bytes: number;
  lastAt: number | null;
  maxGapMs: number;
  maxBufferedBytes: number;
  droppedNotReady: number;
  droppedNoSocket: number;
}

export interface VoiceDiagnosticsOptions {
  /** Where lines go. Null means silent — the shipping configuration. */
  readonly log: ((line: string) => void) | null;
  readonly now?: () => number;
}

export class VoiceDiagnostics {
  private readonly log: ((line: string) => void) | null;
  private readonly now: () => number;
  private readonly frames = new Map<CaptureConsumer, FrameWindow>();
  private send: SendWindow = VoiceDiagnostics.emptySend();
  private windowStartedAt: number;
  /** Per reply: chunks a live window took, and chunks no window took. */
  private readonly delivery = new Map<string, { delivered: number; dropped: number }>();

  constructor(options: VoiceDiagnosticsOptions) {
    this.log = options.log;
    this.now = options.now ?? ((): number => Date.now());
    this.windowStartedAt = this.now();
  }

  /** Whether anything is listening. Capture commands ask the page for reports only when this is true. */
  get enabled(): boolean {
    return this.log !== null;
  }

  private static emptySend(): SendWindow {
    return { chunks: 0, bytes: 0, lastAt: null, maxGapMs: 0, maxBufferedBytes: 0, droppedNotReady: 0, droppedNoSocket: 0 };
  }

  /** One frame arrived in main for a consumer. Counts only. */
  frame(consumer: CaptureConsumer, samples: number, sampleRate: number): void {
    if (!this.enabled) return;
    const now = this.now();
    const window = this.frames.get(consumer) ?? { frames: 0, samples: 0, sampleRate, lastAt: null, maxGapMs: 0 };
    window.frames += 1;
    window.samples += samples;
    window.sampleRate = sampleRate;
    if (window.lastAt !== null) window.maxGapMs = Math.max(window.maxGapMs, now - window.lastAt);
    window.lastAt = now;
    this.frames.set(consumer, window);
    this.maybeFlush(now);
  }

  /** A chunk of microphone audio went to the provider. */
  audioSent(bytes: number, bufferedBytes: number): void {
    if (!this.enabled) return;
    const now = this.now();
    this.send.chunks += 1;
    this.send.bytes += bytes;
    if (this.send.lastAt !== null) this.send.maxGapMs = Math.max(this.send.maxGapMs, now - this.send.lastAt);
    this.send.lastAt = now;
    this.send.maxBufferedBytes = Math.max(this.send.maxBufferedBytes, bufferedBytes);
    this.maybeFlush(now);
  }

  /** Microphone audio that did not go to the provider, and why. */
  audioDropped(bytes: number, reason: 'not-ready' | 'no-socket'): void {
    if (!this.enabled) return;
    if (reason === 'not-ready') this.send.droppedNotReady += bytes;
    else this.send.droppedNoSocket += bytes;
    this.maybeFlush(this.now());
  }

  /** What the capture page measured. */
  capture(consumer: CaptureConsumer, report: CaptureDiagnostics): void {
    if (!this.log) return;
    const prefix = consumer === 'wake' ? '[wake]' : '[voice]';
    const resampled = report.contextSampleRate !== report.targetSampleRate;
    const behind = report.windowMs - report.producedMs;
    this.log(
      `${prefix} capture page [${report.pipeline}]: source ${report.contextSampleRate} Hz` +
        `${resampled ? ` RESAMPLED to ${report.targetSampleRate} Hz` : ''}, ` +
        `track ${report.trackSampleRate ?? '?'} Hz x${report.trackChannelCount ?? '?'} ch, ` +
        `ec=${flag(report.echoCancellation)} ns=${flag(report.noiseSuppression)} agc=${flag(report.autoGainControl)} | ` +
        `${report.windowMs} ms wall: ${report.callbacks} callbacks, produced ${report.producedMs} ms audio ` +
        `(${behind > 0 ? `${behind} ms SHORT` : 'real time'}), audio clock ${report.audioClockMs} ms, ` +
        `max callback gap ${report.maxCallbackGapMs} ms | rms ${report.rms.toFixed(3)} peak ${report.peak.toFixed(3)} ` +
        `silent ${report.silentCallbacks}/${report.callbacks} clipped ${report.clippedSamples}`,
    );
  }

  /** The provider's transcript, for the developer console. */
  transcript(kind: 'partial' | 'final', text: string): void {
    this.log?.(`[voice] ${kind}: ${text}`);
  }

  // --- reply audio: provider -> Axon -> window -> speakers ----------------
  //
  // The other direction from everything above, added because a reply in
  // Hindi reached the screen and never the speakers, and nothing could say
  // where it stopped. Four questions, one line each, correlated by speechId:
  //
  //   did the provider send audio?   the reply summary: audio messages
  //   did Axon accept it?            the summary's accepted count; a line per REJECTION
  //   did a window receive it?       delivered / dropped, from the transport
  //   did it play?                   the window's own report: started, ended, FAILED
  //
  // Counts and words only: never audio, never what was said.

  /** One `reply.audio` message. Printed only when it was rejected. */
  replyAudio(note: ReplyAudioNote): void {
    if (!this.log || note.accepted) return;
    this.log(
      `[voice] reply audio REJECTED (${note.reason ?? 'unknown'}): ${note.payloadType} payload, ` +
        `${note.payloadChars} chars, speech ${short(note.speechId)}`,
    );
  }

  /** A reply chunk was handed to the transport; did a live window take it? */
  replyDelivered(speechId: string, delivered: boolean): void {
    if (!this.enabled) return;
    const counts = this.delivery.get(speechId) ?? { delivered: 0, dropped: 0 };
    if (delivered) counts.delivered += 1;
    else counts.dropped += 1;
    this.delivery.set(speechId, counts);
    // Bounded: the oldest reply's counts go first.
    if (this.delivery.size > MAX_TRACKED_REPLIES) {
      const oldest = this.delivery.keys().next().value;
      if (oldest !== undefined) this.delivery.delete(oldest);
    }
  }

  /** One reply, ended: what the provider sent, what Axon kept, where it went. */
  replySummary(note: ReplyNote): void {
    if (!this.log) return;
    const counts = note.speechId ? this.delivery.get(note.speechId) : undefined;
    if (note.speechId) this.delivery.delete(note.speechId);
    const delivered = counts?.delivered ?? 0;
    const dropped = counts?.dropped ?? 0;
    const rejected = Object.entries(note.rejected)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason} x${count}`);

    // The verdict, stated, for the three ways a reply can be seen and not
    // heard before it ever reaches a speaker.
    const verdict =
      note.audioMessages === 0 && note.transcriptChars > 0
        ? ' -- PROVIDER SENT NO AUDIO FOR THIS REPLY'
        : note.audioMessages > 0 && note.acceptedChunks === 0
          ? ' -- AXON REJECTED ALL OF IT'
          : note.acceptedChunks > 0 && delivered === 0
            ? ' -- NO WINDOW RECEIVED IT'
            : '';

    this.log(
      `[voice] reply ${note.reply} (speech ${short(note.speechId)}, ${note.status}): ` +
        `transcript ${note.transcriptChars} chars [${note.script}] | ` +
        `provider audio: ${note.audioMessages} message(s), ${note.acceptedChunks} accepted ` +
        `(${note.audioMs} ms, ${note.acceptedBytes} bytes)` +
        (rejected.length > 0 ? `, rejected ${rejected.join(', ')}` : '') +
        (note.firstAudioAfterMs === null ? '' : `, first after ${note.firstAudioAfterMs} ms`) +
        ` | to window: ${delivered} delivered, ${dropped} dropped${verdict}`,
    );
  }

  /** The window's own account of playing a reply. */
  playback(report: PlaybackDiagnostics): void {
    if (!this.log) return;
    const what = report.event === 'failed' ? `FAILED${report.reason ? `: ${report.reason}` : ''}` : report.event;
    this.log(`[voice] playback (speech ${short(report.speechId)}): ${what} -- ${report.chunks} chunks, ${report.bytes} bytes received`);
  }

  private maybeFlush(now: number): void {
    if (now - this.windowStartedAt < MAIN_WINDOW_MS) return;
    const log = this.log;
    if (!log) return;
    const seconds = (now - this.windowStartedAt) / 1000;

    for (const [consumer, window] of this.frames) {
      const audioMs = Math.round((window.samples / window.sampleRate) * 1000);
      log(
        `${consumer === 'wake' ? '[wake]' : '[voice]'} main received (${consumer}): ${window.frames} frames, ` +
          `${audioMs} ms audio in ${Math.round(seconds * 1000)} ms ` +
          `(${(window.frames / seconds).toFixed(1)} frames/s, ${Math.round((window.samples * 2) / seconds)} bytes/s at ` +
          `${window.sampleRate} Hz mono PCM16 LE), max gap ${window.maxGapMs} ms`,
      );
    }

    const send = this.send;
    if (send.chunks > 0 || send.droppedNotReady > 0 || send.droppedNoSocket > 0) {
      // 24 kHz, 16-bit: 48 bytes per millisecond.
      const sentMs = Math.round(send.bytes / 48);
      log(
        `[voice] sent to AssemblyAI: ${send.chunks} chunks, ${sentMs} ms audio, ${Math.round(send.bytes / seconds)} bytes/s, ` +
          `max gap between sends ${send.maxGapMs} ms, socket queue max ${send.maxBufferedBytes} bytes` +
          `${send.droppedNotReady > 0 ? `, dropped ${Math.round(send.droppedNotReady / 48)} ms before session.ready` : ''}` +
          `${send.droppedNoSocket > 0 ? `, dropped ${Math.round(send.droppedNoSocket / 48)} ms with no socket` : ''}`,
      );
    }

    this.frames.clear();
    this.send = VoiceDiagnostics.emptySend();
    this.windowStartedAt = now;
  }
}

function flag(value: boolean | null): string {
  return value === null ? '?' : value ? 'on' : 'off';
}
