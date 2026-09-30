/**
 * Voice input contracts.
 *
 * The mirror image of `speech.ts`, and deliberately asymmetric to it.
 *
 * Speech audio flows main -> renderer, and the renderer is given bytes it
 * cannot name or ask for. Microphone audio has to flow the other way, because
 * `getUserMedia` exists only in a browser context — so the renderer is the only
 * place that can hold a microphone, and the samples must cross to the main
 * process to be recognised.
 *
 * That inbound direction is the sensitive one, and these contracts are shaped
 * around three rules:
 *
 * 1. THE RENDERER NEVER DECIDES IT IS LISTENING. It asks; main answers by
 *    sending a `CaptureCommand`. A microphone that opens is a microphone main
 *    opened, and `captureId` is minted in main so a frame can be attributed to
 *    a session main actually authorised.
 *
 * 2. AUDIO IS NEVER AN EVENT. Frames travel on their own channel, exactly as
 *    speech audio does, so nothing raw can reach the AxonEvent stream, the
 *    JSONL log, the timeline, or the brain. What leaves this subsystem is
 *    text.
 *
 * 3. EVERY BOUND IS DECLARED HERE. Frame size, utterance length, silence
 *    windows and transcript length are all fixed constants rather than
 *    negotiated values, so a renderer — sandboxed, and the surface most likely
 *    to be compromised — cannot ask for a bigger buffer or a longer recording.
 */

/**
 * Hard ceilings, enforced in the main process.
 *
 * The renderer is treated as untrusted input. Anything it sends that exceeds
 * one of these is dropped rather than clamped: a clamp teaches a caller that
 * an out-of-range value is acceptable.
 */
export const LISTENING_LIMITS = {
  /** The only sample rate Axon accepts. The renderer resamples to it. */
  sampleRate: 16_000,
  /** Largest single frame, in samples. ~256ms at 16kHz — a generous ceiling. */
  maxFrameSamples: 4_096,
  /**
   * Longest single utterance. Reached, the utterance is closed and whatever
   * was said up to that point is transcribed; Axon does not simply keep
   * recording.
   */
  maxUtteranceMs: 20_000,
  /**
   * How long Axon waits for speech to begin before giving up.
   *
   * This is what makes an accidental activation harmless: press the hotkey by
   * mistake, say nothing, and the microphone closes on its own.
   */
  speechStartTimeoutMs: 6_000,
  /** Trailing silence that ends an utterance once speech has been heard. */
  silenceMs: 900,
  /** Longest a recognition may take after the audio ends. */
  transcriptionTimeoutMs: 15_000,
  /**
   * Total audio a single session may buffer, in bytes of 16-bit PCM.
   *
   * Derived from the duration cap, with a small margin, and enforced
   * independently of it — a renderer that sends frames faster than real time
   * hits this before it hits the clock.
   */
  maxAudioBytes: 16_000 * 2 * 25,
  /**
   * Longest transcript accepted from a provider.
   *
   * A spoken command is short. A recognizer returning a novel is either broken
   * or being driven by something that is not a person, and either way it must
   * not become an unbounded string on the way to the model.
   */
  maxTranscriptCharacters: 1_000,
} as const;

/**
 * What main tells the renderer to do with the microphone.
 *
 * There is deliberately no third action. The renderer cannot be told to
 * "pause", "buffer", or "keep the stream warm" — the microphone is either open
 * for a named session or entirely closed.
 */
export type CaptureAction = 'start' | 'stop';

export interface CaptureCommand {
  readonly action: CaptureAction;
  /** Minted in main. Frames must carry it back or they are dropped. */
  readonly captureId: string;
  /** Always `LISTENING_LIMITS.sampleRate`; carried so the renderer's
   *  resampler has a single source of truth rather than a second constant. */
  readonly sampleRate: number;
  /**
   * Report numeric capture diagnostics for this session (development builds
   * with AXON_VOICE_DEBUG or AXON_WAKE_DEBUG only). Absent means no reports.
   */
  readonly diagnostics?: boolean;
  /**
   * Explicit microphone processing, for a controlled A/B in a development
   * build. Absent — always, in a packaged build — means the defaults: all three
   * on. Decided by main; the renderer cannot ask for it.
   */
  readonly processing?: CaptureProcessing;
}

