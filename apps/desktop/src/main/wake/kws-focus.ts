/**
 * The focus diagnostic: measuring one keyword on live frames, in a process of
 * its own.
 *
 * Runs ONLY when the parent starts a SECOND spotter process with
 * `--focus <keywordId>`, which it does only in a development build with
 * AXON_WAKE_FOCUS and AXON_WAKE_DEBUG set. It never emits `WAKE`, so it can
 * neither wake Axon nor stop it waking: the production spotter, in its own
 * process with its own timing, is untouched by everything here.
 *
 * What it measures is described in `focus-report.ts`: a threshold ladder, an
 * alignment fan across one 320 ms decode chunk, and a free decode of the same
 * acoustic model. It emits:
 *
 *   CONFIG ...                     the runtime configuration, verified, once
 *   FOCUS hit t= off= id= span=    a ladder or offset spotter fired
 *   FOCUS heard rms= peak= pieces= logp= text=
 *                                  what the model emitted for one speech
 *                                  segment, with a log-probability per piece
 *   STATS ...                      rates, queue, drops, decode cost
 *
 * THE ONE THING HERE THAT IS NOT A NUMBER is the free decode's text: the model's
 * own hearing of speech in the room, before any wake. It exists because "the
 * model heard HEY ACTION" is the single most useful fact about a miss, and it is
 * bounded, printed only to a developer console, never persisted, never sent
 * anywhere — the same treatment AXON_VOICE_DEBUG gives AssemblyAI's transcript.
 * No audio is kept beyond one queued block and the models' own state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { KEYWORD_BOOST_SCORE, KEYWORD_MAX_ACTIVE_PATHS, KEYWORD_MODEL_FILES, KEYWORD_TRAILING_BLANKS } from './wake-keywords.js';
import { SpotterAudioQueue, summarize } from './kws-queue.js';
import {
  FOCUS_OFFSETS_MS,
  FOCUS_THRESHOLDS,
  MODEL_CHUNK_MS,
  keywordLine,
  parseTokenTable,
  piecesOf,
  printablePiece,
  withThreshold,
} from './focus-report.js';

interface StreamLike {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

interface SpotterLike {
  createStream(): StreamLike;
  isReady(stream: StreamLike): boolean;
  decode(stream: StreamLike): void;
  reset(stream: StreamLike): void;
  getResult(stream: StreamLike): { keyword?: string; timestamps?: number[]; start_time?: number };
}

interface RecognizerLike {
  createStream(): StreamLike;
  isReady(stream: StreamLike): boolean;
  decode(stream: StreamLike): void;
  reset(stream: StreamLike): void;
  isEndpoint(stream: StreamLike): boolean;
  getResult(stream: StreamLike): { text?: string; tokens?: string[]; ys_probs?: number[] };
}

export interface FocusRuntime {
  KeywordSpotter: new (config: unknown) => SpotterLike;
  OnlineRecognizer: new (config: unknown) => RecognizerLike;
  version?: string;
  onnxruntimeVersion?: string;
}

export interface FocusArgs {
  readonly model: string;
  readonly threshold: number;
  readonly threads: number;
  readonly keywords: readonly string[];
  readonly focus: string;
  readonly scratch: string;
}

const CHUNK_SAMPLES = 1_600;
const AUDIO_GAP_MS = 1_000;
const MAX_QUEUE_BYTES = 16_000;
const STATS_INTERVAL_MS = 5_000;
const MAX_TIMINGS = 200;
/** Longest free-decode text reported. A wake phrase is two words. */
const MAX_TEXT = 120;
const MAX_PIECES = 40;
/** Audio absent this long means the capture paused: report the segment heard so far. */
const FLUSH_AFTER_SILENT_MS = 400;

