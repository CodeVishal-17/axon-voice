/**
 * The rehearsal: the demo that will be given, given.
 *
 *   npm run rehearse      (this file, with the record printed)
 *
 * Every sentence in `CANONICAL_DEMO` is spoken into the real orchestrator and
 * every proposal goes through the real bridge into the real dispatcher. If the
 * demo cannot be performed, this file goes red — which is the entire point of
 * writing the demo down as data rather than as a paragraph in a README.
 *
 * The assertions are of two kinds and it is worth keeping them apart:
 *
 *   THE STORY HOLDS — the beats run in order, the tasks are separate, the
 *   answer continues the task that asked, and the acts do not leak into each
 *   other.
 *
 *   THE BOUNDARY HOLDS — the search asks, the credential field is refused, the
 *   submit asks, and denying the submit means nothing was submitted. These are
 *   the same properties the security suites assert; asserting them again HERE,
 *   in the exact sequence that will be performed in front of people, is the
 *   difference between "the product is safe" and "the demo is safe".
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_DEMO } from './support/canonical-demo.js';
import { rehearse, renderRehearsal, slowestSteps } from './support/rehearsal.js';

/**
 * Printed when this file is run as a rehearsal rather than as part of the
 * suite. `npm_lifecycle_event` is set by npm to the name of the script being
 * run, so `npm run rehearse` shows the record and `npm test` stays quiet —
 * without a second dependency to set an environment variable on Windows.
 */
const SHOW_RECORD =
  process.env.npm_lifecycle_event === 'rehearse' || process.env.AXON_REHEARSAL_RECORD === '1';

// ---------------------------------------------------------------------------

