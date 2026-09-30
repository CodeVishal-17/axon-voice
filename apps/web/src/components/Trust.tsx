import { Section, Reveal } from './Section.js';
import { Orb } from './Orb.js';
import { APPROVAL_TRIGGERS, GATE } from '../content.js';

/**
 * Section 5: the gate every action goes through, and the moment you see it.
 *
 * The approval card is the product, not a disclaimer, so it is rendered at the
 * size it deserves. Its buttons are inert: this is a picture of the desktop
 * dialog, and it says so to assistive technology.
 */
export function Trust(): React.JSX.Element {
  return (
    <Section
      id="trust"
      eyebrow="Trust"
      heading="You stay in control."
      lede="Axon is built so that the model never holds the machine. What it produces is a request; what happens next is decided by Axon’s own rules, and — where it matters — by you."
      className="trust"
    >
      <Reveal>
        <ol className="gate" aria-label="The path of one action">
          {GATE.map((stage, index) => (
            <li className="gate__stage" key={stage} data-emphasis={stage === 'Approval'}>
              <span className="gate__num">{index + 1}</span>
              <span className="gate__name">{stage}</span>
            </li>
          ))}
        </ol>
      </Reveal>

      <div className="trust__grid">
        <Reveal className="trust__card">
          <div className="approval" role="group" aria-label="Example of Axon’s approval dialog">
            <div className="approval__head">
              <Orb size={40} rgb={[255, 166, 72]} motion="approval" />
              <div>
                <p className="approval__eyebrow">Approval required</p>
                <p className="approval__title">Axon wants to submit this application.</p>
              </div>
            </div>
            <dl className="approval__meta">
              <div>
                <dt>Action</dt>
                <dd>
                  <code>browser.click</code>
                </dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>“Submit application”</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd>Leaves this machine</dd>
              </div>
            </dl>
            <div className="approval__actions">
              <button className="button button--ghost" type="button" disabled>
                Cancel
              </button>
              <button className="button button--amber" type="button" disabled>
                Approve
              </button>
            </div>
            <p className="approval__foot">An example of the desktop dialog. Nothing here is live.</p>
          </div>
        </Reveal>

        <Reveal className="trust__points">
          <div className="point">
            <h3>Consequential actions wait for a person</h3>
            <p>Axon asks before it does any of these, every time:</p>
            <ul className="point__list">
              {APPROVAL_TRIGGERS.map((trigger) => (
                <li key={trigger}>{trigger}</li>
              ))}
            </ul>
          </div>
          <div className="point">
            <h3>Risk only ever goes up</h3>
            <p>
              Risk is worked out from the real arguments of the real request. It can be raised on inspection and is never
              downgraded, and an approval nobody answers becomes a denial rather than a hang or an allow.
            </p>
          </div>
          <div className="point">
            <h3>Approval binds to one exact act</h3>
            <p>
              Between your yes and the action running, Axon re-checks that what is about to happen is still what you approved. A
              different act needs a different answer.
            </p>
          </div>
          <div className="point">
            <h3>Credentials are refused outright</h3>
            <p>
              Axon will not type a password or an API key, and anything that looks like one is redacted on its way into the
              transcript. There is no tool that could.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