/** The browser's microphone processing switches. */
export interface CaptureProcessing {
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

/**
 * What the capture page measured about its own microphone, over one window.
 *
 * NUMBERS ONLY, and every one of them is about format or timing or loudness —
 * never a sample. It exists because "the transcription is wrong" has a dozen
 * possible causes before the audio ever reaches a recognizer: the wrong sample
 * rate, a resampler, a callback that the page's main thread could not service
 * in time, gain processing, silence. Each of those shows up here as a number
 * and none of them requires recording anybody to see.
 */
export interface CaptureDiagnostics {
  readonly captureId: string;
  /**
   * Which capture path produced the audio. `track-processor` reads the
   * microphone track directly; `script-processor` is the Web Audio fallback,
   * measured falling behind real time once its silent output is suspended.
   */
  readonly pipeline: 'track-processor' | 'script-processor';
  /** What main asked for. */
  readonly targetSampleRate: number;
  /** The rate audio arrives at before conversion: the track's frames, or the AudioContext on the fallback. */
  readonly contextSampleRate: number;
  /** What the microphone track reports (may be null where the browser does not say). */
  readonly trackSampleRate: number | null;
  readonly trackChannelCount: number | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
  /** Wall-clock length of this window. */
  readonly windowMs: number;
  /** Processing callbacks the page received in the window. */
  readonly callbacks: number;
  /** Audio the page produced, in milliseconds at the target rate. */
  readonly producedMs: number;
  /** How far the AudioContext's own clock advanced. Equal to `windowMs` when the device is healthy. */
  readonly audioClockMs: number;
  /** Longest wall-clock gap between two callbacks. A few block lengths is normal; more is starvation. */
  readonly maxCallbackGapMs: number;
  /** RMS and peak of what was produced, 0..1. */
  readonly rms: number;
  readonly peak: number;
  /** Callbacks whose peak was below the silence floor. */
  readonly silentCallbacks: number;
  /** Samples at or beyond full scale before conversion. */
  readonly clippedSamples: number;
}

/** Bounds on a diagnostics report, so the page cannot use the channel as anything else. */
export const CAPTURE_DIAGNOSTICS_LIMITS = {
  /** How often the page reports while capturing. */
  intervalMs: 2_000,
} as const;

/**
 * Why a capture could not run.
 *
 * A closed enum, not a message. The renderer sees real device errors, whose
 * text can name hardware, drivers and user accounts; mapping them to these
 * five cases in the renderer and back to a sentence in main means nothing
 * device-specific ever crosses the boundary or reaches a log.
 */
export const CAPTURE_FAILURES = [
  'permission-denied',
  'no-device',
  'device-error',
  'audio-unavailable',
  'capture-error',
] as const;
export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

export function isCaptureFailure(value: unknown): value is CaptureFailure {
  return typeof value === 'string' && (CAPTURE_FAILURES as readonly string[]).includes(value);
}

/**
 * What the renderer tells main about the microphone.
 *
 * Advisory for 'started' and 'ended' — main runs its own timers and does not
 * depend on either arriving. 'failed' is acted on, because the renderer is the
 * only side that can know the microphone never opened.
 */
export interface CaptureReport {
  readonly captureId: string;
  readonly status: 'started' | 'ended' | 'failed';
  readonly failure: CaptureFailure | null;
}

/** Whether Axon can listen, and why not when it cannot. */
export interface ListeningStatus {
  readonly available: boolean;
  /** Provider name, e.g. "windows-speech". Never a path or a credential. */
  readonly name: string;
  readonly reason: string | null;
  /** True while a listening session is open. Main is authoritative. */
  readonly active: boolean;
  /**
   * The registered push-to-talk shortcut, for the UI to display, or null when
   * none could be registered. Display only — the renderer cannot change it,
   * and pressing it is handled entirely in main.
   */
  readonly hotkey: string | null;
}

/** Outcome of asking Axon to listen. Refusal is a normal answer. */
export interface StartListeningResult {
  readonly accepted: boolean;
  readonly error: string | null;
}
