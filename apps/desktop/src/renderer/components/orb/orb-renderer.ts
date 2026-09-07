/**
 * The Axon orb renderer.
 *
 * A plain TypeScript class that owns a canvas and an animation loop. It is not
 * a React component and knows nothing about React: it is handed an Axon state
 * and an amplitude source, and it draws. That separation is the point — the
 * animation is a reusable engine driven by the state machine, not a pile of
 * effects living inside a component.
 *
 * How it works:
 *
 * - There is exactly one draw path. State does not select a branch; it selects
 *   a parameter set (`orb-visuals.ts`) which the renderer eases toward. A
 *   change from THINKING to EXECUTING is therefore a physical transition over
 *   ~450ms, not a cut, and no state can be visually "special-cased" into
 *   inconsistency.
 *
 * - The orb's silhouette is a harmonic deformation of a circle rather than a
 *   circle with decoration on top. Three low harmonics at incommensurate
 *   speeds never repeat visibly, which is what keeps it feeling alive instead
 *   of looped. In SPEAKING the same function carries the voice amplitude, so
 *   the orb speaks rather than hosting a separate visualiser.
 *
 * - Interior motion is a pair of counter-rotating conic gradients clipped to
 *   the silhouette. No particles, no sprites: one composited gradient reads as
 *   depth and circulation for a fraction of the cost, and cannot degrade into
 *   the confetti look that "AI orb" usually means.
 *
 * Everything is time-based (seconds of delta), so behaviour is identical at
 * 60Hz and 144Hz and does not accelerate when a frame is dropped.
 */

import type { AxonState } from '@axon/core';
import { easeVisual, rgba, visualFor, type OrbVisual, type Rgb } from './orb-visuals.js';
import { SilentAmplitudeSource, type AmplitudeSource } from './amplitude.js';

/** Time constant for parameter easing. Larger = more languid transitions. */
const TRANSITION_TAU = 0.28;

/** Silhouette resolution. 180 samples is smooth at any size we render. */
const OUTLINE_SAMPLES = 180;

