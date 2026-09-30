/**
 * The window tools, and the boundary they inherit.
 *
 * These are the first tools that reach outside Axon's own windows, so the
 * question they have to answer is the one the browser tools answered for the
 * web: how does a model name a thing it is allowed to touch, without being
 * able to name a thing it is not?
 *
 * The answer is the same. Axon takes a reading, mints references for what it
 * found, and every action names one of those references. A window handle never
 * crosses to the model, so there is no value it could invent that would
 * resolve to a window Axon has not enumerated and described.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AxonEvent, ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import {
  WINDOW_LISTING_MAX_AGE_MS,
  WindowRegistry,
  createAppFocusTool,
  createWindowFocusTool,
  createWindowListTool,
  createWindowMaximizeTool,
  createWindowMinimizeTool,
} from '../src/main/tools/executors/windows.js';
import { APP_KEYS } from '../src/main/tools/executors/app-registry.js';
import { createAppOpenTool } from '../src/main/tools/executors/app-open.js';
import { parseWindows, type DesktopWindow, type DesktopWindows, type WindowAction } from '../src/main/platform/windows-desktop.js';

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

// ---------------------------------------------------------------------------

function win(overrides: Partial<DesktopWindow> & { handle: string; title: string }): DesktopWindow {
  return { foreground: false, minimized: false, ...overrides };
}

/** A desktop that records what it was asked to do. */
function fakeDesktop(initial: readonly DesktopWindow[]) {
  let windows = [...initial];
  const acts: { handle: string; action: WindowAction }[] = [];
  let failNext = false;

  const desktop: DesktopWindows = {
    available: true,
    list: () => Promise.resolve([...windows]),
    act: (handle, action) => {
      acts.push({ handle, action });
      if (failNext) {
        failNext = false;
        return Promise.resolve(false);
      }
      // Model the real effect, so verification has something true to find.
      windows = windows.map((window) => {
        if (window.handle !== handle) return { ...window, foreground: false };
        if (action === 'focus') return { ...window, foreground: true, minimized: false };
        if (action === 'minimize') return { ...window, minimized: true, foreground: false };
        return { ...window, minimized: false, foreground: true };
      });
      return Promise.resolve(true);
    },
  };

  return {
    desktop,
    acts,
    setWindows: (next: readonly DesktopWindow[]) => {
      windows = [...next];
    },
    failNextAct: () => {
      failNext = true;
    },
  };
}

interface Harness {
  readonly registry: ToolRegistry;
  readonly windows: WindowRegistry;
  readonly events: AxonEvent[];
  readonly approvals: ApprovalBroker;
  run(tool: string, input: unknown): Promise<ToolResult>;
}

function harness(desktop: DesktopWindows, now: () => number = () => Date.now()): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const windows = new WindowRegistry(now);
  const registry = new ToolRegistry();
  registry.register(createWindowListTool(desktop, windows));
  registry.register(createWindowFocusTool(desktop, windows));
  registry.register(createWindowMinimizeTool(desktop, windows));
  registry.register(createWindowMaximizeTool(desktop, windows));
  registry.register(createAppFocusTool(desktop, windows, APP_KEYS));

  const approvals = new ApprovalBroker();
  const states: StateController = { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} };
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus,
    states,
    approvalTimeoutMs: 500,
  });
  dispatcher.beginTurn(new TurnBudget());

  return {
    registry,
    windows,
    events,
    approvals,
    run: (tool, input) => dispatcher.dispatch({ callId: newCallId(), tool, input: input as never }),
  };
}

const NOTEPAD = win({ handle: '1001', title: 'Untitled - Notepad' });
const CALC = win({ handle: '1002', title: 'Calculator' });
const BANK = win({ handle: '1003', title: 'Online Banking — Chrome', foreground: true });

// ---------------------------------------------------------------------------
// The model never holds a handle.
// ---------------------------------------------------------------------------

