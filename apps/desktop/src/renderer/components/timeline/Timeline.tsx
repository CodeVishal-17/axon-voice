import { useEffect, useRef } from 'react';
import type { AxonEvent } from '@axon/core';
import { toTimeline } from './timeline-model.js';

export interface TimelineProps {
  readonly events: readonly AxonEvent[];
}

/**
 * The action timeline.
 *
 * Auto-follows the tail only while the user is already at the bottom. Yanking
 * the view down while somebody is reading an earlier entry is the single most
 * common way a live log becomes unusable.
 */
export function Timeline({ events }: TimelineProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const entries = toTimeline(events);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries.length]);

  return (
    <section className="timeline" aria-label="Action timeline">
      <header className="panel-header">
        <h2>Timeline</h2>
        <span className="panel-count">{entries.length}</span>
      </header>

      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {entries.length === 0 ? (
          <p className="empty">No events yet.</p>
        ) : (
          <ol className="timeline-list">
            {entries.map((entry) =>
              entry.minor ? (
                <li key={entry.id} className="timeline-minor">
                  <span className="timeline-minor-label">{entry.label}</span>
                  <span className="timeline-minor-detail">{entry.detail}</span>
                </li>
              ) : (
                <li key={entry.id} className={`timeline-row tone-${entry.tone}`}>
                  <span className="timeline-time">{entry.at}</span>
                  <span className="timeline-marker" aria-hidden="true" />
                  <span className="timeline-body">
                    <span className="timeline-label">{entry.label}</span>
                    {entry.detail ? <span className="timeline-detail">{entry.detail}</span> : null}
                  </span>
                </li>
              ),
            )}
          </ol>
        )}
      </div>
    </section>
  );
}
