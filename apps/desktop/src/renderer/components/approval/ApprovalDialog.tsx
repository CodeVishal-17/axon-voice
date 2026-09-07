/**
 * The approval dialog.
 *
 * Appears only in response to a real APPROVAL_REQUIRED event and sends a real
 * decision back through the IPC bridge to the dispatcher, which is still
 * awaiting the answer. There is no local "pretend to allow" path.
 *
 * Four deliberate choices:
 *
 * - Neither button is styled as the default, and Enter is not bound. An
 *   approval that can be dismissed by muscle memory is not an approval.
 * - The countdown is shown. The request expires into a *denial*, and a user
 *   who walks away should be able to see that is what will happen.
 * - HIGH_RISK is presented differently from REQUIRES_APPROVAL, in colour and
 *   in words. A user asked identically about "write a file to your Desktop"
 *   and "delete this repository" learns to answer both the same way, and the
 *   second question is the one that matters.
 * - An outward action states, in a line of its own, that something is about
 *   to leave this machine and where it is going. "Submit a comment" and
 *   "fill in a field" look almost identical in a parameter list, and only one
 *   of them is a thing the user said in public under their own name.
 *
 * WHAT IS SENT IS SHOWN IN FULL. Where a parameter carries content — the text
 * of a comment, the body of a message — it is rendered as a block, wrapped,
 * with its line breaks intact, rather than squeezed into a definition list. A
 * user cannot consent to text they have not read, and "Thanks for the
 * clarification…" with the rest elided is a dialog that produces consent
 * without comprehension.
 *
 * The decision carries the binding fingerprint back to main, so this dialog
 * can only ever authorise the request it actually rendered.
 */

import { useEffect, useState } from 'react';
import type { ApprovalDecision, ApprovalRequest } from '@axon/core';

export interface ApprovalDialogProps {
  readonly request: ApprovalRequest;
  readonly onDecide: (callId: string, decision: ApprovalDecision, fingerprint: string) => void;
}

function secondsLeft(expiresAt: string): number {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0;
}

/**
 * Which parameters are content rather than metadata.
 *
 * Content gets a readable block; everything else stays in the compact list.
 * Matched on the label because the label is written by the tool's own
 * `summarize`, in this codebase, and is the only place that knows whether a
 * value is a path or a paragraph.
 */
const CONTENT_LABELS = new Set(['Text', 'Content', 'Draft', 'Message']);

export function ApprovalDialog({ request, onDecide }: ApprovalDialogProps): React.JSX.Element {
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

  const outward = request.binding.effect === 'EXTERNAL';
  const details = request.parameters.filter((parameter) => !CONTENT_LABELS.has(parameter.label));
  const contents = request.parameters.filter((parameter) => CONTENT_LABELS.has(parameter.label));

  return (
    <div className="approval-scrim" role="presentation">
      <div className="approval" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <div className={`approval-risk approval-risk-${request.risk.toLowerCase()}`}>
          {request.risk === 'HIGH_RISK' ? 'High risk' : request.risk.replace(/_/g, ' ').toLowerCase()}
        </div>

        <h2 id="approval-title" className="approval-title">
          {request.title}
        </h2>

        {/* Said before the parameters, not buried among them. This is the one
            fact that distinguishes a draft from a thing the user has said. */}
        {outward ? (
          <p className="approval-outward">
            This leaves your computer: Axon will {request.binding.action}
            {request.binding.target ? ` at ${request.binding.target}` : ''}.
          </p>
        ) : null}

        <dl className="approval-params">
          {details.map((parameter) => (
            <div className="approval-param" key={`${parameter.label}:${parameter.value}`}>
              <dt>{parameter.label}</dt>
              <dd>{parameter.value}</dd>
            </div>
          ))}
        </dl>

        {contents.map((parameter) => (
          <div className="approval-content" key={`content:${parameter.label}`}>
            <div className="approval-content-label">{parameter.label}</div>
            {/* `pre-wrap` via the stylesheet: what the user reads here and
                what lands in the field are the same characters in the same
                order, line breaks included. */}
            <div className="approval-content-body">{parameter.value}</div>
          </div>
        ))}

        <p className="approval-detail">{request.detail}</p>

        {/* Said in words, not only in colour. Someone who cannot distinguish
            the accent still gets the warning. */}
        {request.risk === 'HIGH_RISK' ? (
          <p className="approval-warning" role="alert">
            This one is destructive, costly or hard to undo. Read it before allowing it.
          </p>
        ) : null}

        <div className="approval-actions">
          <button type="button" className="btn btn-deny" onClick={() => { decide('DENY'); }} disabled={submitted}>
            Deny
          </button>
          <button type="button" className="btn btn-allow" onClick={() => { decide('ALLOW'); }} disabled={submitted}>
            Allow
          </button>
        </div>

        <p className="approval-expiry">
          {submitted ? 'Sending decision…' : `Denied automatically in ${remaining}s`}
        </p>
      </div>
    </div>
  );
}
