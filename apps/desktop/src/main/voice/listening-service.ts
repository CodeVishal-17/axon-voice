/**
 * The listening service — one utterance at a time, and main stays in charge.
 *
 * Sits between the orchestrator and a `SpeechToText` implementation:
 *
 *     hotkey / button -> Orchestrator -> ListeningService -> SpeechToText
 *                                              |                  |
 *                                     command(start/stop)      transcript
 *                                              v                  v
 *                                      renderer microphone     the brain
 *
 * WHAT THIS CLASS EXISTS TO GUARANTEE.
 *
 * 1. THE MICROPHONE IS OPEN ONLY WHILE A SESSION IS. There is exactly one
 *    place a capture starts (`start`) and exactly one place it ends
 *    (`settle`), and `settle` is reached from every exit — silence, the
 *    duration ceiling, a user stop, a cancellation, a renderer failure, a
 *    recognizer failure, shutdown. A session cannot end without the microphone
 *    being told to close.
 *
 * 2. NOTHING IS RECORDED. Frames are forwarded to the recognizer as they
 *    arrive and are never accumulated here — the warm-up buffer below is the
 *    single exception, it is bounded, it exists only for the few hundred
 *    milliseconds the engine takes to load, and it is discarded the moment it
 *    is flushed. No frame is written to disk, placed in an event, or kept
 *    after the session that produced it.
 *
 * 3. AXON CANNOT GET STUCK LISTENING. The audio-derived VAD is the normal way
 *    a session ends, and it is backed by two wall-clock timers that do not
 *    depend on the renderer sending anything at all: one for a microphone that
 *    never delivers a frame, one as an absolute ceiling on the session. A
 *    renderer that crashes, hangs, or lies cannot hold the microphone open.
 *
 * 4. WHAT LEAVES IS TEXT. The only thing this service hands upward is a
 *    bounded string. The brain has no route to audio, by construction: it is
 *    not on the other end of anything that carries it.
 */

import { randomUUID } from 'node:crypto';
import {
  LISTENING_LIMITS,
  type CaptureCommand,
  type CaptureFailure,
  type ListeningStatus,
  type SpeechToText,
  type SpeechToTextSession,
  type StartListeningResult,
  type WakeTrigger,
} from '@axon/core';
import { VoiceActivityDetector, type VadEvent } from './vad.js';
import { joinPhrases, prepareTranscript } from './transcript-text.js';

/** What the service needs from the world around it. */
export interface ListeningServiceOptions {
  readonly stt: SpeechToText | null;
  /** Opens and closes the microphone in the renderer. */
  command(command: CaptureCommand): void;
  /** A session began. The orchestrator enters LISTENING here. */
  onStarted(trigger: WakeTrigger): void;
  /** A session ended without producing anything to say. */
  onEnded(reason: ListeningEndReason): void;
  /** The user's words. The orchestrator hands these to the brain. */
  onTranscript(text: string, metrics: ListeningMetrics): void;
  /** Something worth showing in the timeline, phrased for a person. */
  onNotice(message: string): void;
  /** A failure worth showing as an error. Never carries provider internals. */
  onFailure(message: string): void;
  readonly unavailableReason?: string | null;
  /** Display only, for the UI's "hold X to talk" hint. */
  readonly hotkey?: string | null;
  readonly newCaptureId?: () => string;
  readonly now?: () => number;
}

export type ListeningEndReason =
  | 'transcribed'
  | 'no-speech'
  | 'empty-transcript'
  | 'cancelled'
  | 'failed'
  | 'shutdown';

/**
 * Where the time went, in milliseconds.
 *
 * Timings only — there is deliberately nothing here derived from the content
 * of the audio, so this can be emitted into the event stream and written to
 * the log without any part of what was said going with it.
 */
export interface ListeningMetrics {
  /** Activation to the renderer reporting the microphone open. */
  readonly micOpenMs: number | null;
  /** Activation to the recognizer being ready to accept audio. */
  readonly recognizerReadyMs: number | null;
  /** Length of the captured utterance, measured from the audio. */
  readonly utteranceMs: number;
  /** End of speech to a finished transcript. */
  readonly transcriptionMs: number;
  /** Activation to a finished transcript. */
  readonly totalMs: number;
}

