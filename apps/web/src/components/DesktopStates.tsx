import { useState } from 'react';
import { Section } from './Section.js';
import { Orb, type OrbMotion } from './Orb.js';
import { ORB_STATES } from '../content.js';
import { useOrbSize } from '../hooks/useOrbSize.js';

const MOTIONS: readonly OrbMotion[] = ['idle', 'listening', 'thinking', 'executing', 'speaking', 'approval'];

/**
 * Section 6: the desktop experience — one orb, six states.
 *
 * Interactive rather than a row of screenshots: the state is what the orb is
 * for, and the difference between thinking and executing is motion, which a
 * still image cannot carry. Radio semantics, so it works from the keyboard.
 */
export function DesktopStates(): React.JSX.Element {
  const [active, setActive] = useState(1);
  const orbSize = useOrbSize(210);
  const state = ORB_STATES[active] ?? ORB_STATES[0];
  const motion = MOTIONS[active] ?? 'idle';
  if (!state) return <></>;

  return (
    <Section
      id="desktop"
      eyebrow="On your desktop"
      heading="One small light, always honest about what Axon is doing."
      lede="Axon has no window in the way. It sits at the bottom of your screen as an orb that never takes focus from the application you are using, and its colour and motion are the state — not decoration."
      className="desktop"
    >
      <div className="desktop__stage">
        <div className="desktop__orb">
          <Orb size={orbSize} rgb={state.rgb} motion={motion} interactive />
          <p className="desktop__caption" aria-live="polite">
            <strong>{state.name}</strong>
            <span>{state.caption}</span>
          </p>
        </div>

        <div className="desktop__states" role="radiogroup" aria-label="Orb states">
          {ORB_STATES.map((option, index) => (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={index === active}
              className="state"
              data-active={index === active}
              style={{ ['--state' as string]: `${option.rgb[0]} ${option.rgb[1]} ${option.rgb[2]}` }}
              onClick={() => setActive(index)}
            >
              <span className="state__swatch" aria-hidden="true" />
              <span className="state__name">{option.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
