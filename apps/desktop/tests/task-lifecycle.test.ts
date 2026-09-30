/**
 * A task, its steps, and what happens to results that arrive late.
 *
 * WHAT THIS FILE IS ABOUT, IN THE WORDS OF THE FAILURE IT PREVENTS.
 *
 * Before Phase 3, a tool result had nothing to belong to. It came back and was
 * delivered, because there was no record of which request had asked for it and
 * no way to know the user had said "stop" or asked for something else while it
 * was running. So work the user had abandoned could still speak, and — worse —
 * could still hand the model a result it would use to justify the next step.
 *
 * The ledger is the smallest structure that closes that. These tests hold it
 * to the three properties everything downstream relies on:
 *
 *   ids are never reused, so an old result cannot match a live request;
 *   a step can only be opened against a task that is still ACTIVE;
 *   a cancelled or superseded task never wants anything again.
 *
 * They also hold it to what it is NOT. It grants nothing, it holds no queue of
 * approved future actions, and it carries no arguments, outputs or text — the
 * things that must not accumulate in memory keyed by anything.
 */

import { describe, expect, it } from 'vitest';
import { TASK_LIMITS, describeTaskEnd, matchesCancellation, type TaskStepTrace } from '@axon/core';
import { TaskLedger } from '../src/main/agent/task-ledger.js';

