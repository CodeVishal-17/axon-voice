/**
 * The Axon orb renderer.
 *
 * A plain TypeScript class that owns a canvas and an animation loop. It is not
 * a React component and knows nothing about React: it is handed an Axon state,
 * an amplitude source and a theme, and it draws. The animation is an engine
 * driven by the state machine, not a pile of effects inside a component.
 *
 * How it works:
 *
 * - One draw path. State does not select a branch; it selects a parameter set
 *   (`orb-visuals.ts`) which the renderer eases toward, so every change of
 *   state is a physical transition rather than a cut.
 *
 * - The silhouette is a harmonic deformation of a circle. Three low harmonics
 *   at incommensurate speeds never visibly repeat. In SPEAKING the same
 *   function carries the real voice amplitude, so the orb speaks rather than
 *   hosting a visualiser; in LISTENING the rings carry the microphone.
 *
 * - Depth comes from light, not decoration: a slow inner nebula, a pair of
 *   counter-rotating conic gradients for thought, a travelling arc for action,
 *   a held ring for approval, and a specular highlight. No particles, no
 *   sprites — the look is meant to feel expensive, not busy.
 *
 * - It respects `prefers-reduced-motion`: motion slows to a crawl, the
 *   travelling rings stop, and error unrest is removed. The state is never
 *   carried by motion alone — the window says it in words as well.
 *
 * Everything is time-based, so behaviour is the same at 60Hz and 144Hz.
 */

import type { AxonState } from '@axon/core';
import { easeVisual, rgba, visualFor, type OrbVisual, type Rgb } from './orb-visuals.js';
import { StateDwell } from './state-dwell.js';
import { SilentAmplitudeSource, type AmplitudeSource } from './amplitude.js';

export type OrbTheme = 'dark' | 'light';

/** Time constant for parameter easing. Larger = more languid transitions. */
const TRANSITION_TAU = 0.32;


/** Silhouette resolution. 180 samples is smooth at any size we render. */
const OUTLINE_SAMPLES = 180;