describe('the canonical demo can be performed', () => {
  it('runs every beat, in order, through the real path', async () => {
    const report = await rehearse();

    if (SHOW_RECORD) {
      console.log(`\n${renderRehearsal(report)}\n`);
      console.log('SLOWEST STEPS');
      for (const step of slowestSteps(report)) {
        console.log(`  ${step.ms}ms  ${step.tool}  — "${step.say}"`);
      }
      console.log('');
    }

    expect(report.beats.map((entry) => entry.beat.id)).toEqual(CANONICAL_DEMO.map((beat) => beat.id));
  });

  it('does what each step said it would do', async () => {
    // The one assertion that keeps the script honest as the product changes:
    // a step marked `refused` must be refused, one marked `question` must
    // produce a question, and an ordinary one must succeed.
    const report = await rehearse();

    for (const entry of report.beats) {
      for (const step of entry.steps) {
        const what = `${entry.beat.id}/${step.tool}`;
        if (step.expected === 'refused') {
          expect(step.outcome, what).not.toBe('SUCCEEDED');
        } else if (step.expected === 'question') {
          expect(step.outcome, what).toBe('CLARIFICATION_NEEDED');
        } else if (step.expected === 'approval') {
          expect(['PENDING_USER_APPROVAL', 'SUCCEEDED'], what).toContain(step.outcome);
        } else {
          expect(step.outcome, what).toBe('SUCCEEDED');
        }
      }
    }
  });

  it('produces a recording with a row per step that reached the dispatcher', async () => {
    const report = await rehearse();
    expect(report.rows.length).toBeGreaterThanOrEqual(8);
    expect(report.rows.every((row) => typeof row.tool === 'string' && row.tool !== '')).toBe(true);
  });

  it('keeps the acts in separate tasks', async () => {
    const report = await rehearse();

    const youtube = report.beats.find((entry) => entry.beat.id === 'open-youtube');
    const calculator = report.beats.find((entry) => entry.beat.id === 'calculator');
    const application = report.beats.find((entry) => entry.beat.id === 'open-application');

    expect(youtube?.taskId).toBeTruthy();
    expect(calculator?.taskId).not.toBe(youtube?.taskId);
    expect(application?.taskId).not.toBe(calculator?.taskId);
  });

  it('answers the clarification inside the task that asked it', async () => {
    // The bug this prevents: "the first one" opening a brand-new task and
    // throwing away the context that made it mean anything.
    const report = await rehearse();

    const asked = report.beats.find((entry) => entry.beat.id === 'ambiguous');
    const answered = report.beats.find((entry) => entry.beat.id === 'answer');

    expect(asked?.taskId).toBeTruthy();
    expect(answered?.taskId).toBe(asked?.taskId);
  });

  it('opens the result once the question has been answered', async () => {
    const report = await rehearse();
    const answered = report.beats.find((entry) => entry.beat.id === 'answer');
    expect(answered?.steps.at(-1)?.outcome).toBe('SUCCEEDED');
  });

  it('reads the machine clock rather than guessing the time', async () => {
    const report = await rehearse();
    const time = report.beats.find((entry) => entry.beat.id === 'time');
    expect(time?.steps.map((step) => step.tool)).toEqual(['system.time']);
    expect(time?.steps[0]?.outcome).toBe('SUCCEEDED');
  });

  it('opens a real application and verifies that it opened', async () => {
    const report = await rehearse();
    const calculator = report.beats.find((entry) => entry.beat.id === 'calculator');
    expect(calculator?.steps[0]?.outcome).toBe('SUCCEEDED');

    const row = report.rows.find((entry) => entry.tool === 'app.open');
    expect(row?.verified).not.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The boundary, in the exact sequence it will be shown
// ---------------------------------------------------------------------------

describe('the demo cannot go wrong in the way that would matter', () => {
  it('asks before submitting a search', async () => {
    const report = await rehearse();
    const search = report.beats.find((entry) => entry.beat.id === 'search');
    expect(search?.approvals.length).toBeGreaterThan(0);
    expect(search?.approvals[0]?.title).toMatch(/submit/i);
  });

  it('refuses the credential field outright, and does not echo it', async () => {
    const report = await rehearse();
    const fill = report.beats.find((entry) => entry.beat.id === 'fill-safe');
    const password = fill?.steps.at(-1);

    expect(password?.outcome).not.toBe('SUCCEEDED');
    expect(JSON.stringify(report.rows)).not.toContain('hunter2');
    expect(password?.message ?? '').not.toContain('hunter2');
  });

  it('fills the ordinary fields it was asked to fill', async () => {
    const report = await rehearse();
    const fill = report.beats.find((entry) => entry.beat.id === 'fill-safe');
    const succeeded = fill?.steps.filter((step) => step.outcome === 'SUCCEEDED') ?? [];
    expect(succeeded).toHaveLength(3);
  });

  it('asks before submitting the application', async () => {
    const report = await rehearse();
    const submit = report.beats.find((entry) => entry.beat.id === 'submit');
    expect(submit?.approvals.length).toBeGreaterThan(0);
    expect(submit?.approvals[0]?.title).toMatch(/submit application/i);
  });

  it('submits nothing when the user denies it — the version worth showing', async () => {
    // Denying only the submit: the search is allowed so the demo still gets
    // to the results, exactly as it would on stage.
    const report = await rehearse({
      decide: (request) => (/submit application/i.test(request.title) ? 'DENY' : 'ALLOW'),
    });

    const submit = report.beats.find((entry) => entry.beat.id === 'submit');
    expect(submit?.approvals.length).toBeGreaterThan(0);

    const row = report.rows.find((entry) => entry.tool === 'browser.click' && entry.approval?.startsWith('DENY'));
    expect(row?.status).toBe('DENIED');
  });

  it('asks exactly twice in the whole demo — the search and the submit', async () => {
    // The presenter needs this number in advance. Two dialogs is a story;
    // six is a demo about dialogs. Everything else in the script is either
    // safe or refused outright.
    const report = await rehearse();
    const asked = report.beats.filter((entry) => entry.approvals.length > 0).map((entry) => entry.beat.id);
    expect(asked).toEqual(['search', 'submit']);
    expect(CANONICAL_DEMO.filter((beat) => beat.approval === 'appears').map((beat) => beat.id)).toEqual(asked);
  });

  it('never lets an approval authorise more than the call it was shown for', async () => {
    const report = await rehearse();
    const approvals = report.beats.flatMap((entry) => entry.approvals);
    const fingerprints = approvals.map((request) => request.binding.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('leaves no credential anywhere in the rehearsal record', async () => {
    const report = await rehearse();
    const record = renderRehearsal(report);
    expect(record).not.toContain('hunter2');
    expect(record).not.toMatch(/password[^s]/i);
  });
});

// ---------------------------------------------------------------------------
// Performance, measured rather than felt
// ---------------------------------------------------------------------------

describe('the rehearsal measures itself', () => {
  it('reports how long each step took', async () => {
    const report = await rehearse();
    for (const entry of report.beats) {
      for (const step of entry.steps) {
        expect(step.ms).toBeGreaterThanOrEqual(0);
        expect(step.ms).toBeLessThan(10_000);
      }
    }
  });

  it('names the slowest steps, which is the useful end of the distribution', async () => {
    const report = await rehearse();
    const slowest = slowestSteps(report, 3);
    expect(slowest).toHaveLength(3);
    expect(slowest[0]!.ms).toBeGreaterThanOrEqual(slowest[2]!.ms);
  });

  it('renders a record a person can read', async () => {
    const report = await rehearse();
    const record = renderRehearsal(report);

    expect(record).toContain('AXON REHEARSAL');
    expect(record).toContain('"Open YouTube."');
    expect(record).toContain('browser.open');
    expect(record).toContain('beats');
  });
});
