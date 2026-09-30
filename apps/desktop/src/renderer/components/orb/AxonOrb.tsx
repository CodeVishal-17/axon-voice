/**
 * The orb, as a React component.
 *
 * A thin shell around `OrbRenderer`: it mounts the canvas once and pushes
 * state, amplitude and theme changes into the long-lived renderer rather than
 * rebuilding it. The canvas is decorative (`aria-hidden`) — the state it shows
 * is always stated in words beside it.
 */

import { useEffect, useRef } from 'react';
import type { AxonState } from '@axon/core';
import { OrbRenderer, type OrbTheme } from './orb-renderer.js';
import { SilentAmplitudeSource, type AmplitudeSource } from './amplitude.js';

export interface AxonOrbProps {
  readonly state: AxonState;
  /**
   * Live level for the reactive parts of the animation: the microphone while
   * listening, the speakers while speaking. Absent means the orb uses only
   * its own intrinsic motion — it never animates to a fake signal.
   */
  readonly amplitude?: AmplitudeSource;
  readonly theme?: OrbTheme;
}

export function AxonOrb({ state, amplitude, theme = 'dark' }: AxonOrbProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new OrbRenderer(canvas, amplitude ?? new SilentAmplitudeSource());
    rendererRef.current = renderer;
    renderer.setState(state);
    renderer.setTheme(theme);
    renderer.start();

    const observer = new ResizeObserver(() => {
      renderer.resize();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      renderer.stop();
      rendererRef.current = null;
    };
    // Mount-only: the renderer is long-lived; the effects below push changes.
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    rendererRef.current?.setAmplitudeSource(amplitude ?? new SilentAmplitudeSource());
  }, [amplitude]);

  useEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);

  return <canvas ref={canvasRef} className="orb-canvas" aria-hidden="true" />;
}