interface ActiveSession {
  readonly captureId: string;
  readonly trigger: WakeTrigger;
  readonly startedAt: number;
  readonly vad: VoiceActivityDetector;
  /** Phrases as the recognizer produces them. Text only — never audio. */
  readonly phrases: string[];
  /** Frames captured before the recognizer finished loading. Bounded, and
   *  discarded as soon as it is flushed. */
  warmup: Int16Array[];
  warmupBytes: number;
  session: SpeechToTextSession | null;
  micOpenedAt: number | null;
  recognizerReadyAt: number | null;
  speechEndedAt: number | null;
  framesReceived: number;
  /** True once the outcome has been reported; guards double-settlement. */
  settled: boolean;
  /** True once the audio stream has been closed and recognition is running. */
  finishing: boolean;
  noAudioTimer: ReturnType<typeof setTimeout> | null;
  hardDeadline: ReturnType<typeof setTimeout> | null;
}

/** How long a session waits for its first frame before giving up. */
const NO_AUDIO_TIMEOUT_MS = 5_000;

/**
 * Shortest gap between one session ending and the next beginning.
 *
 * Every session spawns a recognizer process, and starting one is the most
 * expensive thing the renderer can ask for. The renderer is the untrusted side
 * of Axon: page code that called `startListening` and `stopListening` in a
 * loop would spawn subprocesses as fast as the machine could fork them, which
 * is a way to make the user's computer unusable without ever getting past the
 * dispatcher.
 *
 * A third of a second bounds that to about three spawns a second in the worst
 * case, and is imperceptible in the intended use — nobody presses the hotkey,
 * releases it, and presses it again inside 300ms.
 */
const RESTART_COOLDOWN_MS = 300;

/**
 * Absolute ceiling on a session, on the wall clock rather than on audio.
 *
 * Covers the case the audio-derived limits cannot: a renderer that stops
 * sending frames mid-utterance, where the VAD would simply never see another
 * frame to draw a conclusion from.
 */
const HARD_DEADLINE_MS = LISTENING_LIMITS.maxUtteranceMs + LISTENING_LIMITS.transcriptionTimeoutMs + 5_000;

/**
 * User-facing sentences for a capture failure.
 *
 * The renderer sends a closed enum, never a message: real device errors name
 * hardware, drivers and user accounts, and none of that should cross the
 * boundary or reach a log.
 */
const CAPTURE_FAILURE_MESSAGES: Readonly<Record<CaptureFailure, string>> = Object.freeze({
  'permission-denied': 'Microphone access was denied. Allow it in Windows privacy settings to talk to Axon.',
  'no-device': 'No microphone was detected.',
  'device-error': 'The microphone became unavailable.',
  'audio-unavailable': 'Audio is unavailable in this window, so Axon could not listen.',
  'capture-error': 'Axon could not start listening.',
});

export class ListeningService {
  private readonly options: ListeningServiceOptions;
  private readonly stt: SpeechToText | null;
  private readonly newCaptureId: () => string;
  private readonly now: () => number;

  private active: ActiveSession | null = null;

  /**
   * Set when the microphone has been refused at the OS or browser level.
   *
   * Once set, Axon stops offering to listen until it is restarted. This is the
   * fix for the permission loop: a denied microphone must not mean a prompt
   * every time the user presses the hotkey.
   */
  private deniedReason: string | null = null;

  /** When the last session ended, for the restart cooldown above. */
  private lastEndedAt = 0;

  constructor(options: ListeningServiceOptions) {
    this.options = options;
    this.stt = options.stt;
    this.newCaptureId = options.newCaptureId ?? (() => randomId());
    this.now = options.now ?? (() => Date.now());
  }

  get listening(): boolean {
    return this.active !== null;
  }

  /** Whether Axon can listen. Carries a provider name, never a credential. */
  status(): ListeningStatus {
    const available = this.stt !== null && this.stt.isAvailable() && this.deniedReason === null;
    return {
      available,
      name: this.stt?.name ?? 'none',
      reason: available
        ? null
        : (this.deniedReason ??
          this.options.unavailableReason ??
          (this.stt === null
            ? 'No speech recognizer is configured, so Axon cannot listen.'
            : `${this.stt.name} is not available on this system, so Axon cannot listen.`)),
      active: this.active !== null,
      hotkey: this.options.hotkey ?? null,
    };
  }

