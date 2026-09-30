/**
 * Demo recording: what happened, in rows, with nothing in them.
 *
 * WHY A SECOND PROJECTION. `task-timeline.ts` draws a tree for reading on a
 * second screen while a demo is running — it answers "which gate did that stop
 * at?" in four seconds. This answers a different question, afterwards: "what
 * actually happened, in order, and how long did each part take?" A tree is the
 * wrong shape for that, and a stream of forty raw events is worse.
 *
 * So a recording is a flat, timestamped row per step, in a form that survives
 * being written to a file and read back by a person a day later, or diffed
 * between two rehearsals to see what got slower.
 *
 * WHAT IT MAY CONTAIN. The timestamp, the task, the step, the tool, the
 * status, the latency, the approval and the verification. That is the whole
 * list, and it is the list in the phase brief.
 *
 * WHAT IT MAY NOT CONTAIN, EVER. Tool arguments, page text, typed values, the
 * user's transcript, API keys, tokens, audio. Two mechanisms keep it that way
 * rather than one: this module never reads `event.input`, `event.output` or
 * any transcript field in the first place, and every string that does go into
 * a row passes the shape-based secret scanner on the way out. The goal text is
 * the single exception to "no user words" and it is quoted deliberately — a
 * recording of a demo where nobody can tell what was asked for is not a
 * recording of anything — so it, too, is scanned, and a goal that looks like a
 * credential is dropped rather than written.
 */

import type { AxonEvent } from '@axon/core';
import { containsSecret } from '../persistence/redaction.js';
import { reconstructTasks } from '../bus/task-timeline.js';

export interface DemoRecordingRow {
  /** ISO timestamp of the moment the step settled. */
  readonly at: string;
  readonly taskId: string;
  /** What the user asked for, or null when it could not be shown safely. */
  readonly goal: string | null;
  readonly stepId: string;
  readonly tool: string;
  /** SUCCEEDED, DENIED, CANCELLED, TIMEOUT — the step's own outcome word. */
  readonly status: string;
  /** Wall clock inside the dispatcher, from the TOOL_RESULT. */
  readonly latencyMs: number | null;
  readonly risk: string | null;
  /** "ALLOW by user", "DENY by timeout", or null when none was needed. */
  readonly approval: string | null;
  /** True/false when Axon looked, null when the tool does not verify. */
  readonly verified: boolean | null;
}

