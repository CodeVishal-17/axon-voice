/**
 * The orb tells the truth through a whole live conversation.
 *
 * The live smoke run printed `no legal route from EXECUTING to LISTENING;
 * state unchanged` four times. Each one was a moment the microphone had
 * reopened while the orb still showed Axon working — the exact disagreement
 * between what Axon shows and what Axon is doing that the state machine exists
 * to prevent, and the thing an audience watching the orb would notice first.
 *
 * These tests replay the phase sequences a real voice session produces — taken
 * from that run — through the real transition table, and require every hop to
 * be legal. They also hold the two edges that must stay closed, so the fix
 * could not have been made by simply allowing everything.
 */

import { describe, expect, it } from 'vitest';
import { AXON_STATES, isLegalTransition, type AxonState } from '@axon/core';
import { ORB_VISUALS } from '../src/renderer/components/orb/orb-visuals.js';
import { StateDwell } from '../src/renderer/components/orb/state-dwell.js';

/** Every hop in a sequence must be legal (self-hops are no-ops, and skipped). */
function walk(sequence: readonly AxonState[]): void {
  for (let index = 1; index < sequence.length; index += 1) {
    const from = sequence[index - 1]!;
    const to = sequence[index]!;
    if (from === to) continue;
    expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(true);
  }
}

describe('a live conversation, hop by hop', () => {
  it('"Open Calculator." — hear, think, act, answer, listen again', () => {
    walk(['IDLE', 'THINKING', 'LISTENING', 'THINKING', 'EXECUTING', 'SPEAKING', 'LISTENING']);
  });

  it('the reply ends while the tool is still settling — straight back to listening', () => {
    // `reply.done` arrives and the session reopens the microphone; the orb
    // must follow rather than stay on EXECUTING.
    walk(['LISTENING', 'THINKING', 'EXECUTING', 'LISTENING']);
  });

  it('the model finishes thinking without speaking — back to listening', () => {
    walk(['LISTENING', 'THINKING', 'LISTENING']);
  });

  it('the user talks over a running tool', () => {
    walk(['THINKING', 'EXECUTING', 'LISTENING', 'THINKING']);
  });

  it('an approval, answered, then the result spoken', () => {
    walk(['THINKING', 'EXECUTING', 'WAITING_FOR_APPROVAL', 'EXECUTING', 'SPEAKING', 'LISTENING']);
  });

  it('a failure, and the explicit way out of it', () => {
    walk(['EXECUTING', 'ERROR', 'IDLE', 'LISTENING']);
  });
});

describe('the edges that must stay closed', () => {
  it('never acts straight from listening — audio is understood first', () => {
    expect(isLegalTransition('LISTENING', 'EXECUTING')).toBe(false);
  });

  it('never lets the microphone take the screen from an unanswered approval', () => {
    expect(isLegalTransition('WAITING_FOR_APPROVAL', 'LISTENING')).toBe(false);
  });

  it('never slides out of ERROR into work', () => {
    for (const state of AXON_STATES) {
      if (state === 'IDLE') continue;
      expect(isLegalTransition('ERROR', state)).toBe(false);
    }
  });
});

describe('every state has a look', () => {
  it('has an orb visual for each of the seven states', () => {
    for (const state of AXON_STATES) {
      expect(ORB_VISUALS[state], state).toBeDefined();
    }
  });

  it('reserves warm colour for the states that want attention', () => {
    // Blue family while working; amber and red only for approval and error.
    // An audience learns in one approval what the colour change means.
    const warm = (state: AxonState): boolean => ORB_VISUALS[state].accent[0] > ORB_VISUALS[state].accent[2];
    expect(warm('WAITING_FOR_APPROVAL')).toBe(true);
    expect(warm('ERROR')).toBe(true);
    for (const state of ['IDLE', 'LISTENING', 'THINKING', 'EXECUTING', 'SPEAKING'] as const) {
      expect(warm(state), state).toBe(false);
    }
  });
});

/**
 * The orb is held on a state long enough to be seen.
 *
 * FOUND BY USING THE APP. The transitions above are all legal and all true,
 * and a person watching the orb through a whole conversation still reported
 * that it never changed colour. The event log said why:
 *
 *     12:15:07.531  SPEAKING  -> THINKING
 *     12:15:07.533  THINKING  -> EXECUTING     (2 ms later)
 *
 * At the orb's 320 ms time constant, 2 ms moves the colour 0.6% of the way.
 * The state machine was right and the orb was honest; the state simply was
 * never on screen. `StateDwell` holds it — except where holding would be the
 * greater sin.
 */
describe('a state is held long enough to read', () => {
  const at = (ms: number): number => 1_000 + ms;

  it('shows a state that arrives after the dwell immediately', () => {
    const dwell = new StateDwell('IDLE', at(0));
    expect(dwell.request('THINKING', at(400))).toBe('THINKING');
  });

  it('holds the 2 ms THINKING that started this, then moves on', () => {
    const dwell = new StateDwell('SPEAKING', at(0));
    // The real sequence, at the real spacing.
    expect(dwell.request('THINKING', at(2_000))).toBe('THINKING');
    expect(dwell.request('EXECUTING', at(2_002))).toBeNull();
    expect(dwell.state).toBe('THINKING');

    // Still THINKING a quarter of a second later — which is the entire point.
    expect(dwell.due(at(2_200))).toBeNull();
    expect(dwell.due(at(2_290))).toBe('EXECUTING');
  });

  it('never delays a live microphone', () => {
    const dwell = new StateDwell('THINKING', at(0));
    // One millisecond in. Anything else would wait; LISTENING does not.
    expect(dwell.request('LISTENING', at(1))).toBe('LISTENING');
  });

  it('never delays an approval or an error', () => {
    for (const urgent of ['WAITING_FOR_APPROVAL', 'ERROR'] as const) {
      const dwell = new StateDwell('EXECUTING', at(0));
      expect(dwell.request(urgent, at(1))).toBe(urgent);
    }
  });

  it('drops a waiting state when a live microphone pre-empts it', () => {
    const dwell = new StateDwell('SPEAKING', at(0));
    expect(dwell.request('THINKING', at(500))).toBe('THINKING');
    expect(dwell.request('EXECUTING', at(510))).toBeNull();
    expect(dwell.request('LISTENING', at(520))).toBe('LISTENING');
    // EXECUTING is gone, not queued behind LISTENING: it is no longer true.
    expect(dwell.due(at(2_000))).toBeNull();
    expect(dwell.state).toBe('LISTENING');
  });

  it('keeps only the newest waiting state, never a backlog', () => {
    const dwell = new StateDwell('IDLE', at(0));
    expect(dwell.request('THINKING', at(400))).toBe('THINKING');
    expect(dwell.request('EXECUTING', at(410))).toBeNull();
    expect(dwell.request('SPEAKING', at(420))).toBeNull();
    // What is true now, not a replay of what was missed.
    expect(dwell.due(at(700))).toBe('SPEAKING');
    expect(dwell.due(at(1_500))).toBeNull();
  });

  it('does not hold up a return to the state already showing', () => {
    const dwell = new StateDwell('IDLE', at(0));
    expect(dwell.request('IDLE', at(5))).toBeNull();
    expect(dwell.waiting).toBe(false);
  });
});
