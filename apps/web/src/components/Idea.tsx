import { Section, Reveal } from './Section.js';
import { AXON_LOOP, CHAT_LOOP } from '../content.js';

/**
 * Section 3: what an agent is, as opposed to an answer.
 *
 * Two columns, because the difference is a shape and a shape is quicker to see
 * than to read: a chat box ends at an answer, and Axon carries the same request
 * through acting and then checking. It is a statement about where each model of
 * interaction stops — not a claim about anyone else's product, and there is
 * nothing here about what other assistants can or cannot do.
 */
export function Idea(): React.JSX.Element {
  return (
    <Section
      id="idea"
      eyebrow="The idea"
      heading="AI shouldn’t stop at the chat box."
      lede="An answer still leaves the work to you: the window to open, the field to fill, the button to press. Axon takes the request the rest of the way, and then looks at what happened."
      className="idea"
    >
      <Reveal className="idea__compare">
        <div className="compare">
          <section className="compare__col" aria-labelledby="compare-chat">
            <h3 className="compare__label" id="compare-chat">
              Most AI
            </h3>
            <ol className="compare__steps">
              {CHAT_LOOP.map((step) => (
                <li className="compare__step" key={step.label}>
                  <span className="compare__name">{step.label}</span>
                  <span className="compare__detail">{step.detail}</span>
                </li>
              ))}
            </ol>
            <p className="compare__end">Ends with something to read.</p>
          </section>

          <section className="compare__col compare__col--axon" aria-labelledby="compare-axon">
            <h3 className="compare__label" id="compare-axon">
              Axon
            </h3>
            <ol className="compare__steps">
              {AXON_LOOP.map((step) => (
                <li className="compare__step" key={step.label}>
                  <span className="compare__name">{step.label}</span>
                  <span className="compare__detail">{step.detail}</span>
                </li>
              ))}
            </ol>
            <p className="compare__end">Ends with something done — and checked.</p>
          </section>
        </div>
      </Reveal>
    </Section>
  );
}
