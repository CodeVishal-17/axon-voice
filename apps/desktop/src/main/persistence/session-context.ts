/**
 * Turning stored history into the context a turn is given.
 *
 * THIS FILE IS THE BOUND. Persistence without it would be a slow-motion bug:
 * every conversation would grow, every prompt would grow with it, and the
 * failure — a request that costs ten times what it should, or is rejected
 * outright — would arrive weeks after the code that caused it, on the machine
 * of whoever had used Axon the most.
 *
 * So the limits are enforced here, in code, on the way out of the database.
 * Not asked of the model, not left to a token estimate at the API boundary.
 * `store.ts` will happily hold five hundred messages; this decides how few of
 * them a prompt ever sees.
 *
 * Pure: everything it needs arrives as an argument, so the limits can be
 * tested exhaustively without a database.
 */

import {
  PERSISTENCE_LIMITS,
  type ContextMemory,
  type MemoryEntry,
  type MessageRecord,
  type SessionContext,
  type SessionDigest,
} from '@axon/core';

export interface RestoredHistory {
  /** Messages to replay, oldest first. Already inside every limit. */
  readonly messages: readonly MessageRecord[];
  /** True when older messages were dropped to fit. */
  readonly truncated: boolean;
}

/**
 * Choose which stored messages to replay.
 *
 * Two limits, both from the newest end: a message count, and a character
 * budget. The count alone is not enough — twenty-four messages can be a
 * hundred characters or a hundred thousand, and only one of those is a prompt.
 *
 * Selection walks BACKWARD from the most recent and stops at whichever limit
 * binds first, which keeps the most relevant history rather than the oldest.
 * The result is then re-ordered oldest-first, because that is the order a
 * conversation has to be read in.
 */
export function restoreHistory(
  stored: readonly MessageRecord[],
  limits: { maxMessages?: number; maxCharacters?: number } = {},
): RestoredHistory {
  const maxMessages = limits.maxMessages ?? PERSISTENCE_LIMITS.maxRestoredMessages;
  const maxCharacters = limits.maxCharacters ?? PERSISTENCE_LIMITS.maxRestoredCharacters;

  const chosen: MessageRecord[] = [];
  let characters = 0;

  for (let i = stored.length - 1; i >= 0; i -= 1) {
    const message = stored[i];
    if (!message) continue;
    if (chosen.length >= maxMessages) break;

    const cost = message.content.length;
    // Always take at least one message: a single message longer than the whole
    // budget should still be replayed rather than leaving the model with
    // nothing at all to answer from.
    if (chosen.length > 0 && characters + cost > maxCharacters) break;

    characters += cost;
    chosen.push(message);
  }

  chosen.reverse();
  return { messages: chosen, truncated: chosen.length < stored.length };
}

/**
 * Project stored memories into what a prompt may see.
 *
 * Three strings each — no ids, no timestamps, no sensitivity flag, no source.
 * The model does not need those to use a memory, and every field omitted is a
 * field that cannot end up quoted back to the user or written somewhere else.
 *
 * Disabled memories are excluded upstream by the store; excluded again here so
 * that a caller passing an unfiltered list still cannot leak one.
 */
export function toContextMemories(
  memories: readonly MemoryEntry[],
  limit: number = PERSISTENCE_LIMITS.maxContextMemories,
): readonly ContextMemory[] {
  return memories
    .filter((memory) => memory.enabled)
    .slice(0, Math.max(0, limit))
    .map((memory) => ({ category: memory.category, key: memory.key, value: memory.value }));
}

/** Assemble the bounded context for one turn. */
export function buildSessionContext(input: {
  sessionId: string;
  summary: string | null;
  memories: readonly MemoryEntry[];
  history: RestoredHistory;
  memoryEnabled: boolean;
  /** The machine's clock, as an ISO string. Never the model's idea of now. */
  now: string;
  /** Earlier conversations, already dated and bounded by `temporal.ts`. */
  recent?: readonly SessionDigest[];
}): SessionContext {
  return {
    sessionId: input.sessionId,
    summary: input.summary === null ? null : input.summary.slice(0, PERSISTENCE_LIMITS.maxSummaryCharacters),
    // A user who turned memory off gets none, rather than a filtered few.
    memories: input.memoryEnabled ? toContextMemories(input.memories) : [],
    truncated: input.history.truncated,
    now: input.now,
    // Bounded here as well as at the call site. A caller passing an unfiltered
    // list still cannot put a hundred conversations into a prompt.
    recent: (input.recent ?? []).slice(0, PERSISTENCE_LIMITS.maxContextSessions),
  };
}

/**
 * Build a session summary from the visible transcript.
 *
 * Deterministic, and deliberately so. The obvious alternative is to ask the
 * model to summarise, which costs a request per conversation, adds a failure
 * mode to startup, and — the actual objection — produces a summary derived
 * from whatever the model was thinking, which is exactly the thing that must
 * not be persisted.
 *
 * What this produces instead is a trace of what the USER asked for: their
 * first request, their most recent ones, bounded and stripped. That is enough
 * for "what was I working on yesterday?", it contains nothing the user did not
 * say themselves, and it cannot leak reasoning because it never sees any.
 */
export function summarizeSession(messages: readonly MessageRecord[], limit: number = PERSISTENCE_LIMITS.maxSummaryCharacters): string | null {
  const requests = messages.filter((message) => message.role === 'user').map((message) => oneLine(message.content));
  if (requests.length === 0) return null;

  // The first request usually states the goal; the last few say where it got
  // to. The middle is where the back-and-forth lives and is the least useful
  // per character.
  const first = requests[0];
  const recent = requests.slice(-3).filter((request) => request !== first);
  const parts = [first, ...recent].filter((part): part is string => Boolean(part) && part !== '');

  const summary = parts.join(' · ');
  return summary.length <= limit ? summary : `${summary.slice(0, limit - 1)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
