/**
 * The Axon interaction state machine.
 *
 * These seven states are the product's vocabulary: the UI renders them, the
 * orb animates them, and the orchestrator in the main process owns them.
 *
 * The transition table is deliberately explicit rather than permissive. An
 * agent that can slide from any state into any other state cannot be reasoned
 * about, and a UI driven by such a machine cannot be trusted to reflect what
 * the system is really doing. Self-transitions are illegal: re-entering a
 * state is a no-op that would emit a misleading STATE_CHANGED event.
 */

export const AXON_STATES = [
  'IDLE',
  'LISTENING',
  'THINKING',
  'EXECUTING',
  'SPEAKING',
  'WAITING_FOR_APPROVAL',
  'ERROR',
] as const;

export type AxonState = (typeof AXON_STATES)[number];

export const INITIAL_STATE: AxonState = 'IDLE';

/**
 * Legal successor states, keyed by current state.
 *
 * Notes on the shape of this graph:
 * - ERROR is reachable from everywhere (failure can happen at any point) but
 *   leaves only to IDLE — recovery is always an explicit reset, never a
 *   silent slide back into work.
 * - WAITING_FOR_APPROVAL is reachable only from EXECUTING and THINKING,
 *   because an approval is always raised by a pending tool call.
 * - LISTENING cannot jump straight to EXECUTING: audio must be understood
 *   (THINKING) before anything can act. That is the direction that matters,
 *   and it stays forbidden.
 * - THINKING and EXECUTING CAN return to LISTENING, and must. In a live voice
 *   session the microphone reopens the moment the model's turn ends, and a
 *   user can start talking over a tool that is still running. Without these
 *   two edges the machine refused the move and left the state alone — so the
 *   orb sat on "working" with the microphone open, which is the single thing
 *   this state machine exists to prevent. It was visible in the live smoke
 *   run as `no legal route from EXECUTING to LISTENING`, four times.
 * - WAITING_FOR_APPROVAL deliberately has NO edge to LISTENING. A pending
 *   approval is the more important thing on screen, and it stays on screen
 *   until somebody answers it.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<AxonState, readonly AxonState[]>> = Object.freeze({
  IDLE: ['LISTENING', 'THINKING', 'ERROR'],
  LISTENING: ['THINKING', 'IDLE', 'ERROR'],
  THINKING: ['EXECUTING', 'SPEAKING', 'WAITING_FOR_APPROVAL', 'LISTENING', 'IDLE', 'ERROR'],
  EXECUTING: ['THINKING', 'WAITING_FOR_APPROVAL', 'SPEAKING', 'LISTENING', 'IDLE', 'ERROR'],
  WAITING_FOR_APPROVAL: ['EXECUTING', 'THINKING', 'IDLE', 'ERROR'],
  SPEAKING: ['IDLE', 'LISTENING', 'THINKING', 'ERROR'],
  ERROR: ['IDLE'],
});

export function isAxonState(value: unknown): value is AxonState {
  return typeof value === 'string' && (AXON_STATES as readonly string[]).includes(value);
}

export function legalTargets(from: AxonState): readonly AxonState[] {
  return LEGAL_TRANSITIONS[from];
}

export function isLegalTransition(from: AxonState, to: AxonState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: AxonState;
  readonly to: AxonState;

  constructor(from: AxonState, to: AxonState) {
    super(
      `Illegal Axon state transition ${from} -> ${to}. ` +
        `Legal targets from ${from}: ${LEGAL_TRANSITIONS[from].join(', ') || '(none)'}.`,
    );
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}
