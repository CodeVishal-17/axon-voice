/**
 * `system.time` — what time it actually is on this computer.
 *
 * WHY A TOOL, WHEN THE PROMPT ALREADY CARRIES A TIMESTAMP.
 *
 * It carries the timestamp from when the session was configured, which is the
 * wrong answer the moment the conversation is more than a minute old — and a
 * voice session can run for half an hour. Worse, a model asked what time it is
 * will answer from that stale value with complete confidence, or, if there is
 * no value at hand, from whatever its training suggests. Both are the same
 * failure: an assertion about the user's machine that nothing on the machine
 * produced.
 *
 * So the clock becomes a tool. The model cannot compute the answer, cannot
 * adjust it, and cannot pass a time in — the schema takes nothing, so there is
 * no argument through which a claimed "now" could arrive. The only value that
 * reaches the output comes from `Date` inside the main process. That is what
 * makes "the model must not guess the time" a mechanical property rather than
 * an instruction it may or may not follow.
 *
 * WHAT IS DELIBERATELY NOT HERE. No network time source: this reports the
 * computer's clock, which is what the user means when they ask what time it
 * is, and reaching the network to answer it would be a capability added for
 * nothing. No locale argument, no format argument, no timezone argument. The
 * output carries the pieces; the model does the sentence.
 *
 * SAFE. It reads a clock. Nothing leaves the machine, nothing is written, and
 * there is nothing here a page or another application could influence.
 */

import { z } from 'zod';
import { defineTool, type RegisteredTool, type RiskAssessment, type SideEffectClass, type ToolSummary } from '@axon/core';

/**
 * No arguments, and that is a security property rather than a simplification.
 *
 * Zod strips unknown keys, so a call that tries to supply its own `now`,
 * `timezone` or `date` has those discarded before the executor sees anything.
 * There is no path from a model's assertion about the time into this tool's
 * answer.
 */
const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface SystemTimeOutput {
  /** ISO-8601 in UTC, e.g. 2026-09-09T13:04:22.031Z. */
  readonly utc: string;
  /** Local calendar date, e.g. 2026-09-09. */
  readonly date: string;
  /** Local 24-hour clock time, e.g. 14:04. */
  readonly time: string;
  /** Local time with seconds, for anything that needs them. */
  readonly timeWithSeconds: string;
  /** Local day name, e.g. Wednesday. */
  readonly dayOfWeek: string;
  /**
   * The IANA timezone identifier, e.g. Europe/London.
   *
   * Null when the runtime cannot resolve one. Reported as null rather than
   * guessed: a wrong timezone is worse than an absent one, because it is
   * arithmetic the model will do confidently.
   */
  readonly timezone: string | null;
  /** UTC offset as a signed string, e.g. +05:30. */
  readonly utcOffset: string;
  readonly utcOffsetMinutes: number;
  /** Milliseconds since the Unix epoch, for anything doing arithmetic. */
  readonly epochMs: number;
  [key: string]: string | number | null;
}

export interface SystemTimeToolOptions {
  /** Injected in tests, so the clock can be pinned. Defaults to the real one. */
  readonly now?: () => Date;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/**
 * The offset the way a person writes it.
 *
 * `getTimezoneOffset` returns minutes to ADD to local time to reach UTC, so
 * its sign is the opposite of the one in +05:30. Getting that backwards is the
 * classic bug here, which is why it is inverted once, in one place, with this
 * sentence next to it.
 */
function formatOffset(offsetMinutesFromUtc: number): string {
  const sign = offsetMinutesFromUtc >= 0 ? '+' : '-';
  return `${sign}${pad(Math.trunc(offsetMinutesFromUtc / 60))}:${pad(offsetMinutesFromUtc % 60)}`;
}

/**
 * The IANA zone, when the runtime knows it.
 *
 * Wrapped because `Intl` is permitted to throw on a stripped runtime, and a
 * clock that crashes is worse than a clock without a zone name.
 */
function resolveTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : null;
  } catch {
    return null;
  }
}

/** Read the clock and describe it. Exported so tests can check it directly. */
export function readSystemTime(now: Date): SystemTimeOutput {
  const offsetMinutesFromUtc = -now.getTimezoneOffset();

  return {
    utc: now.toISOString(),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    timeWithSeconds: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    dayOfWeek: DAY_NAMES[now.getDay()] ?? '',
    timezone: resolveTimezone(),
    utcOffset: formatOffset(offsetMinutesFromUtc),
    utcOffsetMinutes: offsetMinutesFromUtc,
    epochMs: now.getTime(),
  };
}

export function createSystemTimeTool({ now = (): Date => new Date() }: SystemTimeToolOptions = {}): RegisteredTool {
  return defineTool<Input, SystemTimeOutput>({
    name: 'system.time',
    title: 'Check the time',
    description:
      "Read this computer's own clock. Returns the local date, the local time, the day of the week, the " +
      'timezone and the UTC offset. Call this whenever the user asks what time or what day it is, or ' +
      'whenever a date matters — never answer from memory or from anything in your instructions.',
    inputSchema,

    resolveRisk: (): RiskAssessment => ({
      level: 'SAFE',
      reason: 'Reading the computer clock produces no effect and sends nothing anywhere.',
    }),

    summarize: (): ToolSummary => ({ title: 'Axon wants to check the time', parameters: [] }),

    sideEffect: (): SideEffectClass => 'NONE',

    /**
     * Asking the time twice is asking a different question the second time.
     *
     * The default repeat bound keys on (tool, arguments), and this tool has no
     * arguments — so three calls in a long conversation would exhaust it and
     * the fourth would be refused, which is absurd for a clock. Keying on the
     * minute keeps the bound doing its real job (a model stuck asking the same
     * question over and over) while leaving a genuine later question free.
     */
    repeatKey: (): string => `time:${Math.floor(now().getTime() / 60_000)}`,

    execute(_input, ctx): Promise<SystemTimeOutput> {
      const reading = readSystemTime(now());
      ctx.observe(`Read the system clock: ${reading.date} ${reading.time}`, {
        date: reading.date,
        time: reading.time,
        timezone: reading.timezone,
      });
      return Promise.resolve(reading);
    },
  });
}
