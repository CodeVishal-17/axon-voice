/**
 * The orb's visual vocabulary.
 *
 * One parameter set per Axon state. The renderer never branches on state — it
 * eases its live parameters toward whichever set is current, so every state
 * change is a transition rather than a cut. Adding a state means adding a row
 * here, not adding an `if` to the draw loop.
 *
 * Palette discipline: the working states (idle, listening, thinking,
 * executing, speaking) all sit in one cool family and differ mostly in
 * luminance and motion. Warm amber and red are reserved for the two states
 * that actually want the user's attention. Colour therefore means something
 * instead of being decoration, and the interface stays calm while Axon works.
 */

import type { AxonState } from '@axon/core';

export type Rgb = readonly [number, number, number];

export interface OrbVisual {
  /** Dominant hue for rim, rings and glow. */
  readonly accent: Rgb;
  /** Inner light at the core's centre. Kept near-white for depth. */
  readonly core: Rgb;
  /** Core radius as a fraction of the layout radius. */
  readonly radius: number;
  /** Amplitude and rate of the slow breathing scale. */
  readonly breathAmplitude: number;
  readonly breathRate: number;
  /** Ambient glow strength, 0..1. */
  readonly halo: number;
  /** Expanding rings: how many are alive at once, and how fast they travel. */
  readonly ringDensity: number;
  readonly ringSpeed: number;
  /** How far rings react to the amplitude source, 0..1. */
  readonly ringReactivity: number;
  /** Internal rotating arcs — the visual signature of reasoning. */
  readonly flow: number;
  readonly flowRate: number;
  /** Radial waveform deformation of the core's edge. */
  readonly wave: number;
  /** How much of `wave` comes from live amplitude rather than intrinsic motion. */
  readonly waveReactivity: number;
  /** Held, non-advancing pulse — "stopped and waiting", not "working". */
  readonly hold: number;
  /** Positional instability. Only the error state uses it. */
  readonly unrest: number;
  /** Overall brightness multiplier. */
  readonly luminance: number;
}

const COOL_CORE: Rgb = [232, 240, 252];
const WARM_CORE: Rgb = [255, 243, 224];

