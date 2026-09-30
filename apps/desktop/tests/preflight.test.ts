/**
 * Preflight, held to the two things a preflight is for.
 *
 * IT MUST BE HONEST. A check that cannot be established from where the probe
 * stands says so; it does not quietly pass. A probe that throws is a failed
 * check rather than a crashed report — the report is the deliverable, and one
 * that stops at the first problem hides the second.
 *
 * IT MUST BE CLEAN. The one input it is given that could leak is the API key,
 * and the only place a key could reach the output is a probe's `detail`
 * string. Several tests here hand a probe a key and then assert the whole
 * rendered report does not contain it, including the case where the probe is
 * actively trying to print it.
 */

import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_ORDER,
  renderPreflight,
  runPreflight,
  scrub,
  type PreflightProbes,
} from '../src/main/demo/preflight.js';

const KEY = 'aabbccdd11223344aabbccdd11223344';

function allPassing(): PreflightProbes {
  const probes: Record<string, () => { status: 'OK' }> = {};
  for (const name of PREFLIGHT_ORDER) probes[name] = () => ({ status: 'OK' });
  return probes as PreflightProbes;
}

// ---------------------------------------------------------------------------

describe('the preflight report', () => {
  it('runs every check, in the printed order', async () => {
    const report = await runPreflight(allPassing());
    expect(report.checks.map((check) => check.name)).toEqual([...PREFLIGHT_ORDER]);
  });

  it('is ready when nothing failed', async () => {
    const report = await runPreflight(allPassing());
    expect(report.ready).toBe(true);
    expect(report.failed).toBe(0);
    expect(renderPreflight(report)).toContain('READY FOR DEMO');
  });

  it('is not ready when one thing failed, and says which', async () => {
    const report = await runPreflight({
      ...allPassing(),
      Microphone: () => ({ status: 'FAIL', detail: 'no input device' }),
    });

    expect(report.ready).toBe(false);
    expect(report.failed).toBe(1);

    const rendered = renderPreflight(report);
    expect(rendered).toContain('✗ Microphone  — no input device');
    expect(rendered).toContain('NOT READY — 1 check failed');
    expect(rendered).not.toContain('READY FOR DEMO');
  });

  it('counts a skip apart from a pass, and never calls it ready without saying so', async () => {
    // The distinction that keeps the report worth reading. "Not established
    // here" is not "fine", and a presenter deserves to know which they have.
    const report = await runPreflight({
      ...allPassing(),
      Renderer: () => ({ status: 'SKIP', detail: 'no window in this process' }),
    });

    expect(report.ready).toBe(true);
    expect(report.skipped).toBe(1);
    expect(renderPreflight(report)).toContain('READY FOR DEMO — 1 not established here');
  });

  it('treats a missing probe as a skip rather than a pass', async () => {
    const { Microphone: _dropped, ...rest } = allPassing();
    void _dropped;
    const report = await runPreflight(rest);

    const microphone = report.checks.find((check) => check.name === 'Microphone');
    expect(microphone?.status).toBe('SKIP');
    expect(report.ready).toBe(true);
    expect(report.skipped).toBe(1);
  });

  it('turns a thrown probe into a failed check and keeps going', async () => {
    const report = await runPreflight({
      ...allPassing(),
      Browser: () => {
        throw new Error('the browser window would not open');
      },
    });

    expect(report.checks).toHaveLength(PREFLIGHT_ORDER.length);
    const browser = report.checks.find((check) => check.name === 'Browser');
    expect(browser?.status).toBe('FAIL');
    expect(browser?.detail).toContain('would not open');
    // And the checks after it still ran.
    expect(report.checks.at(-1)?.status).toBe('OK');
  });

  it('awaits probes that are asynchronous', async () => {
    const report = await runPreflight({
      ...allPassing(),
      'AssemblyAI reachable': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 'OK', detail: 'TCP connect in 40ms' };
      },
    });

    expect(report.checks.find((check) => check.name === 'AssemblyAI reachable')?.detail).toBe('TCP connect in 40ms');
  });
});

// ---------------------------------------------------------------------------
// The part that matters
// ---------------------------------------------------------------------------

describe('preflight never prints a secret', () => {
  it('redacts a declared secret out of a probe detail', async () => {
    const report = await runPreflight(
      { ...allPassing(), 'AssemblyAI key': () => ({ status: 'OK', detail: `loaded ${KEY}` }) },
      { secrets: [KEY] },
    );

    const rendered = renderPreflight(report);
    expect(rendered).not.toContain(KEY);
    expect(rendered).toContain('[redacted]');
  });

  it('redacts a secret out of a THROWN probe message too', async () => {
    // The path nobody writes on purpose: an error that interpolated the thing
    // it was authenticating with.
    const report = await runPreflight(
      {
        ...allPassing(),
        'AssemblyAI reachable': () => {
          throw new Error(`handshake failed for key ${KEY}`);
        },
      },
      { secrets: [KEY] },
    );

    expect(renderPreflight(report)).not.toContain(KEY);
  });

  it('catches a token nobody declared, by its shape', async () => {
    const report = await runPreflight({
      ...allPassing(),
      Policy: () => ({ status: 'OK', detail: 'loaded with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    });

    expect(renderPreflight(report)).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('leaves ordinary detail alone', async () => {
    const report = await runPreflight({
      ...allPassing(),
      'Desktop accessibility': () => ({ status: 'OK', detail: 'UI Automation answered in 210ms' }),
    });

    expect(renderPreflight(report)).toContain('UI Automation answered in 210ms');
  });

  it('scrubs a value only when it is long enough to be one', () => {
    // A three-character "secret" would turn every report into swiss cheese.
    expect(scrub('the state is OK', ['OK'])).toBe('the state is OK');
    expect(scrub(`key ${KEY} loaded`, [KEY])).toBe('key [redacted] loaded');
  });
});
