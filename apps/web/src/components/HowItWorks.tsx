import { useEffect, useState } from 'react';
import { Section } from './Section.js';
import { ARCHITECTURE } from '../content.js';
import { useInView } from '../hooks/useInView.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';

/** How long between one node lighting up and the next. */
const STEP_MS = 320;

/**
 * Section 3: the architecture, activating a node at a time.
 *
 * The sequence is the point: a request does not arrive at execution, it arrives
 * at validation, and only reaches execution if everything between says yes. With
 * reduced motion every node is simply lit from the start.
 */
export function HowItWorks(): React.JSX.Element {
  const reduced = useReducedMotion();
  const { ref, shown } = useInView<HTMLOListElement>({ disabled: reduced });
  const [lit, setLit] = useState(reduced ? ARCHITECTURE.length : 0);

  useEffect(() => {
    if (reduced) {
      setLit(ARCHITECTURE.length);
      return;
    }
    if (!shown) return;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setLit(index);
      if (index >= ARCHITECTURE.length) window.clearInterval(timer);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [shown, reduced]);

  return (
    <Section
      id="how"
      eyebrow="How Axon works"
      heading="Two layers, and only one of them decides."
      lede="AssemblyAI provides the realtime voice layer: recognition, reasoning and the spoken reply, over one connection held by Axon. Axon provides the action layer, and every action is a request that has to get through it."
      className="how"
    >
      <p className="pull">
        The model decides what to ask for.
        <span className="pull__accent"> Axon decides what is allowed.</span>
      </p>

      <ol className="chain" ref={ref}>
        {ARCHITECTURE.map((step, index) => (
          <li className="chain__node" key={step.label} data-lit={index < lit}>
            <span className="chain__marker" aria-hidden="true" />
            <div className="chain__text">
              <h3 className="chain__label">{step.label}</h3>
              <p className="chain__detail">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
