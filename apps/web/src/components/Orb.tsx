import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import './Orb.css';

/**
 * The Axon orb, for the web.
 *
 * The desktop app draws the real one; this is a separate, smaller
 * implementation of the same visual vocabulary, written here so the website
 * shares no code with the product and the desktop app did not have to change to
 * be advertised. It keeps what makes the orb recognisable:
 *
 *   a near-white core inside a coloured rim   the state's own colour
 *   a slow breath                             scale, not opacity
 *   expanding rings                           density and speed follow the state
 *   interior arcs                             counter-rotating: "thinking"
 *   a travelling highlight                    only while executing: "doing"
 *   a held pulse                              approval: stopped, not working
 *
 * Reduced motion draws exactly one frame and schedules nothing.
 */

export type OrbMotion = 'idle' | 'listening' | 'thinking' | 'executing' | 'speaking' | 'approval';

export interface OrbProps {
  /** Drawn diameter in CSS pixels. The glow extends beyond it. */
  readonly size: number;
  /** The state's colour, as `[r, g, b]` — the desktop app's own values. */
  readonly rgb: readonly [number, number, number];
  readonly motion?: OrbMotion;
  /** Decorative by default: the surrounding copy carries the meaning. */
  readonly label?: string;
  /**
   * Respond to the cursor: brighten and lean very slightly towards it as it
   * comes near. Off by default, and off entirely under reduced motion — the
   * small orbs in the header and footer stay still.
   */
  readonly interactive?: boolean;
}

interface Look {
  readonly breath: number;
  readonly breathRate: number;
  readonly halo: number;
  readonly rings: number;
  readonly ringSpeed: number;
  readonly flow: number;
  readonly orbit: number;
  readonly hold: number;
}

const LOOKS: Readonly<Record<OrbMotion, Look>> = {
  idle: { breath: 0.02, breathRate: 0.32, halo: 0.5, rings: 0.5, ringSpeed: 0.2, flow: 0.12, orbit: 0, hold: 0 },
  listening: { breath: 0.035, breathRate: 0.7, halo: 0.82, rings: 1.6, ringSpeed: 0.42, flow: 0.2, orbit: 0, hold: 0 },
  thinking: { breath: 0.026, breathRate: 0.5, halo: 0.72, rings: 0.8, ringSpeed: 0.26, flow: 0.9, orbit: 0, hold: 0 },
  executing: { breath: 0.022, breathRate: 0.6, halo: 0.78, rings: 1.1, ringSpeed: 0.5, flow: 0.4, orbit: 1, hold: 0 },
  speaking: { breath: 0.05, breathRate: 1.05, halo: 0.88, rings: 1.9, ringSpeed: 0.58, flow: 0.24, orbit: 0, hold: 0 },
  approval: { breath: 0.014, breathRate: 0.24, halo: 0.95, rings: 0.35, ringSpeed: 0.12, flow: 0.1, orbit: 0, hold: 1 },
};

/** Near-white inner light, warmed slightly for the amber state. */
const coreOf = (rgb: readonly [number, number, number]): string =>
  rgb[0] > 220 && rgb[2] < 140 ? 'rgb(255, 245, 228)' : 'rgb(234, 241, 253)';

