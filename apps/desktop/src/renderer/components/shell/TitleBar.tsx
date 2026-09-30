/**
 * The title bar: the window's handle, the privacy indicator, and a few quiet
 * controls.
 *
 * The bar itself drags the window; the controls opt out. Windows paints its own
 * minimise, maximise and close buttons at the right-hand end, so the bar leaves
 * room for them rather than imitating them.
 *
 * The privacy indicator is permanent and says, in one word, where microphone
 * audio can currently go: "On-device" while Axon only listens for its name,
 * "Live" once a conversation is sending it to the voice service.
 */

import type { Theme } from '../../state/theme.js';

export interface PrivacyIndicator {
  readonly label: string;
  readonly tone: 'off' | 'armed' | 'live';
  readonly title: string;
}

export interface TitleBarProps {
  readonly theme: Theme;
  readonly privacy: PrivacyIndicator;
  readonly activityOpen: boolean;
  /** Development builds only: the raw event log names tools and states. */
  readonly showActivity: boolean;
  onToggleTheme(): void;
  onOpenSettings(): void;
  onToggleActivity(): void;
}

export function TitleBar(props: TitleBarProps): React.JSX.Element {
  const nextTheme = props.theme === 'dark' ? 'light' : 'dark';

  return (
    <header className="titlebar">
      <span className={`privacy-chip privacy-${props.privacy.tone}`} title={props.privacy.title} role="status">
        <span className="privacy-dot" aria-hidden="true" />
        {props.privacy.label}
      </span>

      <span className="titlebar-actions">
        {props.showActivity ? (
          <button
            type="button"
            className="icon-button"
            onClick={props.onToggleActivity}
            aria-pressed={props.activityOpen}
            aria-label="Developer activity"
            title="Developer activity"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 10h3l2-5 4 10 2-5h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
        >
          {props.theme === 'dark' ? (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.5 12.4A6.5 6.5 0 0 1 7.6 4.5a6.5 6.5 0 1 0 7.9 7.9z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button type="button" className="icon-button" onClick={props.onOpenSettings} aria-label="Settings" title="Settings">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M10 2.8l1.3 1.9 2.2-.6.4 2.3 2.1.9-.9 2.1.9 2.1-2.1.9-.4 2.3-2.2-.6L10 17.2l-1.3-1.9-2.2.6-.4-2.3-2.1-.9.9-2.1-.9-2.1 2.1-.9.4-2.3 2.2.6z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </header>
  );
}