  /**
   * Open a listening session.
   *
   * Returns as soon as the session is *accepted*. The microphone command is
   * sent immediately and the recognizer is started in parallel, so the user
   * sees LISTENING and the orb responds without waiting for .NET to load — the
   * engine warms up while they are drawing breath.
   *
   * The caller (the orchestrator) is responsible for deciding whether
   * listening is legal in the current state; this method owns the session, not
   * the policy.
   */
  start(trigger: WakeTrigger): StartListeningResult {
    if (this.active) return { accepted: false, error: 'Axon is already listening.' };

    const status = this.status();
    if (!status.available || !this.stt) {
      return { accepted: false, error: status.reason ?? 'Axon cannot listen right now.' };
    }

    const sinceLast = this.now() - this.lastEndedAt;
    if (this.lastEndedAt !== 0 && sinceLast < RESTART_COOLDOWN_MS) {
      // Not an error worth showing: at this rate the request cannot have come
      // from a person, and a person who did somehow manage it can simply press
      // again.
      return { accepted: false, error: 'Axon is still finishing the last request.' };
    }

    const session: ActiveSession = {
      captureId: this.newCaptureId(),
      trigger,
      startedAt: this.now(),
      vad: new VoiceActivityDetector({ sampleRate: this.stt.sampleRate }),
      phrases: [],
      warmup: [],
      warmupBytes: 0,
      session: null,
      micOpenedAt: null,
      recognizerReadyAt: null,
      speechEndedAt: null,
      framesReceived: 0,
      settled: false,
      finishing: false,
      noAudioTimer: null,
      hardDeadline: null,
    };
    this.active = session;

    session.noAudioTimer = timer(() => {
      if (session.framesReceived === 0) {
        this.abort(session, 'failed', 'Axon did not receive any audio from the microphone.');
      }
    }, NO_AUDIO_TIMEOUT_MS);

    session.hardDeadline = timer(() => {
      this.abort(session, 'failed', 'Listening timed out.');
    }, HARD_DEADLINE_MS);

    // Announced before the microphone opens, so the UI is already in LISTENING
    // when the first frame arrives rather than a frame behind it.
    this.options.onStarted(trigger);
    this.options.command({ action: 'start', captureId: session.captureId, sampleRate: this.stt.sampleRate });

    void this.warmRecognizer(session);
    return { accepted: true, error: null };
  }

  /**
   * Start the recognizer and flush anything captured while it was loading.
   *
   * Never throws: it runs detached from `start`, so an escaping rejection
   * would become an unhandled rejection in the main process.
   */
  private async warmRecognizer(session: ActiveSession): Promise<void> {
    const stt = this.stt;
    if (!stt) return;

    let recognition: SpeechToTextSession;
    try {
      recognition = await stt.start((chunk) => {
        // Phrases only, and only while the session that asked for them is the
        // one still open.
        if (this.active === session && chunk.text.trim() !== '') session.phrases.push(chunk.text);
      });
    } catch {
      // The provider's own error text can name local paths; the user gets a
      // sentence about Axon instead.
      if (!session.settled) {
        this.abort(session, 'failed', 'Axon could not start speech recognition, so it stopped listening.');
      }
      return;
    }

    if (session.settled || this.active !== session) {
      // Cancelled while the engine was loading. Throw it away rather than
      // leaving a live recognizer behind a closed session.
      recognition.close();
      return;
    }

    session.session = recognition;
    session.recognizerReadyAt = this.now();

    for (const frame of session.warmup) recognition.push(frame);
    // Released immediately: this is the only place audio is held in the main
    // process, and it exists only until the recognizer can take it.
    session.warmup = [];
    session.warmupBytes = 0;

    if (session.finishing) {
      // Speech ended before the engine finished loading — a very short
      // utterance. The audio is in; close the stream so it gets recognised.
      void this.transcribe(session);
    }
  }

