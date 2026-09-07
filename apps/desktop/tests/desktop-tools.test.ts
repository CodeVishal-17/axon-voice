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
import { parseWindows, type DesktopWindow, type DesktopWindows, type WindowAction } from '../src/main/platform/windows-desktop.js';

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
    expect(result.failure.message).toMatch(/cannot tell which one/i);
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

  it('treats a failed query as an empty desktop rather than a crash', async () => {
    const { WindowsDesktop } = await import('../src/main/platform/windows-desktop.js');
    const desktop = new WindowsDesktop({ run: () => Promise.reject(new Error('boom')) });
    await expect(desktop.list()).resolves.toEqual([]);
    await expect(desktop.act('1', 'focus')).resolves.toBe(false);
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
