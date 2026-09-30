import { useEffect, useRef, useState } from 'react';

/**
 * Has this element been scrolled into view yet?
 *
 * Latches: once shown, it stays shown, so a section never fades out again when
 * it leaves the viewport. Without an IntersectionObserver — or with reduced
 * motion, where there is nothing to reveal — it starts out true, which means the
 * content is visible even if none of this runs.
 */
export function useInView<T extends HTMLElement>(options?: {
  readonly margin?: string;
  readonly disabled?: boolean;
  /**
   * How long the floor below waits before giving up on the observer.
   *
   * The default is short because for a fade-in, showing early costs nothing. A
   * caller whose reveal is a sequence people are meant to watch — the demo run —
   * passes a longer one, so that in practice the section plays when it is
   * actually reached rather than while it is still below the fold.
   */
  readonly fallbackMs?: number;
}): {
  readonly ref: React.RefObject<T | null>;
  readonly shown: boolean;
} {
  const ref = useRef<T | null>(null);
  const disabled = options?.disabled === true;
  const fallbackMs = options?.fallbackMs ?? 1_200;
  const [shown, setShown] = useState(disabled);

  useEffect(() => {
    if (disabled) {
      setShown(true);
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    // A floor under the whole mechanism: whatever happens with the observer —
    // a browser that throttles a background tab so it never fires, a layout
    // that never quite meets the threshold — the content appears. Reveal is an
    // enhancement, and content that depends on an animation frame to become
    // visible is a bug waiting for someone else's machine.
    const fallback = window.setTimeout(() => setShown(true), fallbackMs);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: options?.margin ?? '0px 0px -12% 0px', threshold: 0.15 },
    );
    observer.observe(element);
    return () => {
      window.clearTimeout(fallback);
      observer.disconnect();
    };
  }, [disabled, options?.margin, fallbackMs]);

  return { ref, shown };
}
