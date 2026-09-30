/**
 * Preflight: the thirteen things that have to be true before anybody speaks.
 *
 * WHY THIS EXISTS. A demo does not usually fail in an interesting way. It
 * fails because the key was not loaded, or the microphone the laptop chose is
 * the one in the closed lid, or the venue's network eats websockets. All of
 * those are knowable thirty seconds before, and none of them are knowable from
 * looking at the orb.
 *
 * WHAT IT IS NOT. It is not a test suite and it does not exercise the agent.
 * Each probe answers one question about the machine as it is right now, and
 * the report is a list of answers. Running it changes nothing and needs no
 * network round trip beyond a TCP connect.
 *
 * THREE ANSWERS, NOT TWO. `SKIP` exists because some facts cannot be
 * established from where the probe stands — a script with no window cannot
 * prove the renderer is loaded — and reporting that as a pass would be a
 * fabrication, while reporting it as a failure would train the presenter to
 * ignore the report. A skip says "not established here" and is counted
 * separately in the summary line.
 *
 * SECRETS. Probe details are free text, and a probe that read a key could put
 * one there by accident — `${key} loaded` is one keystroke from correct.
 * Every detail passes `scrub` on the way in: the known secret values are
 * replaced by construction, and the shape-based scanner catches the ones
 * nobody thought to declare. There is no path from a probe to the output that
 * skips it.
 */

import { redactSecrets } from '../persistence/redaction.js';

export type PreflightStatus = 'OK' | 'FAIL' | 'SKIP';

/** What a probe answers. `detail` is shown after the name, when present. */
export interface PreflightOutcome {
  readonly status: PreflightStatus;
  readonly detail?: string | null;
}

export interface PreflightCheck {
  readonly name: string;
  readonly status: PreflightStatus;
  readonly detail: string | null;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  /** True when nothing FAILED. Skips are not passes and are counted apart. */
  readonly ready: boolean;
  readonly failed: number;
  readonly skipped: number;
}

export type PreflightProbe = () => PreflightOutcome | Promise<PreflightOutcome>;

/**
 * The checks, in the order they are run and printed.
 *
 * The order is the order things break in: credentials, then the network, then
 * the hardware, then the process, then Axon's own machinery. A presenter
 * reading top to bottom meets the cheapest fix first.
 */
export const PREFLIGHT_ORDER = [
  'AssemblyAI key',
  'AssemblyAI reachable',
  'Microphone',
  'Audio output',
  'Wake word',
  'Renderer',
  'Main process',
  'Tool registry',
  'Policy',
  'Browser',
  'Desktop accessibility',
  'Task ledger',
  'Approval system',
] as const;

export type PreflightName = (typeof PREFLIGHT_ORDER)[number];

/** One probe per check. Every one is required — a missing probe is a skip. */
export type PreflightProbes = Partial<Record<PreflightName, PreflightProbe>>;

export interface PreflightOptions {
  /**
   * Values that must never appear in the output.
   *
   * The API key, typically. Passed in rather than read from the environment
   * here, so this module never touches `process.env` and cannot be the thing
   * that loads a credential.
   */
  readonly secrets?: readonly string[];
}

/**
 * Remove anything secret from a line of probe detail.
 *
 * Two passes, on purpose. The first replaces values the caller declared, which
 * catches the exact key even when it looks like nothing in particular. The
 * second is the shape scanner, which catches a token the caller did not know
 * it had.
 */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return redactSecrets(out).text;
}

function normalise(name: string, outcome: PreflightOutcome, secrets: readonly string[]): PreflightCheck {
  const detail = typeof outcome.detail === 'string' && outcome.detail.trim() !== '' ? scrub(outcome.detail, secrets) : null;
  return { name, status: outcome.status, detail };
}

/**
 * Run every probe and collect the answers.
 *
 * Probes run in order rather than in parallel: they touch the microphone, the
 * speech engine and the accessibility tree, and two of those at once on
 * Windows is a way to make a preflight fail for a reason the demo will not.
 *
 * A probe that throws is a FAILED check, not a crashed preflight. The whole
 * point is to produce a report, and a report that stops at the first problem
 * hides the second one.
 */
export async function runPreflight(
  probes: PreflightProbes,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const secrets = options.secrets ?? [];
  const checks: PreflightCheck[] = [];

  for (const name of PREFLIGHT_ORDER) {
    const probe = probes[name];
    if (!probe) {
      checks.push({ name, status: 'SKIP', detail: 'no probe supplied' });
      continue;
    }

    try {
      const outcome = await probe();
      checks.push(normalise(name, outcome, secrets));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(normalise(name, { status: 'FAIL', detail: message }, secrets));
    }
  }

  const failed = checks.filter((check) => check.status === 'FAIL').length;
  const skipped = checks.filter((check) => check.status === 'SKIP').length;
  return { checks, ready: failed === 0, failed, skipped };
}

const MARK: Readonly<Record<PreflightStatus, string>> = Object.freeze({
  OK: '✓',
  FAIL: '✗',
  SKIP: '-',
});

/**
 * The report, as the presenter reads it.
 *
 *     AXON PREFLIGHT
 *     ✓ AssemblyAI key
 *     ✗ Microphone  — no input device
 *     - Renderer  — not established here
 *     NOT READY — 1 check failed
 *
 * The last line is the whole output as far as a person glancing at a terminal
 * thirty seconds before walking on stage is concerned, so it says the thing
 * that matters and says it in words rather than in a count of ticks.
 */
export function renderPreflight(report: PreflightReport): string {
  const lines = ['AXON PREFLIGHT'];

  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.name}${check.detail ? `  — ${check.detail}` : ''}`);
  }

  if (!report.ready) {
    lines.push(`NOT READY — ${report.failed} check${report.failed === 1 ? '' : 's'} failed`);
  } else if (report.skipped > 0) {
    lines.push(`READY FOR DEMO — ${report.skipped} not established here`);
  } else {
    lines.push('READY FOR DEMO');
  }

  return lines.join('\n');
}
