/**
 * The parent half of the keyword spotter.
 *
 * Owns one child process and nothing else: it starts `kws-host.js`, feeds it
 * microphone frames as raw PCM on stdin, reads the three line shapes it can
 * answer with, and restarts it when it dies. It makes no decision about
 * whether a hit should wake Axon — that is `keyword-wake-detector.ts`, which
 * is pure and testable and never sees a process.
 *
 * WHAT THIS FILE IS ALLOWED TO IMPORT, AND WHY IT IS WRITTEN DOWN.
 *
 * `node:child_process`, `node:fs`, `node:path`, and Axon's own wake modules.
 * That list is asserted by `architecture.test.ts`, because this is the one
 * file on the pre-activation path that is allowed to reach the operating
 * system at all, and "no socket exists" has to stay checkable by reading one
 * import block. There is no `node:net`, no `node:http`, no `ws`, and nothing
 * from `agent/`.
 *
 * THE CHILD'S ENVIRONMENT.
 *
 * Built from a six-name allowlist shared with the Windows recognizer, plus
 * `ELECTRON_RUN_AS_NODE`, which is what makes Electron's own binary run this
 * as an ordinary Node program. Neither API key is on the list. This matters
 * more here than anywhere else in Axon: the spotter is the process that is
 * running, with a microphone open, at three in the morning when nobody has
 * spoken to Axon for nine hours.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  KEYWORD_ENGINE_DETAIL,
  KEYWORD_MODEL_DIRNAME,
  KEYWORD_MODEL_FILE_LIST,
  keywordsFileContents,
} from './wake-keywords.js';

/** One detection, as the spotter reported it. Timing and an id: never text, never audio. */
export interface KeywordHit {
  readonly id: string;
  /** Where the phrase began, in milliseconds from the start of this spotter's stream. */
  readonly startMs: number;
  /** Where its last word piece landed, on the same clock. */
  readonly endMs: number;
  /**
   * How far behind live audio the spotter was when it fired, in milliseconds.
   *
   * Zero means it is keeping up with the microphone; a growing number is the
   * only way the detector itself can add latency to an activation. It is NOT
   * "how long after the phrase ended" — see `kws-host.ts` for why that number
   * cannot be computed from what the spotter reports, and why a number that
   * cannot be computed correctly is not reported.
   */
  readonly behindMs: number;
}

export interface KeywordEngineHandlers {
  /** The spotter heard one of its keywords. */
  onHit(hit: KeywordHit): void;
  /** The spotter loaded and is listening. May fire again after a restart. */
  onReady(detail: string): void;
  /** The spotter could not be kept alive. The detector should disarm and say so. */
  onFailure(message: string): void;
  /** Developer diagnostics. Never audio. */
  onDebug?(line: string): void;
}

/**
 * The part of a keyword spotter the detector uses.
 *
 * An interface, so `keyword-wake-detector.ts` can be tested against a stand-in
 * on any machine, with no model and no child process — the same reason the
 * wake word takes its activity detector as an argument.
 */
export interface KeywordEngine {
  readonly available: boolean;
  /** Why it cannot run, when it cannot. Phrased for a person; never a path or a credential. */
  readonly unavailableReason: string | null;
  /** What is doing the hearing, in a few words. */
  readonly detail: string;
  /** Restarts since `start`. */
  readonly restarts: number;
  start(handlers: KeywordEngineHandlers): void;
  stop(): void;
  push(frame: Int16Array): void;
}

/**
 * The only environment variables the spotter is given.
 *
 * The same allowlist the Windows recognizer uses, for the same reason, plus
 * the one variable that makes Electron's binary behave as Node.
 */
const SPOTTER_ENV_NAMES: readonly string[] = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'Path'];

