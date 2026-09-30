import { Orb } from './Orb.js';
import { GitHubMark } from './GitHubMark.js';
import { SOURCE_URL } from '../config.js';

const LINKS: readonly { readonly href: string; readonly label: string; readonly external?: boolean }[] = [
  { href: '#demo', label: 'In action' },
  { href: '#how', label: 'How it works' },
  { href: '#trust', label: 'Security' },
  { href: '#download', label: 'Download' },
  { href: '#privacy', label: 'Privacy' },
  { href: SOURCE_URL, label: 'GitHub', external: true },
];

export function Footer(): React.JSX.Element {
  return (
    <footer className="foot" aria-labelledby="foot-heading">
      <div className="shell foot__inner">
        <div className="foot__brand">
          <Orb size={30} rgb={[150, 166, 198]} motion="idle" />
          <div>
            <p id="foot-heading" className="foot__name">
              Axon
            </p>
            <p className="foot__tag">Voice-first AI for your desktop.</p>
          </div>
        </div>

        <nav className="foot__links" aria-label="Footer">
          <ul>
            {LINKS.map((link) => (
              <li key={link.label}>
                <a
                  className={link.external === true ? 'foot__external' : undefined}
                  href={link.href}
                  {...(link.external === true ? { rel: 'noreferrer noopener' } : {})}
                >
                  {link.external === true ? <GitHubMark /> : null}
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