export function Orb({ size, rgb, motion = 'idle', label, interactive = false }: OrbProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();
  const target = useRef(motion);
  target.current = motion;
  /** Last known cursor position, in client coordinates. Null: nowhere near. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** The eased attention value, 0 to 1, and the eased lean, -1 to 1 on each axis. */
  const attention = useRef({ near: 0, x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // The glow needs room outside the core, so the canvas is twice the orb.
    const box = size * 2;
    const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    canvas.width = Math.round(box * ratio);
    canvas.height = Math.round(box * ratio);
    canvas.style.width = `${box}px`;
    canvas.style.height = `${box}px`;
    context.scale(ratio, ratio);

    const colour = (alpha: number): string => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

    /**
     * How near the cursor is, and which way it lies — both eased.
     *
     * The rectangle is read once per frame rather than per pointer event, so
     * moving the mouse does not force a layout: the listener only records where
     * the cursor is. `reach` is generous (about one orb-width of empty space
     * around the orb) so the response starts before the cursor arrives, which is
     * what makes it feel like attention rather than a hover state.
     */
    const follow = (): { near: number; x: number; y: number } => {
      const state = attention.current;
      let nearTo = 0;
      let xTo = 0;
      let yTo = 0;
      const here = pointer.current;
      if (here) {
        const rect = canvas.getBoundingClientRect();
        const reach = size * 1.8;
        const dx = here.x - (rect.left + rect.width / 2);
        const dy = here.y - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy);
        if (distance < reach) {
          nearTo = 1 - distance / reach;
          xTo = Math.max(-1, Math.min(1, dx / reach));
          yTo = Math.max(-1, Math.min(1, dy / reach));
        }
      }
      state.near += (nearTo - state.near) * 0.07;
      state.x += (xTo - state.x) * 0.07;
      state.y += (yTo - state.y) * 0.07;
      return state;
    };

    const draw = (time: number): void => {
      const look = LOOKS[target.current];
      const centre = box / 2;
      const radius = size * 0.34;
      const t = time / 1000;

      // Attention: nothing at all unless this orb was asked to be interactive.
      const attn = interactive ? follow() : { near: 0, x: 0, y: 0 };
      const lean = size * 0.028 * attn.near;
      const cx = centre + attn.x * lean;
      const cy = centre + attn.y * lean;

      context.clearRect(0, 0, box, box);

      // A held pulse for approval; a breath otherwise. The cursor adds a little.
      const pulse = look.hold > 0 ? 0.5 + 0.5 * Math.sin(t * 1.9) : Math.sin(t * Math.PI * 2 * look.breathRate);
      const scale = 1 + (look.hold > 0 ? 0.01 * pulse : look.breath * pulse) + 0.035 * attn.near;
      const core = radius * scale;
      const halation = look.halo * (1 + 0.45 * attn.near);

      // Halo.
      const halo = context.createRadialGradient(cx, cy, core * 0.5, cx, cy, core * 3.4);
      halo.addColorStop(0, colour(0.3 * halation));
      halo.addColorStop(0.45, colour(0.08 * halation));
      halo.addColorStop(1, colour(0));
      context.fillStyle = halo;
      context.fillRect(0, 0, box, box);

      // Expanding rings. Two in flight, offset by half a period.
      for (let i = 0; i < 2; i += 1) {
        const phase = ((t * look.ringSpeed + i * 0.5) % 1 + 1) % 1;
        const ringRadius = core * (1.05 + phase * 1.9);
        const fade = (1 - phase) * 0.5 * Math.min(1, look.rings) * (1 + 0.5 * attn.near);
        if (fade <= 0.001) continue;
        context.beginPath();
        context.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        context.strokeStyle = colour(fade);
        context.lineWidth = 1.1;
        context.stroke();
      }

      // The core: near-white centre, the state's colour at the rim.
      const body = context.createRadialGradient(cx - core * 0.22, cy - core * 0.3, core * 0.06, cx, cy, core);
      body.addColorStop(0, coreOf(rgb));
      body.addColorStop(0.42, colour(0.92));
      body.addColorStop(1, colour(0.24));
      context.beginPath();
      context.arc(cx, cy, core, 0, Math.PI * 2);
      context.fillStyle = body;
      context.fill();

      // Rim.
      context.beginPath();
      context.arc(cx, cy, core, 0, Math.PI * 2);
      context.strokeStyle = colour(0.5 + 0.3 * attn.near);
      context.lineWidth = 1;
      context.stroke();

      // Interior arcs, counter-rotating: the signature of reasoning.
      if (look.flow > 0.02) {
        for (let i = 0; i < 2; i += 1) {
          const direction = i === 0 ? 1 : -1;
          const spin = t * (0.5 + look.flow) * direction + i * 1.7;
          const arcRadius = core * (0.52 + i * 0.2);
          context.beginPath();
          context.arc(cx, cy, arcRadius, spin, spin + 1.5 + look.flow);
          context.strokeStyle = `rgba(255, 255, 255, ${0.1 + 0.26 * look.flow})`;
          context.lineWidth = 1.3;
          context.stroke();
        }
      }

      // A bright travelling arc: forward motion, only while executing.
      if (look.orbit > 0) {
        const spin = t * 2.4;
        context.beginPath();
        context.arc(cx, cy, core * 1.24, spin, spin + 0.7);
        context.strokeStyle = colour(0.85);
        context.lineWidth = 2;
        context.lineCap = 'round';
        context.stroke();
      }
    };

    if (reduced) {
      // One still frame, at a moment where every element is visible. No pointer
      // listener either: asking for less movement includes this.
      draw(700);
      return;
    }

    // The cursor, recorded and nothing more. A pointer that leaves the window
    // releases the orb, which eases back to its resting state on its own.
    let onPointerMove: ((event: PointerEvent) => void) | null = null;
    let onPointerOut: (() => void) | null = null;
    if (interactive) {
      onPointerMove = (event: PointerEvent): void => {
        pointer.current = { x: event.clientX, y: event.clientY };
      };
      onPointerOut = (): void => {
        pointer.current = null;
      };
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerleave', onPointerOut, { passive: true });
      window.addEventListener('blur', onPointerOut);
    }

    // Draw once, synchronously, before asking for a frame: in a background or
    // throttled tab `requestAnimationFrame` may not run for a long time, and an
    // orb that is the page's main visual must not be a hole until it does.
    draw(700);

    let frame = 0;
    const loop = (time: number): void => {
      draw(time);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(frame);
      if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
      if (onPointerOut) {
        window.removeEventListener('pointerleave', onPointerOut);
        window.removeEventListener('blur', onPointerOut);
      }
    };
  }, [size, rgb, reduced, interactive]);

  return (
    <span className="orb" data-interactive={interactive} style={{ width: size, height: size }}>
      <canvas ref={canvasRef} className="orb__canvas" aria-hidden="true" />
      {label === undefined ? null : <span className="orb__label">{label}</span>}
    </span>
  );
}
