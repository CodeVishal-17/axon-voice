/**
 * When page code is allowed to obtain a microphone.
 *
 * THE PROBLEM THE WAKE WORD CREATED.
 *
 * Until now, Axon granted microphone permission for as long as a listening
 * session was open — seconds at a time, bounded by a voice-activity detector.
 * The wake word changes that: it listens for minutes or hours, so the same
 * rule would leave the permission open indefinitely, and a compromised
 * renderer could call `getUserMedia` at any moment and be granted it. Axon's
 * renderer displays text that came from web pages, so "a compromised renderer"
 * is not a hypothetical worth waving away.
 *
 * Relaxing the check to make the feature work would have been weakening a
 * boundary for convenience. This is the opposite: a NARROWER rule than the one
 * it replaces.
 *
 * THE INSIGHT THAT MAKES IT WORK.
 *
 * Chromium checks permission when `getUserMedia` is called, not continuously
 * while a track is live. So the permission only has to be open for the instant
 * the renderer is opening the device — after that, the stream keeps running
 * with the gate shut. That turns "open for the whole session" into "open for
 * the few hundred milliseconds after main asked", which holds however long the
 * wake word listens.
 *
 * The window opens ONLY when main issues a capture command, closes as soon as
 * the renderer reports the device open, and closes on a deadline regardless —
 * so a renderer that never reports, or lies about reporting, cannot hold it.
 */

/**
 * How long a permission window may stay open.
 *
 * Long enough for a slow device to enumerate and start, short enough that it
 * is not a meaningful window of opportunity. Device startup is tens of
 * milliseconds on a working machine; this is generous by two orders of
 * magnitude and still brief.
 */
const WINDOW_MS = 5_000;

export interface MicGateOptions {
  readonly windowMs?: number;
  readonly now?: () => number;
}

export class MicGate {
  private readonly windowMs: number;
  private readonly now: () => number;

  /** The capture main is currently expecting the renderer to open. */
  private pending: string | null = null;
  private openedAt = 0;

  constructor(options: MicGateOptions = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.now = options.now ?? ((): number => Date.now());
  }

  /**
   * Whether `getUserMedia` may succeed right now.
   *
   * The deadline is checked here rather than enforced with a timer, so a
   * stalled event loop cannot leave the gate open: the answer is computed from
   * the clock every time it is asked.
   */
  get open(): boolean {
    if (this.pending === null) return false;
    if (this.now() - this.openedAt > this.windowMs) {
      this.pending = null;
      return false;
    }
    return true;
  }

  /** The capture the gate is open for, or null. For diagnostics only. */
  get expecting(): string | null {
    return this.open ? this.pending : null;
  }

  /**
   * Grant the permission, once.
   *
   * THE GRANT IS SINGLE-USE, and that is what makes the window meaningful
   * rather than merely short. Chromium cannot tell Axon's own capture module
   * from arbitrary page code — both are the same renderer, the same origin —
   * so no handler can distinguish them. What Axon CAN do is make the grant
   * consumable: one capture command permits exactly one `getUserMedia`.
   *
   * The consequence is worth stating. Page code that raced Axon's own capture
   * and called first would win the grant — and Axon's capture would then fail
   * visibly, with the user seeing a microphone error rather than two streams
   * opening quietly. A failure the user can see is a far better outcome than
   * a silent second listener.
   */
  consume(): boolean {
    if (!this.open) return false;
    this.pending = null;
    return true;
  }

  /** Main asked the renderer to open the microphone. */
  expect(captureId: string): void {
    this.pending = captureId;
    this.openedAt = this.now();
  }

  /**
   * The renderer reported, or main asked it to stop.
   *
   * Closes only for the capture the gate is actually open for: a report about
   * some other capture — stale, replayed, or invented by a compromised
   * renderer — must not be able to close a window main just opened, and must
   * not be able to open one either.
   */
  settle(captureId: string): void {
    if (this.pending === captureId) this.pending = null;
  }

  /** Shut the gate unconditionally. Used on shutdown. */
  closeAll(): void {
    this.pending = null;
  }
}
