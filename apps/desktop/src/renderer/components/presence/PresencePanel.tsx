/**
 * The words beneath the orb.
 *
 * One short line for what Axon is doing, an optional quieter line, and the
 * current exchange — what you said and what Axon answered. Earlier exchanges
 * stay folded away: this is a companion, not a chat log, and the active
 * interaction gets the space.
 *
 * Everything here arrives already made safe to show (see `presence.ts`), and is
 * announced to assistive technology, so the orb is never the only way to know
 * what state Axon is in.
 */

import type { Exchange, Presence } from '../../state/presence.js';

export interface PresencePanelProps {
  readonly presence: Presence;
  readonly exchange: Exchange;
  readonly notice: string | null;
  readonly browsingHost: string | null;
  readonly speaking: boolean;
  onStopSpeaking(): void;
  /**
   * The orb's action, when that action STOPS something, shown as a visible
   * control beside "Stop speaking".
   *
   * The orb is a button and has been all along, but nothing said so: its label
   * lived in `title` and `aria-label`. A person whose conversation had ended
   * reported having no way to stop it from inside the app, which is what an
   * invisible affordance amounts to. Starting is discoverable enough — the orb
   * invites a click and the hotkey works — so only the stop appears here.
   */
  readonly stopAction: { readonly label: string; run(): void } | null;
}

export function PresencePanel({
  presence,
  exchange,
  notice,
  browsingHost,
  speaking,
  onStopSpeaking,
  stopAction,
}: PresencePanelProps): React.JSX.Element {
  return (
    <section className="presence">
      <h1 className="brand">AXON</h1>

      <div className="presence-lines" role="status" aria-live="polite">
        <p className={`presence-headline tone-${presence.tone}`}>{presence.headline}</p>
        {presence.detail ? <p className="presence-detail">{presence.detail}</p> : null}
      </div>

      {notice ? (
        <p className="presence-notice" role="alert">
          {notice}
        </p>
      ) : null}

      {browsingHost || speaking || stopAction ? (
        <div className="presence-chips">
          {browsingHost ? (
            <span className="chip-soft" title="Axon's browser window is open">
              <span className="chip-soft-dot" aria-hidden="true" />
              Browsing {browsingHost}
            </span>
          ) : null}
          {speaking ? (
            <button type="button" className="pill-button" onClick={onStopSpeaking}>
              Stop speaking
            </button>
          ) : null}
          {stopAction ? (
            <button type="button" className="pill-button" onClick={stopAction.run}>
              {stopAction.label}
            </button>
          ) : null}
        </div>
      ) : null}

      {exchange.user || exchange.axon ? (
        <div className="exchange" aria-label="Current conversation">
          {exchange.user ? (
            <div className="exchange-row exchange-user">
              <span className="exchange-who">You</span>
              <p className="exchange-text">{exchange.user.text}</p>
            </div>
          ) : null}
          {exchange.axon ? (
            <div className="exchange-row exchange-axon">
              <span className="exchange-who">Axon</span>
              <p className="exchange-text">{exchange.axon.text}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {exchange.earlier.length > 0 ? (
        <details className="earlier">
          <summary>Earlier ({exchange.earlier.length})</summary>
          <ol className="earlier-list">
            {exchange.earlier.map((turn) => (
              <li key={turn.id} className={`earlier-turn earlier-${turn.role}`}>
                <span className="exchange-who">{turn.role === 'user' ? 'You' : 'Axon'}</span>
                <span className="earlier-text">{turn.text}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
