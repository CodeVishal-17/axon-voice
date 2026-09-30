import { Section, Reveal } from './Section.js';
import { PRIVACY, PRIVACY_SPLIT } from '../content.js';

/**
 * Section 8: privacy, with the distinction intact.
 *
 * Each row is marked with where the audio or data actually goes, because the
 * honest version of this section is not "everything stays on your device": the
 * wake word is local, and the conversation is streamed to AssemblyAI. Saying both
 * is the only way the first claim means anything.
 */
export function Privacy(): React.JSX.Element {
  return (
    <Section
      id="privacy"
      eyebrow="Privacy"
      heading="Private by default. Clear about what leaves your PC."
      lede="Axon waits for its name on your machine, and your data stays there. When you start talking to it, your speech goes to a voice service — that is the one thing that leaves, and it is named here rather than blurred."
      className="privacy"
    >
      <Reveal className="split">
        {PRIVACY_SPLIT.map((column) => (
          <section className="split__col" key={column.scope} data-scope={column.scope} aria-labelledby={`split-${column.scope}`}>
            <h3 className="split__label" id={`split-${column.scope}`}>
              <span className="split__dot" aria-hidden="true" />
              {column.title}
            </h3>
            <ul className="split__list">
              {column.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </Reveal>

      <Reveal>
        <ul className="facts">
          {PRIVACY.map((fact) => (
            <li className="fact" key={fact.title} data-scope={fact.scope}>
              <span className="fact__scope">{fact.scope === 'local' ? 'On device' : 'Leaves device'}</span>
              <h3 className="fact__title">{fact.title}</h3>
              <p className="fact__detail">{fact.detail}</p>
            </li>
          ))}
        </ul>
      </Reveal>
    </Section>
  );
}
