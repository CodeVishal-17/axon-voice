/**
 * How long a state stays on the orb.
 *
 * MEASURED FROM A REAL SESSION. One turn's event log read:
 *
 *     12:15:07.531  SPEAKING  -> THINKING
 *     12:15:07.533  THINKING  -> EXECUTING     (2 ms later)
 *
 * Two milliseconds. The orb eases toward a target with a 320 ms time constant,
 * so in 2 ms its colour travels 0.6% of the way: the violet of THINKING was
 * never drawn, and a person watching reported — correctly — that the orb never
 * changed colour. The states were true and the machine was right; they were
 * simply not on screen long enough to exist.
 *
 * So a state is held for at least `minDwellMs` before the next may replace it.
 * The cost is real: the orb can lag the machine by that much. That is why the
 * exception list is not empty and never should be.
 *
 *   LISTENING             the microphone is open. Nothing the orb shows about
 *                         a live microphone is ever delayed, for any reason.
 *   WAITING_FOR_APPROVAL  it is asking the person for something.
 *   ERROR                 something is wrong, and saying so late is worse.
 *
 * Those pre-empt immediately and discard anything waiting. Everything else is
 * a working state whose only job is to be legible.
 *
 * Only the LATEST waiting state is kept, never a queue: when the hold ends the
 * orb shows what is true now, not a replay of what it missed.
 *
 * PURE. No canvas, no clock of its own — the caller passes the time, which is
 * what makes this testable to the millisecond.
 */

import type { AxonState } from '@axon/core';

/** States whose arrival is never delayed, whatever is on screen. */
export const IMMEDIATE_STATES: ReadonlySet<AxonState> = new Set<AxonState>([
  'LISTENING',
  'WAITING_FOR_APPROVAL',
  'ERROR',
]);

/**
 * The shortest time a state is allowed to be on screen.
 *
 * At the orb's 320 ms time constant the colour covers about 58% of the
 * distance in this long — enough to read as the new colour rather than as a
 * flicker of it.
 */
export const MIN_DWELL_MS = 280;

export class StateDwell {
  private shown: AxonState;
  private shownAt: number;
  private pending: AxonState | null = null;

  constructor(
    initial: AxonState = 'IDLE',
    startedAt = 0,
    private readonly minDwellMs: number = MIN_DWELL_MS,
    private readonly immediate: ReadonlySet<AxonState> = IMMEDIATE_STATES,
  ) {
    this.shown = initial;
    this.shownAt = startedAt;
  }

  /** What the orb is showing right now. */
  get state(): AxonState {
    return this.shown;
  }

  /** True while a state is waiting for the current one's dwell to end. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /**
   * The machine moved. Returns the state to show now, or null to keep the
   * current one for a little longer.
   */
  request(state: AxonState, now: number): AxonState | null {
    if (state === this.shown && this.pending === null) return null;

    if (this.immediate.has(state)) {
      this.pending = null;
      return this.show(state, now);
    }

    if (now - this.shownAt >= this.minDwellMs) return this.show(state, now);

    // Too soon. Remember only the newest; an older waiting state is already
    // out of date and showing it would be showing the past.
    this.pending = state === this.shown ? null : state;
    return null;
  }

  /**
   * Time passed. Returns a state whose turn has come, or null.
   *
   * Called every frame rather than from a timer, so there is nothing
   * outstanding for a stopped renderer to cancel.
   */
  due(now: number): AxonState | null {
    if (this.pending === null) return null;
    if (now - this.shownAt < this.minDwellMs) return null;
    const next = this.pending;
    this.pending = null;
    return this.show(next, now);
  }

  private show(state: AxonState, now: number): AxonState {
    this.shown = state;
    this.shownAt = now;
    return state;
  }
}
