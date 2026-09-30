/**
 * The keyword spotter, in a process of its own.
 *
 * THIS IS THE ONLY FILE IN AXON THAT TOUCHES THE SPEECH MODEL, and it is
 * deliberately the smallest program in the repository. It is built as its own
 * entry point (`out/main/kws-host.js`) and run as a child process, never
 * imported by anything.
 *
 * WHY A SEPARATE PROCESS, WHEN AN IN-PROCESS ADDON WOULD BE SIMPLER.
 *
 * Three reasons, and the third is the one that decided it.
 *
 *   CREDENTIALS. Axon's main process holds the AssemblyAI and Anthropic keys
 *   in its environment. This process runs for hours while nobody is talking to
 *   Axon, with a microphone open, which makes it exactly the process that
 *   should hold nothing worth taking. It is spawned with a six-name
 *   environment allowlist and neither key is on it.
 *
 *   CAPABILITY. In main, "the wake detector must not execute tools" would be a
 *   promise about code review. Here it is a promise about an operating system:
 *   this program's entire vocabulary is "read bytes from stdin, write one of
 *   three line shapes to stdout". It has no IPC to the renderer, no tool
 *   registry, no browser, no dispatcher, and no way to reach any of them.
 *
 *   CRASHES. The spotter is a native ONNX runtime. A native fault in main
 *   takes Axon down with it; a native fault here is an exit code the parent
 *   notices and restarts. Phase 11 of the brief asks that a wake detector
 *   crash not crash Axon, and a process boundary is the only way to actually
 *   mean it.
 *
 * WHAT CROSSES THE BOUNDARY.
 *
 *   in   raw 16-bit little-endian mono PCM at 16 kHz, on stdin, and nothing
 *        else. No commands, no configuration after argv.
 *   out  exactly three line shapes, on stdout:
 *
 *            READY <runtimeVersion> <threshold>
 *            WAKE <keywordId> <startMs> <endMs> <behindMs>
 *            ERR <code> <message>
 *            STATS <key=value ...>          (only when started with --stats)
 *
 * `behindMs` is how far behind LIVE AUDIO the spotter was when it fired: how
 * long ago the block that completed the phrase arrived on stdin. Zero means it
 * is keeping up; it is the only latency the detector itself adds.
 *
 * A previous definition — wall time since the stream opened, minus audio
 * consumed — reported a human test as "3629 ms behind". Measurement showed the
 * spotter decoding 100 ms of audio in ~4 ms the whole time; what had actually
 * happened was that the capture page upstream delivered only 65% of real-time
 * audio, and that metric booked the missing audio as backlog. This one cannot
 * confuse the two: audio that never arrives has no arrival time.
 *
 * It is deliberately NOT "how long after the end of the phrase". That was
 * tried: the spotter's `start_time` and timestamps are relative to an origin
 * this program cannot observe, and subtracting them from an audio counter
 * produced an eighteen-second "latency" for a phrase that had been spotted
 * immediately. A number that cannot be computed correctly is not reported.
 *
 * `startMs` and `endMs` are passed through as the spotter gives them, and are
 * used only as a SPAN — end minus start — which is origin-independent.
 *
 * `WAKE` is the bounded wake event. It carries no transcript, because a
 * keyword spotter produces none: it is a detector that fires on one sequence
 * of word pieces, so there is nothing for it to have overheard.
 *
 * WHAT IS NEVER DONE HERE. No audio is written to disk. No audio is logged.
 * No audio is buffered beyond the few hundred milliseconds the model's own
 * feature extractor holds. There is no socket, and no module imported by this
 * file can open one — `architecture.test.ts` holds that.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  KEYWORD_MAX_ACTIVE_PATHS,
  KEYWORD_MODEL_FILES,
  KEYWORD_TRAILING_BLANKS,
  KEYWORD_BOOST_SCORE,
} from './wake-keywords.js';
import { SpotterAudioQueue, summarize } from './kws-queue.js';
import { runFocus, type FocusRuntime } from './kws-focus.js';

/**
 * The native runtime, required at runtime rather than imported.
 *
 * `sherpa-onnx-node` is a native addon with a platform-specific binary. A
 * static import would make the whole bundle unloadable on a machine without
 * it; this way a missing runtime is an `ERR` line the parent can report as
 * "wake detector unavailable" rather than a crash at load.
 */
