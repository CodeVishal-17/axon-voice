/**
 * Turning the event stream into timeline rows.
 *
 * A pure function of `AxonEvent`, kept out of the component so it can be read
 * and tested on its own. Every row corresponds to exactly one real event —
 * there is no synthesis, no "probably happened", and no placeholder row while
 * something is in flight. If the timeline shows it, it is in the JSONL log.
 */

import type { AxonEvent } from '@axon/core';

export type TimelineTone = 'neutral' | 'active' | 'attention' | 'success' | 'failure' | 'muted';

export interface TimelineEntry {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: TimelineTone;
  /** Rendered as a thin rule instead of a full row. */
  readonly minor: boolean;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function preview(value: unknown, max = 120): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What each persistence action is called in the timeline. */
const SESSION_LABELS = {
  created: 'New conversation',
  restored: 'Session restored',
  renamed: 'Conversation renamed',
  archived: 'Conversation archived',
  deleted: 'Conversation deleted',
} as const;

const MEMORY_LABELS = {
  created: 'Memory saved',
  updated: 'Memory updated',
  deleted: 'Memory deleted',
  cleared: 'Memory cleared',
} as const;

export function toTimelineEntry(event: AxonEvent): TimelineEntry {
  const base = { id: event.id, seq: event.seq, at: clock(event.at) };

  switch (event.type) {
    case 'STATE_CHANGED':
      return {
        ...base,
        label: event.to,
        detail: event.reason,
        tone: event.to === 'ERROR' ? 'failure' : 'muted',
        minor: true,
      };

    case 'LISTENING':
      return { ...base, label: 'Listening', detail: `via ${event.trigger}`, tone: 'active', minor: false };

    case 'THINKING':
      // "Understanding" reads better to a user than the internal state name.
      return { ...base, label: 'Understanding', detail: event.note, tone: 'active', minor: false };

    case 'PLANNING':
      return {
        ...base,
        label: 'Planning',
        detail: event.steps.length > 0 ? `${event.summary} · ${event.steps.length} steps` : event.summary,
        tone: 'active',
        minor: false,
      };

    case 'TOOL_CALL':
      return {
        ...base,
        label: 'Tool Call',
        detail: `${event.tool} · ${preview(event.input)}`,
        // HIGH_RISK reads as a failure tone deliberately: the row for a call
        // that could delete something should not look like the row for a
        // search box.
        tone: event.risk === 'SAFE' ? 'neutral' : event.risk === 'HIGH_RISK' ? 'failure' : 'attention',
        minor: false,
      };

    case 'TOOL_RESULT':
      return {
        ...base,
        label: 'Tool Result',
        detail: event.ok
          ? `${event.tool} · ${preview(event.output)}`
          : `${event.tool} · ${event.failure?.kind ?? 'FAILED'} · ${event.failure?.message ?? ''}`,
        tone: event.ok ? 'success' : 'failure',
        minor: false,
      };

    case 'OBSERVATION':
      return { ...base, label: 'Observation', detail: event.summary, tone: 'neutral', minor: false };

    case 'APPROVAL_REQUIRED':
      return {
        ...base,
        label: 'Approval Required',
        detail: event.request.title,
        tone: 'attention',
        minor: false,
      };

    case 'APPROVAL_RESOLVED':
      return {
        ...base,
        label: event.decision === 'ALLOW' ? 'Approved' : 'Denied',
        // Distinguishing a human "deny" from an unanswered prompt matters: one
        // is a decision, the other is a default.
        detail: event.resolvedBy === 'user' ? 'by you' : `automatically (${event.resolvedBy})`,
        tone: event.decision === 'ALLOW' ? 'success' : 'failure',
        minor: false,
      };

    case 'COMPLETED':
      return { ...base, label: 'Completed', detail: event.summary, tone: 'success', minor: false };

    case 'ERROR':
      return {
        ...base,
        label: 'Error',
        detail: `${event.scope}: ${event.message}`,
        tone: 'failure',
        minor: false,
      };

    // The transcript renders these in full; in the timeline they are markers
    // that a turn started and ended, so they stay short.
    case 'USER_MESSAGE':
      return { ...base, label: 'You', detail: preview(event.text), tone: 'neutral', minor: false };

    case 'ASSISTANT_MESSAGE':
      return { ...base, label: 'Axon', detail: preview(event.text), tone: 'active', minor: false };

    // Speech rows describe the utterance, never repeat it: the words are
    // already in the ASSISTANT_MESSAGE row directly above.
    case 'SPEECH_STARTED':
      return {
        ...base,
        label: 'Speaking',
        detail: `${(event.durationMs / 1000).toFixed(1)}s${event.truncated ? ' · reply shortened for speech' : ''}`,
        tone: 'active',
        minor: false,
      };

    case 'SPEECH_ENDED':
      return {
        ...base,
        label: event.reason === 'completed' ? 'Finished speaking' : 'Speech stopped',
        detail: event.reason === 'completed' ? '' : event.reason,
        tone: event.reason === 'completed' ? 'muted' : 'attention',
        minor: event.reason === 'completed',
      };

    // Persistence rows are deliberately quiet. A user should be able to see
    // that a conversation was restored or a memory saved, because those are
    // things Axon did on their behalf — and should never see a row per write,
    // which would bury the tool calls that actually matter.
    case 'SESSION_CHANGED':
      return {
        ...base,
        label: SESSION_LABELS[event.action],
        detail: event.title,
        tone: event.action === 'deleted' ? 'attention' : 'muted',
        // Only restoring is worth a full row: it explains why there is already
        // a conversation on screen when the app opens.
        minor: event.action !== 'restored',
      };

    case 'MEMORY_CHANGED':
      return {
        ...base,
        label: MEMORY_LABELS[event.action],
        // The key, never the value. The value is the part most likely to be
        // personal, and this row is written to the JSONL log.
        detail: event.action === 'cleared' ? `${event.count} item(s)` : (event.key ?? ''),
        tone: 'neutral',
        minor: false,
      };

    case 'SETTINGS_UPDATED':
      return {
        ...base,
        label: 'Settings updated',
        detail: event.keys.join(', '),
        tone: 'muted',
        minor: true,
      };

    case 'VOICE_SESSION': {
      // The privacy row. "Armed" and "activated" are different facts and the
      // timeline says which: one is a local recognizer waiting for a name, the
      // other is the moment audio began leaving the machine.
      const labels = {
        armed: 'Wake word ready',
        disarmed: 'Wake word off',
        activated: 'Voice session started',
        connected: 'Voice connected',
        reconnecting: 'Voice reconnecting',
        ended: 'Voice session ended',
        failed: 'Voice session failed',
      } as const;
      return {
        ...base,
        label: labels[event.action],
        detail: event.activation ? `${event.detail} (${event.activation})` : event.detail,
        tone: event.action === 'failed' ? 'failure' : event.action === 'activated' ? 'attention' : 'neutral',
        minor: event.action === 'armed' || event.action === 'disarmed',
      };
    }

    case 'PERSISTENCE_ERROR':
      return {
        ...base,
        label: 'Not saved',
        detail: event.message,
        // Attention rather than failure: Axon is still working, it just is not
        // remembering — which the user needs to know without being alarmed.
        tone: 'attention',
        minor: false,
      };

    default: {
      const exhaustive: never = event;
      return {
        id: 'unknown',
        seq: -1,
        at: '--:--:--',
        label: 'Unknown',
        detail: String(exhaustive),
        tone: 'muted',
        minor: true,
      };
    }
  }
}

export function toTimeline(events: readonly AxonEvent[]): readonly TimelineEntry[] {
  return events.map(toTimelineEntry);
}
