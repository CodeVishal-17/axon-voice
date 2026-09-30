/**
 * Microphone capture.
 *
 *     getUserMedia -> track -> MediaStreamTrackProcessor -> downmix -> resample -> PCM16 -> frames
 *                       |                                                                    |
 *                       +--> MediaStreamSource -> Analyser -> the orb                 main process
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
 *   - It cannot record. There is no accumulating buffer anywhere below beyond
 *     one outgoing frame (~64 ms) and the resampler's filter history: each
 *     frame is converted, handed to the callback, and dropped. Nothing is
 *     retained after `stop`, nothing is written anywhere, and there is no
 *     `MediaRecorder`, no `Blob`, no object URL and no download.
 *   - It cannot ask for a camera. The constraint object is a literal with
 *     `audio` only; `video` appears nowhere in this file, and the main process
 *     refuses a request carrying it regardless.
 *
 * WHY THE AUDIO NO LONGER COMES THROUGH WEB AUDIO. MEASURED, NOT GUESSED.
 *
 * Capture used to be a ScriptProcessorNode inside an AudioContext. A
 * ScriptProcessorNode only runs while connected to the speakers, so it was
 * connected through a zero-gain node — which means the context's output was
 * silence, always. With numeric diagnostics on (`AXON_WAKE_DEBUG=1`), the
 * capture page reported real time for about thirty seconds and then, in every
 * run: the AudioContext's OWN audio clock advancing 1344 ms per 2040 ms of wall
 * time, callbacks falling from 32 to 21 per window, and main receiving 65% of
 * real-time audio. That is Chromium's behaviour for an output that has played
 * nothing but silence for thirty seconds: the output sink is suspended and
 * rendering is driven by a coarse fallback timer, which on Windows runs slow.
 * The microphone FIFO feeding the graph overflows and a third of the audio is
 * thrown away — exactly the "wake detector seconds behind real time" and the
 * garbled transcripts people heard.
 *
 * `MediaStreamTrackProcessor` reads the track's own audio frames with no
 * output sink anywhere in the path, so nothing can suspend it. The AudioContext
 * remains ONLY for the orb's analyser, where a slow clock costs a lagging glow
 * and nothing else. Sample-rate conversion happens once, explicitly, in
 * `resampler.ts`, from whatever rate the device delivers.
 *
 * Where the browser has no track processor, the old graph is used, and the
 * diagnostics say `pipeline: script-processor` so nobody mistakes it for the fix.
 *
 * RESOURCES. `stop` is idempotent and reached from every exit — a normal end,
 * a failure mid-setup, the component unmounting, the window closing. It stops
 * every track (which is what turns the operating system's microphone
 * indicator off), cancels the reader, disconnects every node, and closes the
 * AudioContext.
 */

import {
  CAPTURE_DIAGNOSTICS_LIMITS,
  LISTENING_LIMITS,
  type CaptureDiagnostics,
  type CaptureFailure,
} from '@axon/core';
import { CaptureDiagnosticsWindow } from './capture-diagnostics.js';
import { StreamingResampler, downmix } from './resampler.js';
import { AnalyserAmplitudeSource } from '../components/orb/analyser-amplitude.js';

/**
 * Samples per processing block for the fallback graph.
 *
 * 1024 at 16kHz is 64ms — short enough that the voice activity detector in
 * main sees the end of a sentence promptly, long enough that the IPC traffic
 * stays at ~16 messages a second.
 */
const BLOCK_SIZE = 1024;

/**
 * Outgoing frame length on the track-processor path, in milliseconds.
 *
 * The track delivers ~10 ms at a time; sending each would be a hundred IPC
 * messages a second. 64 ms matches the fallback graph's cadence, so main, the
 * spotter and the voice session see the same rhythm whichever path ran.
 */
const FRAME_MS = 64;

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
  /** Numeric capture diagnostics, when they were asked for. Never samples. */
  onDiagnostics?(report: CaptureDiagnostics): void;
}

/** What a capture is opened with. */
export interface CaptureOptions {
  /** Stamped on diagnostics so main can attribute them. */
  readonly captureId?: string;
  /** Report `CaptureDiagnostics` every couple of seconds. */
  readonly diagnostics?: boolean;
  /** Explicit processing from main's capture command (development A/B only). Absent: all on. */
  readonly processing?: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
}

/** The slice of WebCodecs `AudioData` used here. Declared locally: not every DOM lib ships it. */
interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  /** Microseconds, on the capture clock. */
  readonly timestamp: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}

type TrackProcessorConstructor = new (init: { track: MediaStreamTrack }) => {
  readonly readable: ReadableStream<AudioDataLike>;
};