export const ORB_VISUALS: Readonly<Record<AxonState, OrbVisual>> = Object.freeze({
  /** Asleep but alive. Almost nothing moves; the breath is the only signal. */
  IDLE: {
    accent: [124, 140, 168],
    core: COOL_CORE,
    radius: 0.72,
    breathAmplitude: 0.022,
    breathRate: 0.26,
    halo: 0.3,
    ringDensity: 0,
    ringSpeed: 0.18,
    ringReactivity: 0,
    flow: 0,
    flowRate: 0.05,
    wave: 0.1,
    waveReactivity: 0,
    hold: 0,
    unrest: 0,
    luminance: 0.72,
  },

  /** Open and attentive. Rings travel outward; amplitude pushes them further. */
  LISTENING: {
    accent: [99, 164, 255],
    core: COOL_CORE,
    radius: 0.74,
    breathAmplitude: 0.03,
    breathRate: 0.5,
    halo: 0.62,
    ringDensity: 3,
    ringSpeed: 0.42,
    ringReactivity: 1,
    flow: 0.1,
    flowRate: 0.12,
    wave: 0.18,
    waveReactivity: 0.9,
    hold: 0,
    unrest: 0,
    luminance: 1,
  },

  /** Interior motion, still surface. Reasoning looks like circulation. */
  THINKING: {
    accent: [139, 140, 255],
    core: COOL_CORE,
    radius: 0.71,
    breathAmplitude: 0.014,
    breathRate: 0.34,
    halo: 0.5,
    ringDensity: 0,
    ringSpeed: 0.2,
    ringReactivity: 0,
    flow: 1,
    flowRate: 0.36,
    wave: 0.12,
    waveReactivity: 0,
    hold: 0,
    unrest: 0,
    luminance: 0.9,
  },

  /** Directed and quick. The flow tightens and speeds up; one ring pushes out
   *  per action, so the motion reads as progress rather than as thought. */
  EXECUTING: {
    accent: [79, 209, 197],
    core: COOL_CORE,
    radius: 0.69,
    breathAmplitude: 0.01,
    breathRate: 0.9,
    halo: 0.7,
    ringDensity: 1.4,
    ringSpeed: 0.85,
    ringReactivity: 0.2,
    flow: 0.85,
    flowRate: 1.15,
    wave: 0.14,
    waveReactivity: 0,
    hold: 0,
    unrest: 0,
    luminance: 1.05,
  },

  /** The edge of the core becomes the waveform. Not bars — a deformed sphere,
   *  so the orb is speaking rather than hosting a visualiser. */
  SPEAKING: {
    accent: [127, 217, 255],
    core: COOL_CORE,
    radius: 0.7,
    breathAmplitude: 0.012,
    breathRate: 0.6,
    halo: 0.66,
    ringDensity: 0.6,
    ringSpeed: 0.5,
    ringReactivity: 0.5,
    flow: 0.25,
    flowRate: 0.3,
    wave: 1,
    waveReactivity: 0.75,
    hold: 0,
    unrest: 0,
    luminance: 1,
  },

  /** Stopped. The breath is gone, one ring hangs at a fixed radius and pulses
   *  in place, and the core dims. Nothing advances — that is the message. */
  WAITING_FOR_APPROVAL: {
    accent: [224, 163, 86],
    core: WARM_CORE,
    radius: 0.66,
    breathAmplitude: 0,
    breathRate: 0,
    halo: 0.48,
    ringDensity: 0,
    ringSpeed: 0,
    ringReactivity: 0,
    flow: 0,
    flowRate: 0,
    wave: 0,
    waveReactivity: 0,
    hold: 1,
    unrest: 0,
    luminance: 0.82,
  },

  /** Destabilised. Slight positional unrest and a broken rim; still restrained,
   *  because an alarm the user cannot switch off is not information. */
  ERROR: {
    accent: [224, 87, 91],
    core: [255, 226, 226],
    radius: 0.68,
    breathAmplitude: 0.008,
    breathRate: 1.6,
    halo: 0.5,
    ringDensity: 0,
    ringSpeed: 0,
    ringReactivity: 0,
    flow: 0.2,
    flowRate: 0.1,
    wave: 0.3,
    waveReactivity: 0,
    hold: 0.35,
    unrest: 1,
    luminance: 0.88,
  },
});

export function visualFor(state: AxonState): OrbVisual {
  return ORB_VISUALS[state];
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

export function rgba(color: Rgb, alpha: number): string {
  const r = Math.round(color[0]);
  const g = Math.round(color[1]);
  const b = Math.round(color[2]);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/** Ease every numeric field of an OrbVisual toward a target. */
export function easeVisual(current: OrbVisual, target: OrbVisual, t: number): OrbVisual {
  return {
    accent: lerpRgb(current.accent, target.accent, t),
    core: lerpRgb(current.core, target.core, t),
    radius: lerp(current.radius, target.radius, t),
    breathAmplitude: lerp(current.breathAmplitude, target.breathAmplitude, t),
    breathRate: lerp(current.breathRate, target.breathRate, t),
    halo: lerp(current.halo, target.halo, t),
    ringDensity: lerp(current.ringDensity, target.ringDensity, t),
    ringSpeed: lerp(current.ringSpeed, target.ringSpeed, t),
    ringReactivity: lerp(current.ringReactivity, target.ringReactivity, t),
    flow: lerp(current.flow, target.flow, t),
    flowRate: lerp(current.flowRate, target.flowRate, t),
    wave: lerp(current.wave, target.wave, t),
    waveReactivity: lerp(current.waveReactivity, target.waveReactivity, t),
    hold: lerp(current.hold, target.hold, t),
    unrest: lerp(current.unrest, target.unrest, t),
    luminance: lerp(current.luminance, target.luminance, t),
  };
}
