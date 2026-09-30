import { Orb } from './Orb.js';
import { GitHubMark } from './GitHubMark.js';
import { SOURCE_URL, download } from '../config.js';

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '#demo', label: 'In action' },
  { href: '#how', label: 'How it works' },
  { href: '#can-do', label: 'Capabilities' },
  { href: '#trust', label: 'Security' },
  { href: '#privacy', label: 'Privacy' },
];

/**
 * The header: identity, the page's own sections, the source, and one action.
 *
 * THE ACTION IS NOT "GET AXON" UNTIL THERE IS AN AXON TO GET. While no
 * installer is published the button says "Explore Axon" and scrolls to the
 * download section, where the state of things is explained and the download
 * button itself is visibly disabled. Setting `VITE_AXON_DOWNLOAD_URL` turns
 * both of them into the real thing at once.
 */
export function Nav(): React.JSX.Element {
  return (
    <header className="nav">
      <div className="nav__inner shell">
        <a className="nav__brand" href="#top">
          <Orb size={26} rgb={[150, 166, 198]} motion="idle" />
          <span className="nav__word">Axon</span>
        </a>

        <nav className="nav__links" aria-label="Sections">
          <ul>
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <a className="nav__source" href={SOURCE_URL} rel="noreferrer noopener" aria-label="Axon on GitHub">
          <GitHubMark />
        </a>

        <a className="button button--small" href="#download">
          {download.available ? 'Download' : 'Explore Axon'}
        </a>
      </div>
    </header>
  );
}
