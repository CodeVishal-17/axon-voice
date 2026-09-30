import type { ReactNode } from 'react';
import { useInView } from '../hooks/useInView.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';

export interface SectionProps {
  readonly id: string;
  /** Short label above the heading. */
  readonly eyebrow?: string;
  readonly heading: string;
  readonly lede?: string;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * One section of the page: a landmark, a heading its region is named by, and a
 * reveal that only animates for visitors who did not ask for less movement.
 *
 * Every section is a real `<section>` with `aria-labelledby`, so the page has a
 * usable landmark and heading outline rather than a stack of divs.
 */
export function Section({ id, eyebrow, heading, lede, children, className }: SectionProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const { ref, shown } = useInView<HTMLDivElement>({ disabled: reduced });

  return (
    <section id={id} className={`section ${className ?? ''}`.trim()} aria-labelledby={`${id}-heading`}>
      <div className="shell">
        <div ref={ref} className="reveal" data-shown={shown}>
          {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
          <h2 id={`${id}-heading`}>{heading}</h2>
          {lede === undefined ? null : <p className="lede section__lede">{lede}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

/**
 * A child block that reveals on its own, slightly after its heading.
 *
 * Used instead of animating a whole section at once, so a long section does not
 * wait for its bottom edge to enter the viewport.
 */
export function Reveal({ children, className }: { readonly children: ReactNode; readonly className?: string }): React.JSX.Element {
  const reduced = useReducedMotion();
  const { ref, shown } = useInView<HTMLDivElement>({ disabled: reduced });
  return (
    <div ref={ref} className={`reveal ${className ?? ''}`.trim()} data-shown={shown}>
      {children}
    </div>
  );
}
