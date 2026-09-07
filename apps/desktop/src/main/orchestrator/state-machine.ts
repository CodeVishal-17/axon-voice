/**
 * The authoritative Axon state machine.
 *
 * It lives in the main process and nowhere else. The renderer is told what the
 * state is; it never decides. Transitions are validated against the table in
 * @axon/core, and an illegal transition is refused rather than clamped to
 * something plausible — a machine that quietly repairs bad input teaches
 * callers that bad input is fine.
 */

import {
  IllegalTransitionError,
  INITIAL_STATE,
  isLegalTransition,
  legalTargets,
  type AxonState,
} from '@axon/core';

export interface StateChange {
  readonly from: AxonState;
  readonly to: AxonState;
  readonly reason: string;
}

export interface TransitionOutcome {
  readonly accepted: boolean;
  readonly state: AxonState;
  readonly error: string | null;
}

export class AxonStateMachine {
  private current: AxonState;
  private readonly onChange: (change: StateChange) => void;

  constructor(onChange: (change: StateChange) => void, initial: AxonState = INITIAL_STATE) {
    this.current = initial;
    this.onChange = onChange;
  }

  get state(): AxonState {
    return this.current;
  }

  canTransition(to: AxonState): boolean {
    return isLegalTransition(this.current, to);
  }

  legalTargets(): readonly AxonState[] {
    return legalTargets(this.current);
  }

  /** Move, or throw. Used internally where an illegal move is a bug. */
  transition(to: AxonState, reason: string): void {
    const from = this.current;
    if (!isLegalTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }
    this.current = to;
    this.onChange({ from, to, reason });
  }

  /**
   * Move if legal, report if not.
   *
   * Used for transitions proposed from outside the main process (the dev
   * console) and for opportunistic moves where the machine may legitimately
   * already be elsewhere.
   */
  tryTransition(to: AxonState, reason: string): TransitionOutcome {
    try {
      this.transition(to, reason);
      return { accepted: true, state: this.current, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { accepted: false, state: this.current, error: message };
    }
  }
}
