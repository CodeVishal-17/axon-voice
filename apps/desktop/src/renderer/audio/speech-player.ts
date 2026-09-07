/**
 * Speech playback.
 *
 *     bytes from main -> decodeAudioData -> BufferSource -> Analyser -> out
 *                                                              |
 *                                                              +-> the orb
 *
 * The analyser sits in the signal path rather than beside it, so the level the
 * orb reacts to is measured from the samples actually being played. One graph,
 * one signal, no second source of truth about whether Axon is speaking.
 *
 * RESOURCES. Every utterance creates a source node and an analyser, and both
 * are released in `stop()`, which is idempotent and reached from every exit —
 * natural end, cancellation, decode failure, teardown. The `AudioContext`
 * itself is deliberately long-lived and shared: contexts are a limited
 * resource, and creating one per utterance is the standard way to run a
 * browser out of them.
 *
 * WHAT THIS CANNOT DO. It plays an `ArrayBuffer` handed to it. There is no
 * path, URL, filename or `fetch` anywhere in this file, so there is no version
 * of "play this file" available to the renderer even if page code were
 * compromised. What can be played is exactly what main sent.
 */

import { AnalyserAmplitudeSource } from '../components/orb/analyser-amplitude.js';

/** Small FFT: we want a fast time-domain window, not spectral resolution. */
const FFT_SIZE = 1024;

/** Slew applied to the analyser's own smoothing, on top of the orb's. */
const ANALYSER_SMOOTHING = 0.6;

export interface SpeechPlaybackHandlers {
  /** Playback actually began. */
  onStarted(speechId: string): void;
  /** Reached the end of the audio on its own. */
  onEnded(speechId: string): void;
  /** Could not decode or could not play. Carries a short reason. */
  onFailed(speechId: string, reason: string): void;
  /** A new amplitude source is live, or null once speech is over. */
  onAmplitude(source: AnalyserAmplitudeSource | null): void;
}

interface ActivePlayback {
  readonly speechId: string;
  readonly source: AudioBufferSourceNode;
  readonly analyser: AnalyserNode;
  readonly amplitude: AnalyserAmplitudeSource;
  stopped: boolean;
}

export class SpeechPlayer {
  private readonly handlers: SpeechPlaybackHandlers;
  private context: AudioContext | null = null;
  private active: ActivePlayback | null = null;

  constructor(handlers: SpeechPlaybackHandlers) {
    this.handlers = handlers;
  }

  get speaking(): boolean {
    return this.active !== null;
  }

  /**
   * Play one utterance, replacing anything already playing.
   *
   * `bytes` is copied into a fresh ArrayBuffer before decoding:
   * `decodeAudioData` detaches the buffer it is given, and the incoming
   * Uint8Array is owned by the IPC layer.
   */
  async play(speechId: string, bytes: Uint8Array): Promise<void> {
    this.stop();

    let context: AudioContext;
    try {
      context = this.ensureContext();
    } catch {
      this.handlers.onFailed(speechId, 'Audio is unavailable in this window.');
      return;
    }

    // A context created before any user gesture starts suspended. Axon speaks
    // in response to a message the user just sent, so a resume is legitimate
    // here and will be permitted.
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        // Non-fatal: decoding still works, and the context may resume on the
        // next interaction. Better to try playing than to give up here.
      }
    }

    let buffer: AudioBuffer;
    try {
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      buffer = await context.decodeAudioData(copy);
    } catch {
      // The message is deliberately vague. Decoder errors can name internals,
      // and the user's problem is "Axon did not speak", not the codec.
      this.handlers.onFailed(speechId, 'Axon could not decode its voice audio.');
      return;
    }

    // Cancelled while decoding: drop it rather than starting audio the user
    // has already asked to stop.
    if (this.active !== null) return;

    const source = context.createBufferSource();
    source.buffer = buffer;

    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

    // In the path, not tapped off it.
    source.connect(analyser);
    analyser.connect(context.destination);

    const amplitude = new AnalyserAmplitudeSource(analyser);
    const playback: ActivePlayback = { speechId, source, analyser, amplitude, stopped: false };
    this.active = playback;

    source.onended = (): void => {
      // Fires for both a natural end and an explicit stop(); only the natural
      // end is a completion, and `stopped` is what distinguishes them.
      if (playback.stopped) return;
      this.release(playback);
      this.handlers.onEnded(speechId);
    };

    try {
      source.start();
    } catch {
      this.release(playback);
      this.handlers.onFailed(speechId, 'Axon could not start audio playback.');
      return;
    }

    this.handlers.onAmplitude(amplitude);
    this.handlers.onStarted(speechId);
  }

  /**
   * Stop whatever is playing.
   *
   * Idempotent, and safe to call when nothing is playing. Returns the id that
   * was stopped, or null.
   */
  stop(): string | null {
    const playback = this.active;
    if (!playback) return null;

    playback.stopped = true;
    try {
      playback.source.stop();
    } catch {
      // Already ended, or never started. Either way there is nothing to stop
      // and nothing to report.
    }
    this.release(playback);
    return playback.speechId;
  }

  /**
   * Release the window's audio resources.
   *
   * Closes the shared context — call only when the component owning this
   * player unmounts.
   */
  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {
        // Closing a context that is already tearing down rejects; there is
        // nothing left to clean up if it does.
      });
    }
  }

  /**
   * Tear down one playback's nodes.
   *
   * Disconnecting matters: an undisconnected source node keeps its buffer
   * alive, and one per utterance is a leak that grows for as long as Axon
   * keeps talking.
   */
  private release(playback: ActivePlayback): void {
    playback.amplitude.detach();
    playback.source.onended = null;
    try {
      playback.source.disconnect();
      playback.analyser.disconnect();
    } catch {
      // Disconnecting a node that is already detached throws in some engines.
    }
    if (this.active === playback) this.active = null;
    this.handlers.onAmplitude(null);
  }

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context;
    this.context = new AudioContext();
    return this.context;
  }
}
