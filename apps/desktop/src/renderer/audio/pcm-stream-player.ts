/**
 * Streaming playback for agent audio.
 *
 *     PCM chunks from main -> AudioBuffer per chunk -> scheduled queue
 *                                    -> Analyser -> out
 *                                          |
 *                                          +-> the orb
 *
 * WHY A SECOND PLAYER RATHER THAN A BIGGER FIRST ONE.
 *
 * `SpeechPlayer` decodes a complete encoded utterance and plays it. That is
 * the right shape for a synthesiser that hands over a finished WAV, and the
 * wrong shape for a voice agent that starts talking before it has finished
 * deciding what to say. Buffering the stream to reuse the existing player
 * would put the entire latency advantage of a streaming API back — the user
 * would wait through the whole reply before hearing its first word.
 *
 * So this schedules chunks as they arrive, against the audio clock rather than
 * against wall time, which is what keeps a stream gapless: each buffer is
 * queued to start exactly where the previous one ends, and a chunk that
 * arrives late restarts the schedule from "now" rather than trying to play in
 * the past.
 *
 * THE ORB IS DRIVEN BY THE REAL SIGNAL. The analyser sits in the path, after
 * the scheduled sources and before the output, so the level the orb reacts to
 * is measured from samples that are actually being played. Not a simulation,
 * not a timer, not an animation keyed off "the agent is probably speaking" —
 * the same rule the existing player follows, for the same reason.
 *
 * WHAT THIS CANNOT DO. It plays bytes handed to it by main. There is no path,
 * URL, filename or `fetch` in this file, so there is no version of "play this
 * file" available to page code even if the renderer were compromised.
 */

import { AnalyserAmplitudeSource } from '../components/orb/analyser-amplitude.js';

const FFT_SIZE = 1024;
const ANALYSER_SMOOTHING = 0.6;

/**
 * How far ahead of the audio clock a chunk is scheduled when the queue has
 * run dry. A small cushion absorbs network jitter without being audible as
 * latency; zero would mean every late chunk produced an underrun click.
 */
const SCHEDULE_CUSHION_SECONDS = 0.08;

export interface PcmStreamHandlers {
  /** The first chunk of an utterance began playing. */
  onStarted(speechId: string): void;
  /** The stream drained after being marked final. */
  onEnded(speechId: string): void;
  onFailed(speechId: string, reason: string): void;
  /** A live amplitude source, or null once the stream is over. */
  onAmplitude(source: AnalyserAmplitudeSource | null): void;
}

interface ActiveStream {
  readonly speechId: string;
  readonly analyser: AnalyserNode;
  readonly amplitude: AnalyserAmplitudeSource;
  readonly sources: Set<AudioBufferSourceNode>;
  /** Where in the context's timeline the next chunk should begin. */
  nextStartAt: number;
  /** True once main has sent the final chunk; the stream ends when it drains. */
  finished: boolean;
  started: boolean;
  stopped: boolean;
}

/**
 * Decode 16-bit signed little-endian PCM into float samples.
 *
 * Written out rather than handed to `decodeAudioData`, which expects a
 * container (WAV, MP3) and cannot decode a bare PCM chunk — and wrapping every
 * 50 ms chunk in a synthetic WAV header to satisfy it would be both slower and
 * sillier.
 *
 * An odd byte length means a truncated sample. The trailing byte is dropped
 * rather than padded: half a sample is noise, and inventing the other half is
 * inventing audio.
 */
