/**
 * One colour family per state.
 *
 * The orb, the two side auras and every accent in both windows take their
 * colour from here, so they can never disagree about what Axon is doing. The
 * bright value is for light itself — glow, rings, the auras. The ink value is
 * for text and fine lines, deepened on the light theme where the bright value
 * would not be readable.
 *
 * Friendly, not neon: saturated enough to be happy, never pure primaries. Warm
 * hues are reserved for the two states that want the user's attention.
 */

import type { AxonState } from '@axon/core';
import type { Theme } from './theme.js';

export type StateRgb = readonly [number, number, number];

export const STATE_RGB: Readonly<Record<AxonState, StateRgb>> = Object.freeze({
  IDLE: [150, 166, 198],
  LISTENING: [74, 150, 255],
  THINKING: [150, 126, 255],
  EXECUTING: [34, 206, 188],
  SPEAKING: [96, 190, 255],
  WAITING_FOR_APPROVAL: [255, 166, 72],
  ERROR: [244, 104, 116],
});

const INK_ON_LIGHT: Readonly<Record<AxonState, StateRgb>> = Object.freeze({
  IDLE: [88, 102, 132],
  LISTENING: [28, 108, 222],
  THINKING: [102, 76, 220],
  EXECUTING: [8, 134, 120],
  SPEAKING: [20, 124, 192],
  WAITING_FOR_APPROVAL: [172, 96, 10],
  ERROR: [192, 50, 64],
});

const asVar = ([r, g, b]: StateRgb): string => `${r} ${g} ${b}`;

/** The state's light, as `r g b` for `rgb(var(--state-rgb) / alpha)`. */
export function stateRgb(state: AxonState): string {
  return asVar(STATE_RGB[state]);
}

/** The state's ink for text on the given theme, as `r g b`. */
export function stateInk(state: AxonState, theme: Theme): string {
  return asVar(theme === 'light' ? INK_ON_LIGHT[state] : STATE_RGB[state]);
}

/** Both, as the custom properties a surface's root carries. */
export function stateStyle(state: AxonState, theme: Theme): Record<'--state-rgb' | '--state-ink', string> {
  return { '--state-rgb': stateRgb(state), '--state-ink': stateInk(state, theme) };
}