  /**
   * Accept one frame of captured audio.
   *
   * Silently drops anything that does not belong to the open session: a stale
   * id, a frame arriving after the session closed, an oversized frame, a wrong
   * sample rate. Dropping rather than throwing is deliberate — the renderer is
   * untrusted input, and an error reply would tell a compromised page whether
   * its guess at a session id was right.
   */
  pushFrame(captureId: string, samples: Int16Array): void {
    const session = this.active;
    if (!session || session.settled || session.captureId !== captureId) return;
    if (samples.length === 0 || samples.length > LISTENING_LIMITS.maxFrameSamples) return;

    session.framesReceived += 1;

    // Once the utterance is finishing, nothing further is kept OR forwarded.
    // The user has stopped talking and the microphone has been told to close;
    // audio still arriving is the tail of a stream shutting down, and it
    // belongs to a moment Axon was no longer listening for.
    if (session.finishing) return;

    // Forwarded, never accumulated. Past the warm-up window the only copy of
    // this audio in the main process is what is briefly in the pipe.
    if (session.session) {
      session.session.push(samples);
    } else if (session.warmupBytes + samples.byteLength <= LISTENING_LIMITS.maxAudioBytes) {
      session.warmup.push(samples);
      session.warmupBytes += samples.byteLength;
    }

    const result = session.vad.push(samples);
    if (result.event !== 'none') this.onVadEvent(session, result.event);
  }

  private onVadEvent(session: ActiveSession, event: VadEvent): void {
    switch (event) {
      case 'speech-started':
        // Not announced. A timeline entry per syllable would bury the events
        // that describe what Axon actually did.
        return;
      case 'speech-ended':
        this.finish(session);
        return;
      case 'max-duration':
        this.options.onNotice(
          `That was longer than Axon listens for in one go (${Math.round(
            LISTENING_LIMITS.maxUtteranceMs / 1000,
          )} seconds), so it stopped there.`,
        );
        this.finish(session);
        return;
      case 'no-speech-timeout':
        this.abortQuietly(session, 'no-speech', "Axon didn't hear anything, so it stopped listening.");
        return;
      default:
        return;
    }
  }

  /**
   * The user asking Axon to stop listening.
   *
   * If they have said something, that is transcribed — stopping early is how a
   * person signals "I'm done", not "forget it". If they have not, the session
   * is simply abandoned.
   */
  stop(): boolean {
    const session = this.active;
    if (!session || session.settled) return false;

    if (session.vad.heardSpeech) this.finish(session);
    else this.abortQuietly(session, 'cancelled', null);
    return true;
  }

  /** Abandon the session without transcribing. */
  cancel(): boolean {
    const session = this.active;
    if (!session || session.settled) return false;
    this.abortQuietly(session, 'cancelled', null);
    return true;
  }

  /**
   * The renderer's report on the microphone.
   *
   * 'started' and 'ended' are advisory — the timers above do not depend on
   * either. 'failed' is acted on, because the renderer is the only side that
   * can know the microphone never opened.
   */
  report(captureId: string, status: 'started' | 'ended' | 'failed', failure: CaptureFailure | null): void {
    const session = this.active;
    if (!session || session.captureId !== captureId || session.settled) return;

    if (status === 'started') {
      session.micOpenedAt = this.now();
      return;
    }

    if (status === 'failed') {
      const reason = CAPTURE_FAILURE_MESSAGES[failure ?? 'capture-error'];
      if (failure === 'permission-denied') {
        // Remembered for the rest of the run. Without this, every activation
        // would raise the same refused prompt again.
        this.deniedReason = reason;
      }
      this.abort(session, 'failed', reason);
      return;
    }

    // 'ended' while still capturing means the stream stopped on its own — an
    // unplugged microphone, say. Transcribe what there is rather than
    // discarding a sentence the user already finished.
    if (!session.finishing) {
      if (session.vad.heardSpeech) this.finish(session);
      else this.abortQuietly(session, 'cancelled', null);
    }
  }

  /** Release everything. Safe to call more than once. */
  shutdown(): void {
    const session = this.active;
    if (!session || session.settled) return;
    this.abortQuietly(session, 'shutdown', null);
  }

