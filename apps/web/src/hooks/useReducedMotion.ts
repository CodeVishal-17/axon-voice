import { useEffect, useState } from 'react';

/**
 * Whether this visitor has asked for less movement.
 *
 * Read in JavaScript as well as CSS, because the orb animates on a canvas: a
 * media query can stop a transition but it cannot stop a requestAnimationFrame
 * loop. When this is true the orb draws one still frame and nothing schedules
 * another.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