interface ActiveCapture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly amplitude: AnalyserAmplitudeSource;
  /** Tears down whichever pipeline produces frames. */
  readonly release: () => void;
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
   * Open the microphone and stream frames at `sampleRate`.
   *
   * Every failure path ends in `onFailed` with one of five reasons and a fully
   * released capture. Nothing here is allowed to throw: a rejected microphone
   * must leave Axon in a state it can recover from, not an unhandled error in
   * the window that renders its UI.
   */
  async start(sampleRate: number, options: CaptureOptions = {}): Promise<void> {
    this.stop();
    const generation = ++this.generation;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.handlers.onFailed('audio-unavailable');
      return;
    }

    let stream: MediaStream;
    try {
      // Audio only, and nothing beyond it. The processing flags are the
      // browser's own. They stay on: echo cancellation is what lets Axon hear
      // a person interrupt it while it is speaking, and whether noise
      // suppression or gain control harm recognition is a question for a
      // measured human comparison (`npm run voice:live`), not for a default
      // flipped on a hunch. Diagnostics report what the track actually applied.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: options.processing?.echoCancellation ?? true,
          noiseSuppression: options.processing?.noiseSuppression ?? true,
          autoGainControl: options.processing?.autoGainControl ?? true,
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

    const track = stream.getAudioTracks()[0];
    const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor;
    const useTrackProcessor = typeof Processor === 'function' && track !== undefined;

    let context: AudioContext;
    try {
      // On the track-processor path this context serves only the orb's
      // analyser, so its rate does not matter. On the fallback path it is asked
      // for the target rate, as before.
      context = useTrackProcessor ? new AudioContext() : new AudioContext({ sampleRate });
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
      source.connect(analyser);
      const amplitude = new AnalyserAmplitudeSource(analyser, 'microphone-analyser');

      const settings = firstTrackSettings(stream);
      const diagnostics = options.diagnostics
        ? new CaptureDiagnosticsWindow(
            {
              captureId: options.captureId ?? '',
              pipeline: useTrackProcessor ? 'track-processor' : 'script-processor',
              targetSampleRate: sampleRate,
              contextSampleRate: useTrackProcessor
                ? typeof settings.sampleRate === 'number'
                  ? settings.sampleRate
                  : 0
                : context.sampleRate,
              trackSampleRate: typeof settings.sampleRate === 'number' ? settings.sampleRate : null,
              trackChannelCount: typeof settings.channelCount === 'number' ? settings.channelCount : null,
              echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
              noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
              autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
            },
            performance.now(),
          )
        : null;

      const release =
        useTrackProcessor && Processor && track
          ? this.pumpTrack(new Processor({ track }).readable.getReader(), generation, sampleRate, diagnostics)
          : this.scriptGraph(context, analyser, sampleRate, diagnostics);

      // The user revoking access, or unplugging the device, ends the track.
      // Without this the session would sit in LISTENING against a dead stream
      // until a timer in main rescued it.
      for (const audioTrack of stream.getAudioTracks()) {
        audioTrack.addEventListener('ended', () => {
          if (generation === this.generation) {
            this.stop();
            this.handlers.onEnded();
          }
        });
      }

      this.active = { stream, context, source, analyser, amplitude, release };

      if (context.state === 'suspended') {
        // Started from a hotkey there may have been no gesture in this window.
        // Only the orb depends on this now, but a suspended context shows none.
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
   * Read the track's own frames until the capture ends.
   *
   * Returns the release function. Each `AudioData` is copied to float planes,
   * averaged to mono, resampled once to the target rate, converted to PCM16 and
   * sent in ~64 ms frames; then closed. The only audio held between reads is
   * the not-yet-full outgoing frame and the resampler's filter history.
   */
  private pumpTrack(
    reader: ReadableStreamDefaultReader<AudioDataLike>,
    generation: number,
    targetRate: number,
    diagnostics: CaptureDiagnosticsWindow | null,
  ): () => void {
    let released = false;
    const frameSamples = Math.min(LISTENING_LIMITS.maxFrameSamples, Math.round((targetRate * FRAME_MS) / 1000));
    let outgoing = new Float32Array(frameSamples);
    let filled = 0;
    let resampler: StreamingResampler | null = null;

    const pump = async (): Promise<void> => {
      for (;;) {
        let result: ReadableStreamReadResult<AudioDataLike>;
        try {
          result = await reader.read();
        } catch {
          return;
        }
        if (result.done) return;
        const data = result.value;
        try {
          if (released || generation !== this.generation) return;
          const frames = data.numberOfFrames;
          const planes: Float32Array[] = [];
          for (let channel = 0; channel < Math.max(1, data.numberOfChannels); channel += 1) {
            const plane = new Float32Array(frames);
            data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
            planes.push(plane);
          }
          const mono = downmix(planes);
          if (resampler === null || resampler.fromRate !== data.sampleRate) {
            resampler = new StreamingResampler(data.sampleRate, targetRate);
          }
          const converted = resampler.process(mono);

          let offset = 0;
          while (offset < converted.length) {
            const take = Math.min(frameSamples - filled, converted.length - offset);
            outgoing.set(converted.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === frameSamples) {
              // Converted and handed straight on; the next frame gets a fresh
              // array, so nothing downstream shares memory with this one.
              this.handlers.onFrame(toPcm16(outgoing));
              outgoing = new Float32Array(frameSamples);
              filled = 0;
            }
          }

          if (diagnostics) {
            const now = performance.now();
            diagnostics.setSourceRate(data.sampleRate);
            diagnostics.record(mono, converted.length, now, data.timestamp / 1_000_000);
            if (diagnostics.due(now, CAPTURE_DIAGNOSTICS_LIMITS.intervalMs)) {
              this.handlers.onDiagnostics?.(diagnostics.take(now));
            }
          }
        } finally {
          data.close();
        }
      }
    };
    void pump();

    return () => {
      released = true;
      void reader.cancel().catch(() => undefined);
    };
  }

  /**
   * The fallback: a ScriptProcessorNode connected to the speakers at zero gain.
   *
   * Kept for browsers without a track processor, and known — measured — to fall
   * behind real time after thirty seconds of silent output. See the header.
   */
  private scriptGraph(
    context: AudioContext,
    analyser: AnalyserNode,
    sampleRate: number,
    diagnostics: CaptureDiagnosticsWindow | null,
  ): () => void {
    // A ScriptProcessorNode rather than an AudioWorklet: a worklet has to load
    // its module from a URL, and Axon's Content-Security-Policy admits no such
    // URL.
    const processor = context.createScriptProcessor(BLOCK_SIZE, 1, 1);
    // A ScriptProcessorNode only runs while it is connected to a destination.
    // This gain node is that destination at zero volume — the microphone must
    // never be routed to the speakers.
    const sink = context.createGain();
    sink.gain.value = 0;
    analyser.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);

    processor.onaudioprocess = (event): void => {
      // One-channel node: a stereo device is down-mixed by the audio graph
      // before this sees it — never interleaved.
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resample(input, context.sampleRate, sampleRate);
      this.handlers.onFrame(toPcm16(resampled));
      if (diagnostics) {
        const now = performance.now();
        diagnostics.record(input, resampled.length, now, context.currentTime);
        if (diagnostics.due(now, CAPTURE_DIAGNOSTICS_LIMITS.intervalMs)) {
          this.handlers.onDiagnostics?.(diagnostics.take(now));
        }
      }
    };

    return () => {
      processor.onaudioprocess = null;
      try {
        analyser.disconnect(processor);
        processor.disconnect();
        sink.disconnect();
      } catch {
        // Disconnecting a node that is already detached throws in some engines.
      }
    };
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
    stopTracks(capture.stream);
    capture.release();

    try {
      capture.source.disconnect();
      capture.analyser.disconnect();
    } catch {
      // Disconnecting a node that is already detached throws in some engines.
    }

    if (capture.context.state !== 'closed') {
      void capture.context.close().catch(() => undefined);
    }

    this.handlers.onAmplitude(null);
  }
}

/** The first audio track's actual settings, or an empty object. */
function firstTrackSettings(stream: MediaStream): MediaTrackSettings {
  const track = stream.getAudioTracks()[0];
  try {
    return track?.getSettings() ?? {};
  } catch {
    return {};
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
 * Float samples to signed 16-bit PCM.
 *
 * Clamped before scaling: a sample slightly outside -1..1 (which
 * `autoGainControl` can produce) would otherwise wrap around and become a loud
 * click of the opposite sign. NaN becomes silence. Asymmetric scaling (0x8000
 * below zero, 0x7fff above) maps -1 and 1 onto the exact ends of the range.
 */
export function toPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] ?? 0;
    const sample = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

/**
 * Linear resampling of one block, for the FALLBACK graph only.
 *
 * Has no low-pass and restarts its phase at every block, both measured in
 * `audio-format.test.ts`. The fallback asks its AudioContext for the target
 * rate so this is normally the identity; the track-processor path uses
 * `StreamingResampler` instead.
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
