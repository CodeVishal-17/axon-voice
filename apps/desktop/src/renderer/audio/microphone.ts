/**
 * Microphone capture.
 *
 *     getUserMedia -> MediaStreamSource -> Analyser -> Processor -> frames
 *                                              |                      |
 *                                          the orb              main process
 *
 * The renderer is the only place a microphone can exist, because
 * `getUserMedia` is a browser API. That makes this file the most sensitive one
 * in the renderer, and it is written to be short enough to audit.
 *
 * WHAT IT CANNOT DO.
 *
 *   - It cannot open itself. `start` is called only from the capture command
 *     main sends, and every frame it emits is stamped with the capture id main
 *     minted. A session the main process did not open produces nothing.
 *   - It cannot record. There is no accumulating buffer anywhere below: each
 *     frame is converted, handed to the callback, and dropped on the next one.
 *     Nothing is retained after `stop`, nothing is written anywhere, and there
 *     is no `MediaRecorder`, no `Blob`, no object URL and no download.
 *   - It cannot ask for a camera. The constraint object is a literal with
 *     `audio` only; `video` appears nowhere in this file, and the main process
 *     refuses a request carrying it regardless.
 *
 * RESOURCES. `stop` is idempotent and reached from every exit — a normal end,
 * a failure mid-setup, the component unmounting, the window closing. It stops
 * every track (which is what turns the operating system's microphone
 * indicator off), disconnects every node, and closes the AudioContext.
 */

import type { CaptureFailure } from '@axon/core';
import { AnalyserAmplitudeSource } from '../components/orb/analyser-amplitude.js';

/**
 * Samples per processing block.
 *
 * 1024 at 16kHz is 64ms — short enough that the voice activity detector in
 * main sees the end of a sentence promptly, long enough that the IPC traffic
 * stays at ~16 messages a second.
 */
const BLOCK_SIZE = 1024;

/** Small FFT: a fast time-domain window for the orb, not spectral analysis. */
const FFT_SIZE = 1024;

export interface MicrophoneHandlers {
  /** One frame of 16-bit PCM at the requested rate. Not retained. */
  onFrame(samples: Int16Array): void;
  /** The stream is live. */
  onStarted(): void;
  /** The stream stopped on its own (device unplugged, track ended). */
  onEnded(): void;
  /** Could not capture. Carries a closed enum, never a device message. */
  onFailed(failure: CaptureFailure): void;
  /** A live amplitude source for the orb, or null once capture is over. */
  onAmplitude(source: AnalyserAmplitudeSource | null): void;
}

interface ActiveCapture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly processor: ScriptProcessorNode;
  readonly sink: GainNode;
  readonly amplitude: AnalyserAmplitudeSource;
}

export class MicrophoneCapture {
  private readonly handlers: MicrophoneHandlers;
  private active: ActiveCapture | null = null;
  /** Guards against a stop that arrives while `start` is still awaiting. */
  private generation = 0;

  constructor(handlers: MicrophoneHandlers) {
    this.handlers = handlers;
  }

  get capturing(): boolean {
    return this.active !== null;
  }

  /**
   * Open the microphone at `sampleRate` and stream frames.
   *
   * Every failure path ends in `onFailed` with one of five reasons and a fully
   * released capture. Nothing here is allowed to throw: a rejected microphone
   * must leave Axon in a state it can recover from, not an unhandled error in
   * the window that renders its UI.
   */
  async start(sampleRate: number): Promise<void> {
    this.stop();
    const generation = ++this.generation;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.handlers.onFailed('audio-unavailable');
      return;
    }

    let stream: MediaStream;
    try {
      // Audio only, and nothing beyond it. The processing flags are the
      // browser's own: they make speech recognition markedly better in a room
      // with a fan or a laptop next to a speaker, and they cost nothing.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      this.handlers.onFailed(classifyMediaError(error));
      return;
    }

    // Stopped while the permission prompt was up: release the stream rather
    // than leaving a live microphone behind a session that no longer exists.
    if (generation !== this.generation) {
      stopTracks(stream);
      return;
    }

    let context: AudioContext;
    try {
      // Asking for the target rate lets the browser resample in native code.
      // `resample` below covers the case where it declines.
      context = new AudioContext({ sampleRate });
    } catch {
      try {
        context = new AudioContext();
      } catch {
        stopTracks(stream);
        this.handlers.onFailed('audio-unavailable');
        return;
      }
    }