export function decodePcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  // Explicitly backed by an ArrayBuffer, not an ArrayBufferLike: `copyToChannel`
  // will not accept a view that might be over a SharedArrayBuffer, and the
  // distinction is real rather than a type-system detail — a shared buffer
  // could be mutated by another thread mid-copy.
  const samples = new Float32Array(new ArrayBuffer(sampleCount * 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);

  for (let i = 0; i < sampleCount; i += 1) {
    // 32768 rather than 32767: it is the true magnitude of the negative rail,
    // and dividing by 32767 lets a full-scale negative sample exceed -1.0.
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

export class PcmStreamPlayer {
  private readonly handlers: PcmStreamHandlers;
  private context: AudioContext | null = null;
  private active: ActiveStream | null = null;

  constructor(handlers: PcmStreamHandlers) {
    this.handlers = handlers;
  }

  get playing(): boolean {
    return this.active !== null && !this.active.stopped;
  }

  /**
   * Accept one chunk.
   *
   * A chunk carrying a new `speechId` supersedes whatever was playing: the
   * agent has started a different reply, and finishing the old one would mean
   * talking over itself.
   */
  push(speechId: string, pcm: Uint8Array, sampleRate: number, final: boolean): void {
    if (this.active && this.active.speechId !== speechId) this.stop();

    let context: AudioContext;
    try {
      // One long-lived context, shared across utterances. Contexts are a
      // limited resource and one per utterance is how a browser runs out.
      this.context ??= new AudioContext();
      context = this.context;
    } catch {
      this.handlers.onFailed(speechId, 'audio-unavailable');
      return;
    }

    // Chromium suspends a context created before a user gesture. Speech is
    // always a response to something the user did, so resuming is safe here.
    if (context.state === 'suspended') void context.resume();

    const stream = this.active ?? this.begin(context, speechId);

    if (final) {
      stream.finished = true;
      // A final marker with no audio means "that was the end", so if nothing
      // is still scheduled the stream is done now.
      if (pcm.byteLength === 0 && stream.sources.size === 0) this.finish(stream);
      if (pcm.byteLength === 0) return;
    }

    const samples = decodePcm16(pcm);
    if (samples.length === 0) return;

    let buffer: AudioBuffer;
    try {
      buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
    } catch {
      // An unsupported rate is the realistic cause. Reported once per stream
      // rather than per chunk.
      this.handlers.onFailed(speechId, 'decode-failed');
      this.stop();
      return;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(stream.analyser);

    // Schedule against the AUDIO clock. Falling behind it — which happens
    // whenever the network stalls — restarts from now plus a cushion rather
    // than scheduling into the past, where it would play instantly and click.
    const startAt = Math.max(stream.nextStartAt, context.currentTime + SCHEDULE_CUSHION_SECONDS);
    stream.nextStartAt = startAt + buffer.duration;

    stream.sources.add(source);
    source.onended = (): void => {
      stream.sources.delete(source);
      if (stream.finished && stream.sources.size === 0) this.finish(stream);
    };

    source.start(startAt);

    if (!stream.started) {
      stream.started = true;
      this.handlers.onStarted(speechId);
      this.handlers.onAmplitude(stream.amplitude);
    }
  }

  /** Stop immediately and release everything. Idempotent. */
  stop(): string | null {
    const stream = this.active;
    if (!stream || stream.stopped) return null;

    stream.stopped = true;
    this.active = null;

    for (const source of stream.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already finished */
      }
      try {
        source.disconnect();
      } catch {
        /* already detached */
      }
    }
    stream.sources.clear();

    try {
      stream.analyser.disconnect();
    } catch {
      /* already detached */
    }

    this.handlers.onAmplitude(null);
    return stream.speechId;
  }

  /** Release the shared context. Called when the component unmounts. */
  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => {
      /* closing a closed context is not an error worth surfacing */
    });
  }

  // --- internals ----------------------------------------------------------

  private begin(context: AudioContext, speechId: string): ActiveStream {
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    // In the path, not beside it: the orb reacts to what is actually audible.
    analyser.connect(context.destination);

    const stream: ActiveStream = {
      speechId,
      analyser,
      amplitude: new AnalyserAmplitudeSource(analyser),
      sources: new Set(),
      nextStartAt: 0,
      finished: false,
      started: false,
      stopped: false,
    };
    this.active = stream;
    return stream;
  }

  private finish(stream: ActiveStream): void {
    if (stream.stopped) return;
    const speechId = stream.speechId;
    this.stop();
    this.handlers.onEnded(speechId);
  }
}
