/**
 * State machine contract tests.
 *
 * The transition table is the safety-relevant part of the state machine: it is
 * what stops Axon presenting itself as acting when it has not understood
 * anything, or as idle while a tool is still running.
 */

import { describe, expect, it } from 'vitest';
import {
  AXON_STATES,
  IllegalTransitionError,
  INITIAL_STATE,
  isAxonState,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  legalTargets,
  type AxonState,
} from '@axon/core';

describe('Axon states', () => {
  it('declares exactly the seven product states', () => {
    expect([...AXON_STATES]).toEqual([
      'IDLE',
      'LISTENING',
      'THINKING',
      'EXECUTING',
      'SPEAKING',
      'WAITING_FOR_APPROVAL',
      'ERROR',
    ]);
  });

  it('starts IDLE', () => {
    expect(INITIAL_STATE).toBe('IDLE');
  });

  it('recognizes its own states and rejects anything else', () => {
    expect(isAxonState('THINKING')).toBe(true);
    expect(isAxonState('thinking')).toBe(false);
    expect(isAxonState('BUSY')).toBe(false);
    expect(isAxonState(null)).toBe(false);
  });
});

describe('legal transitions', () => {
  it.each([
    ['IDLE', 'LISTENING'],
    ['IDLE', 'THINKING'],
    ['LISTENING', 'THINKING'],
    ['THINKING', 'EXECUTING'],
    ['THINKING', 'WAITING_FOR_APPROVAL'],
    ['EXECUTING', 'WAITING_FOR_APPROVAL'],
    ['WAITING_FOR_APPROVAL', 'EXECUTING'],
    ['EXECUTING', 'IDLE'],
    ['SPEAKING', 'IDLE'],
    ['ERROR', 'IDLE'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
  });

  it('allows every state to fail into ERROR', () => {
    for (const state of AXON_STATES) {
      if (state === 'ERROR') continue;
      expect(isLegalTransition(state, 'ERROR')).toBe(true);
    }
  });
});

describe('illegal transitions', () => {
  it('refuses to act without having understood: IDLE -> EXECUTING', () => {
    expect(isLegalTransition('IDLE', 'EXECUTING')).toBe(false);
  });

  it('refuses LISTENING -> EXECUTING', () => {
    expect(isLegalTransition('LISTENING', 'EXECUTING')).toBe(false);
  });

  it('refuses LISTENING -> SPEAKING', () => {
    expect(isLegalTransition('LISTENING', 'SPEAKING')).toBe(false);
  });

  it('refuses IDLE -> WAITING_FOR_APPROVAL (approvals come from tool calls)', () => {
    expect(isLegalTransition('IDLE', 'WAITING_FOR_APPROVAL')).toBe(false);
  });

  it('only lets ERROR leave to IDLE — recovery is always explicit', () => {
    expect(legalTargets('ERROR')).toEqual(['IDLE']);
    for (const state of AXON_STATES) {
      if (state === 'IDLE') continue;
      expect(isLegalTransition('ERROR', state)).toBe(false);
    }
  });

  it('refuses every self-transition', () => {
    for (const state of AXON_STATES) {
      expect(isLegalTransition(state, state)).toBe(false);
    }
  });

  it('never lists an unknown state as a legal target', () => {
    for (const state of AXON_STATES) {
      for (const target of LEGAL_TRANSITIONS[state]) {
        expect(AXON_STATES).toContain(target);
      }
    }
  });
});

describe('IllegalTransitionError', () => {
  it('names both states and the legal alternatives', () => {
    const error = new IllegalTransitionError('IDLE', 'EXECUTING' as AxonState);
    expect(error.from).toBe('IDLE');
    expect(error.to).toBe('EXECUTING');
    expect(error.message).toContain('IDLE -> EXECUTING');
    expect(error.message).toContain('LISTENING');
    expect(error).toBeInstanceOf(Error);
  });
});