  /**
   * Close the audio stream and turn what was captured into text.
   *
   * The microphone is told to close FIRST, before recognition starts. The user
   * has stopped talking; nothing said between here and the transcript arriving
   * should be captured, and the UI should stop showing a live level.
   */
  private finish(session: ActiveSession): void {
    if (session.settled || session.finishing) return;
    session.finishing = true;
    session.speechEndedAt = this.now();

    this.closeCapture(session);

    if (!session.session) {
      // The recognizer is still loading; `warmRecognizer` will call through
      // once it has the audio.
      return;
    }
    void this.transcribe(session);
  }

  /**
   * Wait for the recognizer, then hand up a bounded string.
   *
   * Never throws: it runs detached, and a rejection here would take the main
   * process down.
   */
  private async transcribe(session: ActiveSession): Promise<void> {
    const recognition = session.session;
    if (!recognition) return;

    try {
      await recognition.end();
    } catch {
      // A recognizer that failed mid-utterance may still have delivered
      // phrases before it did; fall through and use whatever arrived.
    } finally {
      recognition.close();
    }

    if (session.settled) return;

    const prepared = prepareTranscript(joinPhrases(session.phrases));
    const metrics = this.metrics(session);

    if (prepared.text === '') {
      this.settle(session, 'empty-transcript');
      // Deliberately not an ERROR: failing to catch a mumble is an ordinary
      // outcome of listening, not a fault in the machine.
      this.options.onNotice("Axon didn't catch that. Try again.");
      return;
    }

    if (prepared.truncated) {
      this.options.onNotice('That was longer than Axon accepts in one request, so it used the first part.');
    }

    this.settle(session, 'transcribed');
    this.options.onTranscript(prepared.text, metrics);
  }

  /** End a session with an error the user should see. */
  private abort(session: ActiveSession, reason: ListeningEndReason, message: string): void {
    if (session.settled) return;
    this.settle(session, reason);
    this.options.onFailure(message);
  }

  /** End a session with, at most, a note in the timeline. */
  private abortQuietly(session: ActiveSession, reason: ListeningEndReason, message: string | null): void {
    if (session.settled) return;
    this.settle(session, reason);
    if (message) this.options.onNotice(message);
  }

  /**
   * End a session exactly once.
   *
   * Every path out — silence, the ceiling, a stop, a cancel, a failure,
   * shutdown — comes through here, so the microphone is always closed, the
   * recognizer is always killed, the timers are always cleared and the
   * warm-up buffer is always dropped.
   */
  private settle(session: ActiveSession, reason: ListeningEndReason): void {
    if (session.settled) return;
    session.settled = true;

    this.lastEndedAt = this.now();

    if (session.noAudioTimer) clearTimeout(session.noAudioTimer);
    if (session.hardDeadline) clearTimeout(session.hardDeadline);
    session.noAudioTimer = null;
    session.hardDeadline = null;

    this.closeCapture(session);

    session.session?.close();
    session.session = null;
    session.warmup = [];
    session.warmupBytes = 0;

    if (this.active === session) this.active = null;

    this.options.onEnded(reason);
  }

  /** Tell the renderer to close the microphone. Idempotent by construction. */
  private closeCapture(session: ActiveSession): void {
    this.options.command({
      action: 'stop',
      captureId: session.captureId,
      sampleRate: this.stt?.sampleRate ?? LISTENING_LIMITS.sampleRate,
    });
  }

  private metrics(session: ActiveSession): ListeningMetrics {
    const finishedAt = this.now();
    const speechEndedAt = session.speechEndedAt ?? finishedAt;
    return {
      micOpenMs: session.micOpenedAt === null ? null : session.micOpenedAt - session.startedAt,
      recognizerReadyMs: session.recognizerReadyAt === null ? null : session.recognizerReadyAt - session.startedAt,
      utteranceMs: Math.round(session.vad.elapsedMs),
      transcriptionMs: finishedAt - speechEndedAt,
      totalMs: finishedAt - session.startedAt,
    };
  }
}

/** A timer that never keeps the process alive on its own. */
function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * A capture id.
 *
 * Cryptographically random, and minted in main. It is not a secret — it is a
 * correlation handle — but it must not be guessable enough for a frame from a
 * stale session, or from page code that has lost track of which session is
 * open, to be accepted by the current one.
 */
function randomId(): string {
  return randomUUID();
}
