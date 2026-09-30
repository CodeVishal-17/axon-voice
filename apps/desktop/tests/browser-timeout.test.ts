/**
 * A navigation is bounded, and what it says afterwards is established.
 *
 * THE LIVE FAILURE THESE TESTS ARE ABOUT. A single `browser.open` stayed in
 * flight for minutes until the whole-turn budget killed it. For a typed
 * assistant that is slow. For one holding a spoken conversation it is broken:
 * the person is sitting in silence with no idea whether anything is happening,
 * and the answer when it finally arrives is "the turn ran out of time", which
 * tells them nothing about the page.
 *
 * So three properties, and the third is the one that keeps the first two
 * honest:
 *
 *   The tool stops waiting on its own clock.
 *   Having stopped, it looks ONCE and says what it found.
 *   It never says the page opened unless it read the page.
 */

import { describe, expect, it, vi } from 'vitest';
import { BROWSING_LIMITS, type BrowserStatus, type ObservedElement, type PageObservation } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { createBrowserOpenTool } from '../src/main/tools/executors/browser.js';
import type { BrowserController } from '../src/main/browser/axon-browser.js';

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

function observationOf(url: string): PageObservation {
  return {
    epoch: 1,
    url,
    title: 'Example',
    text: 'hello',
    textTruncated: false,
    elements: [] as readonly ObservedElement[],
    elementsTruncated: false,
    loading: false,
  };
}

/**
 * A browser that can be told to hang, to fail, or to work.
 *
 * `hang` never resolves, which is exactly the case the deadline exists for:
 * not an error, not a success, just a promise that does not settle.
 */
function fakeBrowser(options: {
  readonly openBehaviour: 'hang' | 'fail' | 'ok';
  /** What a subsequent `read` finds. Null means the read itself fails. */
  readonly readsUrl: string | null;
  readonly readBehaviour?: 'ok' | 'hang' | 'throw';
}) {
  const calls: string[] = [];
  let observation: PageObservation | null = null;

  const controller: BrowserController = {
    status: (): BrowserStatus => ({ available: true, reason: null, open: true, url: observation?.url ?? null }),
    open: (url: string): Promise<PageObservation> => {
      calls.push(`open:${url}`);
      if (options.openBehaviour === 'hang') return new Promise<PageObservation>(() => {});
      if (options.openBehaviour === 'fail') return Promise.reject(new Error('ERR_CONNECTION_TIMED_OUT'));
      observation = observationOf(url);
      return Promise.resolve(observation);
    },
    navigate: (url: string): Promise<PageObservation> => controller.open(url),
    read: (): Promise<PageObservation> => {
      calls.push('read');
      if (options.readBehaviour === 'hang') return new Promise<PageObservation>(() => {});
      if (options.readBehaviour === 'throw') return Promise.reject(new Error('the page could not be read'));
      if (options.readsUrl === null) return Promise.reject(new Error('the page could not be read'));
      observation = observationOf(options.readsUrl);
      return Promise.resolve(observation);
    },
    click: () => Promise.reject(new Error('not used')),
    type: () => Promise.reject(new Error('not used')),
    scroll: () => Promise.reject(new Error('not used')),
    history: () => Promise.reject(new Error('not used')),
    close: () => {},
    lastObservation: () => observation,
    describeElement: () => null,
    observationFresh: () => true,
    beginTurn: () => {},
    cancel: () => {},
  };

  return { controller, calls };
}

/** A dispatcher wrapped around one navigation tool with a short deadline. */
function harness(browser: BrowserController, budgetMs = 40) {
  const bus = new EventBus();
  const registry = new ToolRegistry();
  registry.register(createBrowserOpenTool(browser, { budgetMs }));

  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals: new ApprovalBroker(),
    bus,
    states: noopStates,
    approvalTimeoutMs: 1_000,
  });
  // A real turn, so the repeat bound is live alongside the tool's own.
  dispatcher.beginTurn(new TurnBudget(), 'open example');

  return (url: string) => dispatcher.dispatch({ callId: newCallId(), tool: 'browser.open', input: { url } });
}

// ---------------------------------------------------------------------------