describe('a window is named by reference, never by handle', () => {
  it('mints references and reports titles, not handles', async () => {
    const h = harness(fakeDesktop([NOTEPAD, CALC, BANK]).desktop);
    const result = await h.run('window.list', {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const output = JSON.stringify(result.output);
    expect(output).toContain('"ref":"w1"');
    expect(output).toContain('Untitled - Notepad');
    // The handle stays in the main process. A model that never receives one
    // cannot invent one that resolves.
    expect(output).not.toContain('1001');
    expect(output).not.toContain('handle');
  });

  it('refuses a reference from no listing at all', async () => {
    const h = harness(fakeDesktop([NOTEPAD]).desktop);
    const result = await h.run('window.focus', { ref: 'w1' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.kind).toBe('STALE_REFERENCE');
    expect(result.failure.message).toMatch(/window\.list first/i);
  });

  it('refuses a reference the listing never contained', async () => {
    const rig = fakeDesktop([NOTEPAD]);
    const h = harness(rig.desktop);
    await h.run('window.list', {});

    const result = await h.run('window.focus', { ref: 'w9' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.kind).toBe('STALE_REFERENCE');
    expect(rig.acts).toHaveLength(0);
  });

  it('refuses anything that is not a reference at the schema', async () => {
    const h = harness(fakeDesktop([NOTEPAD]).desktop);
    await h.run('window.list', {});

    for (const ref of ['1001', '0x3E9', 'w', 'notepad', '../w1', 'w1; calc', '']) {
      const result = await h.run('window.focus', { ref });
      expect(result.ok, ref).toBe(false);
      if (!result.ok) expect(result.failure.kind, ref).toBe('INVALID_INPUT');
    }
  });

  it('refuses a listing that has gone stale', async () => {
    // A desktop changes while nobody is looking. A reading from a while ago is
    // not evidence about the desktop now.
    let now = 0;
    const rig = fakeDesktop([NOTEPAD]);
    const h = harness(rig.desktop, () => now);

    await h.run('window.list', {});
    now = WINDOW_LISTING_MAX_AGE_MS + 1;

    const result = await h.run('window.focus', { ref: 'w1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toMatch(/out of date/i);
    expect(rig.acts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Observe, act, verify.
// ---------------------------------------------------------------------------

describe('a window action is verified against a fresh listing', () => {
  it('focuses and confirms from the desktop, not from the return value', async () => {
    const rig = fakeDesktop([NOTEPAD, BANK]);
    const h = harness(rig.desktop);
    await h.run('window.list', {});

    const result = await h.run('window.focus', { ref: 'w1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(rig.acts).toEqual([{ handle: '1001', action: 'focus' }]);
    expect(JSON.stringify(result.output)).toMatch(/"changed":true/);
  });

  it('reports honestly when the window refuses to come forward', async () => {
    // Windows can decline focus. An agent that reports success from a return
    // value is reporting its own optimism.
    const rig = fakeDesktop([NOTEPAD]);
    const h = harness(rig.desktop);
    await h.run('window.list', {});

    // The act "succeeds" but the desktop does not change.
    rig.desktop.act = () => Promise.resolve(true);

    const result = await h.run('window.focus', { ref: 'w1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.output)).toMatch(/"changed":false/);
    expect(JSON.stringify(result.output)).toMatch(/do not report it as done/i);
  });

  it('fails when the window has gone', async () => {
    const rig = fakeDesktop([NOTEPAD]);
    const h = harness(rig.desktop);
    await h.run('window.list', {});
    rig.failNextAct();

    const result = await h.run('window.focus', { ref: 'w1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toMatch(/may have been closed/i);
  });

  it('minimises and maximises, each verified on its own terms', async () => {
    const rig = fakeDesktop([NOTEPAD, CALC]);
    const h = harness(rig.desktop);
    await h.run('window.list', {});

    const minimized = await h.run('window.minimize', { ref: 'w1' });
    expect(minimized.ok).toBe(true);
    expect(JSON.stringify((minimized as { output: unknown }).output)).toMatch(/"changed":true/);

    await h.run('window.list', {});
    const maximized = await h.run('window.maximize', { ref: 'w1' });
    expect(maximized.ok).toBe(true);
    expect(rig.acts.map((act) => act.action)).toEqual(['minimize', 'maximize']);
  });
});

// ---------------------------------------------------------------------------
// app.focus
// ---------------------------------------------------------------------------

describe('app.focus names an application, never a window', () => {
  it('switches to a running permitted application', async () => {
    const rig = fakeDesktop([NOTEPAD, BANK]);
    const h = harness(rig.desktop);

    const result = await h.run('app.focus', { app: 'notepad' });
    expect(result.ok).toBe(true);
    expect(rig.acts).toEqual([{ handle: '1001', action: 'focus' }]);
  });

  it('refuses an application that is not on the permitted list', async () => {
    const h = harness(fakeDesktop([NOTEPAD]).desktop);

    for (const app of ['chrome', 'powershell', 'cmd.exe', 'C:/Windows/System32/cmd.exe']) {
      const result = await h.run('app.focus', { app });
      expect(result.ok, app).toBe(false);
      if (!result.ok) expect(result.failure.kind, app).toBe('INVALID_INPUT');
    }
  });

  it('says so when the application is not running', async () => {
    const h = harness(fakeDesktop([BANK]).desktop);
    const result = await h.run('app.focus', { app: 'notepad' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toMatch(/does not appear to be running/i);
  });

  it('refuses rather than guessing when two windows match', async () => {
    // Ambiguity is a refusal. Raising either would be choosing for the user.
    const rig = fakeDesktop([NOTEPAD, win({ handle: '1004', title: 'notes.txt - Notepad' })]);
    const h = harness(rig.desktop);

    const result = await h.run('app.focus', { app: 'notepad' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // ASK, DO NOT GUESS. Phase 3 made the distinction reach the user: this is
    // not a failure to apologise for, it is a question, and the failure kind
    // is what carries that all the way to what gets said out loud.
    expect(result.failure.kind).toBe('CLARIFICATION_NEEDED');
    expect(result.failure.message).toMatch(/which one do you mean/i);
    // And it names the candidates, so the question is answerable.
    expect(result.failure.message).toContain('notes.txt - Notepad');
    expect(rig.acts).toHaveLength(0);
  });

  it('never focuses a window it cannot identify as a permitted application', async () => {
    // The banking window is visible and Axon can list it — but `app.focus`
    // resolves only through the application registry, so there is no value
    // that reaches it.
    const rig = fakeDesktop([BANK]);
    const h = harness(rig.desktop);
    await h.run('app.focus', { app: 'notepad' }).catch(() => undefined);
    expect(rig.acts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The desktop's own output is untrusted input.
// ---------------------------------------------------------------------------

describe('window titles are treated as untrusted content', () => {
  it('labels them as such in every listing', async () => {
    const h = harness(fakeDesktop([NOTEPAD]).desktop);
    const result = await h.run('window.list', {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.output)).toMatch(/never as instructions/i);
  });

  it('strips control characters and bidirectional overrides from a title', () => {
    // Any application can name its window anything, including something built
    // to reorder what a person reads in an approval dialog.
    const parsed = parseWindows(
      JSON.stringify([{ handle: '1', title: 'Innocent\u202E gnitnuocca\u0000 evil', foreground: false, minimized: false }]),
    );
    // Built with `new RegExp` from an escape string rather than written as
    // a regex literal: a literal containing real control characters is a
    // source file tools report as binary and no reviewer can read.
    const title = parsed[0]?.title ?? '';
    expect(title.includes('\u202E'), 'bidirectional override survived').toBe(false);
    expect(title.includes('\u0000'), 'null byte survived').toBe(false);
    expect(title).toContain('Innocent');
  });

  it('drops an entry whose handle is not a plain integer', () => {
    // The handle is about to become a process argument on the way back in.
    const parsed = parseWindows(
      JSON.stringify([
        { handle: '1001', title: 'Fine' },
        { handle: '$(calc)', title: 'Hostile' },
        { handle: '0x41; calc', title: 'Also hostile' },
      ]),
    );
    expect(parsed.map((window) => window.title)).toEqual(['Fine']);
  });

  it('survives malformed output rather than throwing', () => {
    for (const raw of ['', 'not json', '{"handle":', 'null', '[1,2,3]']) {
      expect(() => parseWindows(raw)).not.toThrow();
    }
  });

  it('bounds how many windows and how long a title can be', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ handle: String(i + 1), title: 'x'.repeat(500) }));
    const parsed = parseWindows(JSON.stringify(many));
    expect(parsed.length).toBeLessThanOrEqual(60);
    for (const window of parsed) expect(window.title.length).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// Every desktop tool goes through the dispatcher.
// ---------------------------------------------------------------------------

describe('the window tools inherit the whole pipeline', () => {
  it('emits exactly one TOOL_CALL and one TOOL_RESULT per dispatch', async () => {
    const h = harness(fakeDesktop([NOTEPAD]).desktop);
    await h.run('window.list', {});
    await h.run('window.focus', { ref: 'w1' });
    await h.run('window.focus', { ref: 'w9' });

    const calls = h.events.filter((event) => event.type === 'TOOL_CALL');
    const results = h.events.filter((event) => event.type === 'TOOL_RESULT');
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);
  });

  it('is bounded by the same turn budget as everything else', async () => {
    const rig = fakeDesktop([NOTEPAD]);
    const h = harness(rig.desktop);

    // Repeated listings of an UNCHANGED desktop are bounded, like repeated
    // reads of an unchanged page.
    const outcomes: boolean[] = [];
    for (let i = 0; i < 8; i += 1) outcomes.push((await h.run('window.list', {})).ok);
    expect(outcomes.some((ok) => !ok)).toBe(true);
  });

  it('spends nothing and does nothing when the platform has no windows', async () => {
    const unavailable: DesktopWindows = {
      available: false,
      list: () => Promise.resolve([]),
      act: () => Promise.resolve(false),
    };
    const h = harness(unavailable);
    const result = await h.run('window.list', {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.output)).toContain('"count":0');
  });
});

// ---------------------------------------------------------------------------
// The program that talks to the OS.
// ---------------------------------------------------------------------------

describe('the desktop query runs a constant program', () => {
  it('passes the handle in argument position and never in the script', async () => {
    const seen: string[][] = [];
    const { WindowsDesktop } = await import('../src/main/platform/windows-desktop.js');
    const desktop = new WindowsDesktop({
      run: (args) => {
        seen.push([...args]);
        return Promise.resolve('ok');
      },
    });

    await desktop.act('1001', 'focus');
    expect(seen).toEqual([['focus', '1001']]);
  });

  it('refuses a handle that is not a plain integer, before spawning anything', async () => {
    const seen: string[][] = [];
    const { WindowsDesktop } = await import('../src/main/platform/windows-desktop.js');
    const desktop = new WindowsDesktop({
      run: (args) => {
        seen.push([...args]);
        return Promise.resolve('ok');
      },
    });

    for (const handle of ['$(calc)', '1001; calc', '0x3E9', '', 'abc', '1'.repeat(40)]) {
      expect(await desktop.act(handle, 'focus'), handle).toBe(false);
    }
    expect(seen).toHaveLength(0);
  });

  it('reports a failed query as a failure — never as an empty desktop, and never as a crash', async () => {
    // CHANGED DELIBERATELY, with the Phase 2 error taxonomy. This used to
    // assert `list()` resolved [] on failure — "a listing that failed is an
    // empty listing". `app.focus` then read that empty list as "Calculator
    // does not appear to be running", so a slow PowerShell start reached the
    // user as a false statement about their desktop. A failed listing has
    // established nothing, and now says so. The original intent holds: it is
    // not a crash. It is a rejection the dispatcher turns into a structured
    // tool failure, and the callers that can tolerate a missing listing
    // (launch verification, the post-act re-check) catch it.
    const { WindowsDesktop } = await import('../src/main/platform/windows-desktop.js');
    const { ToolError } = await import('@axon/core');

    const broken = new WindowsDesktop({ run: () => Promise.reject(new Error('boom')) });
    await expect(broken.list()).rejects.toThrow('Axon could not read the list of open windows.');

    // A timeout says it is one — the only failure allowed to.
    const slow = new WindowsDesktop({ run: () => Promise.reject(new ToolError('TIMEOUT', 'too slow')) });
    await expect(slow.list()).rejects.toMatchObject({ toolFailureKind: 'TIMEOUT' });

    // Acting is unchanged: a refused act is `false`, and the tool re-checks.
    await expect(broken.act('1', 'focus')).resolves.toBe(false);
  });

  it('does nothing at all when the platform is not Windows', async () => {
    const { WindowsDesktop } = await import('../src/main/platform/windows-desktop.js');
    const desktop = new WindowsDesktop({ platform: 'darwin' });
    expect(desktop.available).toBe(false);
    await expect(desktop.list()).resolves.toEqual([]);
  });
});

// Keeps `vi` referenced for the config's strict unused checks in this file.
void vi;


// ---------------------------------------------------------------------------
// app.open verifies against a window, not against a pid
// ---------------------------------------------------------------------------

/**
 * "Calculator is open" has to be established, not assumed.
 *
 * `CreateProcess` returning a pid means the operating system agreed to start
 * something. It does not mean an application opened: the executable can exit
 * immediately, a policy can block it, an installer can be pending, another
 * instance can take the launch and do nothing visible.
 *
 * Reporting success from a pid is reporting Axon's own optimism, and it is the
 * same defect as claiming a page loaded because a navigation was requested —
 * which is a mistake this codebase has already made once, in the browser, and
 * fixed there for the same reason.
 */
describe('app.open establishes that the window appeared', () => {
  function openHarness(windows: readonly DesktopWindow[], options: { readonly available?: boolean } = {}) {
    const launched: string[] = [];
    let current = [...windows];

    const desktop: DesktopWindows = {
      available: options.available ?? true,
      list: () => Promise.resolve([...current]),
      act: () => Promise.resolve(true),
    };

    const bus = new EventBus();
    const events: AxonEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const registry = new ToolRegistry();
    registry.register(
      createAppOpenTool(
        {
          launchExecutable: (file) => {
            launched.push(file);
            return Promise.resolve({ pid: 4242 });
          },
          openUri: (uri) => {
            launched.push(uri);
            return Promise.resolve();
          },
        },
        { desktop, verifyTimeoutMs: 120, verifyIntervalMs: 20 },
      ),
    );

    const approvals = new ApprovalBroker();
    const dispatcher = new Dispatcher({
      registry,
      policy: new Policy(),
      approvals,
      bus,
      states: noopStates,
      approvalTimeoutMs: 1_000,
    });

    return {
      events,
      launched,
      appear: (window: DesktopWindow) => {
        current = [...current, window];
      },
      run: (app: string): Promise<ToolResult> =>
        dispatcher.dispatch({ callId: newCallId(), tool: 'app.open', input: { app } as never }),
    };
  }

  it('says it is open when a window for it is actually there', async () => {
    const h = openHarness([win({ handle: '2001', title: 'Calculator' })]);
    const result = await h.run('calculator');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = (result.output as { verified: { opened: boolean; window: string; summary: string } }).verified;
    expect(verified.opened).toBe(true);
    expect(verified.window).toBe('Calculator');
    expect(verified.summary).toBe('Calculator is open.');
  });

  it('waits for a window that takes a moment to appear', async () => {
    // Applications are not instant. Verification that gave up immediately
    // would report every cold start as a failure.
    const h = openHarness([]);
    setTimeout(() => h.appear(win({ handle: '2002', title: 'Untitled - Notepad' })), 40);

    const result = await h.run('notepad');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.output as { verified: { opened: boolean } }).verified.opened).toBe(true);
  });

  it('does NOT say it is open when no window ever appears', async () => {
    // The failure this whole change exists for. The launch "succeeded" — a pid
    // came back — and nothing opened.
    const h = openHarness([]);
    const result = await h.run('calculator');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = (result.output as { verified: { opened: boolean; window: null; summary: string } }).verified;

    expect(h.launched).toHaveLength(1);
    expect(verified.opened).toBe(false);
    expect(verified.window).toBeNull();
    expect(verified.summary).toMatch(/do not say it is open/i);
  });

  it('is not fooled by some other application being open', async () => {
    const h = openHarness([win({ handle: '2003', title: 'Untitled - Notepad' })]);
    const result = await h.run('calculator');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.output as { verified: { opened: boolean } }).verified.opened).toBe(false);
  });

  it('says it could not check, rather than claiming success, where it cannot look', async () => {
    // Off Windows there is no window list. "I started it and cannot check" is
    // true; "it is open" would not be.
    const h = openHarness([], { available: false });
    const result = await h.run('calculator');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = (result.output as { verified: { opened: boolean; summary: string } }).verified;
    expect(verified.opened).toBe(false);
    expect(verified.summary).toMatch(/cannot check the desktop/i);
    expect(verified.summary).toMatch(/do not claim it is open/i);
  });

  it('records what it established in the timeline, either way', async () => {
    const opened = openHarness([win({ handle: '2004', title: 'Calculator' })]);
    await opened.run('calculator');
    expect(
      opened.events.some((event) => event.type === 'OBSERVATION' && /is open/.test(event.summary)),
    ).toBe(true);

    const missing = openHarness([]);
    await missing.run('calculator');
    expect(
      missing.events.some((event) => event.type === 'OBSERVATION' && /no window appeared/.test(event.summary)),
    ).toBe(true);
  });

  it('still refuses anything outside the allowlist, unchanged', async () => {
    // Verification is an addition, not a relaxation.
    const h = openHarness([]);
    for (const hostile of ['powershell', 'cmd.exe', 'C:/Windows/System32/cmd.exe', 'chrome']) {
      const result = await h.run(hostile);
      expect(result.ok, hostile).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('INVALID_INPUT');
    }
    expect(h.launched).toEqual([]);
  });
});