function shade(color: Rgb, factor: number): Rgb {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Darker, keeping hue and saturation.
 *
 * The light theme needs a deeper orb to stand out from a bright ground. A
 * plain multiply does that by mixing in black, which turns the approval amber
 * into brown and dulls every state; lowering lightness in HSL keeps amber
 * orange and blue blue.
 */
function deepen(color: Rgb, factor: number): Rgb {
  const r = color[0] / 255;
  const g = color[1] / 255;
  const b = color[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return shade(color, factor);
  const lightness = (max + min) / 2;
  const saturation = Math.min(1, delta / (1 - Math.abs(2 * lightness - 1)));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;

  const nextLightness = lightness * factor;
  const chroma = (1 - Math.abs(2 * nextLightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = nextLightness - chroma / 2;
  const [r1, g1, b1] =
    hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

export class OrbRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private amplitude: AmplitudeSource;
  private target: OrbVisual;
  private live: OrbVisual;
  private theme: OrbTheme = 'dark';
  private reducedMotion = false;
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
  };

  private frameHandle: number | null = null;
  private lastFrameAt = 0;

  /** Holds a state on screen long enough to be seen. See `state-dwell.ts`. */
  private readonly dwell = new StateDwell();

  /** Independent clocks, so speeding up one motion never resets another. */
  private clock = 0;
  private ringPhase = 0;
  private flowPhase = 0;
  private orbitPhase = 0;
  private unrestSeed = 0;

  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, amplitude: AmplitudeSource = new SilentAmplitudeSource()) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Could not acquire a 2D canvas context for the orb.');

    this.canvas = canvas;
    this.ctx = ctx;
    this.amplitude = amplitude;
    this.target = visualFor('IDLE');
    this.live = this.target;

    this.motionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.reducedMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotionChange);

    this.resize();
  }

  /**
   * The state to show.
   *
   * Handed to `StateDwell`, which decides whether it goes on screen now or
   * waits for the current state to have been visible long enough to read. The
   * reasoning, and the states that are never delayed, are documented there.
   */
  setState(state: AxonState): void {
    const show = this.dwell.request(state, this.clockNow());
    if (show !== null) this.target = visualFor(show);
  }

  private clockNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  setAmplitudeSource(source: AmplitudeSource): void {
    this.amplitude = source;
  }

  setTheme(theme: OrbTheme): void {
    this.theme = theme;
  }

  /** Match the backing store to the element's CSS size and pixel ratio. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    if (width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.lastFrameAt = performance.now();
    const tick = (now: number): void => {
      this.frameHandle = requestAnimationFrame(tick);
      this.step(now);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
  }

  // --- loop --------------------------------------------------------------

  private step(now: number): void {
    // Clamp so a backgrounded window returning after minutes does not advance
    // every clock by that whole gap in a single frame.
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.05);
    this.lastFrameAt = now;

    // A state that arrived during another's dwell takes over once that dwell
    // has been served.
    const due = this.dwell.due(now);
    if (due !== null) this.target = visualFor(due);

    const ease = 1 - Math.exp(-dt / TRANSITION_TAU);
    this.live = easeVisual(this.live, this.target, ease);

    const level = Math.max(0, Math.min(1, this.amplitude.level()));
    const motion = this.reducedMotion ? 0.25 : 1;

    this.clock += dt * motion;
    this.ringPhase += dt * this.live.ringSpeed * (1 + level * 0.5) * motion;
    this.flowPhase += dt * this.live.flowRate * motion;
    this.orbitPhase += dt * (0.42 + this.live.orbit * 0.38) * motion;
    this.unrestSeed += dt * motion;

    this.draw(level);
  }

  private draw(level: number): void {
    const { ctx, width, height, live } = this;
    ctx.clearRect(0, 0, width, height);

    // The core is sized so everything drawn around it — the halo at ~2.5x and
    // the outermost ring at ~1.9x — reaches zero alpha inside the canvas, so
    // no faint square is painted at the element's edges.
    const layoutRadius = (Math.min(width, height) * 0.5) / 1.85;
    const breath = live.breathAmplitude * Math.sin(this.clock * live.breathRate * Math.PI * 2);
    const hold = live.hold > 0 ? 1 + 0.012 * live.hold * Math.sin(this.clock * 1.1) : 1;
    const radius = layoutRadius * live.radius * (1 + breath) * hold;

    // Only ERROR moves the orb off centre, by a couple of pixels — enough to
    // read as instability, not enough to look broken. Never with reduced motion.
    const drift = this.reducedMotion ? 0 : live.unrest * 2.2;
    const cx = width / 2 + Math.sin(this.unrestSeed * 9.1) * drift;
    const cy = height / 2 + Math.cos(this.unrestSeed * 7.7) * drift;

    if (this.theme === 'light') this.drawGroundShadow(cx, cy, radius);
    this.drawHalo(cx, cy, radius, level);
    if (!this.reducedMotion) this.drawExpandingRings(cx, cy, radius, level);
    this.drawHoldRing(cx, cy, radius);

    const outline = this.buildOutline(cx, cy, radius, level);
    this.drawBody(outline, cx, cy, radius);
    this.drawNebula(outline, cx, cy, radius);
    this.drawInterior(outline, cx, cy, radius);
    this.drawRim(outline, radius);
    this.drawSpecular(cx, cy, radius);
    this.drawOrbit(cx, cy, radius);
  }

  // --- palette -----------------------------------------------------------

  /** The accent as it should read on the current background. */
  private accent(): Rgb {
    return this.theme === 'light' ? deepen(this.live.accent, 0.88) : this.live.accent;
  }

  // --- layers ------------------------------------------------------------

  /** Light theme only: a soft contact shadow, so the orb sits on the page. */
  private drawGroundShadow(cx: number, cy: number, radius: number): void {
    const { ctx } = this;
    const y = cy + radius * 1.18;
    const gradient = ctx.createRadialGradient(cx, y, 0, cx, y, radius * 0.95);
    gradient.addColorStop(0, 'rgba(40, 36, 30, 0.14)');
    gradient.addColorStop(1, 'rgba(40, 36, 30, 0)');
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(1, 0.22);
    ctx.translate(-cx, -y);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, y, radius * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHalo(cx: number, cy: number, radius: number, level: number): void {
    const { ctx, live } = this;
    // Approval breathes its halo slowly, warm: calm, but plainly waiting.
    const waiting = live.hold > 0 ? 0.88 + 0.22 * live.hold * (0.5 + 0.5 * Math.sin(this.clock * 1.6)) : 1;
    const themeFactor = this.theme === 'light' ? 0.6 : 1;
    const strength = live.halo * live.luminance * (0.85 + level * 0.35) * waiting * themeFactor;
    if (strength <= 0.01) return;

    const accent = this.accent();
    const outer = radius * (2.5 + level * 0.35);
    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, outer);
    gradient.addColorStop(0, rgba(accent, 0.18 * strength));
    gradient.addColorStop(0.42, rgba(accent, 0.065 * strength));
    gradient.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawExpandingRings(cx: number, cy: number, radius: number, level: number): void {
    const { ctx, live } = this;
    const count = Math.round(live.ringDensity);
    if (count < 1 || live.ringDensity < 0.15) return;

    const accent = this.accent();
    const reach = 1.35 + level * live.ringReactivity * 0.85;
    for (let i = 0; i < count; i += 1) {
      const progress = (this.ringPhase + i / count) % 1;
      const ringRadius = radius * (1 + progress * reach);
      // Fade in over the first tenth of travel so rings emerge from the
      // surface instead of popping into existence.
      const fade = Math.pow(1 - progress, 1.7) * Math.min(1, progress * 10);
      const alpha = fade * 0.32 * live.luminance;
      if (alpha <= 0.004) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(accent, alpha);
      ctx.lineWidth = Math.max(0.6, 1.5 * (1 - progress));
      ctx.stroke();
    }
  }

  private drawHoldRing(cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    if (live.hold <= 0.02) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 1.6);
    const alpha = live.hold * (0.16 + pulse * 0.22);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.32, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(this.accent(), alpha);
    ctx.lineWidth = 1.3;
    ctx.setLineDash([radius * 0.06, radius * 0.045]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private buildOutline(cx: number, cy: number, radius: number, level: number): Path2D {
    const { live } = this;
    const path = new Path2D();
    const intrinsic = live.wave * (1 - live.waveReactivity);
    const reactive = live.wave * live.waveReactivity * level;
    const amount = intrinsic * 0.03 + reactive * 0.16 + (this.reducedMotion ? 0 : live.unrest * 0.012);
    const t = this.clock;

    for (let i = 0; i <= OUTLINE_SAMPLES; i += 1) {
      const theta = (i / OUTLINE_SAMPLES) * Math.PI * 2;
      const wobble =
        Math.sin(theta * 2 + t * 0.71) * 0.5 + Math.sin(theta * 3 - t * 0.93) * 0.33 + Math.sin(theta * 5 + t * 1.37) * 0.17;
      const r = radius * (1 + wobble * amount);
      const x = cx + Math.cos(theta) * r;
      const y = cy + Math.sin(theta) * r;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  }

  private drawBody(outline: Path2D, cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    const accent = this.accent();
    const light = this.theme === 'light';
    const lightX = cx - radius * 0.3;
    const lightY = cy - radius * 0.34;
    const gradient = ctx.createRadialGradient(lightX, lightY, radius * 0.06, cx, cy, radius * 1.08);
    gradient.addColorStop(0, rgba(live.core, (light ? 0.98 : 0.94) * live.luminance));
    gradient.addColorStop(0.34, rgba(accent, (light ? 0.62 : 0.55) * live.luminance));
    gradient.addColorStop(0.78, rgba(light ? deepen(accent, 0.74) : shade(accent, 0.42), light ? 0.8 : 0.5));
    gradient.addColorStop(1, rgba(light ? deepen(accent, 0.56) : shade(accent, 0.16), light ? 0.82 : 0.44));
    ctx.fillStyle = gradient;
    ctx.fill(outline);
  }

  /** A slow drift of light inside the orb: depth, even at rest. */
  private drawNebula(outline: Path2D, cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    ctx.save();
    ctx.clip(outline);
    const glow = mix(live.core, this.accent(), 0.35);
    for (const [phase, speed, reach] of [
      [0, 0.13, 0.34],
      [2.2, -0.09, 0.28],
    ] as const) {
      const angle = phase + this.clock * speed;
      const x = cx + Math.cos(angle) * radius * reach;
      const y = cy + Math.sin(angle) * radius * reach;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.75);
      gradient.addColorStop(0, rgba(glow, 0.2 * live.luminance));
      gradient.addColorStop(1, rgba(glow, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.05, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Counter-rotating circulation: the visual signature of thought. */
  private drawInterior(outline: Path2D, cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    if (live.flow <= 0.02) return;

    ctx.save();
    ctx.clip(outline);
    const strength = live.flow * live.luminance;
    // Soft light carried round in two counter-rotating orbits. Radial blobs,
    // not conic wedges: a wedge's edges are straight rays that meet at the
    // centre, and they read as a seam cut into the glass.
    for (const layer of [
      { direction: 1, rate: 1, reach: 0.42, size: 0.62, alpha: 0.26 },
      { direction: -1, rate: 0.62, reach: 0.24, size: 0.48, alpha: 0.18 },
    ]) {
      const angle = this.flowPhase * Math.PI * 2 * layer.rate * layer.direction;
      for (const offset of [0, Math.PI]) {
        const x = cx + Math.cos(angle + offset) * radius * layer.reach;
        const y = cy + Math.sin(angle + offset) * radius * layer.reach;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * layer.size);
        gradient.addColorStop(0, rgba(live.core, layer.alpha * strength));
        gradient.addColorStop(1, rgba(live.core, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 1.02, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawRim(outline: Path2D, radius: number): void {
    const { ctx, live } = this;
    const broken = Math.max(live.hold, live.unrest);
    if (broken > 0.05) {
      ctx.setLineDash([radius * 0.28, radius * 0.12]);
      ctx.lineDashOffset = -this.clock * radius * 0.06;
    }
    ctx.strokeStyle =
      this.theme === 'light' ? rgba(deepen(this.accent(), 0.66), 0.42) : rgba(live.core, (broken > 0.05 ? 0.5 : 0.24) * live.luminance);
    ctx.lineWidth = 1.1;
    ctx.stroke(outline);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  private drawSpecular(cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    const x = cx - radius * 0.32;
    const y = cy - radius * 0.38;
    const r = radius * 0.42;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, rgba(live.core, 0.32 * live.luminance));
    gradient.addColorStop(1, rgba(live.core, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * A bright arc travelling around the orb, with a fading tail.
   *
   * Forward, directional motion — the difference between EXECUTING and
   * THINKING should be visible from across a room.
   */
  private drawOrbit(cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    if (live.orbit <= 0.02) return;

    const orbitRadius = radius * 1.2;
    const head = this.orbitPhase * Math.PI * 2;
    const tail = 1.1;
    const segments = 22;
    const color = this.theme === 'light' ? deepen(this.accent(), 0.86) : mix(this.accent(), live.core, 0.35);

    ctx.lineCap = 'round';
    for (let i = 0; i < segments; i += 1) {
      const from = head - (tail * i) / segments;
      const to = head - (tail * (i + 1)) / segments;
      const fade = 1 - i / segments;
      ctx.beginPath();
      ctx.arc(cx, cy, orbitRadius, to, from);
      ctx.strokeStyle = rgba(color, 0.55 * fade * fade * live.orbit * live.luminance);
      ctx.lineWidth = 2.2 * fade + 0.4;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    const hx = cx + Math.cos(head) * orbitRadius;
    const hy = cy + Math.sin(head) * orbitRadius;
    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * 0.12);
    glow.addColorStop(0, rgba(color, 0.7 * live.orbit));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(hx, hy, radius * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
}