/** Build the spotter's environment from the allowlist. Names match case-insensitively, as Windows does. */
export function spotterEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  const keys = Object.keys(source);
  for (const name of SPOTTER_ENV_NAMES) {
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : source[key];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

/** Longest line accepted from the child. Its three line shapes are well under a hundred bytes. */
const MAX_LINE_BYTES = 4 * 1024;

/** How long the spotter has to load a model before Axon gives up on that attempt. */
const READY_TIMEOUT_MS = 20_000;

/** Backoff between restarts, in order. After the last one the engine reports failure. */
const RESTART_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * How long a spotter must stay up before its restarts are forgiven.
 *
 * A spotter that runs for a minute is healthy; one that dies five times in
 * thirty seconds is broken, and the difference is worth keeping so a machine
 * that wakes from sleep once a day never exhausts its restart budget.
 */
const HEALTHY_AFTER_MS = 60_000;

export interface SherpaKeywordEngineOptions {
  /** The detection threshold the spotter is configured with. */
  readonly threshold: number;
  /** Where the model lives. Defaults to the resolution below. */
  readonly modelDir?: string;
  /** The program to run. TESTS ONLY, and the reason is the same as `windows-stt.ts`: whatever sets this chooses what executes. */
  readonly executable?: string;
  /** Argv override. TESTS ONLY, as above. */
  readonly args?: readonly string[];
  /** Threads the model may use. One is enough: measured real-time factor is about 0.03. */
  readonly threads?: number;
  /**
   * Ask the spotter for STATS lines (rates, queue depth, decode timings). Only
   * when wake debugging is on; the lines go to the debug channel.
   */
  readonly stats?: boolean;
  /**
   * Start this process as the focus DIAGNOSTIC for one keyword id instead of a
   * production spotter. It never emits WAKE; its CONFIG and FOCUS lines go to the
   * debug channel. Development only — see `FocusKeywordEngine`.
   */
  readonly focus?: string;
  /** Wall clock and timers, injected in tests. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Where the model is, in a development tree and in a packaged app.
 *
 * `AXON_WAKE_MODEL_DIR` overrides both, for the calibration harness and for a
 * machine that keeps its models somewhere else. It names a directory to read,
 * never a program to run.
 */
export function resolveModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AXON_WAKE_MODEL_DIR;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());

  // Packaged: beside the app's other resources.
  const packaged = typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, KEYWORD_MODEL_DIRNAME) : null;
  if (packaged !== null && fs.existsSync(packaged)) return packaged;

  // Development: this file builds to `out/main/`, and the model sits under
  // `resources/` beside it. `__dirname` rather than `import.meta.url` because
  // the main process is built to CommonJS.
  return path.resolve(__dirname, '..', '..', 'resources', KEYWORD_MODEL_DIRNAME);
}

/** Where the child program is, built beside this one. */
function resolveHostScript(): string {
  return path.join(__dirname, 'kws-host.js');
}

/**
 * A keyword spotter running as a child process.
 *
 * Restarts it on an unexpected exit, with a bounded budget, and reports
 * failure rather than looping: an assistant that respawns a broken model
 * forever is a laptop fan, not a feature.
 */
export class SherpaKeywordEngine implements KeywordEngine {
  readonly detail = KEYWORD_ENGINE_DETAIL;

  private readonly threshold: number;
  private readonly modelDir: string;
  private readonly executable: string;
  private readonly hostScript: string;
  private readonly explicitArgs: readonly string[] | null;
  private readonly threads: number;
  private readonly stats: boolean;
  private readonly focus: string | null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private handlers: KeywordEngineHandlers | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private line = '';
  private ready = false;
  private running = false;
  private startedAt = 0;
  private attempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  /** False while the spotter's stdin is full; frames are dropped, never queued. */
  private stdinReady = true;
  private droppedSinceDrain = 0;
  /** Frames dropped in the parent since the spotter started, for STATS. */
  private droppedTotal = 0;