describe('browser.open has a bound of its own', () => {
  it('is shorter than the whole-turn budget, which is what made this necessary', () => {
    // The turn budget is a backstop measured in minutes. A voice agent needs a
    // bound measured in seconds, and the relationship between the two is the
    // point rather than either number.
    expect(BROWSING_LIMITS.navigationBudgetMs).toBeLessThan(BROWSING_LIMITS.navigationTimeoutMs);
    expect(BROWSING_LIMITS.navigationVerifyMs).toBeLessThan(BROWSING_LIMITS.navigationBudgetMs);
  });

  it('stops waiting for a navigation that never settles', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null });
    const run = harness(controller, 40);

    const started = Date.now();
    const result = await run('https://example.com/');
    const elapsed = Date.now() - started;

    // It returned. That is the whole assertion: without the deadline this
    // promise never settles and the test times out.
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('performs exactly one bounded check after the deadline, and no retry', async () => {
    const { controller, calls } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null });
    await harness(controller, 40)('https://example.com/');

    expect(calls.filter((call) => call.startsWith('open:'))).toHaveLength(1);
    expect(calls.filter((call) => call === 'read')).toHaveLength(1);
  });

  it('says STILL_LOADING rather than inventing either answer', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null });
    const result = await harness(controller, 40)('https://example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as { navigation: { status: string }; note: string };
    expect(output.navigation.status).toBe('STILL_LOADING');
    // And it tells the model what that means for what it is about to say.
    expect(output.note).toMatch(/do NOT say it opened/i);
  });

  it('reports SUCCESS after the deadline only when it read the page', async () => {
    // Slow is not failed. The navigation never settles, but the check finds
    // Axon on the requested host — so the page IS loaded, established rather
    // than assumed, and saying otherwise would be its own kind of lie.
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: 'https://example.com/welcome' });
    const result = await harness(controller, 40)('https://example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.output as { navigation: { status: string } }).navigation.status).toBe('SUCCESS');
  });

  it('does not call a different host a success', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: 'https://elsewhere.example.org/' });
    const result = await harness(controller, 40)('https://example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.output as { navigation: { status: string } }).navigation.status).toBe('STILL_LOADING');
  });

  it('bounds the verification too, so a hung read cannot restore the hang', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null, readBehaviour: 'hang' });
    const run = harness(controller, 40);

    const started = Date.now();
    const result = await run('https://example.com/');

    expect(result.ok).toBe(true);
    // The verify bound is the contract's, not the test's, so this only proves
    // it is bounded at all — which is the property that matters.
    expect(Date.now() - started).toBeLessThan(BROWSING_LIMITS.navigationVerifyMs + 3_000);
  });

  it('reports SUCCESS with the page when the navigation simply works', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'ok', readsUrl: 'https://example.com/' });
    const result = await harness(controller, 5_000)('https://example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.output as { navigation: { status: string; landedOn: string } };
    expect(output.navigation.status).toBe('SUCCESS');
    expect(output.navigation.landedOn).toBe('https://example.com/');
  });
});

