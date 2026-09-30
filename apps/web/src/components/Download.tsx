import { Orb } from './Orb.js';
import { DownloadButton } from './DownloadButton.js';
import { download } from '../config.js';
import { REQUIREMENTS } from '../content.js';
import { Reveal } from './Section.js';
import { useOrbSize } from '../hooks/useOrbSize.js';

/** Section 7: the download, in whichever state is true right now. */
export function Download(): React.JSX.Element {
  const orbSize = useOrbSize(120);

  return (
    <section id="download" className="section get" aria-labelledby="download-heading">
      <div className="get__glow" aria-hidden="true" />
      <div className="shell get__inner">
        <Reveal className="get__body">
          <Orb size={orbSize} rgb={[96, 190, 255]} motion="speaking" />
          <h2 id="download-heading">Meet Axon on Windows.</h2>
          <p className="lede get__lede">Bring voice control to your desktop.</p>

          <div className="get__actions">
            <DownloadButton withSource />
          </div>
          <p className="get__note" id="download-note">
            {download.note}
          </p>

          <ul className="get__requirements">
            {REQUIREMENTS.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