// `__filename` rather than `import.meta.url`: the main process is built to
// CommonJS, where the latter does not exist.
const requireNative = createRequire(__filename);

/** The longest a single stdout line may be. Nothing here writes anywhere near it. */
const MAX_LINE = 512;

/** 100 ms of 16 kHz audio: the block size the spotter is fed. */
const CHUNK_SAMPLES = 1_600;

/**
 * A pause in the audio this long means the capture stopped — the microphone
 * was lent to a conversation, or the window reloaded. Audio either side of a
 * gap is not one utterance, so the model's context is reset across it.
 */
const AUDIO_GAP_MS = 1_000;

/**
 * The most audio the queue holds, in bytes: half a second.
 *
 * Measured decode cost is ~4 ms per 100 ms block (p95 ~12 ms), so a healthy
 * spotter's queue is under one block. Half a second is room for a CPU spike;
 * beyond it the OLDEST audio is dropped, because the wake phrase worth hearing
 * is the one being said now. Never raised to hide a backlog.
 */
const MAX_QUEUE_BYTES = (16_000 * 2) / 2;

/** Blocks decoded per event-loop turn before stdin gets a chance to be read. */
const BLOCKS_PER_TURN = 3;

/** How often measurements are reported, when they were asked for. */
const STATS_INTERVAL_MS = 5_000;

/** Decode timings kept per stats window, bounded. */
const MAX_TIMINGS = 200;

function say(line: string): void {
  if (line.length > MAX_LINE) return;
  process.stdout.write(`${line}\n`);
}

