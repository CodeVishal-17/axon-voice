/**
 * REHEARSAL — the canonical demo, run for real, recorded row by row.
 *
 * This is the deterministic rehearsal mode. It builds one harness and walks
 * `CANONICAL_DEMO` through it: the presenter's sentence goes in at
 * `onVoiceTranscript`, each proposal goes in at `bridge.handleToolCall`, and
 * everything between those and the effect is shipping code — the same
 * orchestrator, the same tool bridge, the same dispatcher, the same policy,
 * the same approval broker, the same task lifecycle. There is no second
 * implementation of any of it, and no rehearsal-only path through any of it.
 *
 * WHAT IS SUBSTITUTED is stated in `canonical-demo.ts` and is exactly two
 * things: the model, and the internet. Neither is on the far side of a gate.
 *
 * WHAT IS RECORDED, per the phase brief: the utterance, the task id, the step
 * id, the tool, the policy result, the approval result, the execution time,
 * the verification result, and what Axon said. The rows are built by the
 * SHIPPING projection (`demo/recording.ts`) rather than by a second one
 * written here — a rehearsal that measured itself with its own ruler would
 * prove nothing about the recording a real demo produces.
 */

import type { ApprovalDecision, ApprovalRequest } from '@axon/core';
import { recordDemo, type DemoRecordingRow } from '../../src/main/demo/recording.js';
import { createDemoHarness, fakeDesktop, type DemoHarness } from './demo-harness.js';
import { combinedSite, internshipSite, youtubeSite, type FakeSite } from './fake-site.js';
import { CANONICAL_DEMO, type DemoBeat, type DemoElement } from './canonical-demo.js';

export interface RehearsedStep {
  readonly tool: string;
  /** SUCCEEDED, DENIED, CLARIFICATION_NEEDED, FORBIDDEN — the step's own word. */
  readonly outcome: string;
  readonly expected: 'ok' | 'refused' | 'question' | 'approval';
  /** Wall clock from the moment the proposal entered the bridge. */
  readonly ms: number;
  /** The message the model was handed back. Never a page's text. */
  readonly message: string | null;
  /**
   * This step's row in the shipping recording, or null when it never reached
   * the dispatcher (an invented tool is refused at the bridge).
   *
   * Joined by task and step id — the ledger's own identity for a step — and
   * never by tool name. A lookup by name put the SEARCH's approval against
   * every later `browser.type` in the first version of this record, which
   * made three safe fills look like three dialogs.
   */
  readonly row: DemoRecordingRow | null;
}

export interface RehearsedBeat {
  readonly beat: DemoBeat;
  readonly taskId: string | null;
  readonly steps: readonly RehearsedStep[];
  /** Approvals the user was shown during this beat. */
  readonly approvals: readonly ApprovalRequest[];
  /** What Axon said out loud during this beat, in order. */
  readonly spoken: readonly string[];
  readonly ms: number;
}

export interface RehearsalReport {
  readonly beats: readonly RehearsedBeat[];
  /** The shipping recording projection, over the whole rehearsal. */
  readonly rows: readonly DemoRecordingRow[];
  readonly harness: DemoHarness;
  readonly ms: number;
}

export interface RehearsalOptions {
  /**
   * What the user does at the dialog. Defaults to allowing, because the
   * canonical run is the one where the demo proceeds; `demo-script.test.ts`
   * runs it again denying, which is the version worth showing on stage.
   */
  readonly decide?: (request: ApprovalRequest) => ApprovalDecision | null;
  /** Beats to run. Defaults to the whole canonical demo. */
  readonly beats?: readonly DemoBeat[];
}

function elementsOf(answer: { body: Record<string, unknown> } | undefined): DemoElement[] {
  const output = (answer?.body.output ?? {}) as { elements?: DemoElement[] };
  return output.elements ?? [];
}

function messageOf(answer: { body: Record<string, unknown> } | undefined): string | null {
  const body = answer?.body ?? {};
  const message = body.message ?? body.error ?? null;
  return typeof message === 'string' ? message : null;
}

/**
 * How a step turned out, in the vocabulary the recording uses.
 *
 * Read off the result the MODEL was handed rather than off internal state,
 * because that is what the model — and, a moment later, the room — actually
 * gets to know.
 */
function outcomeOf(answer: { body: Record<string, unknown> } | undefined): string {
  const body = answer?.body ?? {};
  if (body.ok === true) return 'SUCCEEDED';
  if (typeof body.status === 'string') return String(body.status).toUpperCase();
  if (typeof body.errorKind === 'string') return String(body.errorKind);
  return 'UNKNOWN';
}

/**
 * Run the canonical demo end to end.
 *
 * One harness for the whole thing, on purpose: the interesting properties are
 * between the beats — that a task on the careers site starts clean after a
 * task on YouTube, that an answer continues the task that asked, that the
 * budget survives a dozen steps.
 */