/** A ledger on a clock the test drives. */
function ledger() {
  const clock = { value: 1_000_000 };
  const traces: TaskStepTrace[] = [];
  const instance = new TaskLedger({ now: () => clock.value, onTrace: (trace) => traces.push(trace) });
  return { instance, traces, clock };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('a task and its steps have identities that are never reused', () => {
  it('mints a fresh id for every task and every step', () => {
    const { instance } = ledger();

    const first = instance.begin('open github', 'voice');
    const stepA = instance.beginStep('browser.open');
    const second = instance.begin('open youtube', 'voice');
    const stepB = instance.beginStep('browser.open');

    expect(first).not.toBe(second);
    expect(stepA?.stepId).not.toBe(stepB?.stepId);
    // And a step knows which task it belongs to, which is the whole point.
    expect(stepA?.taskId).toBe(first);
    expect(stepB?.taskId).toBe(second);
  });

  it('does not reuse an id after everything is cleared', () => {
    // Reuse would let a result the model remembered from earlier resolve
    // against something else entirely — the exact failure this prevents.
    const { instance } = ledger();
    const first = instance.begin('one', 'voice');
    instance.clear();
    const second = instance.begin('two', 'voice');
    expect(second).not.toBe(first);
  });

  it('holds the user’s own words as the goal, bounded', () => {
    const { instance } = ledger();
    instance.begin('x'.repeat(5_000), 'voice');
    expect((instance.activeGoal ?? '').length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Steps belong to an active task, or they do not happen
// ---------------------------------------------------------------------------

describe('a step can only be opened against an active task', () => {
  it('refuses when nothing has been asked for', () => {
    const { instance } = ledger();
    expect(instance.beginStep('browser.open')).toBeNull();
  });

  it('refuses once the task has been cancelled', () => {
    const { instance } = ledger();
    instance.begin('open github', 'voice');
    expect(instance.beginStep('browser.open')).not.toBeNull();

    instance.cancelActive();
    // THE CONTROL. A null handle is a refusal the bridge turns into "that
    // request is no longer active", which is what stops the model carrying on
    // with work the user has stopped.
    expect(instance.beginStep('browser.read')).toBeNull();
  });

  it('refuses once the user has asked for something else', () => {
    const { instance } = ledger();
    const first = instance.begin('open github', 'voice');
    instance.begin('what time is it', 'voice');

    expect(instance.statusOf(first)).toBe('SUPERSEDED');
    // The new task is the one steps open against.
    expect(instance.beginStep('system.time')?.taskId).not.toBe(first);
  });

  it('bounds how many steps one task may take', () => {
    const { instance } = ledger();
    instance.begin('do a lot', 'voice');

    for (let i = 0; i < TASK_LIMITS.maxStepsPerTask; i += 1) {
      expect(instance.beginStep('browser.read'), `step ${i}`).not.toBeNull();
    }
    // A task that has taken forty actions has stopped converging.
    expect(instance.beginStep('browser.read')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wanting a result
// ---------------------------------------------------------------------------

describe('whether a result is still wanted', () => {
  it('wants results for the task that is running', () => {
    const { instance } = ledger();
    const task = instance.begin('open github', 'voice');
    expect(instance.wants(task)).toBe(true);
  });

  it('never wants a result for a task the user stopped', () => {
    const { instance } = ledger();
    const task = instance.begin('open github', 'voice');
    instance.cancelActive();

    expect(instance.wants(task)).toBe(false);
    expect(instance.wasCancelled(task)).toBe(true);
  });

  it('never wants a result for a task the user moved on from', () => {
    const { instance } = ledger();
    const task = instance.begin('open github', 'voice');
    instance.begin('what time is it', 'voice');

    expect(instance.wants(task)).toBe(false);
    // And it is NOT reported as cancelled: the user did not tell Axon to stop,
    // they asked for something else, and only the first is worth saying.
    expect(instance.wasCancelled(task)).toBe(false);
  });

  it('still wants a result that arrives just after a task completed', () => {
    // A task can finish while its last result is still travelling. Discarding
    // that would lose an outcome nobody had a reason to throw away.
    const { instance, clock } = ledger();
    const task = instance.begin('open github', 'voice');
    instance.close(task, 'COMPLETED');

    clock.value += TASK_LIMITS.lateResultGraceMs - 1;
    expect(instance.wants(task)).toBe(true);
  });

  it('stops wanting it once the grace window has passed', () => {
    const { instance, clock } = ledger();
    const task = instance.begin('open github', 'voice');
    instance.close(task, 'COMPLETED');

    clock.value += TASK_LIMITS.lateResultGraceMs + 1;
    expect(instance.wants(task)).toBe(false);
  });

  it('wants nothing for a task it has never heard of', () => {
    const { instance } = ledger();
    expect(instance.wants('task-999')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

describe('a finished task stays finished', () => {
  it('cannot be revived by a late completion', () => {
    // Without this, a `COMPLETED` arriving after the user said stop would
    // quietly undo the cancellation and let the result through.
    const { instance } = ledger();
    const task = instance.begin('open github', 'voice');
    instance.cancelActive();
    instance.close(task, 'COMPLETED');

    expect(instance.statusOf(task)).toBe('CANCELLED');
    expect(instance.wants(task)).toBe(false);
  });

  it('reports nothing to cancel when nothing is running', () => {
    const { instance } = ledger();
    expect(instance.cancelActive()).toBeNull();

    instance.begin('open github', 'voice');
    expect(instance.cancelActive()).not.toBeNull();
    expect(instance.cancelActive()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

describe('a task can be reconstructed from its trace', () => {
  it('records the whole shape of one step', () => {
    const { instance, traces } = ledger();
    instance.begin('open github', 'voice');
    const step = instance.beginStep('browser.open');
    expect(step).not.toBeNull();
    if (!step) return;

    instance.endStep(step, 'SUCCEEDED', { risk: 'SAFE', approval: 'not-required', verified: true });

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ tool: 'browser.open', outcome: 'PROPOSED' });
    expect(traces[1]).toMatchObject({
      taskId: step.taskId,
      stepId: step.stepId,
      tool: 'browser.open',
      outcome: 'SUCCEEDED',
      risk: 'SAFE',
      approval: 'not-required',
      verified: true,
    });
  });

  it('carries no arguments, no output and no text', () => {
    // A trace is read in logs and shown in a timeline. A typed password, a
    // page of text or a URL with a token in it has no business in either.
    const { instance, traces } = ledger();
    instance.begin('type my password into the box', 'voice');
    const step = instance.beginStep('keyboard.type');
    if (step) instance.endStep(step, 'SUCCEEDED');

    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toMatch(/"(input|arguments|args|output|text|value)"/);
  });

  it('ties every step to the task that asked for it', () => {
    const { instance, traces } = ledger();
    const first = instance.begin('open github', 'voice');
    const a = instance.beginStep('browser.open');
    instance.begin('open youtube', 'voice');
    const b = instance.beginStep('browser.open');

    expect(a?.taskId).toBe(first);
    expect(b?.taskId).not.toBe(first);
    // Every trace names its task, so one task's steps can be pulled out of a
    // stream carrying several.
    expect(traces.every((trace) => trace.taskId.startsWith('task-'))).toBe(true);
    expect(traces.filter((trace) => trace.taskId === first)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The words that stop it
// ---------------------------------------------------------------------------

describe('recognising a cancellation', () => {
  it('recognises the ways people actually say it', () => {
    for (const said of [
      'stop',
      'Stop.',
      'stop it',
      'Cancel',
      'cancel that',
      'never mind',
      'Nevermind!',
      'forget it',
      'abort',
      "don't do that",
      'Do not do it',
      'okay Axon, stop please',
      'no, wait, stop',
      'hey, cancel',
    ]) {
      expect(matchesCancellation(said), said).toBe(true);
    }
  });

  it('does not fire on a request that merely contains the word', () => {
    // THE ASYMMETRY THAT SETS THE THRESHOLD. A false negative costs the user
    // saying it again. A false positive abandons work they wanted, halfway
    // through, for no reason they can see.
    for (const said of [
      'stop the video',
      'open the stop sign page',
      'stop by the shop on the way',
      "don't stop",
      'cancel my subscription on the website',
      'search for how to cancel a flight',
      'never mind that, open Notepad instead',
      'can you stop the music in Spotify for me',
      'forget it was ever there and open the file',
    ]) {
      expect(matchesCancellation(said), said).toBe(false);
    }
  });

  it('is not fooled by punctuation, case or an apostrophe', () => {
    expect(matchesCancellation('  STOP!!!  ')).toBe(true);
    expect(matchesCancellation('don’t do that')).toBe(true);
    expect(matchesCancellation("Don't do that.")).toBe(true);
  });

  it('ignores nothing at all', () => {
    expect(matchesCancellation('')).toBe(false);
    expect(matchesCancellation('   ')).toBe(false);
    expect(matchesCancellation(undefined as never)).toBe(false);
    expect(matchesCancellation(42 as never)).toBe(false);
  });

  it('says as little as possible about how a task ended', () => {
    // "Stopped." is the whole of what a user needs to hear when they said
    // stop. Anything longer is Axon explaining itself after they moved on.
    expect(describeTaskEnd('CANCELLED')).toBe('Stopped.');
    expect(describeTaskEnd('CANCELLED').split(' ').length).toBe(1);
    expect(describeTaskEnd('ACTIVE')).toBe('');
  });
});