    try {
      const source = context.createMediaStreamSource(stream);

      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.5;

      // A ScriptProcessorNode rather than an AudioWorklet: a worklet has to
      // load its module from a URL, and Axon's Content-Security-Policy admits
      // no such URL. The deprecated node needs no module, no blob and no
      // policy exception, and at 1024 samples its main-thread cost is
      // negligible next to rendering the orb.
      const processor = context.createScriptProcessor(BLOCK_SIZE, 1, 1);

      // A ScriptProcessorNode only runs while it is connected to a
      // destination. This gain node is that destination at zero volume — the
      // microphone must never be routed to the speakers, which would be a
      // feedback loop and, worse, would play the room back out loud.
      const sink = context.createGain();
      sink.gain.value = 0;

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);

      const amplitude = new AnalyserAmplitudeSource(analyser, 'microphone-analyser');

      processor.onaudioprocess = (event): void => {
        if (this.active?.processor !== processor) return;
        const input = event.inputBuffer.getChannelData(0);
        const resampled = resample(input, context.sampleRate, sampleRate);
        // Converted and handed straight on. The Float32Array belongs to the
        // audio thread and is reused on the next block; nothing here keeps a
        // reference to it or to what it becomes.
        this.handlers.onFrame(toPcm16(resampled));
      };

      // The user revoking access, or unplugging the device, ends the track.
      // Without this the session would sit in LISTENING against a dead stream
      // until a timer in main rescued it.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (generation === this.generation) {
            this.stop();
            this.handlers.onEnded();
          }
        });
      }

      this.active = { stream, context, source, analyser, processor, sink, amplitude };

      if (context.state === 'suspended') {
        // Started from a hotkey there may have been no gesture in this window.
        // A suspended context still delivers no audio, so this matters.
        await context.resume().catch(() => undefined);
      }

      this.handlers.onAmplitude(amplitude);
      this.handlers.onStarted();
    } catch {
      stopTracks(stream);
      void context.close().catch(() => undefined);
      this.active = null;
      this.handlers.onFailed('capture-error');
    }
  }

  /**
   * Close the microphone and release everything.
   *
   * Idempotent. Track stop comes first: it is what turns off the operating
   * system's recording indicator, and a user watching that indicator is
   * entitled to see it go out the instant Axon stops listening.
   */
  stop(): void {
    this.generation += 1;

    const capture = this.active;
    this.active = null;
    if (!capture) return;

    capture.amplitude.detach();
    capture.processor.onaudioprocess = null;

    stopTracks(capture.stream);

    try {
      capture.source.disconnect();
      capture.analyser.disconnect();
      capture.processor.disconnect();
      capture.sink.disconnect();
    } catch {
      // Disconnecting a node that is already detached throws in some engines.
    }

    if (capture.context.state !== 'closed') {
      void capture.context.close().catch(() => undefined);
    }

    this.handlers.onAmplitude(null);
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  }
}

/**
 * Map a `getUserMedia` rejection onto one of five reasons.
 *
 * The error's own message is deliberately discarded rather than forwarded: on
 * Windows it can name the device, the driver and the user account, and none of
 * that belongs in an event, a log, or a sentence shown to someone else looking
 * at the screen.
 */
export function classifyMediaError(error: unknown): CaptureFailure {
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no-device';
    case 'NotReadableError':
    case 'AbortError':
      return 'device-error';
    default:
      return 'capture-error';
  }
}

/**
 * Float samples to 16-bit PCM.
 *
 * Clamped before scaling: a sample slightly outside -1..1 (which
 * `autoGainControl` can produce) would otherwise wrap around and become a loud
 * click in the middle of a quiet passage — audible to a person and, more to
 * the point, a spike the voice activity detector would read as speech.
 */
export function toPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

/**
 * Linear resampling to the recognizer's rate.
 *
 * A fallback, not the main path: the AudioContext is asked for the target rate
 * and normally provides it, in which case this returns its input untouched. It
 * exists because a browser is entitled to refuse a rate, and a recognizer fed
 * 48kHz audio it believes is 16kHz hears a chipmunk and transcribes nothing.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return input;

  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}
