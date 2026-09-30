import { useEffect, useState } from 'react';

/**
 * An orb size that fits the screen it is drawn on.
 *
 * The orb's glow is painted on a canvas twice the orb's width, so a 260px orb
 * occupies 520px — wider than a phone. Measured at 390px: the document scrolled
 * 15px sideways. Clipping it at the page level was the wrong fix (`overflow-x:
 * clip` on the root makes the other axis compute to `auto`, which broke the
 * sticky header), and clipping the glow itself looks like a mistake. So the orb
 * is smaller on a small screen, which is what it should have been anyway.
 *
 * Half the viewport leaves the doubled canvas exactly inside it; 0.46 keeps a
 * margin for the scrollbar.
 */
function fit(base: number): number {
  if (typeof window === 'undefined') return base;
  return Math.max(96, Math.min(base, Math.round(window.innerWidth * 0.46)));
}

export function useOrbSize(base: number): number {
  const [size, setSize] = useState(() => fit(base));

  useEffect(() => {
    const onResize = (): void => setSize(fit(base));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [base]);

  return size;
}
