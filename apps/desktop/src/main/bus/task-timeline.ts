/**
 * One task, reconstructed from the event stream, for a developer to read.
 *
 * WHAT THIS IS FOR.
 *
 * When a demo goes wrong on stage, the question is always the same: which step
 * was it, and which gate did it stop at? The event stream already contains the
 * answer — every decision Axon makes is on it — but it contains it as a flat
 * sequence of forty events interleaved with audio phases and speech markers,
 * which is not a form anybody can read in the four seconds available.
 *
 * So this projects the stream into the shape the decisions actually have:
 *
 *     TASK task-1  "open youtube and search for assemblyai"
 *     └── STEP step-1  browser.open
 *         ├── proposal
 *         ├── policy: SAFE — allowed without asking
 *         ├── execution
 *         ├── verification: the page changed
 *         └── SUCCEEDED
 *
 * A PROJECTION, NOT A SECOND LOG. It derives everything from events that were
 * already emitted and stores nothing of its own. There is no path by which the
 * timeline can disagree with the stream, because it has no independent record
 * to disagree from — which is the property that makes it worth trusting when
 * something has gone wrong.
 *
 * WHAT IT MUST NEVER CONTAIN, and does not.
 *
 * Tool ARGUMENTS. A `TOOL_CALL` event carries the input the model proposed,
 * and that input is where a typed password, a page of text, or a URL with a
 * session token in it would be. The renderer never reads that field. It reads
 * the tool NAME, the risk LEVEL, the approval DECISION and the outcome — the
 * shape of the decision, which is what the question actually needs, and none
 * of the content. `task-timeline.test.ts` asserts that a secret typed in one
 * end does not come out of this one.
 *
 * Pure: events in, a string out. No clock, no filesystem, no Electron.
 */

import type { AxonEvent } from '@axon/core';

/** How a step's gates went. Every field is derived, none is stored. */
interface StepView {
  readonly taskId: string;
  readonly stepId: string;
  readonly tool: string;
  callId: string | null;
  outcome: string;
  risk: string | null;
  riskReason: string | null;
  approval: string | null;
  approvalDecision: string | null;
  verified: boolean | null;
  /** Axon's own observations attributed to this step's call. */
  readonly notes: string[];
  rebound: boolean;
}

interface TaskView {
  readonly taskId: string;
  goal: string | null;
  /** How the task ended, when it ended for a reason worth showing. */
  status: string | null;
  readonly steps: StepView[];
}

/** The trace payload the orchestrator puts on an OBSERVATION. */
interface TracePayload {
  readonly task?: unknown;
  readonly status?: unknown;
  readonly step?: unknown;
  readonly tool?: unknown;
  readonly outcome?: unknown;
  readonly call?: unknown;
  readonly risk?: unknown;
  readonly approval?: unknown;
  readonly verified?: unknown;
}

function asTrace(detail: unknown): TracePayload | null {
  if (detail === null || typeof detail !== 'object') return null;
  const payload = detail as TracePayload;
  return typeof payload.task === 'string' && typeof payload.step === 'string' ? payload : null;
}

/** A note about a TASK rather than about a step inside one. */
function asTaskNote(detail: unknown): TracePayload | null {
  if (detail === null || typeof detail !== 'object') return null;
  const payload = detail as TracePayload;
  return typeof payload.task === 'string' && payload.step === undefined ? payload : null;
}

/**
 * Build the task views.
 *
 * Exported separately from the renderer so a UI can draw the same structure
 * without going through text — the shape is the useful part, and a caller that
 * only had a formatted string would have to parse it back.
 */
