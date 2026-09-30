import { Section, Reveal } from './Section.js';
import { CardGlyph } from './CardGlyph.js';
import { CAPABILITIES, REFUSALS } from '../content.js';

/**
 * Section 4: what Axon can do — and, beside it, what it cannot.
 *
 * Each card names the real tools behind it, so the list can be checked against
 * the repository rather than believed. The refusals are on the same screen on
 * purpose: for an agent that can act on your machine, the boundary is a feature,
 * and a capability list that hides it is marketing.
 */
export function Capabilities(): React.JSX.Element {
  return (
    <Section
      id="can-do"
      eyebrow="What Axon can do"
      heading="Thirty-three tools. No surprises."
      lede="These are the actions Axon can take today, each backed by a named tool in its registry. Say it in a sentence; Axon works out which of these it needs."
      className="can-do"
    >
      <Reveal>
        <ul className="cards">
          {CAPABILITIES.map((capability) => (
            <li className="card" key={capability.title}>
              <CardGlyph kind={capability.glyph} />
              <h3 className="card__title">{capability.title}</h3>
              <p className="card__detail">{capability.detail}</p>
              <p className="card__say">{capability.say}</p>
              <ul className="card__tools" aria-label="Tools behind this">
                {capability.tools.map((tool) => (
                  <li key={tool}>
                    <code>{tool}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal className="limits">
        <h3 className="limits__title">And what it deliberately cannot do</h3>
        <ul className="limits__list">
          {REFUSALS.map((refusal) => (
            <li key={refusal}>{refusal}</li>
          ))}
        </ul>
        <p className="limits__note">
          These are not settings. There is no shell tool, no key-press tool and no mouse tool to enable — the code to do those
          things is not in Axon.
        </p>
      </Reveal>
    </Section>
  );
}
