import { SOURCE_URL, download } from '../config.js';

/**
 * The download call to action, in whichever state is honest.
 *
 * When no build has been published this is a DISABLED button that says so, next
 * to a link to the source — not a link to a URL that does not exist. See
 * `config.ts`: the difference is one build-time variable.
 */
export function DownloadButton({
  className,
  withSource = false,
}: {
  readonly className?: string;
  /** Show the "build from source" link beside it. The download section does; the hero does not. */
  readonly withSource?: boolean;
}): React.JSX.Element {
  if (!download.available) {
    return (
      <span className={`download ${className ?? ''}`.trim()}>
        <button className="button" type="button" disabled aria-describedby="download-note">
          {download.label}
        </button>
        {withSource ? (
          <a className="button button--ghost" href={SOURCE_URL} rel="noreferrer noopener">
            Build from source
          </a>
        ) : null}
      </span>
    );
  }

  return (
    <span className={`download ${className ?? ''}`.trim()}>
      <a className="button" href={download.url ?? '#download'} aria-describedby="download-note">
        {download.label}
      </a>
    </span>
  );
}