export function reconstructTasks(events: readonly AxonEvent[]): readonly TaskView[] {
  const tasks = new Map<string, TaskView>();
  const byCall = new Map<string, StepView>();
  /** The most recent user utterance, which becomes the next task's goal. */
  let lastUtterance: string | null = null;

  const stepFor = (trace: TracePayload): StepView => {
    const taskId = String(trace.task);
    const stepId = String(trace.step);

    let task = tasks.get(taskId);
    if (!task) {
      task = { taskId, goal: lastUtterance, status: null, steps: [] };
      tasks.set(taskId, task);
    }

    let step = task.steps.find((entry) => entry.stepId === stepId);
    if (!step) {
      step = {
        taskId,
        stepId,
        tool: typeof trace.tool === 'string' ? trace.tool : 'unknown',
        callId: null,
        outcome: 'PROPOSED',
        risk: null,
        riskReason: null,
        approval: null,
        approvalDecision: null,
        verified: null,
        notes: [],
        rebound: false,
      };
      task.steps.push(step);
    }
    return step;
  };

  for (const event of events) {
    switch (event.type) {
      case 'USER_MESSAGE':
        lastUtterance = event.text;
        break;

      case 'OBSERVATION': {
        const ended = asTaskNote(event.detail);
        if (ended && typeof ended.status === 'string') {
          const existing = tasks.get(String(ended.task));
          if (existing) existing.status = ended.status;
          break;
        }

        const trace = asTrace(event.detail);
        if (trace) {
          const step = stepFor(trace);
          // RUNNING exists to carry the call id; it is not an outcome, and
          // letting it overwrite one would show a finished step as running.
          if (typeof trace.outcome === 'string' && trace.outcome !== 'RUNNING') step.outcome = trace.outcome;
          if (typeof trace.call === 'string') {
            step.callId = trace.call;
            byCall.set(trace.call, step);
          }
          if (typeof trace.risk === 'string') step.risk = trace.risk;
          if (typeof trace.approval === 'string') step.approval = trace.approval;
          if (typeof trace.verified === 'boolean') step.verified = trace.verified;
          break;
        }

        // An ordinary observation from inside an executor. Attributed to its
        // step when Axon knows which one, and otherwise dropped — an
        // unattributed line in a per-step tree would be a line under the wrong
        // step, which is worse than a line that is not there.
        if (event.callId) {
          const step = byCall.get(event.callId);
          if (step && step.notes.length < 6) step.notes.push(event.summary);
        }
        break;
      }

      case 'TOOL_CALL': {
        // The RISK and the REASON. Never `event.input`: that is where a typed
        // password or a tokened URL would be, and this renderer has no
        // business holding either.
        const step = byCall.get(event.callId);
        if (step) {
          step.risk = event.risk;
          step.riskReason = event.riskReason;
        }
        break;
      }

      case 'APPROVAL_REQUIRED': {
        const step = byCall.get(event.request.callId);
        if (step) step.approval = 'requested';
        break;
      }

      case 'APPROVAL_RESOLVED': {
        const step = byCall.get(event.callId);
        if (step) {
          step.approval = event.decision === 'ALLOW' ? 'allowed' : 'denied';
          step.approvalDecision = `${event.decision} by ${event.resolvedBy}`;
          // An allowed approval is re-bound before execution — the dispatcher
          // recomputes the fingerprint and compares. Worth showing, because
          // "was it re-checked?" is exactly the question somebody auditing a
          // demo asks.
          step.rebound = event.decision === 'ALLOW';
        }
        break;
      }

      case 'TOOL_RESULT': {
        const step = byCall.get(event.callId);
        if (step && !event.ok && event.failure) step.outcome = event.failure.kind;
        break;
      }

      default:
        break;
    }
  }

  return [...tasks.values()];
}

/**
 * Render the tasks as a tree.
 *
 * Developer-facing: it is dense, it uses Axon's own vocabulary, and it is not
 * shown to a user. The spoken interface stays one short sentence.
 */
export function renderTaskTimeline(events: readonly AxonEvent[]): string {
  const tasks = reconstructTasks(events);
  if (tasks.length === 0) return 'No tasks.';

  const lines: string[] = [];

  for (const task of tasks) {
    lines.push(
      `TASK ${task.taskId}${task.goal ? `  "${task.goal}"` : ''}${task.status ? `  [${task.status}]` : ''}`,
    );

    task.steps.forEach((step, index) => {
      const lastStep = index === task.steps.length - 1;
      lines.push(`${lastStep ? '└──' : '├──'} STEP ${step.stepId}  ${step.tool}`);
      const gutter = lastStep ? '    ' : '│   ';

      const rows: string[] = ['proposal'];
      if (step.risk) rows.push(`policy: ${step.risk}${describePolicy(step)}`);
      if (step.approval) rows.push(`approval: ${step.approvalDecision ?? step.approval}`);
      if (step.rebound) rows.push('re-bind: fingerprint re-checked before execution');
      for (const note of step.notes) rows.push(`observation: ${note}`);
      if (step.verified !== null) {
        rows.push(`verification: ${step.verified ? 'confirmed by looking' : 'NOT confirmed'}`);
      }
      rows.push(step.outcome);

      rows.forEach((row, rowIndex) => {
        const lastRow = rowIndex === rows.length - 1;
        lines.push(`${gutter}${lastRow ? '└──' : '├──'} ${row}`);
      });
    });
  }

  return lines.join('\n');
}

/** Why the policy decided what it did, in a few words. */
function describePolicy(step: StepView): string {
  if (step.risk === 'FORBIDDEN') return ' — refused outright';
  if (step.risk === 'SAFE') return ' — allowed without asking';
  return ' — a human was asked';
}
