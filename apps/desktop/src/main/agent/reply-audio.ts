/**
 * What happened to each piece of the voice agent's reply audio — as numbers.
 *
 * WHY THIS EXISTS. In a real conversation Axon answered in Hindi: the reply
 * appeared on screen and was never heard, while English replies played. Two
 * separate protocol messages carry a reply — `transcript.agent` (the words,
 * which reached the screen) and `reply.audio` (the sound) — and the second
 * one was handled by three silent `return`s. Nothing recorded whether audio
 * for that reply ever arrived, so "the provider sent none", "Axon threw it
 * away" and "the window never played it" were indistinguishable.
 *
 * This module answers the first two, per reply:
 *
 *   classifyReplyAudio   every `reply.audio` payload is ACCEPTED, or REJECTED
 *                        with a reason — never silently dropped
 *   ReplyLedger          per reply (reply.started -> reply.done): how many
 *                        audio messages came, how many were accepted, how
 *                        much audio that was, how long before the first one,
 *                        and how long the TRANSCRIPT was and in which writing
 *                        system. "Transcript 31 characters, Devanagari; 0
 *                        audio messages" is the provider not voicing the
 *                        reply. "38 accepted" is the problem being further on.
 *
 * The rest of the chain — delivered to a live window, received, playback
 * started, ended or failed — is counted where it happens (the transport and
 * the renderer) and correlated by the same `speechId`.
 *
 * NEVER AUDIO, NEVER TEXT. A payload's length, never its content. A
 * transcript's length and script, never its words — which is also why the
 * script is a coarse category and not a language guess.
 */

import { REPLY_AUDIO_REJECTIONS, type ReplyAudioRejection } from '@axon/core';

export type ReplyAudioClassification =
  | { readonly accepted: true; readonly pcm: Buffer; readonly payloadChars: number }
  | {
      readonly accepted: false;
      readonly reason: ReplyAudioRejection;
      /** `typeof` the payload: what arrived, when it was not a string. */
      readonly payloadType: string;
      readonly payloadChars: number;
    };

/** Base64 or base64url, with line breaks tolerated. Anything else is not audio. */
const BASE64 = /^[A-Za-z0-9+/_\-=\s]*$/;

/**
 * Accept or reject one `reply.audio` payload, saying why.
 *
 * The same rules `receiveAudio` always applied — a non-empty string that
 * decodes to at most `maxBytes` of PCM — plus one: a payload that is not
 * base64 at all is refused rather than decoded. `Buffer.from` skips invalid
 * characters instead of failing, so such a payload used to be played as
 * whatever bytes happened to survive, which is noise.
 */
export function classifyReplyAudio(data: unknown, maxBytes: number): ReplyAudioClassification {
  if (typeof data !== 'string') {
    return { accepted: false, reason: 'not-a-string', payloadType: data === null ? 'null' : typeof data, payloadChars: 0 };
  }
  if (data === '') return { accepted: false, reason: 'empty', payloadType: 'string', payloadChars: 0 };
  if (!BASE64.test(data)) return { accepted: false, reason: 'not-base64', payloadType: 'string', payloadChars: data.length };

  const pcm = Buffer.from(data, 'base64');
  if (pcm.byteLength === 0) return { accepted: false, reason: 'decoded-empty', payloadType: 'string', payloadChars: data.length };
  if (pcm.byteLength > maxBytes) return { accepted: false, reason: 'oversized', payloadType: 'string', payloadChars: data.length };
  return { accepted: true, pcm, payloadChars: data.length };
}

/** A coarse writing-system label for a transcript. Never the text. */
export type TranscriptScript = 'none' | 'latin' | 'devanagari' | 'mixed' | 'other';

export function scriptOf(text: string): TranscriptScript {
  let latin = 0;
  let devanagari = 0;
  let other = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    if (/\p{Script=Latin}/u.test(char)) latin += 1;
    else if (/\p{Script=Devanagari}/u.test(char)) devanagari += 1;
    else other += 1;
  }
  const scripts = [latin, devanagari, other].filter((count) => count > 0).length;
  if (scripts === 0) return 'none';
  if (scripts > 1) return 'mixed';
  return latin > 0 ? 'latin' : devanagari > 0 ? 'devanagari' : 'other';
}

