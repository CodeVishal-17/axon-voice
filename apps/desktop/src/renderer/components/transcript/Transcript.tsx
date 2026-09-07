/**
 * The conversation transcript.
 *
 * Derived entirely from USER_MESSAGE and ASSISTANT_MESSAGE events, like every
 * other view in this app. Nothing here is stored locally on submit: the
 * message appears because the main process emitted it, which means the
 * transcript and the JSONL log can never disagree about what was said.
 *
 * Only visible model output reaches this component. Reasoning is requested in
 * its omitted form and never enters the event stream, so there is no hidden
 * chain-of-thought to leak into the UI.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { AxonEvent } from '@axon/core';

interface Turn {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'axon';
  readonly text: string;
}

function toTurns(events: readonly AxonEvent[]): readonly Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.type === 'USER_MESSAGE') {
      turns.push({ id: event.id, seq: event.seq, role: 'user', text: event.text });
    } else if (event.type === 'ASSISTANT_MESSAGE') {
      turns.push({ id: event.id, seq: event.seq, role: 'axon', text: event.text });
    }
  }
  return turns;
}

export interface TranscriptProps {
  readonly events: readonly AxonEvent[];
  readonly busy: boolean;
}

export function Transcript({ events, busy }: TranscriptProps): React.JSX.Element {
  const turns = useMemo(() => toTurns(events), [events]);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns.length, busy]);

  if (turns.length === 0) {
    return (
      <div className="transcript transcript-empty">
        <p>Ask Axon to do something on your computer.</p>
        <p className="transcript-hint">Try “open Notepad” or “write hello world to my workspace”.</p>
      </div>
    );
  }

  return (
    <div className="transcript" aria-live="polite">
      {turns.map((turn) => (
        <article key={turn.id} className={`turn turn-${turn.role}`}>
          <span className="turn-who">{turn.role === 'user' ? 'You' : 'Axon'}</span>
          <p className="turn-text">{turn.text}</p>
        </article>
      ))}

      {busy ? (
        <article className="turn turn-axon turn-pending">
          <span className="turn-who">Axon</span>
          <span className="turn-dots" aria-label="Axon is working">
            <i />
            <i />
            <i />
          </span>
        </article>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
