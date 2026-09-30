/**
 * What the window says, in words a person would use.
 *
 * PURE. The renderer receives Axon's real state and events; this turns them
 * into the one short line under the orb and the one exchange above the fold.
 * Kept out of the components so it can be tested without a DOM, and so the
 * rule it enforces lives in one place:
 *
 *   THE USER NEVER SEES THE MACHINERY. No tool names, task or step ids,
 *   internal statuses, policy terms or stack traces. Main already phrases its
 *   captions for people ("Opening YouTube"); this is the second line, and
 *   anything that looks internal is replaced with a plain sentence rather than
 *   shown.
 */

import type { AxonEvent, AxonState, ListeningStatus, VoiceAgentStatus } from '@axon/core';

export type PresenceTone = 'calm' | 'active' | 'attention' | 'problem';

export interface Presence {
  /** The main line. Short. */
  readonly headline: string;
  /** An optional quieter line beneath it. */
  readonly detail: string | null;
  readonly tone: PresenceTone;
}

/**
 * Text that must never reach the screen.
 *
 * Tool names are matched by their real prefixes, so an ordinary host such as
 * "youtube.com" is not mistaken for one.
 */
const INTERNAL: readonly RegExp[] = [
  /\b(browser|app|system|window|memory|fs|ui|keyboard)\.[a-z_]+\b/i,
  /\b(task|step|call)[-_ ]?(id\b|[0-9a-f]{3,})/i,
  /\b(REQUIRES_APPROVAL|HIGH_RISK|FORBIDDEN|SAFE|EXECUTION_ERROR|CLARIFICATION_NEEDED|APPROVAL_TIMEOUT)\b/,
  /\b(dispatcher|fingerprint|policy engine|orchestrator)\b/i,
  /\bat [^\s]+ \(?[^\s]+:\d+:\d+\)?/, // a stack frame
  /\b(TypeError|ReferenceError|SyntaxError|Error):/,
  /[A-Za-z]:\\|\/src\/|\.tsx?:\d+/, // a path
];

/** Is this safe and sensible to show a person? */
export function isPresentable(text: string | null | undefined): text is string {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > 160) return false;
  return !INTERNAL.some((pattern) => pattern.test(trimmed));
}

function lastReasonInto(events: readonly AxonEvent[], state: AxonState): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'STATE_CHANGED' && event.to === state) return event.reason;
  }
  return null;
}

function lastError(events: readonly AxonEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'ERROR') return event.message;
  }
  return null;
}

function ellipsis(text: string): string {
  const trimmed = text.trim().replace(/[.…]+$/, '');
  return `${trimmed}…`;
}

export interface PresenceInput {
  readonly state: AxonState;
  readonly events: readonly AxonEvent[];
  readonly voiceAgent: VoiceAgentStatus;
  readonly listening: ListeningStatus;
}

/** The line under the orb, for the state Axon is really in. */
export function presenceFor({ state, events, voiceAgent, listening }: PresenceInput): Presence {
  switch (state) {
    case 'WAITING_FOR_APPROVAL':
      return { headline: 'Axon needs your approval', detail: null, tone: 'attention' };

    case 'ERROR': {
      const message = lastError(events);
      return {
        headline: 'Something went wrong',
        detail: isPresentable(message) ? message : 'Try again when you are ready.',
        tone: 'problem',
      };
    }

    case 'LISTENING':
      return { headline: 'Listening…', detail: null, tone: 'active' };

    case 'THINKING':
      if (voiceAgent.active && voiceAgent.phase === 'CONNECTING') {
        return { headline: 'Connecting…', detail: null, tone: 'active' };
      }
      return { headline: 'Thinking…', detail: null, tone: 'active' };

    case 'EXECUTING': {
      const reason = lastReasonInto(events, 'EXECUTING');
      return { headline: isPresentable(reason) ? ellipsis(reason) : 'Working on it…', detail: null, tone: 'active' };
    }

    case 'SPEAKING':
      return { headline: 'Speaking…', detail: null, tone: 'active' };

    case 'IDLE':
    default: {
      if (voiceAgent.armed) {
        return { headline: 'Say “Hey Axon”', detail: 'Listening for your wake phrase on this device', tone: 'calm' };
      }
      if (voiceAgent.available || listening.available) {
        return { headline: 'Ready', detail: 'Click the orb to talk', tone: 'calm' };
      }
      const reason = voiceAgent.reason ?? listening.reason;
      return {
        headline: 'Voice is unavailable',
        detail: isPresentable(reason) ? reason : 'Check the voice settings.',
        tone: 'calm',
      };
    }
  }
}

export interface Turn {
  readonly id: string;
  readonly role: 'user' | 'axon';
  readonly text: string;
}

export interface Exchange {
  /** What the person last said or typed. */
  readonly user: Turn | null;
  /** Axon's latest reply to it, once there is one. */
  readonly axon: Turn | null;
  /** Everything before the current exchange, oldest first. */
  readonly earlier: readonly Turn[];
}

/** The current interaction, and the history that stays collapsed behind it. */
export function currentExchange(events: readonly AxonEvent[]): Exchange {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.type === 'USER_MESSAGE') turns.push({ id: event.id, role: 'user', text: event.text });
    else if (event.type === 'ASSISTANT_MESSAGE') turns.push({ id: event.id, role: 'axon', text: event.text });
  }

  let userIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === 'user') {
      userIndex = i;
      break;
    }
  }

  if (userIndex === -1) {
    const lastAxon = turns.at(-1) ?? null;
    return { user: null, axon: lastAxon, earlier: lastAxon ? turns.slice(0, -1) : turns };
  }

  const after = turns.slice(userIndex + 1);
  const axon = [...after].reverse().find((turn) => turn.role === 'axon') ?? null;
  return { user: turns[userIndex] ?? null, axon, earlier: turns.slice(0, userIndex) };
}

/** The host of a URL, for display. Never the path or query, which can carry tokens. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