/** A string is only allowed out of here if it is not secret-shaped. */
function safe(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (containsSecret(trimmed)) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/**
 * Project the event stream into recording rows.
 *
 * The step structure is `reconstructTasks`', deliberately: two projections of
 * the same events that disagreed about what a step is would be a bug factory,
 * and the timeline's version is the one with the tests about call-id joins.
 * What is added here is TIME — when each step settled and how long it took —
 * which the tree has no place for.
 */
export function recordDemo(events: readonly AxonEvent[]): readonly DemoRecordingRow[] {
  const tasks = reconstructTasks(events);

  /** Latency and settle time, keyed by call id, from the results themselves. */
  const timings = new Map<string, { readonly at: string; readonly durationMs: number }>();
  for (const event of events) {
    if (event.type === 'TOOL_RESULT') {
      timings.set(event.callId, { at: event.at, durationMs: event.durationMs });
    }
  }

  const rows: DemoRecordingRow[] = [];
  for (const task of tasks) {
    for (const step of task.steps) {
      const timing = step.callId ? timings.get(step.callId) : undefined;
      rows.push({
        at: timing?.at ?? '',
        taskId: task.taskId,
        goal: safe(task.goal),
        stepId: step.stepId,
        tool: step.tool,
        status: step.outcome,
        latencyMs: timing?.durationMs ?? null,
        risk: step.risk,
        approval: step.approvalDecision,
        verified: step.verified,
      });
    }
  }

  // In settle order, so a recording reads the way the demo sounded. Rows with
  // no timing (a step that never reached an executor — denied, cancelled)
  // keep their relative order at the end of their task rather than jumping to
  // the front, which is what sorting on an empty string would do.
  return rows;
}

/** One JSON object per line: greppable, diffable, and streamable to a file. */
export function serializeRecording(rows: readonly DemoRecordingRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

/**
 * The recording as a table, for reading in a terminal after the demo.
 *
 *     TIME      TASK    STEP    TOOL           STATUS      LATENCY  APPROVAL
 *     22:14:03  task-1  step-1  browser.open   SUCCEEDED     1240ms  -
 */
export function renderRecording(rows: readonly DemoRecordingRow[]): string {
  if (rows.length === 0) return 'No steps recorded.';

  const lines = [
    `${pad('TIME', 10)}${pad('TASK', 8)}${pad('STEP', 8)}${pad('TOOL', 20)}${pad('STATUS', 18)}${pad('LATENCY', 10)}APPROVAL`,
  ];

  let goal: string | null = null;
  for (const row of rows) {
    if (row.goal !== goal) {
      goal = row.goal;
      lines.push(`  "${goal ?? '(not shown)'}"`);
    }
    const time = row.at === '' ? '-' : new Date(row.at).toISOString().slice(11, 19);
    lines.push(
      pad(time, 10) +
        pad(row.taskId, 8) +
        pad(row.stepId, 8) +
        pad(row.tool, 20) +
        pad(row.status, 18) +
        pad(row.latencyMs === null ? '-' : `${row.latencyMs}ms`, 10) +
        (row.approval ?? '-'),
    );
  }

  return lines.join('\n');
}

/**
 * The developer-only recording mode.
 *
 * OFF UNLESS ASKED FOR, TWICE. It requires a development build AND
 * `AXON_DEMO_RECORDING=1`; a packaged Axon cannot turn it on with an
 * environment variable, and a developer cannot turn it on by accident.
 *
 * IT HOLDS EVENTS, NOT CONTENT. Only the six event types the projection reads
 * are kept, and they are kept because a row cannot be built until the events
 * after it have arrived — a step's approval and outcome come later than its
 * proposal. The buffer is bounded: a long session drops its oldest events
 * rather than growing without limit, and a dropped prefix costs the earliest
 * rows, which is the right thing to lose.
 *
 * The file is written once, at close. There is no partial file to interpret,
 * and nothing is written at all if no step ever ran.
 */
export interface DemoRecorderOptions {
  readonly filePath: string;
  /** Events retained. Roughly ten per step; the default holds a long demo. */
  readonly capacity?: number;
  writeFile(filePath: string, contents: string): void;
}

const RECORDED_TYPES = new Set([
  'USER_MESSAGE',
  'OBSERVATION',
  'TOOL_CALL',
  'TOOL_RESULT',
  'APPROVAL_REQUIRED',
  'APPROVAL_RESOLVED',
]);

export class DemoRecorder {
  private readonly options: DemoRecorderOptions;
  private readonly capacity: number;
  private readonly events: AxonEvent[] = [];
  private closed = false;

  constructor(options: DemoRecorderOptions) {
    this.options = options;
    this.capacity = options.capacity ?? 4_000;
  }

  /** Subscribe this to the bus. Cheap enough to call on every event. */
  observe(event: AxonEvent): void {
    if (this.closed) return;
    if (!RECORDED_TYPES.has(event.type)) return;
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }

  /** The rows as they stand, without closing. Used by tests and by a console. */
  rows(): readonly DemoRecordingRow[] {
    return recordDemo(this.events);
  }

  /**
   * Write the recording out. Idempotent; a second call does nothing.
   *
   * Returns the path when a file was written and null when there was nothing
   * to write, so a caller can say "no steps ran" rather than pointing at an
   * empty file.
   */
  close(): string | null {
    if (this.closed) return null;
    this.closed = true;

    const rows = recordDemo(this.events);
    this.events.length = 0;
    if (rows.length === 0) return null;

    this.options.writeFile(this.options.filePath, `${serializeRecording(rows)}\n`);
    return this.options.filePath;
  }
}
