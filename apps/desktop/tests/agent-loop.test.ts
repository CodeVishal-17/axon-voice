/**
 * The agent loop's own machinery, tested in isolation.
 *
 * Four pure-ish pieces, each of which is a security control:
 *
 *   TurnBudget          what one turn may spend.
 *   SideEffectLedger    what has already left the machine.
 *   approval-binding    what an approval actually authorises.
 *   verifyChange        what an action is known to have done.
 *
 * They are tested here separately from the workflow that uses them, because a
 * bound is only trustworthy at its edges and a flagship test exercises exactly
 * one point in the middle of each range.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_LOOP_LIMITS, stableStringify, type PageObservation } from '@axon/core';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { SideEffectLedger } from '../src/main/safety/side-effect-ledger.js';
import { bindApproval, classifySideEffect, describeAction, fingerprintCall } from '../src/main/safety/approval-binding.js';
import { submittedTextVisible, verifyChange } from '../src/main/browser/verification.js';
import { serializeToolResult } from '../src/main/brain/tool-result-view.js';
import { describeWhen, toSessionDigests } from '../src/main/persistence/temporal.js';

// ---------------------------------------------------------------------------
// TurnBudget
// ---------------------------------------------------------------------------

describe('TurnBudget', () => {
  it('allows exactly the number of calls it advertises', () => {
    const budget = new TurnBudget({ maxToolCalls: 3 });
    // Distinct arguments so the repeat bound is not what is being measured.
    expect(budget.spend('t', { i: 1 }).ok).toBe(true);
    expect(budget.spend('t', { i: 2 }).ok).toBe(true);
    expect(budget.spend('t', { i: 3 }).ok).toBe(true);

    const refused = budget.spend('t', { i: 4 });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.breach).toBe('TOOL_CALLS');
  });

  it('does not charge for a call it refused', () => {
    // A refusal that still consumed budget would make the limit drift down
    // every time the model made a mistake.
    const budget = new TurnBudget({ maxToolCalls: 1 });
    budget.spend('t', { i: 1 });
    budget.spend('t', { i: 2 });
    budget.spend('t', { i: 3 });
    expect(budget.snapshot().toolCalls).toBe(1);
  });

  it('reports time before count, because the diagnosis matters', () => {
    let now = 0;
    const budget = new TurnBudget({ maxToolCalls: 1, maxTurnMilliseconds: 100, now: () => now });
    budget.spend('t', { i: 1 });

    now = 200;
    const refused = budget.spend('t', { i: 2 });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    // Both bounds are blown; the message must name the one the user can act on.
    expect(refused.breach).toBe('TIME');
    expect(refused.message).toMatch(/seconds/);
  });

  it('counts identical calls regardless of argument order', () => {
    const budget = new TurnBudget({ maxRepeatedAttempts: 2 });
    expect(budget.spend('t', { a: 1, b: 2 }).ok).toBe(true);
    expect(budget.spend('t', { b: 2, a: 1 }).ok).toBe(true);

    const third = budget.spend('t', { a: 1, b: 2 });
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable');
    expect(third.breach).toBe('REPEATS');
  });

  it('treats a different argument as a different call', () => {
    const budget = new TurnBudget({ maxRepeatedAttempts: 1 });
    expect(budget.spend('t', { ref: 'e1' }).ok).toBe(true);
    expect(budget.spend('t', { ref: 'e2' }).ok).toBe(true);
    expect(budget.spend('t', { ref: 'e1' }).ok).toBe(false);
  });

  it('publishes counters and nothing else', () => {
    const budget = new TurnBudget({ maxToolCalls: 5 });
    budget.spend('browser.type', { text: 'a private draft' });
    const snapshot = budget.snapshot();

    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.maxToolCalls).toBe(5);
    expect(snapshot.exhausted).toBe(false);
    // Nothing derived from the arguments escapes into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain('private draft');
  });

  it('defaults to the shared limits', () => {
    const budget = new TurnBudget();
    expect(budget.snapshot().maxToolCalls).toBe(AGENT_LOOP_LIMITS.maxToolCalls);
  });
});

// ---------------------------------------------------------------------------
// SideEffectLedger
// ---------------------------------------------------------------------------

describe('SideEffectLedger', () => {
  it('refuses a repeated EXTERNAL action', () => {
    const ledger = new SideEffectLedger();
    expect(ledger.check('EXTERNAL', 'fp1').ok).toBe(true);
    ledger.record('EXTERNAL', 'fp1', 'browser.type', 'attempted');

    const again = ledger.check('EXTERNAL', 'fp1');
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.message).toMatch(/browser\.type/);
  });

  it('never blocks a read or a local action', () => {
    const ledger = new SideEffectLedger();
    ledger.record('NONE', 'fp1', 'browser.read', 'succeeded');
    ledger.record('LOCAL', 'fp2', 'browser.type', 'succeeded');

    expect(ledger.check('NONE', 'fp1').ok).toBe(true);
    expect(ledger.check('LOCAL', 'fp2').ok).toBe(true);
    // Nothing that is not EXTERNAL is even recorded.
    expect(ledger.size).toBe(0);
  });

  it('forgets everything between turns', () => {
    // A user who asks twice means it twice, and the dialog is where they say
    // so. The guard is against an accidental repeat inside one intention.
    const ledger = new SideEffectLedger();
    ledger.record('EXTERNAL', 'fp1', 'browser.type', 'attempted');
    expect(ledger.check('EXTERNAL', 'fp1').ok).toBe(false);

    ledger.reset();
    expect(ledger.check('EXTERNAL', 'fp1').ok).toBe(true);
  });

  it('records an attempt, not only a success', () => {
    // The dangerous case: the request reached the network and the executor
    // then threw. A ledger written only on success would let that be retried.
    const ledger = new SideEffectLedger();
    ledger.record('EXTERNAL', 'fp1', 'browser.type', 'attempted');
    expect(ledger.check('EXTERNAL', 'fp1').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approval binding
// ---------------------------------------------------------------------------

describe('approval binding', () => {
  it('classifies submitting as outward and filling as local', () => {
    expect(classifySideEffect('browser.type', { submit: true })).toBe('EXTERNAL');
    expect(classifySideEffect('browser.type', { submit: false })).toBe('LOCAL');
    expect(classifySideEffect('browser.read', {})).toBe('NONE');
  });

  it('assumes the worst about a tool it does not recognise', () => {
    // Deny-by-default applies to repeatability as much as to permission.
    expect(classifySideEffect('some.future.tool', {})).toBe('EXTERNAL');
  });

  it('escalates to outward when the policy asked a human', () => {
    // "A person had to be asked" is the strongest available signal that
    // something leaves the machine, and it overrides the static table.
    const binding = bindApproval({
      tool: 'browser.click',
      input: { ref: 'e3' },
      page: 'https://github.com/axon/demo/issues/41',
      escalated: true,
    });
    expect(binding.effect).toBe('EXTERNAL');
    expect(binding.target).toBe('https://github.com/axon/demo/issues/41');
  });

  it('describes the act in words a person can check', () => {
    expect(describeAction('browser.type', { submit: true })).toBe('submit text on a web page');
    expect(describeAction('browser.type', { submit: false })).toBe('fill in a field on a web page');
    expect(describeAction('fs.write', { path: 'x' })).toBe('write a file');
  });

  it('fingerprints the arguments, not just the tool', () => {
    const a = fingerprintCall('browser.type', { ref: 'e2', text: 'one', submit: true });
    const b = fingerprintCall('browser.type', { ref: 'e2', text: 'two', submit: true });
    const c = fingerprintCall('browser.click', { ref: 'e2', text: 'one', submit: true });

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(fingerprintCall('browser.type', { submit: true, text: 'one', ref: 'e2' }));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('never puts the arguments in the fingerprint', () => {
    // The fingerprint travels on an event, and events are written to a JSONL
    // file a user may share. It must be a digest, not an encoding.
    const fingerprint = fingerprintCall('browser.type', { text: 'my private draft' });
    expect(fingerprint).not.toContain('private');
    expect(fingerprint).toHaveLength(32);
  });

  it('shares one normalization with the rest of the loop', () => {
    // The repeat bound, the duplicate guard and the binding must agree about
    // whether two calls are the same call.
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: [1, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [1, { c: 2, d: 1 }] }));
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function page(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    epoch: 1,
    url: 'https://github.com/axon/demo/issues/41',
    title: 'An issue',
    text: 'The maintainer replied.',
    textTruncated: false,
    elements: [],
    elementsTruncated: false,
    loading: false,
    ...overrides,
  };
}

describe('verifyChange', () => {
  it('reports no change when nothing changed, and says not to claim success', () => {
    const before = page();
    const verdict = verifyChange({ before, after: page() });

    expect(verdict.changed).toBe(false);
    expect(verdict.summary).toMatch(/nothing observable changed/i);
    expect(verdict.summary).toMatch(/do not report it as done/i);
  });

  it('ignores incidental whitespace', () => {
    // Re-flow is not change. Reporting it as change would make "changed" mean
    // nothing, which is worse than not reporting it at all.
    const before = page({ text: 'one  two\nthree' });
    const after = page({ text: 'one two three' });
    expect(verifyChange({ before, after }).textChanged).toBe(false);
  });

  it('notices a navigation', () => {
    const verdict = verifyChange({
      before: page(),
      after: page({ url: 'https://github.com/axon/demo/issues/42' }),
    });
    expect(verdict.urlChanged).toBe(true);
    expect(verdict.changed).toBe(true);
    expect(verdict.summary).toContain('issues/42');
  });

  it('notices the controls changing even when the text does not', () => {
    const verdict = verifyChange({
      before: page({ elements: [] }),
      after: page({
        elements: [{ ref: 'e1', role: 'button', label: 'Edit', href: null, sensitive: false, submits: false, value: null }],
      }),
    });
    expect(verdict.elementsChanged).toBe(true);
    expect(verdict.changed).toBe(true);
  });

  it('does not treat a re-minted reference as a change', () => {
    // References are minted per reading, so `e1` becoming `e2` for the same
    // element is normal. Identity is role, label and href.
    const element = { role: 'button' as const, label: 'Comment', href: null, sensitive: false, submits: true, value: null };
    const verdict = verifyChange({
      before: page({ elements: [{ ...element, ref: 'e1' }] }),
      after: page({ elements: [{ ...element, ref: 'e7' }] }),
    });
    expect(verdict.elementsChanged).toBe(false);
  });

  it('confirms submitted text when it appears on the page', () => {
    const verdict = verifyChange({
      before: page({ text: 'The maintainer replied.' }),
      after: page({ text: 'The maintainer replied.\nyou commented: Thanks for the clarification.' }),
      submittedText: 'Thanks for the clarification.',
    });
    expect(verdict.submittedTextVisible).toBe(true);
    expect(verdict.summary).toMatch(/now visible on the page/i);
  });

  it('says it could not confirm, rather than that it failed', () => {
    // The distinction the whole file exists for. Axon does not know the site's
    // rendering model, so absence of evidence is reported as exactly that.
    const verdict = verifyChange({
      before: page({ text: 'a' }),
      after: page({ text: 'b' }),
      submittedText: 'Thanks for the clarification.',
    });
    expect(verdict.submittedTextVisible).toBe(false);
    expect(verdict.summary).toMatch(/could not confirm/i);
    expect(verdict.summary).toMatch(/not proof it failed/i);
  });

  it('admits when it has nothing to compare against', () => {
    const verdict = verifyChange({ before: null, after: page() });
    expect(verdict.changed).toBe(false);
    expect(verdict.summary).toMatch(/no earlier reading/i);
  });

  it('finds submitted text that the site re-wrapped', () => {
    const text = 'Thanks for the clarification, I am on 0.4.2 as well and it works.';
    const observation = page({ text: `you commented\n\n   Thanks for the clarification, I am on 0.4.2\n as well and it works.  ` });
    expect(submittedTextVisible(text, observation)).toBe(true);
  });

  it('does not match empty text', () => {
    expect(submittedTextVisible('   ', page())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bounded tool results
// ---------------------------------------------------------------------------

describe('tool results handed back to the model are bounded', () => {
  it('truncates an enormous result and says so', () => {
    const huge = 'x'.repeat(AGENT_LOOP_LIMITS.maxToolResultCharacters * 2);
    const serialized = serializeToolResult({
      callId: 'c1',
      tool: 'browser.read',
      ok: true,
      output: { text: huge },
      durationMs: 1,
    });

    expect(serialized.length).toBeLessThan(AGENT_LOOP_LIMITS.maxToolResultCharacters + 500);
    expect(serialized).toMatch(/Axon truncated this result/);
    // Announced, so the model does not answer confidently from a fragment.
    expect(serialized).toMatch(/incomplete/);
  });

  it('leaves an ordinary result exactly as it was', () => {
    const serialized = serializeToolResult({
      callId: 'c1',
      tool: 'browser.read',
      ok: true,
      output: { title: 'An issue' },
      durationMs: 1,
    });
    expect(JSON.parse(serialized)).toEqual({ success: true, output: { title: 'An issue' } });
  });
});

// ---------------------------------------------------------------------------
// Temporal context
// ---------------------------------------------------------------------------

describe('resolving "yesterday" against a real clock', () => {
  // Constructed in LOCAL time, deliberately.
  //
  // "Yesterday" is a local calendar concept: 23:00 UTC is tomorrow morning in
  // Delhi and yesterday evening in Los Angeles, and the user means the day
  // they lived through. A fixture written in UTC would encode the test
  // machine's offset into the expectations and fail somewhere else — which is
  // how a timezone bug ships.
  const local = (year: number, month: number, day: number, hour = 12): Date =>
    new Date(year, month - 1, day, hour, 0, 0, 0);
  const iso = (date: Date): string => date.toISOString();

  const now = local(2026, 9, 4, 10);

  it('uses calendar days, not elapsed hours', () => {
    // 23:30 last night and 00:30 this morning are an hour apart and on
    // different days. Only the calendar answer matches what a person means.
    expect(describeWhen(iso(local(2026, 9, 4, 9)), now)).toBe('today');
    expect(describeWhen(iso(local(2026, 9, 3, 23)), now)).toBe('yesterday');
    expect(describeWhen(iso(local(2026, 9, 4, 0)), now)).toBe('today');
    expect(describeWhen(iso(local(2026, 9, 2, 10)), now)).toBe('2 days ago');
  });

  it('gives a date once "days ago" stops being useful', () => {
    expect(describeWhen(iso(local(2026, 8, 1, 10)), now)).toMatch(/^on 2026-08-0[12]$/);
  });

  it('does not claim to know the future', () => {
    // A future timestamp means a clock changed, not that Axon can see ahead.
    expect(describeWhen(iso(local(2026, 9, 9, 10)), now)).toMatch(/^at 2026-09-0[89]$/);
  });

  it('survives a corrupted timestamp', () => {
    expect(describeWhen('not a date', now)).toBe('at an unknown time');
  });

  it('digests earlier conversations without their contents', () => {
    const digests = toSessionDigests(
      [
        {
          id: 'a',
          title: 'GitHub issue #41',
          summary: 'check the timeout bug',
          status: 'active',
          createdAt: iso(local(2026, 9, 3, 9)),
          updatedAt: iso(local(2026, 9, 3, 18)),
          messageCount: 8,
        },
        {
          id: 'current',
          title: 'Today',
          summary: null,
          status: 'active',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          messageCount: 1,
        },
        {
          id: 'archived',
          title: 'Old',
          summary: null,
          status: 'archived',
          createdAt: iso(local(2026, 8, 1, 9)),
          updatedAt: iso(local(2026, 8, 1, 9)),
          messageCount: 3,
        },
      ],
      { now, excludeId: 'current' },
    );

    expect(digests).toHaveLength(1);
    expect(digests[0]?.when).toBe('yesterday');
    expect(digests[0]?.title).toBe('GitHub issue #41');
    // No id reaches the prompt: there is nothing here the model could act on.
    expect(JSON.stringify(digests)).not.toContain('"id"');
  });

  it('is bounded, however many conversations exist', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      summary: 'x'.repeat(5_000),
      status: 'active' as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messageCount: 1,
    }));

    const digests = toSessionDigests(many, { now });
    expect(digests.length).toBeLessThanOrEqual(6);
    for (const digest of digests) expect(digest.summary?.length).toBeLessThanOrEqual(240);
  });
});
