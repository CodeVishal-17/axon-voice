/**
 * Speech delivery contracts.
 *
 * Audio does NOT travel on the AxonEvent stream. Two reasons, both hard:
 * every event is validated as a `JsonValue` and written to the JSONL log, and
 * a few hundred kilobytes of PCM per utterance would destroy both properties.
 * Audio therefore has its own IPC channel, and the event stream carries only
 * metadata about speech — never the samples, never the text a second time.
 *
 * What the renderer is given is deliberately narrow. It receives *bytes* and a
 * media type. It never receives a path, a URL, a directory, or a filename, so
 * there is no version of "play this file" it is able to ask for. The audio it
 * can play is exactly the audio the main process chose to hand it.
 */

/** Media types the renderer is permitted to decode. */
export const SPEECH_MIME_TYPES = ['audio/wav'] as const;
export type SpeechMimeType = (typeof SPEECH_MIME_TYPES)[number];

export function isSpeechMimeType(value: unknown): value is SpeechMimeType {
  return typeof value === 'string' && (SPEECH_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Hard ceilings, enforced in the main process.
 *
 * The text a model produces is untrusted input to the voice layer: it can
 * originate, through a summarised web page or file, from someone hostile. An
 * unbounded response would otherwise become unbounded synthesis time, an
 * unbounded subprocess and an unbounded buffer.
 */
export const SPEECH_LIMITS = {
  /** Characters handed to a synthesiser. Longer replies are truncated. */
  maxCharacters: 2_000,
  /** Bytes of audio accepted back. ~4 minutes of 16-bit 22.05kHz mono. */
  maxAudioBytes: 12_000_000,
  /** Synthesis is abandoned after this. */
  synthesisTimeoutMs: 30_000,
  /** Extra grace on top of the audio's own duration before the watchdog fires. */
  playbackGraceMs: 5_000,
} as const;

/**
 * One utterance, as handed to the renderer.
 *
 * `speechId` correlates this payload with the SPEECH_STARTED event, the
 * renderer's playback report and any later stop request. It is a random id
 * minted in main — never derived from the text.
 */
export interface SpeechDelivery {
  readonly speechId: string;
  readonly mimeType: SpeechMimeType;
  readonly sampleRate: number;
  /** Encoded audio. Structured-cloned across IPC; never a path. */
  readonly bytes: Uint8Array;
  /** Duration main computed from the audio itself, for the UI and the watchdog. */
  readonly durationMs: number;
}

/** Why an utterance stopped. */
export const SPEECH_END_REASONS = ['completed', 'cancelled', 'failed', 'timeout'] as const;
export type SpeechEndReason = (typeof SPEECH_END_REASONS)[number];

/**
 * What the renderer tells main about playback.
 *
 * Advisory, not authoritative. It makes the UI responsive — main learns that
 * speech finished early rather than waiting out the watchdog — but main never
 * depends on it: a renderer that reports nothing, or lies, is bounded by the
 * watchdog derived from the audio main itself produced.
 */
export interface SpeechReport {
  readonly speechId: string;
  readonly status: 'started' | 'ended' | 'failed';
  /** Present when status is 'failed'. A short reason, never a stack trace. */
  readonly error: string | null;
}

/**
 * Why a chunk of the voice agent's reply audio was not played.
 *
 * Each of these used to be a silent `return` in `receiveAudio`, which is why
 * "Hindi text on screen, no Hindi audio" could not be diagnosed: nothing
 * distinguished "the provider sent no audio" from "Axon threw it away".
 */
export const REPLY_AUDIO_REJECTIONS = ['not-a-string', 'empty', 'not-base64', 'decoded-empty', 'oversized'] as const;
export type ReplyAudioRejection = (typeof REPLY_AUDIO_REJECTIONS)[number];

/** What the renderer can say about playing one reply. */
export const PLAYBACK_EVENTS = ['received', 'started', 'ended', 'failed'] as const;
export type PlaybackEvent = (typeof PLAYBACK_EVENTS)[number];

/**
 * The renderer's account of one reply's playback. NUMBERS AND FIXED WORDS.
 *
 * No audio, no text Axon said, nothing the user said. `speechId` is the
 * correlation id main minted and sent with every chunk, so a report can be
 * laid next to main's own count for the same reply: main sent 38 chunks, the
 * renderer received 38, playback started, playback ended — or where that
 * chain breaks.
 */
export interface PlaybackDiagnostics {
  readonly speechId: string;
  readonly event: PlaybackEvent;
  /** Chunks received for this reply so far. */
  readonly chunks: number;
  /** Bytes of PCM received for this reply so far. */
  readonly bytes: number;
  /** A short reason for 'failed', else null. */
  readonly reason: string | null;
}

/** Bounds applied on both sides of the boundary. */
export const PLAYBACK_DIAGNOSTICS_LIMITS = {
  maxSpeechIdCharacters: 64,
  maxReasonCharacters: 120,
} as const;

/** Whether Axon can speak, and why not when it cannot. */
export interface SpeechStatus {
  readonly available: boolean;
  /** Provider name, e.g. "windows-sapi". Never a path or a credential. */
  readonly name: string;
  readonly reason: string | null;
}