/** One `reply.audio` message, after classification. */
export interface ReplyAudioEvent {
  readonly at: number;
  readonly speechId: string | null;
  /** The chunk's ordinal within the reply, when it was accepted. */
  readonly sequence: number | null;
  readonly accepted: boolean;
  readonly reason: ReplyAudioRejection | null;
  readonly payloadType: string;
  readonly payloadChars: number;
  readonly bytes: number;
}

/** One reply, summarised when it ends. */
export interface ReplySummary {
  readonly reply: number;
  readonly speechId: string | null;
  /** How the reply ended: the provider's `reply.done` status, or 'session-ended'. */
  readonly status: string;
  readonly transcriptChars: number;
  readonly script: TranscriptScript;
  readonly audioMessages: number;
  readonly acceptedChunks: number;
  readonly acceptedBytes: number;
  /** Milliseconds of audio accepted, at the agent's sample rate. */
  readonly audioMs: number;
  readonly rejected: Readonly<Record<ReplyAudioRejection, number>>;
  /** From the reply starting to its first audio message; null if none came. */
  readonly firstAudioAfterMs: number | null;
}

const noRejections = (): Record<ReplyAudioRejection, number> =>
  Object.fromEntries(REPLY_AUDIO_REJECTIONS.map((reason) => [reason, 0])) as Record<ReplyAudioRejection, number>;

/** Counts for the reply in flight. Cheap enough to run always; emitted only when asked. */
export class ReplyLedger {
  private open = false;
  private replies = 0;
  private startedAt = 0;
  private speechId: string | null = null;
  private transcriptChars = 0;
  private transcriptScript: TranscriptScript = 'none';
  private audioMessages = 0;
  private acceptedChunks = 0;
  private acceptedBytes = 0;
  private rejected = noRejections();
  private firstAudioAt: number | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A reply began (`reply.started`, or audio arriving before one). Idempotent. */
  begin(speechId: string | null): void {
    if (this.open) {
      this.speechId ??= speechId;
      return;
    }
    this.open = true;
    this.replies += 1;
    this.startedAt = this.now();
    this.speechId = speechId;
    this.transcriptChars = 0;
    this.transcriptScript = 'none';
    this.audioMessages = 0;
    this.acceptedChunks = 0;
    this.acceptedBytes = 0;
    this.rejected = noRejections();
    this.firstAudioAt = null;
  }

  /** The reply's words arrived. Only their length and script are kept. */
  transcript(text: string): void {
    this.begin(this.speechId);
    this.transcriptChars += text.length;
    const script = scriptOf(text);
    if (script !== 'none') {
      this.transcriptScript =
        this.transcriptScript === 'none' || this.transcriptScript === script ? script : 'mixed';
    }
  }

  /** One audio message, classified. Returns the event for the diagnostic hook. */
  audio(result: ReplyAudioClassification, speechId: string | null, sequence: number | null): ReplyAudioEvent {
    this.begin(speechId);
    const at = this.now();
    this.audioMessages += 1;
    this.firstAudioAt ??= at;
    if (result.accepted) {
      this.acceptedChunks += 1;
      this.acceptedBytes += result.pcm.byteLength;
    } else {
      this.rejected[result.reason] += 1;
    }
    return {
      at,
      speechId,
      sequence: result.accepted ? sequence : null,
      accepted: result.accepted,
      reason: result.accepted ? null : result.reason,
      payloadType: result.accepted ? 'string' : result.payloadType,
      payloadChars: result.payloadChars,
      bytes: result.accepted ? result.pcm.byteLength : 0,
    };
  }

  /** The reply ended. Returns its summary, or null if none was open. */
  done(status: string): ReplySummary | null {
    if (!this.open) return null;
    this.open = false;
    return {
      reply: this.replies,
      speechId: this.speechId,
      status,
      transcriptChars: this.transcriptChars,
      script: this.transcriptScript,
      audioMessages: this.audioMessages,
      acceptedChunks: this.acceptedChunks,
      acceptedBytes: this.acceptedBytes,
      // PCM16 mono: two bytes a sample.
      audioMs: Math.round((this.acceptedBytes / 2 / this.sampleRate) * 1000),
      rejected: { ...this.rejected },
      firstAudioAfterMs: this.firstAudioAt === null ? null : this.firstAudioAt - this.startedAt,
    };
  }
}
