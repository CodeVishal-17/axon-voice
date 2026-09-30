/**
 * The overlay's presentation rules: one colour family per state, and what the
 * orb does when clicked. Pure, so they are the same in the panel and the
 * overlay by construction.
 */

import { describe, expect, it } from 'vitest';
import { AXON_STATES, type AxonState } from '@axon/core';
import { STATE_RGB, stateInk, stateRgb, stateStyle } from '../src/renderer/state/state-colors.js';
import { orbActionFor } from '../src/renderer/state/orb-action.js';
import { ORB_VISUALS } from '../src/renderer/components/orb/orb-visuals.js';

describe('the state colour system', () => {
  it('gives every state a colour, as a CSS rgb triple', () => {
    for (const state of AXON_STATES) {
      expect(stateRgb(state)).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      expect(stateInk(state, 'light')).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it('is the orb’s colour, so the orb and the auras cannot disagree', () => {
    for (const state of AXON_STATES) expect(ORB_VISUALS[state].accent).toEqual(STATE_RGB[state]);
  });

  it('keeps warm colour for the states that want attention', () => {
    const warm = (state: AxonState): boolean => (STATE_RGB[state][0] ?? 0) > (STATE_RGB[state][2] ?? 0);
    expect(warm('WAITING_FOR_APPROVAL')).toBe(true);
    expect(warm('ERROR')).toBe(true);
    for (const state of ['IDLE', 'LISTENING', 'THINKING', 'EXECUTING', 'SPEAKING'] as const) expect(warm(state)).toBe(false);
  });

  it('deepens the ink on the light theme, and uses the light itself on dark', () => {
    expect(stateInk('LISTENING', 'dark')).toBe(stateRgb('LISTENING'));
    expect(stateInk('LISTENING', 'light')).not.toBe(stateRgb('LISTENING'));
    expect(stateStyle('ERROR', 'dark')).toEqual({ '--state-rgb': stateRgb('ERROR'), '--state-ink': stateRgb('ERROR') });
  });
});

describe('what clicking the orb does', () => {
  const base = {
    state: 'IDLE' as AxonState,
    voiceActive: false,
    voiceAvailable: true,
    listeningAvailable: true,
    approvalPending: false,
  };

  it('ends a conversation that is open', () => {
    expect(orbActionFor({ ...base, voiceActive: true, state: 'LISTENING' })?.kind).toBe('end-conversation');
  });

  it('stops listening or speaking', () => {
    expect(orbActionFor({ ...base, state: 'LISTENING' })?.kind).toBe('stop-listening');
    expect(orbActionFor({ ...base, state: 'SPEAKING' })?.kind).toBe('stop-speaking');
  });

  it('does nothing mid-task or while an approval waits', () => {
    for (const state of ['THINKING', 'EXECUTING', 'WAITING_FOR_APPROVAL'] as const) {
      expect(orbActionFor({ ...base, state }), state).toBeNull();
    }
    expect(orbActionFor({ ...base, voiceActive: true, approvalPending: true })).toBeNull();
  });

  it('prefers a conversation, falls back to push-to-talk, and admits when it can do neither', () => {
    expect(orbActionFor(base)?.kind).toBe('talk');
    expect(orbActionFor({ ...base, voiceAvailable: false })?.kind).toBe('listen');
    expect(orbActionFor({ ...base, voiceAvailable: false, listeningAvailable: false })).toBeNull();
  });
});
