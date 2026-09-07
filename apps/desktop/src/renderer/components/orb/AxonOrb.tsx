/**
 * React wrapper around the orb renderer.
 *
 * Deliberately thin. It mounts the canvas, hands the renderer the current Axon
 * state, and keeps the backing store in step with the element's size. There is
 * no animation logic here at all — the engine in `orb-renderer.ts` owns that,
 * so the visuals can be reasoned about, tuned and reused without React in the
 * way, and a re-render can never restart or perturb the animation.
 */

import { useEffect, useRef } from 'react';
import type { AxonState } from '@axon/core';
import { OrbRenderer } from './orb-renderer.js';
import { SilentAmplitudeSource, type AmplitudeSource } from './amplitude.js';

export interface AxonOrbProps {
  readonly state: AxonState;
  /**
   * Live level for the reactive parts of the animation. Defaults to silence
   * until the microphone (Step 4) and speech playback (Step 3) are connected.
   */
  readonly amplitude?: AmplitudeSource;
}

export function AxonOrb({ state, amplitude }: AxonOrbProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new OrbRenderer(canvas, amplitude ?? new SilentAmplitudeSource());
    rendererRef.current = renderer;
    renderer.setState(state);
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
    // Mount-only: the renderer is long-lived, and state/amplitude changes are
    // pushed to it by the effects below rather than by rebuilding it.
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    if (amplitude) rendererRef.current?.setAmplitudeSource(amplitude);
  }, [amplitude]);

  return <canvas ref={canvasRef} className="orb-canvas" aria-hidden="true" />;
}
