import { Orb } from './Orb.js';
import { DownloadButton } from './DownloadButton.js';
import { useOrbSize } from '../hooks/useOrbSize.js';

/**
 * The hero.
 *
 * The orb is the identity, so it is the largest thing on the screen after the
 * headline. Beside it sits one real exchange — a request, the action it became,
 * and the verification — because what distinguishes Axon from a chat box is that
 * third line, and saying so is more convincing than a slogan about it.
 */
export function Hero(): React.JSX.Element {
  const orbSize = useOrbSize(260);

  return (
    <section className="hero" id="top" aria-labelledby="hero-heading">
      <div className="hero__glow" aria-hidden="true" />
      <div className="shell hero__inner">
        <div className="hero__copy">
          <p className="eyebrow">Voice-first AI for Windows</p>
          {/* The space before the break matters: the break is hidden on a phone,
              and without it the two lines run together into one word. */}
          <h1 id="hero-heading">
            {'Talk to your '}
            <br />
            computer.
          </h1>
          <p className="hero__sub">Axon turns voice into verified action.</p>
          <p className="lede hero__lede">
            A desktop agent that understands a spoken request, operates your computer through its own control layer, and then
            checks what actually happened — so the result is something it can show you rather than something it claims.
          </p>

          <div className="hero__actions">
            <DownloadButton />
            <a className="button button--ghost" href="#how">
              See how it works
            </a>
          </div>

          <p className="hero__meta">Windows 10 / 11 · 64-bit · your own AssemblyAI key</p>
        </div>

        <div className="hero__stage">
          <div className="hero__orb">
            <Orb size={orbSize} rgb={[74, 150, 255]} motion="listening" label="The Axon orb, listening" interactive />
          </div>

          <figure className="trace" aria-label="One exchange, from request to verification">
            <figcaption className="trace__title">
              <span className="trace__dot" />
              A single turn
            </figcaption>
            <ol className="trace__list">
              <li className="trace__row">
                <span className="trace__who">You</span>
                <span className="trace__what">“Open Notepad.”</span>
              </li>
              <li className="trace__row trace__row--tool">
                <span className="trace__who">Request</span>
                <span className="trace__what">
                  <code>app.open</code>
                  <span className="trace__tag">allowed by policy</span>
                </span>
              </li>
              <li className="trace__row">
                <span className="trace__who">Axon</span>
                <span className="trace__what">“Notepad is open.” — verified: its window is on screen</span>
              </li>
            </ol>
          </figure>
        </div>
      </div>
    </section>
  );
}