  constructor(options: SherpaKeywordEngineOptions) {
    this.threshold = options.threshold;
    this.modelDir = options.modelDir ?? resolveModelDir();
    this.executable = options.executable ?? process.execPath;
    this.hostScript = resolveHostScript();
    this.explicitArgs = options.args ?? null;
    this.threads = options.threads ?? 1;
    this.stats = options.stats ?? false;
    this.focus = options.focus ?? null;
    this.now = options.now ?? ((): number => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  get restarts(): number {
    return this.restartCount;
  }

  /** The model files that are missing, if any. Named, so a failure says what to do. */
  private missingModelFiles(): readonly string[] {
    return KEYWORD_MODEL_FILE_LIST.filter((name) => !fs.existsSync(path.join(this.modelDir, name)));
  }

  get available(): boolean {
    if (this.explicitArgs !== null) return true;
    return fs.existsSync(this.hostScript) && this.missingModelFiles().length === 0;
  }

  get unavailableReason(): string | null {
    if (this.available) return null;
    if (!fs.existsSync(this.hostScript)) return 'The wake-word engine has not been built. Run `npm run build`.';
    return 'The local wake-word model is not installed. Run `npm run wake:model`.';
  }

  /**
   * The complete argv the spotter is started with.
   *
   * Every element is either a constant, a number, or a path Axon resolved —
   * nothing here is built from anything a person said, and the keyword lines
   * come from `wake-keywords.ts`, which is the only place the phrase exists.
   */
  private argv(): readonly string[] {
    if (this.explicitArgs !== null) return this.explicitArgs;
    const keywords = keywordsFileContents(this.threshold).trim().split('\n');
    return [
      this.hostScript,
      '--model',
      this.modelDir,
      '--threshold',
      this.threshold.toFixed(2),
      '--threads',
      String(this.threads),
      ...keywords.flatMap((line) => ['--keyword', line]),
      ...(this.stats ? ['--stats'] : []),
      ...(this.focus !== null ? ['--focus', this.focus] : []),
    ];
  }

  start(handlers: KeywordEngineHandlers): void {
    if (this.running) return;
    this.handlers = handlers;
    this.running = true;
    this.attempts = 0;
    this.restartCount = 0;
    this.spawnChild();
  }

  stop(): void {
    this.running = false;
    this.handlers = null;
    this.ready = false;
    this.stdinReady = true;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    this.line = '';
    if (child) {
      // Closing stdin is how the host is asked to leave; the kill is the
      // answer to one that does not.
      child.stdout.removeAllListeners();
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * One frame of microphone audio, to the spotter and nowhere else.
   *
   * Note what this does not do: it does not buffer, does not log, does not
   * persist, and does not return anything. Frames that arrive while the
   * spotter is restarting are DROPPED rather than queued — a wake word is
   * live audio, and a queue of it is a recording.
   */
  push(frame: Int16Array): void {
    const child = this.child;
    if (!child || !this.ready) return;
    // Backpressure is handled by DROPPING, not by growing. Node's stream would
    // happily buffer for us, and that buffer would be a recording of somebody's
    // room — so when `write` says the pipe is full, frames are discarded until
    // it drains. A wake word is live audio; the next frame is worth more than
    // this one, and a queue of it is the one thing this subsystem must not have.
    if (!this.stdinReady) {
      this.droppedSinceDrain += 1;
      this.droppedTotal += 1;
      return;
    }
    // The spotter reads 16-bit little-endian, which is what an Int16Array's
    // bytes already are on x86. Axon is a Windows product; a big-endian host
    // would need a byte swap here and would fail loudly rather than quietly,
    // because nothing would ever be detected.
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    try {
      if (!child.stdin.write(bytes)) {
        this.stdinReady = false;
        this.droppedSinceDrain = 0;
        child.stdin.once('drain', () => {
          if (this.child !== child) return;
          this.stdinReady = true;
          if (this.droppedSinceDrain > 0) {
            this.debug(`the spotter fell behind; ${this.droppedSinceDrain} frame(s) dropped rather than queued`);
          }
        });
      }
    } catch {
      /* the exit handler will deal with it */
    }
  }

  private clearTimers(): void {
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    if (this.readyTimer) this.clearTimer(this.readyTimer);
    this.restartTimer = null;
    this.readyTimer = null;
  }

  private spawnChild(): void {
    if (!this.running) return;

    const missing = this.missingModelFiles();
    if (this.explicitArgs === null && missing.length > 0) {
      this.handlers?.onFailure(this.unavailableReason ?? 'The local wake-word model is not installed.');
      this.running = false;
      return;
    }

    this.ready = false;
    this.line = '';
    this.stdinReady = true;
    this.droppedSinceDrain = 0;
    this.startedAt = this.now();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executable, [...this.argv()], {
        shell: false,
        windowsHide: true,
        env: spotterEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.debug(`the spotter would not start: ${(error as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      this.onStdout(child, text);
    });
    // The child's stderr is the native runtime's, not Axon's. It is drained so
    // the pipe cannot fill and stall the spotter, and shown only in debug mode.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      this.debug(`spotter stderr: ${text.trim().slice(0, 200)}`);
    });
    child.on('error', () => {
      this.onExit(child, 'could not be started');
    });
    child.on('exit', (code, signal) => {
      this.onExit(child, `exited with ${signal ?? code ?? 'no status'}`);
    });
    child.stdin.on('error', () => {
      /* the exit handler reports it once */
    });

    this.readyTimer = this.setTimer(() => {
      if (this.child === child && !this.ready) {
        this.debug('the spotter did not finish loading in time');
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }, READY_TIMEOUT_MS);
  }

  private onStdout(child: ChildProcessWithoutNullStreams, text: string): void {
    if (this.child !== child) return;
    this.line += text;
    if (this.line.length > MAX_LINE_BYTES) this.line = this.line.slice(-MAX_LINE_BYTES);
    for (;;) {
      const at = this.line.indexOf('\n');
      if (at < 0) break;
      const line = this.line.slice(0, at).trim();
      this.line = this.line.slice(at + 1);
      if (line !== '') this.onLine(line);
    }
  }

  /**
   * One line from the spotter.
   *
   * Three shapes are understood and everything else is ignored — a child that
   * starts saying something new does not get to be interesting by default.
   */
  private onLine(line: string): void {
    if (line.startsWith('READY ')) {
      this.ready = true;
      if (this.readyTimer) this.clearTimer(this.readyTimer);
      this.readyTimer = null;
      const version = line.slice('READY '.length).trim();
      this.debug(`the local keyword spotter is listening (${version})`);
      this.handlers?.onReady(`${KEYWORD_ENGINE_DETAIL}, runtime ${version.split(' ')[0] ?? '?'}`);
      return;
    }

    if (line.startsWith('WAKE ')) {
      const [, id, start, end, behind] = line.split(/\s+/);
      if (id === undefined) return;
      const number = (raw: string | undefined): number => {
        const value = Number.parseInt(raw ?? '', 10);
        return Number.isFinite(value) ? value : 0;
      };
      this.handlers?.onHit({ id, startMs: number(start), endMs: number(end), behindMs: number(behind) });
      return;
    }

    if (line.startsWith('FOCUS ') || line.startsWith('CONFIG ')) {
      // Diagnostic measurements, from a focus process only. Bounded, and never
      // audio; the one text field is the model's own free decode.
      this.debug(`spotter ${line.slice(0, 600)}`);
      return;
    }

    if (line.startsWith('STATS ')) {
      // The parent's half of the pipeline: bytes waiting in this side's pipe
      // buffer, and frames dropped here because that pipe was full.
      this.debug(
        `spotter ${line.slice(0, 400)} parentQueued=${this.child?.stdin.writableLength ?? 0}B ` +
          `parentDropped=${this.droppedTotal}frames`,
      );
      return;
    }

    if (line.startsWith('ERR ')) {
      this.debug(`the spotter reported ${line.slice('ERR '.length).slice(0, 200)}`);
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, how: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    if (this.readyTimer) this.clearTimer(this.readyTimer);
    this.readyTimer = null;
    if (!this.running) return;

    // A spotter that ran for a minute was working; whatever killed it is a
    // one-off, and its restart should not count against a budget meant for a
    // model that cannot load at all.
    if (this.now() - this.startedAt >= HEALTHY_AFTER_MS) this.attempts = 0;

    this.debug(`the spotter ${how}; restarting`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.running) return;
    const delay = RESTART_DELAYS_MS[this.attempts];
    if (delay === undefined) {
      this.running = false;
      this.handlers?.onFailure('Axon could not keep the wake-word engine running, so it has stopped listening.');
      return;
    }
    this.attempts += 1;
    this.restartCount += 1;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delay);
    if (typeof this.restartTimer?.unref === 'function') this.restartTimer.unref();
  }

  private debug(line: string): void {
    this.handlers?.onDebug?.(line);
  }
}