export function runFocus(
  runtime: FocusRuntime,
  args: FocusArgs,
  say: (line: string) => void,
  fail: (code: string, message: string) => never,
): void {
  const line = keywordLine(args.keywords, args.focus);
  if (line === null) fail('ARGV', `no keyword with id ${args.focus.slice(0, 32)} to focus on`);
  const pieces = piecesOf(line);

  const modelFile = (name: string): string => path.join(args.model, name);
  const modelConfig = {
    transducer: {
      encoder: modelFile(KEYWORD_MODEL_FILES.encoder),
      decoder: modelFile(KEYWORD_MODEL_FILES.decoder),
      joiner: modelFile(KEYWORD_MODEL_FILES.joiner),
    },
    tokens: modelFile(KEYWORD_MODEL_FILES.tokens),
    numThreads: args.threads,
    provider: 'cpu',
    debug: false,
  };
  const featConfig = { sampleRate: 16_000, featureDim: 80 };

  // --- the configuration, verified against what is actually on disk -------------
  const sizes = Object.entries(KEYWORD_MODEL_FILES)
    .map(([role, file]) => `${role}:${fs.statSync(modelFile(file)).size}`)
    .join(',');
  say(
    `CONFIG runtime=${(runtime.version ?? '?').slice(0, 24)} onnxruntime=${(runtime.onnxruntimeVersion ?? '?').slice(0, 24)} ` +
      `sampleRate=${featConfig.sampleRate} featureDim=${featConfig.featureDim} decodeChunkMs=${MODEL_CHUNK_MS} ` +
      `boost=${KEYWORD_BOOST_SCORE} trailingBlanks=${KEYWORD_TRAILING_BLANKS} beam=${KEYWORD_MAX_ACTIVE_PATHS} files=${sizes}`,
  );
  const table = parseTokenTable(fs.readFileSync(modelFile(KEYWORD_MODEL_FILES.tokens), 'utf8'));
  const ids = pieces.map((piece) => `${printablePiece(piece)}=${table.get(piece) ?? 'MISSING'}`).join('|');

  // Write each ladder keywords file, then READ IT BACK and check the pieces
  // survived as the exact code points the model's token table holds — the
  // argv -> file -> runtime path, not the constant it started from.
  const files: string[] = [];
  let roundTrip = 'ok';
  for (const threshold of FOCUS_THRESHOLDS) {
    const file = path.join(args.scratch, `focus-${threshold.toFixed(2)}.txt`);
    fs.writeFileSync(file, `${withThreshold(line, threshold)}\n`, 'utf8');
    const back = piecesOf(fs.readFileSync(file, 'utf8').trim());
    if (back.join(' ') !== pieces.join(' ') || back.some((piece) => !table.has(piece))) roundTrip = 'MISMATCH';
    files.push(file);
  }
  say(
    `CONFIG keyword id=${args.focus} pieces=${ids} line=${printablePiece(withThreshold(line, args.threshold))} ` +
      `fileRoundTrip=${roundTrip} productionThreshold=${args.threshold.toFixed(2)}`,
  );

  // --- the instruments ---------------------------------------------------------------
  const ladder = FOCUS_THRESHOLDS.map((threshold, index) => {
    const spotter = new runtime.KeywordSpotter({
      featConfig,
      modelConfig,
      maxActivePaths: KEYWORD_MAX_ACTIVE_PATHS,
      numTrailingBlanks: KEYWORD_TRAILING_BLANKS,
      keywordsScore: KEYWORD_BOOST_SCORE,
      keywordsThreshold: threshold,
      keywordsFile: files[index],
    });
    return { threshold, spotter };
  });
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the scratch directory is removed with the process */
    }
  }

  const production =
    ladder.find((arm) => Math.abs(arm.threshold - args.threshold) < 1e-9) ??
    (() => {
      fail('ARGV', `the production threshold ${args.threshold} is not on the focus ladder`);
    })();

  interface Arm {
    readonly spotter: SpotterLike;
    readonly threshold: number;
    readonly offsetMs: number;
    stream: StreamLike;
  }
  const newArms = (): Arm[] => [
    // The ladder, all at offset 0.
    ...ladder.map((arm) => ({ spotter: arm.spotter, threshold: arm.threshold, offsetMs: 0, stream: arm.spotter.createStream() })),
    // The alignment fan, at the production threshold. Offset 0 is the ladder's own arm.
    ...FOCUS_OFFSETS_MS.filter((offset) => offset > 0).map((offsetMs) => {
      const stream = production.spotter.createStream();
      // Delay this stream by `offsetMs` of silence once, so everything after
      // lands at a different position inside the model's 320 ms chunks.
      stream.acceptWaveform({ samples: new Float32Array(Math.round((16_000 * offsetMs) / 1000)), sampleRate: 16_000 });
      return { spotter: production.spotter, threshold: production.threshold, offsetMs, stream };
    }),
  ];
  let arms = newArms();

  const recognizer = new runtime.OnlineRecognizer({
    featConfig,
    modelConfig,
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    // A segment ends after 0.5 s of silence following speech, or 1 s with none.
    rule1MinTrailingSilence: 1.0,
    rule2MinTrailingSilence: 0.5,
    rule3MinUtteranceLength: 10,
  });
  let heardStream = recognizer.createStream();
  let segmentSquares = 0;
  let segmentSamples = 0;
  let segmentPeak = 0;

  const queue = new SpotterAudioQueue(MAX_QUEUE_BYTES);
  const stats = { windowStartedAt: Date.now(), bytesIn: 0, blocks: 0, droppedAt: 0, maxQueueMs: 0, decodeMs: [] as number[] };
  let lastAudioAt = 0;

  const emitHeard = (): void => {
    const result = recognizer.getResult(heardStream);
    const text = (result.text ?? '').trim();
    if (text !== '') {
      const tokens = (result.tokens ?? []).slice(0, MAX_PIECES);
      const logProbs = (result.ys_probs ?? []).slice(0, MAX_PIECES);
      const rms = segmentSamples === 0 ? 0 : Math.sqrt(segmentSquares / segmentSamples);
      say(
        `FOCUS heard rms=${rms.toFixed(3)} peak=${segmentPeak.toFixed(3)} ` +
          `pieces=${tokens.map((token) => printablePiece(token.replace(/\s/g, '\u2581'))).join('|')} ` +
          `logp=${logProbs.map((value) => value.toFixed(2)).join('|')} ` +
          `text=${text.replace(/[\r\n]+/g, ' ').slice(0, MAX_TEXT)}`,
      );
    }
    recognizer.reset(heardStream);
    segmentSquares = 0;
    segmentSamples = 0;
    segmentPeak = 0;
  };

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(pump);
  };
  const pump = (): void => {
    scheduled = false;
    const block = queue.take(CHUNK_SAMPLES * 2);
    if (block === null) return;
    const startedAt = process.hrtime.bigint();

    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
    const samples = new Float32Array(CHUNK_SAMPLES);
    for (let i = 0; i < CHUNK_SAMPLES; i += 1) {
      const sample = view.getInt16(i * 2, true) / 32_768;
      samples[i] = sample;
      segmentSquares += sample * sample;
      segmentPeak = Math.max(segmentPeak, Math.abs(sample));
    }
    segmentSamples += CHUNK_SAMPLES;

    for (const arm of arms) {
      arm.stream.acceptWaveform({ samples, sampleRate: 16_000 });
      while (arm.spotter.isReady(arm.stream)) {
        arm.spotter.decode(arm.stream);
        const result = arm.spotter.getResult(arm.stream);
        if (typeof result.keyword !== 'string' || result.keyword === '') continue;
        const stamps = Array.isArray(result.timestamps) ? result.timestamps : [];
        const span = stamps.length > 1 ? Math.round(((stamps[stamps.length - 1] ?? 0) - (stamps[0] ?? 0)) * 1000) : 0;
        say(
          `FOCUS hit t=${arm.threshold.toFixed(2)} off=${arm.offsetMs} ` +
            `id=${result.keyword.replace(/[^\w]/g, '').slice(0, 32)} span=${span}`,
        );
        arm.spotter.reset(arm.stream);
      }
    }

    heardStream.acceptWaveform({ samples, sampleRate: 16_000 });
    while (recognizer.isReady(heardStream)) recognizer.decode(heardStream);
    if (recognizer.isEndpoint(heardStream)) emitHeard();

    stats.blocks += 1;
    if (stats.decodeMs.length < MAX_TIMINGS) stats.decodeMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    if (queue.queuedBytes >= CHUNK_SAMPLES * 2) schedule();
  };

  process.stdin.on('data', (chunk: Buffer) => {
    const now = Date.now();
    if (lastAudioAt !== 0 && now - lastAudioAt > AUDIO_GAP_MS) {
      // The capture paused: new streams, so no measurement spans the hole.
      arms = newArms();
      heardStream = recognizer.createStream();
      segmentSquares = 0;
      segmentSamples = 0;
      segmentPeak = 0;
      queue.clear();
    }
    lastAudioAt = now;
    queue.push(chunk, now);
    stats.bytesIn += chunk.byteLength;
    stats.maxQueueMs = Math.max(stats.maxQueueMs, Math.round((queue.queuedBytes / 32_000) * 1000));
    schedule();
  });

  // When audio STOPS — the production detector fired and the microphone moved
  // to a voice session — the free decode never sees the trailing silence that
  // ends a segment. Report what it heard as soon as the audio has paused,
  // rather than losing exactly the utterances that were detected.
  const flush = setInterval(() => {
    if (lastAudioAt !== 0 && Date.now() - lastAudioAt > FLUSH_AFTER_SILENT_MS && segmentSamples > 0) {
      while (recognizer.isReady(heardStream)) recognizer.decode(heardStream);
      emitHeard();
    }
  }, FLUSH_AFTER_SILENT_MS);
  flush.unref();

  const timer = setInterval(() => {
    const now = Date.now();
    const seconds = Math.max(0.001, (now - stats.windowStartedAt) / 1000);
    const decode = summarize(stats.decodeMs);
    const droppedMs = Math.round(((queue.droppedBytes - stats.droppedAt) / 32_000) * 1000);
    say(
      `STATS focus in=${Math.round((stats.bytesIn / 32_000 / seconds) * 1000)}ms/s ` +
        `processed=${Math.round((stats.blocks * 100) / seconds)}ms/s maxQueue=${stats.maxQueueMs}ms dropped=${droppedMs}ms ` +
        `decode mean=${decode.mean.toFixed(2)} p95=${decode.p95.toFixed(2)} max=${decode.max.toFixed(2)}ms/100ms ` +
        `streams=${arms.length}+1 rss=${Math.round(process.memoryUsage().rss / 1e6)}MB`,
    );
    stats.windowStartedAt = now;
    stats.bytesIn = 0;
    stats.blocks = 0;
    stats.droppedAt = queue.droppedBytes;
    stats.maxQueueMs = 0;
    stats.decodeMs = [];
  }, STATS_INTERVAL_MS);
  timer.unref();

  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));

  say(`READY ${(runtime.version ?? 'unknown').slice(0, 32)} focus`);
}
