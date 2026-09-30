/**
 * The persistent native accessibility engine, from Axon's side (Phase 4B).
 *
 * WHY PERSISTENT. Every read used to start PowerShell and compile its program
 * again — measured at 1–1.5 s before the first control was looked at. The
 * engine (`uia-program.ts`) now stays up while Axon is using it: the first
 * request pays the start (about 1.3 s), later ones do not (a ping answers in
 * about 2 ms).
 *
 * THE CHANNEL. The child's stdin and stdout: anonymous pipes created for this
 * one child. No port, no pipe name, nothing on disk — no other process can
 * reach it, so there is nothing to authenticate against. One JSON object per
 * line each way, answered in order.
 *
 * WHAT CAN BE SENT. Exactly the requests built in `windows-desktop.ts` from
 * Axon's own records: `ping`, `observe`, `act`. Nothing a model wrote is ever
 * forwarded as a request; the engine re-validates every field regardless.
 *
 * FAILURE IS ALWAYS CONTAINED:
 *
 *   one at a time   requests are queued and sent strictly one after another,
 *                   because the engine is one COM thread
 *   timeout         the engine is ENDED (it may be stuck inside an unresponsive
 *                   application's accessibility provider) and the request fails
 *                   as TIMEOUT; the next request starts a fresh engine
 *   crash           everything in flight fails; the next request restarts it
 *   crash loop      three exits inside a minute and Axon stops restarting it
 *                   for a while, rather than spawning PowerShell in a loop
 *   idle            after two quiet minutes it is ended, so it runs only while
 *                   Axon is actually reading or acting on the desktop
 *   oversize        an answer beyond the bound ends it; nothing unbounded is
 *                   buffered
 */

import { ToolError } from '@axon/core';

/** The child process, as far as this module needs it. Injected, so tests use a fake. */
export interface HostProcess {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export interface UiaHostOptions {
  readonly start: () => HostProcess;
  readonly idleMs?: number;
  /** Extra time the first request after a start is given, for PowerShell to start and compile. */
  readonly startupAllowanceMs?: number;
  readonly now?: () => number;
}

/** A request, as the engine accepts it. Built only by `windows-desktop.ts`. */
export type UiaRequest =
  | { readonly op: 'ping' }
  | {
      readonly op: 'observe';
      readonly window: string;
      readonly skip: number;
      readonly max: number;
      readonly scope?: Readonly<Record<string, string>>;
    }
  | { readonly op: 'act'; readonly window: string; readonly target: Readonly<Record<string, string>> }
  | { readonly op: 'page'; readonly window: string; readonly max: number };

/** The longest answer accepted: 60 controls with bounded names are far below this. */
export const MAX_ANSWER_CHARS = 2 * 1024 * 1024;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_COOLDOWN_MS = 30_000;

interface Pending {
  readonly id: string;
  readonly line: string;
  readonly timeoutMs: number;
  readonly resolve: (answer: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export class UiaHost {
  private readonly start: () => HostProcess;
  private readonly idleMs: number;
  private readonly startupAllowanceMs: number;
  private readonly now: () => number;

  private process: HostProcess | null = null;
  private fresh = false;
  private readonly queue: Pending[] = [];
  private inFlight: (Pending & { timer: ReturnType<typeof setTimeout> }) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private exits: number[] = [];
  private coolingUntil = 0;

  constructor(options: UiaHostOptions) {
    this.start = options.start;
    this.idleMs = options.idleMs ?? 120_000;
    this.startupAllowanceMs = options.startupAllowanceMs ?? 5_000;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Whether an engine process is currently running. For diagnostics and tests. */
  get running(): boolean {
    return this.process !== null;
  }

  /**
   * Send one request and wait for its answer.
   *
   * Resolves with the engine's answer object, including an `error` field when
   * the engine refused or failed — the caller maps those. Rejects only when the
   * channel itself failed: TIMEOUT, a crash, a malformed answer.
   */
  request(request: UiaRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = `r${this.nextId++}`;
    const line = JSON.stringify({ id, ...request });
    return new Promise((resolve, reject) => {
      this.queue.push({ id, line, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** End the engine now. Anything waiting fails. Called when Axon shuts down. */
  dispose(): void {
    this.stop(new Error('The accessibility engine was shut down.'));
    for (const waiting of this.queue.splice(0)) waiting.reject(new Error('The accessibility engine was shut down.'));
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;
    if (this.now() < this.coolingUntil) {
      for (const waiting of this.queue.splice(0)) {
        waiting.reject(new ToolError('UNSUPPORTED', 'The accessibility engine keeps stopping, so Axon has paused it for a moment.'));
      }
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.clearIdle();

    let process: HostProcess;
    try {
      process = this.ensure();
    } catch {
      next.reject(new ToolError('UNSUPPORTED', 'The accessibility engine could not be started.'));
      this.pump();
      return;
    }

    const allowance = this.fresh ? this.startupAllowanceMs : 0;
    this.fresh = false;
    const timer = setTimeout(() => {
      // Stuck, most likely inside an application that stopped answering. The
      // engine is ended rather than trusted to recover; the next request
      // starts a clean one.
      this.stop(null);
      next.reject(new ToolError('TIMEOUT', 'Reading the screen did not finish in time.'));
      this.pump();
    }, next.timeoutMs + allowance);
    if (typeof timer.unref === 'function') timer.unref();
    this.inFlight = { ...next, timer };
    process.write(`${next.line}\n`);
  }

  private ensure(): HostProcess {
    if (this.process) return this.process;
    const process = this.start();
    this.process = process;
    this.fresh = true;
    process.onLine((line) => {
      if (this.process === process) this.answer(line);
    });
    process.onExit(() => {
      if (this.process !== process) return;
      this.process = null;
      this.recordExit();
      const current = this.inFlight;
      this.inFlight = null;
      if (current) {
        clearTimeout(current.timer);
        current.reject(new Error('The accessibility engine stopped unexpectedly.'));
      }
      this.pump();
    });
    return process;
  }

  private answer(line: string): void {
    const current = this.inFlight;
    if (!current) return; // Nothing asked: an answer to nothing is ignored, never matched to a later request.
    if (line.length > MAX_ANSWER_CHARS) {
      this.inFlight = null;
      clearTimeout(current.timer);
      this.stop(null);
      current.reject(new Error('The accessibility engine answered with more than Axon accepts.'));
      this.pump();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    const answer = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    // Answers come back in order, one per request. One that is not an object,
    // or is for a different request, means the channel is out of step — the
    // engine is ended rather than guessed at.
    if (!answer || (answer.id !== current.id && answer.id !== null)) {
      this.inFlight = null;
      clearTimeout(current.timer);
      this.stop(null);
      current.reject(new Error('The accessibility engine gave an answer Axon could not match to its question.'));
      this.pump();
      return;
    }
    this.inFlight = null;
    clearTimeout(current.timer);
    current.resolve(answer);
    this.armIdle();
    this.pump();
  }

  private stop(reason: Error | null): void {
    const process = this.process;
    this.process = null;
    const current = this.inFlight;
    this.inFlight = null;
    if (current) {
      clearTimeout(current.timer);
      if (reason) current.reject(reason);
    }
    this.clearIdle();
    if (process) {
      try {
        process.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private recordExit(): void {
    const now = this.now();
    this.exits = [...this.exits.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.exits.length >= CRASH_LIMIT) {
      this.coolingUntil = now + CRASH_COOLDOWN_MS;
      this.exits = [];
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.queue.length > 0) return;
    this.idleTimer = setTimeout(() => this.stop(null), this.idleMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
