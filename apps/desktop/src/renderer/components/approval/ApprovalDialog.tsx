/**
 * The approval card.
 *
 * Appears only in response to a real APPROVAL_REQUIRED event and sends a real
 * decision back through the IPC bridge to the dispatcher, which is still
 * awaiting the answer. There is no local "pretend to allow" path.
 *
 * Deliberate choices, carried over from the dialog it replaces:
 *
 * - It leads with WHAT and WHERE: the act, and the place it lands. Why is one
 *   click away, under Details, for anyone who wants it.
 * - Neither button is styled as the default, and Enter is not bound. An
 *   approval that can be dismissed by muscle memory is not an approval.
 * - The countdown is shown. The request expires into a denial, and a person who
 *   walks away should see that is what will happen.
 * - A high-risk act is said so in words, not only in colour.
 * - What will be sent is shown IN FULL. A person cannot consent to text they
 *   have not read. Anything shaped like a secret is hidden (see
 *   `approval-card.ts`) — and credentials are refused before any approval is
 *   raised in the first place.
 *
 * The decision carries the binding fingerprint back to main, so this card can
 * only ever authorise the request it actually rendered, and nothing else.
 */

import { useEffect, useState } from 'react';
import type { ApprovalDecision, ApprovalRequest } from '@axon/core';
import { describeApprovalCard } from './approval-card.js';

export interface ApprovalDialogProps {
  readonly request: ApprovalRequest;
  /**
   * `modal` (the panel): over a scrim. `docked` (the overlay): beside the orb,
   * with no scrim, so the desktop behind it stays exactly as it was. The card
   * and what its buttons send are identical either way.
   */
  readonly variant?: 'modal' | 'docked';
  readonly onDecide: (callId: string, decision: ApprovalDecision, fingerprint: string) => void;
}

function secondsLeft(expiresAt: string): number {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0;
}

export function ApprovalDialog({ request, onDecide, variant = 'modal' }: ApprovalDialogProps): React.JSX.Element {
  const [remaining, setRemaining] = useState(() => secondsLeft(request.expiresAt));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setRemaining(secondsLeft(request.expiresAt));
    setSubmitted(false);
    const timer = setInterval(() => {
      setRemaining(secondsLeft(request.expiresAt));
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [request.expiresAt, request.callId]);

  const decide = (decision: ApprovalDecision): void => {
    if (submitted) return;
    setSubmitted(true);
    onDecide(request.callId, decision, request.binding.fingerprint);
  };

  const card = describeApprovalCard(request);

  const body = (
      <div
        className={`approval${card.highRisk ? ' approval-high' : ''}${variant === 'docked' ? ' approval-docked' : ''}`}
        role="alertdialog"
        aria-modal={variant === 'docked' ? undefined : true}
        aria-labelledby="approval-title"
        aria-describedby="approval-act"
      >
        <p className="approval-eyebrow">
          <span className="approval-eyebrow-dot" aria-hidden="true" />
          AXON
        </p>
        <h2 id="approval-title" className="approval-heading">
          Action requires your approval
        </h2>

        <div className="approval-what">
          <p id="approval-act" className="approval-act">
            {card.act}
          </p>
          {card.where ? <p className="approval-where">{card.where}</p> : null}
        </div>

        {card.outward ? <p className="approval-outward">This may send something from the website.</p> : null}

        {card.highRisk ? (
          <p className="approval-warning" role="alert">
            This one is destructive, costly or hard to undo. Read it before allowing it.
          </p>
        ) : null}

        {card.contents.map((content) => (
          <div className="approval-content" key={`content:${content.label}`}>
            <div className="approval-content-label">{content.label}</div>
            {/* `pre-wrap`: what is read here and what is sent are the same
                characters in the same order, line breaks included. */}
            <div className={`approval-content-body${content.hidden ? ' approval-hidden' : ''}`}>{content.value}</div>
          </div>
        ))}

        <details className="approval-details">
          <summary>Details</summary>
          <dl className="approval-params">
            <div className="approval-param">
              <dt>Why Axon is asking</dt>
              <dd>{request.detail}</dd>
            </div>
            {card.details.map((detail) => (
              <div className="approval-param" key={`${detail.label}:${detail.value}`}>
                <dt>{detail.label}</dt>
                <dd className={detail.hidden ? 'approval-hidden' : undefined}>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>

        <div className="approval-actions">
          <button type="button" className="btn btn-deny" onClick={() => decide('DENY')} disabled={submitted}>
            Deny
          </button>
          <button type="button" className="btn btn-allow" onClick={() => decide('ALLOW')} disabled={submitted}>
            Allow
          </button>
        </div>

        <p className="approval-expiry" aria-live="polite">
          {submitted ? 'Sending your decision…' : `If you do nothing, this is denied in ${remaining}s`}
        </p>
      </div>
  );

  if (variant === 'docked') return body;
  return (
    <div className="approval-scrim" role="presentation">
      {body}
    </div>
  );
}