function fail(code: string, message: string): never {
  say(`ERR ${code} ${message.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
  process.exit(3);
}

interface Argv {
  readonly model: string;
  readonly threshold: number;
  readonly threads: number;
  readonly keywords: readonly string[];
  /** Emit STATS lines. Set by the parent only when wake debugging is on. */
  readonly stats: boolean;
  /**
   * Run the focus DIAGNOSTIC for this keyword id instead of the production
   * spotter. Never emits WAKE. See `kws-focus.ts`.
   */
  readonly focus: string | null;
}

function parseArgv(argv: readonly string[]): Argv {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const model = value('--model');
  const threshold = Number.parseFloat(value('--threshold') ?? '');
  const threads = Number.parseInt(value('--threads') ?? '1', 10);
  // Every `--keyword` is one line of the spotter's keywords file. They come
  // from `wake-keywords.ts` in the parent, which is the only place the wake
  // phrase is written down.
  const keywords: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keyword') {
      const line = argv[i + 1];
      if (typeof line === 'string' && line !== '') keywords.push(line);
    }
  }
  if (model === undefined || !Number.isFinite(threshold) || keywords.length === 0) {
    fail('ARGV', 'the spotter was started without a model, a threshold or a keyword');
  }
  return {
    model,
    threshold,
    threads: Number.isFinite(threads) && threads > 0 ? threads : 1,
    keywords,
    stats: argv.includes('--stats'),
    focus: (() => {
      const id = value('--focus');
      return typeof id === 'string' && /^\w{1,32}$/.test(id) ? id : null;
    })(),
  };
}

function main(): void {
  const args = parseArgv(process.argv.slice(2));

  let sherpa: FocusRuntime & {
    KeywordSpotter: new (config: unknown) => KeywordSpotterLike;
    version?: string;
  };
  try {
    sherpa = requireNative('sherpa-onnx-node');
  } catch (error) {
    fail('RUNTIME', `the local keyword runtime would not load: ${(error as Error).message}`);
  }

  for (const file of Object.values(KEYWORD_MODEL_FILES)) {
    if (!fs.existsSync(path.join(args.model, file))) fail('MODEL', `the wake model is missing ${file}`);
  }

  if (args.focus !== null) {
    // The diagnostic, in place of the production spotter. It writes its own
    // keywords files into a private temporary directory, reads them back to
    // verify them, and removes them before it starts listening.
    const focusScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-kws-focus-'));
    process.on('exit', () => {
      try {
        fs.rmSync(focusScratch, { recursive: true, force: true });
      } catch {
        /* temporary */
      }
    });
    runFocus(sherpa, { ...args, focus: args.focus, scratch: focusScratch }, say, fail);
    return;
  }

  // The keywords file is the spotter's only configuration format. It is
  // written into a private temporary directory, read once, and removed —
  // never left beside the model, where an installer could edit what wakes
  // Axon. It holds five word pieces and a number; no audio touches it.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-kws-'));
  const keywordsFile = path.join(scratch, 'keywords.txt');
  const cleanup = (): void => {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* a temporary directory that outlives us is not worth an error path */
    }
  };
  fs.writeFileSync(keywordsFile, `${args.keywords.join('\n')}\n`, 'utf8');

  let spotter: KeywordSpotterLike;
  try {
    spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(args.model, KEYWORD_MODEL_FILES.encoder),
          decoder: path.join(args.model, KEYWORD_MODEL_FILES.decoder),
          joiner: path.join(args.model, KEYWORD_MODEL_FILES.joiner),
        },
        tokens: path.join(args.model, KEYWORD_MODEL_FILES.tokens),
        numThreads: args.threads,
        provider: 'cpu',
        debug: false,
      },
      maxActivePaths: KEYWORD_MAX_ACTIVE_PATHS,
      numTrailingBlanks: KEYWORD_TRAILING_BLANKS,
      keywordsScore: KEYWORD_BOOST_SCORE,
      keywordsThreshold: args.threshold,
      keywordsFile,
    });
  } catch (error) {
    cleanup();
    fail('MODEL', `the wake model would not load: ${(error as Error).message}`);
  } finally {
    // The spotter has read the file; nothing needs it again.
    cleanup();
  }

  let stream = spotter.createStream();
  const queue = new SpotterAudioQueue(MAX_QUEUE_BYTES);
  let lastAudioAt = 0;

  // Measured, and reported only when the parent asked (`--stats`). Numbers
  // about rates, time and queue depth; never audio.
  const stats = {
    windowStartedAt: Date.now(),
    bytesIn: 0,
    chunksIn: 0,
    blocks: 0,
    droppedAtWindowStart: 0,
    maxQueueMs: 0,
    maxBehindMs: 0,
    decodeMs: [] as number[],
  };

  /**
   * Decode what is queued, a bounded amount per turn of the event loop.
   *
   * Bounded so stdin is read between turns: a long decode can delay the next
   * read by at most `BLOCKS_PER_TURN` blocks, and whatever piles up meanwhile
   * lands in the queue, where the stalest audio is what gets dropped.
   */
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(pump);
  };
  const pump = (): void => {
    scheduled = false;
    for (let turn = 0; turn < BLOCKS_PER_TURN; turn += 1) {
      const block = queue.take(CHUNK_SAMPLES * 2);
      if (block === null) return;
      const startedAt = process.hrtime.bigint();

      const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
      const samples = new Float32Array(CHUNK_SAMPLES);
      for (let i = 0; i < CHUNK_SAMPLES; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
      stream.acceptWaveform({ samples, sampleRate: 16_000 });

      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (typeof result.keyword !== 'string' || result.keyword === '') continue;
        // Timestamps are used only as a SPAN (end minus start), which does not
        // depend on their origin. The parent refuses a match stretched across a
        // sentence with it.
        const stamps = Array.isArray(result.timestamps) ? result.timestamps : [];
        const first = stamps.length > 0 ? (stamps[0] ?? 0) : 0;
        const last = stamps.length > 0 ? (stamps[stamps.length - 1] ?? first) : first;
        const base = typeof result.start_time === 'number' ? result.start_time : 0;
        // How far behind live audio this detection is: how long ago the block
        // that completed the phrase arrived here. One clock, no guesswork.
        const behindMs = Math.max(0, Date.now() - block.arrivedAt);
        say(
          `WAKE ${result.keyword.replace(/[^\w]/g, '').slice(0, 32)} ` +
            `${Math.round((base + first) * 1000)} ${Math.round((base + last) * 1000)} ${behindMs}`,
        );
        // Without this the next phrase decodes against the last one's context.
        spotter.reset(stream);
      }

      if (args.stats) {
        stats.blocks += 1;
        if (stats.decodeMs.length < MAX_TIMINGS) stats.decodeMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        stats.maxBehindMs = Math.max(stats.maxBehindMs, Date.now() - block.arrivedAt);
      }
    }
    // More than a turn's worth queued: yield to stdin, then carry on.
    if (queue.queuedBytes >= CHUNK_SAMPLES * 2) schedule();
  };

  process.stdin.on('data', (chunk: Buffer) => {
    const now = Date.now();
    if (lastAudioAt !== 0 && now - lastAudioAt > AUDIO_GAP_MS) {
      // The capture paused. Start the model's context again rather than
      // decoding across a hole that no human voice crossed.
      stream = spotter.createStream();
      queue.clear();
    }
    lastAudioAt = now;
    queue.push(chunk, now);
    if (args.stats) {
      stats.bytesIn += chunk.byteLength;
      stats.chunksIn += 1;
      stats.maxQueueMs = Math.max(stats.maxQueueMs, Math.round((queue.queuedBytes / 32_000) * 1000));
    }
    schedule();
  });

  if (args.stats) {
    const timer = setInterval(() => {
      const now = Date.now();
      const seconds = Math.max(0.001, (now - stats.windowStartedAt) / 1000);
      const decode = summarize(stats.decodeMs);
      const droppedMs = Math.round(((queue.droppedBytes - stats.droppedAtWindowStart) / 32_000) * 1000);
      say(
        `STATS in=${Math.round((stats.bytesIn / 32_000 / seconds) * 1000)}ms/s ` +
          `processed=${Math.round((stats.blocks * 100) / seconds)}ms/s chunks=${stats.chunksIn} blocks=${stats.blocks} ` +
          `queue=${Math.round((queue.queuedBytes / 32_000) * 1000)}ms maxQueue=${stats.maxQueueMs}ms ` +
          `maxBehind=${stats.maxBehindMs}ms dropped=${droppedMs}ms ` +
          `decode mean=${decode.mean.toFixed(2)} p95=${decode.p95.toFixed(2)} max=${decode.max.toFixed(2)}ms/100ms ` +
          `rss=${Math.round(process.memoryUsage().rss / 1e6)}MB`,
      );
      stats.windowStartedAt = now;
      stats.bytesIn = 0;
      stats.chunksIn = 0;
      stats.blocks = 0;
      stats.droppedAtWindowStart = queue.droppedBytes;
      stats.maxQueueMs = 0;
      stats.maxBehindMs = 0;
      stats.decodeMs = [];
    }, STATS_INTERVAL_MS);
    timer.unref();
  }

  process.stdin.on('end', () => {
    process.exit(0);
  });
  // A parent that goes away takes the spotter with it: a keyword spotter with
  // an open microphone and nobody listening is the one state worth exiting for.
  process.stdin.on('error', () => {
    process.exit(0);
  });

  say(`READY ${(sherpa.version ?? 'unknown').slice(0, 32)} ${args.threshold.toFixed(2)}`);
}

/** The slice of the native spotter this program uses. Declared, not imported, so the addon stays behind one require. */
interface KeywordSpotterLike {
  createStream(): OnlineStreamLike;
  isReady(stream: OnlineStreamLike): boolean;
  decode(stream: OnlineStreamLike): void;
  reset(stream: OnlineStreamLike): void;
  getResult(stream: OnlineStreamLike): {
    keyword?: string;
    timestamps?: number[];
    start_time?: number;
  };
}

interface OnlineStreamLike {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

try {
  main();
} catch (error) {
  fail('FATAL', (error as Error).message ?? 'the keyword spotter stopped');
}