describe('a failing address is not retried forever', () => {
  it('refuses a third attempt at an address that has already failed twice', async () => {
    const { controller, calls } = fakeBrowser({ openBehaviour: 'fail', readsUrl: null });
    const run = harness(controller, 5_000);

    const first = await run('https://broken.example.com/');
    const second = await run('https://broken.example.com/');
    const third = await run('https://broken.example.com/');

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
    if (third.ok) return;

    // The third is refused BEFORE anything is attempted — a precheck, not a
    // failure — and it is refused non-retryably, so the model is told to stop
    // rather than encouraged to vary the arguments.
    expect(third.failure.kind).toBe('FORBIDDEN');
    expect(third.failure.message).toMatch(/do not try again/i);
    expect(calls.filter((call) => call.startsWith('open:'))).toHaveLength(2);
  });

  it('does not hold a failure against a different address', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'fail', readsUrl: null });
    const run = harness(controller, 5_000);

    await run('https://broken.example.com/');
    await run('https://broken.example.com/');
    const other = await run('https://working.example.com/');

    // It still fails — this browser fails everything — but it was ATTEMPTED,
    // which is the difference between a bound and a blocklist.
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.failure.kind).not.toBe('FORBIDDEN');
  });

  it('forgets the failures once the window has passed', async () => {
    // A site that was down five minutes ago may be up now, and a user who asks
    // again deserves an attempt. This is a bound on a burst, not a ban.
    const clock = { value: 1_000_000 };
    const { controller, calls } = fakeBrowser({ openBehaviour: 'fail', readsUrl: null });

    const bus = new EventBus();
    const registry = new ToolRegistry();
    registry.register(createBrowserOpenTool(controller, { budgetMs: 5_000, now: () => clock.value }));
    const dispatcher = new Dispatcher({
      registry,
      policy: new Policy(),
      approvals: new ApprovalBroker(),
      bus,
      states: noopStates,
      approvalTimeoutMs: 1_000,
    });
    const run = (url: string) => dispatcher.dispatch({ callId: newCallId(), tool: 'browser.open', input: { url } });

    await run('https://broken.example.com/');
    await run('https://broken.example.com/');
    clock.value += 10 * 60_000;
    await run('https://broken.example.com/');

    expect(calls.filter((call) => call.startsWith('open:'))).toHaveLength(3);
  });

  it('does not count a success against the address', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'ok', readsUrl: 'https://example.com/' });
    const run = harness(controller, 5_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await run('https://example.com/');
      expect(result.ok).toBe(true);
    }
  });

  it('is still bounded by the turn budget on top of its own bound', async () => {
    // Belt and braces: the tool's bound is address-keyed and the turn's is
    // not, so a model varying the address still runs out of turn.
    const { controller } = fakeBrowser({ openBehaviour: 'ok', readsUrl: 'https://example.com/' });
    const bus = new EventBus();
    const registry = new ToolRegistry();
    registry.register(createBrowserOpenTool(controller, { budgetMs: 5_000 }));
    const dispatcher = new Dispatcher({
      registry,
      policy: new Policy(),
      approvals: new ApprovalBroker(),
      bus,
      states: noopStates,
      approvalTimeoutMs: 1_000,
    });
    dispatcher.beginTurn(new TurnBudget({ maxToolCalls: 2 }), 'open example');
    const run = (url: string) => dispatcher.dispatch({ callId: newCallId(), tool: 'browser.open', input: { url } });

    await run('https://a.example.com/');
    await run('https://b.example.com/');
    const third = await run('https://c.example.com/');

    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.failure.kind).toBe('BUDGET_EXCEEDED');
  });
});

describe('the deadline does not swallow a real error', () => {
  it('still verifies before declaring failure, and still fails when there is nothing there', async () => {
    const { controller, calls } = fakeBrowser({ openBehaviour: 'fail', readsUrl: null });
    const result = await harness(controller, 5_000)('https://example.com/');

    expect(result.ok).toBe(false);
    // One check, then the original error stands.
    expect(calls.filter((call) => call === 'read')).toHaveLength(1);
  });

  it('turns a reported error into SUCCESS when the page really did load', async () => {
    const { controller } = fakeBrowser({ openBehaviour: 'fail', readsUrl: 'https://example.com/watch' });
    const result = await harness(controller, 5_000)('https://example.com/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.output as { navigation: { status: string }; note: string };
    expect(output.navigation.status).toBe('SUCCESS');
    expect(output.note).toMatch(/navigation reported an error/i);
  });

  it('emits exactly one call and one result whichever way it goes', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    const registry = new ToolRegistry();
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null });
    registry.register(createBrowserOpenTool(controller, { budgetMs: 40 }));
    const dispatcher = new Dispatcher({
      registry,
      policy: new Policy(),
      approvals: new ApprovalBroker(),
      bus,
      states: noopStates,
      approvalTimeoutMs: 1_000,
    });

    await dispatcher.dispatch({ callId: newCallId(), tool: 'browser.open', input: { url: 'https://example.com/' } });

    expect(seen.filter((type) => type === 'TOOL_CALL')).toHaveLength(1);
    expect(seen.filter((type) => type === 'TOOL_RESULT')).toHaveLength(1);
  });
});

describe('the deadline is not a cancellation', () => {
  it('leaves the navigation alone rather than killing a nearly-finished load', async () => {
    // Abandoning the wait is not the same as abandoning the page. Cancelling a
    // load that is one redirect from arriving, purely to satisfy a deadline,
    // would be worse than waiting.
    const cancelled = vi.fn();
    const { controller } = fakeBrowser({ openBehaviour: 'hang', readsUrl: null });
    const spied: BrowserController = { ...controller, cancel: cancelled };

    await harness(spied, 40)('https://example.com/');
    expect(cancelled).not.toHaveBeenCalled();
  });
});