export async function rehearse(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const youtube = youtubeSite({ ambiguousResults: true });
  const careers = internshipSite();
  const site = combinedSite({
    'https://www.youtube.com': youtube,
    'https://careers.example.com': careers,
  });

  const harness = createDemoHarness({
    site,
    desktop: fakeDesktop(),
    ...(options.decide ? { decide: options.decide } : {}),
  });

  const beats = options.beats ?? CANONICAL_DEMO;
  const rehearsed: RehearsedBeat[] = [];
  const startedAll = Date.now();

  for (const beat of beats) {
    const beatStartedAt = Date.now();
    const approvalsBefore = harness.approvals.length;
    const spokenBefore = harness.spoken.length;

    harness.say(beat.say);
    const taskId = harness.orchestrator.tasks.activeTaskId;

    const steps: RehearsedStep[] = [];
    /** Step keys, filled in once the beat has settled and its rows exist. */
    const keys: (string | null)[] = [];
    const seen: DemoElement[] = [];

    for (const step of beat.steps) {
      // The live page moving under Axon, when the script says it does.
      if (step.drift) currentSite(site, youtube, careers).driftTo(step.drift);

      const context = { elements: elementsOf(harness.answers.at(-1)), seen };
      const input = step.input(context);

      const known = new Set(recordDemo(harness.events).map((row) => `${row.taskId}/${row.stepId}`));
      const startedAt = Date.now();
      await harness.propose(step.tool, input);
      const ms = Date.now() - startedAt;
      const fresh = recordDemo(harness.events).find((row) => !known.has(`${row.taskId}/${row.stepId}`));
      keys.push(fresh ? `${fresh.taskId}/${fresh.stepId}` : null);

      const answer = harness.answers.at(-1);
      for (const element of elementsOf(answer)) {
        if (!seen.some((entry) => entry.ref === element.ref && entry.label === element.label)) seen.push(element);
      }

      steps.push({
        tool: step.tool,
        outcome: outcomeOf(answer),
        expected: step.expect ?? 'ok',
        ms,
        message: messageOf(answer),
        row: null,
      });
    }

    // Approvals are answered on a later tick, exactly as a person would, so a
    // beat that raised one has to be given the chance to settle before the
    // next sentence arrives.
    if (beat.approval === 'appears') await harness.settle(80);

    // Now that approvals have been answered, the rows carry their final
    // outcome — attach each step's own.
    const rows = recordDemo(harness.events);
    const settled = steps.map((step, index) => ({
      ...step,
      row: rows.find((row) => `${row.taskId}/${row.stepId}` === keys[index]) ?? null,
    }));

    rehearsed.push({
      beat,
      taskId,
      steps: settled,
      approvals: harness.approvals.slice(approvalsBefore),
      spoken: harness.spoken.slice(spokenBefore),
      ms: Date.now() - beatStartedAt,
    });
  }

  await harness.settle(60);

  return {
    beats: rehearsed,
    rows: recordDemo(harness.events),
    harness,
    ms: Date.now() - startedAll,
  };
}

/** Which of the two sites the browser is currently on. */
function currentSite(
  site: ReturnType<typeof combinedSite>,
  youtube: FakeSite,
  careers: FakeSite,
): FakeSite {
  const current = site.current();
  return current === careers ? careers : youtube;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

/**
 * The instruction Axon gave the model, without the result it carried.
 *
 * When a deferred action settles, Axon tells the model what happened AND
 * hands it the result to speak from — which contains the page. That is
 * correct for the model, which needs the facts and is told they are
 * untrusted, and wrong for a record a person reads: a rehearsal transcript
 * with a site's marketing copy pasted into it is unreadable, and printing
 * page text into a developer artifact is a habit worth not having.
 */
function firstSentence(summary: string): string {
  const withoutResult = summary.split(' Result:')[0] ?? summary;
  const trimmed = withoutResult.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/**
 * The rehearsal record, printed.
 *
 * Read top to bottom it is the demo: every sentence the presenter says, every
 * proposal it produced, what the policy decided, what the human decided, how
 * long it took, and what Axon said back. It is developer-facing and dense on
 * purpose — the audience-facing version of this information is one short
 * sentence at a time, out loud.
 */
export function renderRehearsal(report: RehearsalReport): string {
  const lines: string[] = ['AXON REHEARSAL — the canonical demo', ''];

  let act: string | null = null;
  for (const entry of report.beats) {
    if (entry.beat.act !== act) {
      act = entry.beat.act;
      lines.push(`ACT ${act}`);
    }

    lines.push(`  "${entry.beat.say}"   [${entry.taskId ?? 'no task'}]  ${entry.ms}ms`);

    if (entry.beat.steps.length === 0) {
      lines.push(`      (no tools) ${entry.beat.noTools ?? ''}`.trimEnd());
    }

    for (const step of entry.steps) {
      const row = step.row;
      lines.push(
        `      ${pad(step.tool, 18)}${pad(step.outcome, 22)}${pad(`${step.ms}ms`, 9)}` +
          `${pad(row?.risk ?? '-', 20)}${row?.approval ?? '-'}`,
      );
    }

    for (const approval of entry.approvals) {
      lines.push(`      ASKED: ${approval.title}${approval.binding.target ? ` — ${approval.binding.target}` : ''}`);
    }

    for (const said of entry.spoken) {
      lines.push(`      TOLD TO SAY: ${firstSentence(said)}`);
    }
  }

  lines.push('', `${report.beats.length} beats, ${report.rows.length} steps, ${report.ms}ms total`);
  return lines.join('\n');
}

/**
 * Slowest first, for the performance profile.
 *
 * The point is never the total. It is which step is the one worth being ready
 * to talk over, and that is a question about the maximum rather than the mean.
 */
export function slowestSteps(report: RehearsalReport, count = 5): readonly { tool: string; ms: number; say: string }[] {
  const all = report.beats.flatMap((entry) => entry.steps.map((step) => ({ tool: step.tool, ms: step.ms, say: entry.beat.say })));
  return [...all].sort((left, right) => right.ms - left.ms).slice(0, count);
}
