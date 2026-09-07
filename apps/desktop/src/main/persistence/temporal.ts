/**
 * Resolving "yesterday" against a clock rather than against a guess.
 *
 * WHY THIS EXISTS.
 *
 * "The GitHub issue I was working on yesterday" is the flagship request, and
 * it contains a word no language model can evaluate. A model has no clock. Ask
 * one what "yesterday" means and it will answer from its training data, pick a
 * date months in the past, and then reason confidently from it — a wrong
 * answer shaped exactly like a right one, which is the worst kind.
 *
 * So Axon supplies the time. `now` comes from the machine's clock, the
 * conversation digests come from real `updatedAt` columns, and `when` is
 * computed here by comparing the two. The model is told what yesterday
 * contained; it is never asked to work out when yesterday was.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * No parsing of the user's phrasing. There is no table mapping "last week" or
 * "the other day" to a range, because that is a guess dressed as a rule, and
 * the failure — silently picking the wrong conversation — is invisible to the
 * user. Axon provides dated facts and lets the model match them against what
 * the user said; when two conversations fit, the right behaviour is to ask,
 * not to rank.
 *
 * Pure: two dates in, a string out.
 */

import { PERSISTENCE_LIMITS, type SessionDigest, type SessionRecord } from '@axon/core';

/** Local-calendar midnight for a date. Day boundaries are local, not UTC. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How a timestamp reads relative to now.
 *
 * Calendar days, not elapsed hours: "yesterday" at 00:30 means the previous
 * calendar day, which is what a person means and what `Math.floor(hours/24)`
 * gets wrong every night.
 *
 * Beyond a week it returns the date itself. "Twenty-three days ago" is a
 * number nobody holds in their head, and the ISO date is both shorter and
 * checkable.
 */
export function describeWhen(then: string, now: Date): string {
  const at = new Date(then);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';

  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);

  // A future timestamp means a clock changed, not that Axon knows the future.
  // Saying "in 2 days" would be a confident lie about a corrupted row.
  if (days < 0) return `at ${at.toISOString().slice(0, 10)}`;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return `${days} days ago`;
  return `on ${at.toISOString().slice(0, 10)}`;
}

/**
 * Project stored conversations into dated digests for a prompt.
 *
 * Bounded twice: by count, and by characters per digest. Excludes the
 * conversation currently open — its content is already in the history and the
 * summary, and repeating it as "earlier work" would invite the model to treat
 * this conversation as a different one.
 */
export function toSessionDigests(
  sessions: readonly SessionRecord[],
  options: { now: Date; excludeId?: string | null; limit?: number },
): readonly SessionDigest[] {
  const limit = options.limit ?? PERSISTENCE_LIMITS.maxContextSessions;

  return sessions
    .filter((session) => session.id !== options.excludeId)
    .filter((session) => session.status === 'active')
    .slice(0, Math.max(0, limit))
    .map((session) => ({
      title: session.title.slice(0, PERSISTENCE_LIMITS.maxTitleCharacters),
      summary:
        session.summary === null
          ? null
          : session.summary.slice(0, PERSISTENCE_LIMITS.maxSessionDigestCharacters),
      updatedAt: session.updatedAt,
      when: describeWhen(session.updatedAt, options.now),
    }));
}