function shade(color: Rgb, factor: number): Rgb {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

export class OrbRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private amplitude: AmplitudeSource;
  private target: OrbVisual;
  private live: OrbVisual;

  private frameHandle: number | null = null;
  private lastFrameAt = 0;

  /** Independent clocks, so speeding up one motion never resets another. */
  private clock = 0;
  private ringPhase = 0;
  private flowPhase = 0;
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
    this.resize();
  }

  setState(state: AxonState): void {
    this.target = visualFor(state);
  }

  setAmplitudeSource(source: AmplitudeSource): void {
    this.amplitude = source;
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
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  // --- loop --------------------------------------------------------------

  private step(now: number): void {
    // Clamp so a backgrounded window returning after minutes does not advance
    // every clock by that whole gap in a single frame.
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.05);
    this.lastFrameAt = now;

    const ease = 1 - Math.exp(-dt / TRANSITION_TAU);
    this.live = easeVisual(this.live, this.target, ease);

    const level = Math.max(0, Math.min(1, this.amplitude.level()));

    this.clock += dt;
    this.ringPhase += dt * this.live.ringSpeed * (1 + level * 0.5);
    this.flowPhase += dt * this.live.flowRate;
    this.unrestSeed += dt;

    this.draw(level);
  }

  private draw(level: number): void {
    const { ctx, width, height, live } = this;
    ctx.clearRect(0, 0, width, height);

    // The core is sized so that everything drawn around it — the halo at 2.45x
    // and the outermost ring at ~1.9x — still reaches zero alpha inside the
    // canvas. Sizing the core to the full half-extent instead clips the glow
    // at the element's edges, which paints a faint but very visible square
    // around the orb. The canvas is drawn larger than its layout box (see
    // `.orb-canvas` in styles.css) so this costs no apparent size.
    const layoutRadius = (Math.min(width, height) * 0.5) / 1.85;
    const breath = live.breathAmplitude * Math.sin(this.clock * live.breathRate * Math.PI * 2);
    const hold = live.hold > 0 ? 1 + 0.012 * live.hold * Math.sin(this.clock * 1.1) : 1;
    const radius = layoutRadius * live.radius * (1 + breath) * hold;

    // The error state is the only one that moves the orb off centre, and it
    // does so by a couple of pixels — enough to read as instability, not
    // enough to look broken.
    const drift = live.unrest * 2.2;
    const cx = width / 2 + Math.sin(this.unrestSeed * 9.1) * drift;
    const cy = height / 2 + Math.cos(this.unrestSeed * 7.7) * drift;

    this.drawHalo(cx, cy, radius, level);
    this.drawExpandingRings(cx, cy, radius, level);
    this.drawHoldRing(cx, cy, radius);

    const outline = this.buildOutline(cx, cy, radius, level);
    this.drawBody(outline, cx, cy, radius);
    this.drawInterior(outline, cx, cy, radius);
    this.drawRim(outline, radius);
    this.drawSpecular(cx, cy, radius);
  }

  // --- layers ------------------------------------------------------------

  private drawHalo(cx: number, cy: number, radius: number, level: number): void {
    const { ctx, live } = this;
    const strength = live.halo * live.luminance * (0.85 + level * 0.35);
    if (strength <= 0.01) return;

    const outer = radius * (2.45 + level * 0.35);
    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, outer);
    gradient.addColorStop(0, rgba(live.accent, 0.16 * strength));
    gradient.addColorStop(0.45, rgba(live.accent, 0.06 * strength));
    gradient.addColorStop(1, rgba(live.accent, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Rings that travel outward from the core.
   *
   * Phase-driven rather than object-pooled: ring positions are derived from
   * one accumulator, so there is nothing to allocate or garbage-collect per
   * frame and the spacing stays perfectly even as the speed changes.
   *
   * `ringReactivity` is where the amplitude source reaches the picture. With
   * the silent source the rings still travel — that is the orb's own pulse —
   * but their reach is unmodulated. Wiring a microphone in Step 4 changes this
   * number's input and nothing else.
   */
  private drawExpandingRings(cx: number, cy: number, radius: number, level: number): void {
    const { ctx, live } = this;
    const count = Math.round(live.ringDensity);
    if (count < 1 || live.ringDensity < 0.15) return;

    const reach = 1.35 + level * live.ringReactivity * 0.85;

    for (let i = 0; i < count; i += 1) {
      const progress = (this.ringPhase + i / count) % 1;
      const ringRadius = radius * (1 + progress * reach);
      // Fade out with distance, and in again over the first tenth of travel so
      // rings emerge from the surface instead of popping into existence.
      const fade = Math.pow(1 - progress, 1.7) * Math.min(1, progress * 10);
      const alpha = fade * 0.34 * live.luminance;
      if (alpha <= 0.004) continue;

      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(live.accent, alpha);
      ctx.lineWidth = Math.max(0.6, 1.5 * (1 - progress));
      ctx.stroke();
    }
  }

  /** The approval state's single, non-advancing ring. */
  private drawHoldRing(cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    if (live.hold <= 0.02) return;

    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 1.6);
    const alpha = live.hold * (0.14 + pulse * 0.2);

    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.32, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(live.accent, alpha);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([radius * 0.06, radius * 0.045]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * The silhouette.
   *
   * Three harmonics with unrelated periods, so the shape never visibly loops.
   * `waveReactivity` decides how much of the deformation is live audio versus
   * the orb's intrinsic motion; with no audio attached the reactive term is
   * zero and what remains is the orb's own movement — not a simulation of
   * sound.
   */
  private buildOutline(cx: number, cy: number, radius: number, level: number): Path2D {
    const { live } = this;
    const path = new Path2D();

    const intrinsic = live.wave * (1 - live.waveReactivity);
    const reactive = live.wave * live.waveReactivity * level;
    const amount = (intrinsic * 0.03 + reactive * 0.16) + live.unrest * 0.012;

    const t = this.clock;

    for (let i = 0; i <= OUTLINE_SAMPLES; i += 1) {
      const theta = (i / OUTLINE_SAMPLES) * Math.PI * 2;
      const wobble =
        Math.sin(theta * 2 + t * 0.71) * 0.5 +
        Math.sin(theta * 3 - t * 0.93) * 0.33 +
        Math.sin(theta * 5 + t * 1.37) * 0.17;

      const r = radius * (1 + wobble * amount);
      const x = cx + Math.cos(theta) * r;
      const y = cy + Math.sin(theta) * r;

      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }

    path.closePath();
    return path;
  }

  /** The sphere itself: an off-centre radial gradient, which is what makes a
   *  flat disc read as a lit ball. */
  private drawBody(outline: Path2D, cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    const lightX = cx - radius * 0.3;
    const lightY = cy - radius * 0.34;

    const gradient = ctx.createRadialGradient(lightX, lightY, radius * 0.06, cx, cy, radius * 1.08);
    gradient.addColorStop(0, rgba(live.core, 0.94 * live.luminance));
    gradient.addColorStop(0.32, rgba(live.accent, 0.55 * live.luminance));
    gradient.addColorStop(0.78, rgba(shade(live.accent, 0.42), 0.5));
    gradient.addColorStop(1, rgba(shade(live.accent, 0.16), 0.44));

    ctx.fillStyle = gradient;
    ctx.fill(outline);
  }

  /**
   * Interior circulation.
   *
   * Two conic gradients turning at different rates and in opposite directions,
   * clipped to the silhouette. Where their bright arcs coincide the interior
   * brightens; where they oppose it settles. The result drifts continuously
   * without ever repeating, which is what "thinking" should look like — and it
   * costs two gradient fills, not a particle system.
   */
  private drawInterior(outline: Path2D, cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    if (live.flow <= 0.02) return;

    ctx.save();
    ctx.clip(outline);

    const strength = live.flow * live.luminance;

    for (const layer of [
      { direction: 1, rate: 1, width: 0.34, alpha: 0.3 },
      { direction: -1, rate: 0.62, width: 0.22, alpha: 0.2 },
    ]) {
      const angle = this.flowPhase * Math.PI * 2 * layer.rate * layer.direction;
      const conic = ctx.createConicGradient(angle, cx, cy);
      const a = layer.alpha * strength;

      conic.addColorStop(0, rgba(live.core, 0));
      conic.addColorStop(Math.max(0.001, 0.5 - layer.width), rgba(live.core, 0));
      conic.addColorStop(0.5, rgba(live.core, a));
      conic.addColorStop(Math.min(0.999, 0.5 + layer.width), rgba(live.core, 0));
      conic.addColorStop(1, rgba(live.core, 0));

      ctx.fillStyle = conic;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.02, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * The rim.
   *
   * Continuous while Axon is working. In the waiting and error states it is
   * dashed, so the two states that mean "stopped" are legible at a glance and
   * without relying on colour alone.
   */
  private drawRim(outline: Path2D, radius: number): void {
    const { ctx, live } = this;
    const broken = Math.max(live.hold, live.unrest);

    if (broken > 0.05) {
      ctx.setLineDash([radius * 0.28, radius * 0.12]);
      ctx.lineDashOffset = -this.clock * radius * 0.06;
    }

    ctx.strokeStyle = rgba(live.core, 0.5 * live.luminance);
    ctx.lineWidth = 1.1;
    ctx.stroke(outline);

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  /** A small soft highlight. Cheap, and it is most of what sells the sphere. */
  private drawSpecular(cx: number, cy: number, radius: number): void {
    const { ctx, live } = this;
    const x = cx - radius * 0.32;
    const y = cy - radius * 0.38;
    const r = radius * 0.42;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, rgba(live.core, 0.3 * live.luminance));
    gradient.addColorStop(1, rgba(live.core, 0));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
