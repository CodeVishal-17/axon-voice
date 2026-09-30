/**
 * Phase 4A — window identity and deep UI observation.
 *
 * "What application owns this window?" answered from the operating system
 * (package identity, owning program) before the title, and the accessibility
 * tree read past its first 60 controls — a page at a time, or inside one
 * control — without weakening the reference model. OS fakes only; the live
 * measurements are in the Phase 4A report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OBSERVATION_LIMITS, type ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { AppCatalog, buildCatalog, executableOf, resolveApp } from '../src/main/apps/app-catalog.js';
import { chooseWindow, hasIdentity, ownerOf, windowsOf, withoutNotificationCount } from '../src/main/apps/window-identity.js';
import {
  MAX_OBSERVE_SKIP,
  WindowsDesktop,
  parseReading,
  parseStartMenuApps,
  parseWindows,
  type DefaultBrowser,
  type DesktopApps,
  type DesktopControl,
  type DesktopScreenReading,
  type DesktopUi,
  type DesktopWindow,
  type DesktopWindows,
  type ObserveOptions,
  type RawStartMenuApp,
  type UiInvocation,
} from '../src/main/platform/windows-desktop.js';
import type { AppLauncher } from '../src/main/platform/ports.js';
import { VisualObservationStore } from '../src/main/screen/visual-observation.js';
import { WindowRegistry, createAppFocusTool, createWindowListTool } from '../src/main/tools/executors/windows.js';
import { APP_KEYS } from '../src/main/tools/executors/app-registry.js';
import { createAppLaunchTool } from '../src/main/tools/executors/app-launch.js';
import { createWebOpenTool } from '../src/main/tools/executors/web-open.js';
import { createUiClickTool } from '../src/main/tools/executors/ui-input.js';
import { createUiReadTool } from '../src/main/tools/executors/ui-read.js';

// ---------------------------------------------------------------------------
// The machine Phase 4A was measured on, as the Start menu lists it
// ---------------------------------------------------------------------------

const SPOTIFY_ID = 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify';
const WHATSAPP_ID = '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App';
const BETA_ID = '5319275A.51895FA4EA97F_cv1g1gvanyjgm!App';
const DIA_ID = 'TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia';
const CODE_EXE = 'c:\\users\\me\\appdata\\local\\programs\\microsoft vs code\\code.exe';

const RAW: readonly RawStartMenuApp[] = [
  { name: 'Spotify', appId: SPOTIFY_ID },
  { name: 'WhatsApp', appId: WHATSAPP_ID },
  { name: 'WhatsApp Beta', appId: BETA_ID },
  { name: 'Dia', appId: DIA_ID },
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode', target: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' },
  { name: 'Claude', appId: 'Claude_pzs8sxrjxfjjc!Claude' },
  { name: 'Claude', appId: 'com.squirrel.AnthropicClaude.claude', target: 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\claude.exe' },
  { name: 'Command Prompt', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe' },
];
const APPS = buildCatalog(RAW);
const app = (name: string) => APPS.find((entry) => entry.name === name)!;

let nextHandle = 7000;
function win(title: string, owner: Partial<Pick<DesktopWindow, 'processId' | 'executable' | 'appUserModelId'>> = {}, state: Partial<Pick<DesktopWindow, 'foreground' | 'minimized'>> = {}): DesktopWindow {
  return { handle: String(nextHandle++), title, foreground: false, minimized: false, ...state, ...owner };
}

// ---------------------------------------------------------------------------
// Identity from the listing
// ---------------------------------------------------------------------------

describe('reading window ownership from the listing', () => {
  it('keeps process, program and package identity that have the right shape', () => {
    const [window] = parseWindows(
      JSON.stringify([
        {
          handle: '42',
          title: 'Spotify',
          foreground: true,
          minimized: false,
          processId: 1234,
          executable: 'C:\\Program Files\\WindowsApps\\SpotifyAB\\Spotify.exe',
          appUserModelId: SPOTIFY_ID,
        },
      ]),
    );
    expect(window).toMatchObject({ processId: 1234, appUserModelId: SPOTIFY_ID });
    // Lowercased, because Windows paths are compared case-insensitively.
    expect(window?.executable).toBe('c:\\program files\\windowsapps\\spotifyab\\spotify.exe');
  });

  it('drops a malformed owner as UNKNOWN rather than trusting part of it', () => {
    const windows = parseWindows(
      JSON.stringify([
        { handle: '1', title: 'A', processId: -5, executable: 'Spotify.exe', appUserModelId: 'no bang here' },
        { handle: '2', title: 'B', processId: 1.5, executable: 'C:\\x.exe"; calc', appUserModelId: 'A!B!C' },
        { handle: '3', title: 'C', processId: '77', executable: 'C:\\a\u0007b.exe', appUserModelId: 42 },
        { handle: '4', title: 'D' },
      ]),
    );
    expect(windows).toHaveLength(4);
    for (const window of windows) {
      expect(window.processId).toBeUndefined();
      expect(window.executable).toBeUndefined();
      expect(window.appUserModelId).toBeUndefined();
      expect(hasIdentity(window)).toBe(false);
    }
  });

  it('records a Start-menu shortcut target as the entry\'s program, and nothing else', () => {
    expect(parseStartMenuApps('[{"name":"Code","appId":"Microsoft.VisualStudioCode","target":"C:\\\\Code\\\\Code.exe"}]')[0]?.target).toBe(
      'C:\\Code\\Code.exe',
    );
    expect(app('Visual Studio Code').executable).toBe(CODE_EXE);
    expect(app('Spotify').executable).toBeNull();
    expect(executableOf('Microsoft.VisualStudioCode', 'https://example.com/')).toBeNull();
    expect(executableOf('C:\\Tools\\thing.exe', undefined)).toBe('c:\\tools\\thing.exe');
    expect(executableOf('X', 'C:\\Docs\\manual.pdf')).toBeNull();
  });
});

describe('who owns a window', () => {
  it('recognises a packaged application by its exact package identity', () => {
    const owner = ownerOf(win('The Weeknd – Blinding Lights', { processId: 1, appUserModelId: SPOTIFY_ID }), APPS);
    expect(owner).toMatchObject({ evidence: 'package', app: { name: 'Spotify' } });
  });

  it('tells WhatsApp from WhatsApp Beta although both windows are called "WhatsApp"', () => {
    expect(ownerOf(win('WhatsApp', { appUserModelId: WHATSAPP_ID }), APPS)?.app.name).toBe('WhatsApp');
    expect(ownerOf(win('WhatsApp', { appUserModelId: BETA_ID }), APPS)?.app.name).toBe('WhatsApp Beta');
  });

  it('recognises an unpackaged application by the program its shortcut points at', () => {
    const owner = ownerOf(win('index.ts - axon - Visual Studio Code', { processId: 9, executable: CODE_EXE }), APPS);
    expect(owner).toMatchObject({ evidence: 'executable', app: { name: 'Visual Studio Code' } });
  });

  it('separates the two Claude installs by identity', () => {
    expect(ownerOf(win('Claude', { appUserModelId: 'Claude_pzs8sxrjxfjjc!Claude' }), APPS)?.app.kind).toBe('packaged');
    expect(ownerOf(win('Claude', { executable: 'c:\\users\\me\\appdata\\local\\anthropicclaude\\claude.exe' }), APPS)?.app.kind).toBe(
      'registered',
    );
  });

  it('claims nothing it cannot establish', () => {
    // No identity at all; an identity matching nothing; a program two entries share.
    expect(ownerOf(win('Spotify'), APPS)).toBeNull();
    expect(ownerOf(win('Spotify', { appUserModelId: 'Someone.Else_x!App' }), APPS)).toBeNull();
    const twice = buildCatalog([
      { name: 'Tool A', appId: 'Vendor.ToolA', target: 'C:\\Tools\\tool.exe' },
      { name: 'Tool B', appId: 'Vendor.ToolB', target: 'C:\\Tools\\tool.exe' },
    ]);
    expect(ownerOf(win('Tool', { executable: 'c:\\tools\\tool.exe' }), twice)).toBeNull();
  });

  it('never lets a packaged window fall through to a program match', () => {
    const window = win('Visual Studio Code', { appUserModelId: 'Unrelated.Package_x!App', executable: CODE_EXE });
    expect(ownerOf(window, APPS)).toBeNull();
  });
});

describe("an application's windows", () => {
  it('finds Spotify by its process while its title is a song', () => {
    const song = win('The Weeknd – Blinding Lights', { appUserModelId: SPOTIFY_ID });
    const found = windowsOf(app('Spotify'), [win('Inbox', { appUserModelId: DIA_ID }), song], APPS);
    expect(found).toEqual({ windows: [song], basis: 'identity' });
  });

  it('falls back to the title only where the OS cannot say, and never onto another application\'s window', () => {
    const beta = win('WhatsApp', { appUserModelId: BETA_ID });
    const unknown = win('WhatsApp');
    const browserTab = win('WhatsApp Web - Dia', { appUserModelId: DIA_ID });
    const found = windowsOf(app('WhatsApp'), [beta, unknown, browserTab], APPS);
    expect(found).toEqual({ windows: [unknown], basis: 'title' });
  });

  it('prefers identity over any title when both exist', () => {
    const real = win('Chats', { appUserModelId: WHATSAPP_ID });
    const impostor = win('WhatsApp');
    expect(windowsOf(app('WhatsApp'), [impostor, real], APPS)).toEqual({ windows: [real], basis: 'identity' });
  });

  it('chooses one window only by rules, and otherwise asks', () => {
    const a = win('Project A - Visual Studio Code');
    const b = win('Project B - Visual Studio Code');
    expect(chooseWindow([])).toEqual({ kind: 'none' });
    expect(chooseWindow([a])).toEqual({ kind: 'one', window: a });
    const hidden = { ...b, minimized: true };
    expect(chooseWindow([a, hidden])).toEqual({ kind: 'one', window: a });
    expect(chooseWindow([a, b])).toEqual({ kind: 'ambiguous', windows: [a, b] });
  });
});

// ---------------------------------------------------------------------------
// Tools, through the dispatcher
// ---------------------------------------------------------------------------

function fakeDesktop(initial: DesktopWindow[]) {
  let windows = [...initial];
  const desktop: DesktopWindows = {
    available: true,
    list: () => Promise.resolve([...windows]),
    act: (handle, action) => {
      if (!windows.some((window) => window.handle === handle)) return Promise.resolve(false);
      if (action === 'focus') windows = windows.map((window) => ({ ...window, foreground: window.handle === handle, minimized: window.handle === handle ? false : window.minimized }));
      return Promise.resolve(true);
    },
  };
  return {
    desktop,
    set: (next: DesktopWindow[]) => {
      windows = [...next];
    },
    add: (window: DesktopWindow) => {
      windows = [...windows.map((entry) => ({ ...entry, foreground: false })), window];
    },
    windows: () => windows,
  };
}

async function harness(windows: DesktopWindow[], ui?: DesktopUi, browser: DefaultBrowser | null = null) {
  const fake = fakeDesktop(windows);
  const primed: string[] = [];
  const catalog = new AppCatalog(() => Promise.resolve(RAW));
  await catalog.refresh();
  const store = new VisualObservationStore();
  const launched: string[] = [];
  const uris: string[] = [];
  const launcher: AppLauncher = {
    launchExecutable: () => Promise.resolve({ pid: 1 }),
    openUri: (uri) => {
      uris.push(uri);
      return Promise.resolve();
    },
    launchStartMenuApp: (appId) => {
      launched.push(appId);
      return Promise.resolve();
    },
  };
  const apps: DesktopApps = {
    appsAvailable: true,
    listStartMenuApps: () => Promise.resolve(RAW),
    defaultBrowser: () => Promise.resolve(browser),
  };

  const registry = new ToolRegistry();
  const windowRegistry = new WindowRegistry();
  registry.register(createWindowListTool(fake.desktop, windowRegistry, catalog));
  registry.register(createAppFocusTool(fake.desktop, windowRegistry, APP_KEYS, catalog));
  registry.register(createAppLaunchTool(launcher, { catalog, desktop: fake.desktop, verifyTimeoutMs: 100, verifyIntervalMs: 10, prime: (handle) => primed.push(handle) }));
  registry.register(createWebOpenTool(launcher, { apps, catalog, desktop: fake.desktop, verifyTimeoutMs: 100, verifyIntervalMs: 10 }));
  if (ui) {
    registry.register(createUiReadTool({ ui, store, desktop: fake.desktop, catalog }));
    registry.register(createUiClickTool({ ui, store }));
  }

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus: new EventBus(),
    states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} },
    approvalTimeoutMs: 2_000,
  });
  // The user named the site, so the goal boundary has no reason to ask.
  dispatcher.beginTurn(new TurnBudget(), 'open example.com');
  const run = (tool: string, input: unknown): Promise<ToolResult> => dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });
  const approve = async (tool: string, input: unknown): Promise<ToolResult> => {
    const pending = run(tool, input);
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    approvals.settle(approvals.list()[0]!.callId, 'ALLOW', 'user');
    return pending;
  };
  return { ...fake, run, approve, store, launched, uris, primed };
}

type Loose = { readonly [key: string]: Loose } & { readonly summary?: string; readonly length?: number };
const out = (result: ToolResult): Loose => (result.ok ? (result.output as unknown as Loose) : ({} as Loose));
const kind = (result: ToolResult) => (result.ok ? null : result.failure.kind);

describe('app.focus by ownership', () => {
  it('focuses Spotify whatever its title says', async () => {
    const song = win('The Weeknd – Blinding Lights', { appUserModelId: SPOTIFY_ID });
    const h = await harness([win('Inbox', { appUserModelId: DIA_ID }, { foreground: true }), song]);
    const result = await h.run('app.focus', { app: 'Spotify' });
    expect(result.ok).toBe(true);
    expect(out(result).verified).toMatchObject({ changed: true, recognisedBy: 'identity' });
    expect(h.windows().find((window) => window.handle === song.handle)?.foreground).toBe(true);
  });

  it('focuses WhatsApp, not WhatsApp Beta, when both are called "WhatsApp"', async () => {
    const beta = win('WhatsApp', { appUserModelId: BETA_ID });
    const real = win('WhatsApp', { appUserModelId: WHATSAPP_ID });
    const h = await harness([beta, real]);
    expect((await h.run('app.focus', { app: 'WhatsApp' })).ok).toBe(true);
    expect(h.windows().find((window) => window.handle === real.handle)?.foreground).toBe(true);
    expect(h.windows().find((window) => window.handle === beta.handle)?.foreground).toBe(false);

    expect((await h.run('app.focus', { app: 'WhatsApp Beta' })).ok).toBe(true);
    expect(h.windows().find((window) => window.handle === beta.handle)?.foreground).toBe(true);
  });

  it('picks the one visible window of several, and asks when more than one is visible', async () => {
    const one = win('Project A - Visual Studio Code', { executable: CODE_EXE });
    const two = win('Project B - Visual Studio Code', { executable: CODE_EXE }, { minimized: true });
    const h = await harness([one, two]);
    expect((await h.run('app.focus', { app: 'VS Code' })).ok).toBe(true);
    expect(h.windows().find((window) => window.handle === one.handle)?.foreground).toBe(true);

    h.set([one, { ...two, minimized: false }]);
    const asked = await h.run('app.focus', { app: 'VS Code' });
    expect(kind(asked)).toBe('CLARIFICATION_NEEDED');
    expect(asked.ok ? '' : asked.failure.message).toMatch(/Project A.*Project B/);
  });

  it('falls back to the title when the listing carries no identity', async () => {
    const h = await harness([win('Spotify Free')]);
    const result = await h.run('app.focus', { app: 'Spotify' });
    expect(result.ok).toBe(true);
    expect(out(result).verified).toMatchObject({ recognisedBy: 'title' });
  });

  it('is WINDOW_NOT_FOUND when the only window by that name belongs to someone else', async () => {
    const h = await harness([win('WhatsApp', { appUserModelId: BETA_ID })]);
    expect(kind(await h.run('app.focus', { app: 'WhatsApp' }))).toBe('WINDOW_NOT_FOUND');
  });

  it('is WINDOW_NOT_FOUND when the process closed between listing and focusing', async () => {
    const song = win('Song', { appUserModelId: SPOTIFY_ID });
    const h = await harness([song]);
    const original = h.desktop.act;
    h.desktop.act = (handle, action) => {
      h.set([]);
      return original(handle, action);
    };
    expect(kind(await h.run('app.focus', { app: 'Spotify' }))).toBe('WINDOW_NOT_FOUND');
  });
});

describe('window.list reports the owner as Axon identifies it', () => {
  it('names the owning application by Axon id and name only', async () => {
    const h = await harness([win('The Weeknd – Blinding Lights', { processId: 4242, appUserModelId: SPOTIFY_ID, executable: 'c:\\program files\\windowsapps\\spotify.exe' })]);
    const result = await h.run('window.list', {});
    const text = JSON.stringify(result);
    expect(out(result).windows).toBeDefined();
    const first = (out(result).windows as unknown as { owner: { id: string; name: string } }[])[0];
    expect(first?.owner).toEqual({ id: app('Spotify').id, name: 'Spotify' });
    // Never the process id, the package identity or the program path.
    expect(text).not.toContain('4242');
    expect(text).not.toContain(SPOTIFY_ID);
    expect(text).not.toContain('spotify.exe');
  });
});

describe('app.launch verification by identity', () => {
  it('confirms a launch by the owning process even when the title names something else', async () => {
    const h = await harness([]);
    const launching = h.approve('app.launch', { app: 'Spotify' });
    await vi.waitFor(() => expect(h.launched).toHaveLength(1));
    h.add(win('Blinding Lights', { appUserModelId: SPOTIFY_ID }, { foreground: true }));
    const result = await launching;
    expect(out(result).verified).toMatchObject({ opened: true, evidence: 'identity' });
    expect(out(result).verified?.summary).toMatch(/confirmed by the process/);
  });

  it('does not take WhatsApp Beta\'s window as proof that WhatsApp opened', async () => {
    const h = await harness([win('WhatsApp', { appUserModelId: BETA_ID })]);
    const result = await h.approve('app.launch', { app: 'WhatsApp' });
    expect(out(result).verified).toMatchObject({ opened: false });
  });

  // Chromium-based applications build their accessibility tree only when a
  // client first asks, and that first read of a fresh Spotify measured ~13 s —
  // past the voice provider's tool timeout. So a verified launch warms it.
  it('primes a read of exactly the window it verified, and nothing when it verified none', async () => {
    const h = await harness([]);
    const launching = h.approve('app.launch', { app: 'Spotify' });
    await vi.waitFor(() => expect(h.launched).toHaveLength(1));
    const spotify = win('Spotify Free', { appUserModelId: SPOTIFY_ID }, { foreground: true });
    h.add(spotify);
    await launching;
    expect(h.primed).toEqual([spotify.handle]);

    const unseen = await harness([win('WhatsApp', { appUserModelId: BETA_ID })]);
    await unseen.approve('app.launch', { app: 'WhatsApp' });
    expect(unseen.primed).toEqual([]);
  });
});

describe('web.open verification by the browser\'s process', () => {
  const DIA: DefaultBrowser = { progId: 'DiaHTML', name: 'Dia', appUserModelId: DIA_ID };

  it('names the browser when its own process brings a window forward', async () => {
    const h = await harness([win('New Tab - Dia', { appUserModelId: DIA_ID })], undefined, DIA);
    const opening = h.run('web.open', { url: 'https://example.com' });
    await vi.waitFor(() => expect(h.uris).toHaveLength(1));
    h.set([{ ...h.windows()[0]!, foreground: true, title: 'Example Domain' }]);
    const result = await opening;
    expect(out(result)).toMatchObject({ browserConfirmed: true });
    expect(out(result).verified).toMatchObject({ evidence: 'identity' });
    expect(out(result).verified?.summary).toMatch(/Dia/);
  });

  it('does not count a browser window that merely exists in the background', async () => {
    const h = await harness([win('Old tab - Dia', { appUserModelId: DIA_ID }), win('Editor', {}, { foreground: true })], undefined, DIA);
    const result = await h.run('web.open', { url: 'https://example.com' });
    expect(out(result)).toMatchObject({ browserConfirmed: false });
    expect(out(result).verified).toMatchObject({ opened: false });
    expect(out(result).verified?.summary).toMatch(/handed it to your default browser/);
  });

  it('says only "your default browser" when the browser cannot be identified', async () => {
    const h = await harness([], undefined, null);
    const opening = h.run('web.open', { url: 'https://example.com' });
    await vi.waitFor(() => expect(h.uris).toHaveLength(1));
    h.add(win('Example Domain', { appUserModelId: 'Some.Browser_x!App' }, { foreground: true }));
    const result = await opening;
    expect(out(result)).toMatchObject({ browserConfirmed: false, defaultBrowser: null });
    expect(JSON.stringify(out(result).verified)).not.toMatch(/Chrome|Edge|Firefox|Dia/);
  });
});

// ---------------------------------------------------------------------------
// Deep observation: pages and subtrees
// ---------------------------------------------------------------------------

function control(name: string, role: DesktopControl['role'] = 'button', automationId = ''): DesktopControl {
  return {
    nativeRole: role === 'listitem' ? 'ControlType.ListItem' : 'ControlType.Button',
    role,
    name,
    automationId,
    sensitive: false,
    actions: ['invoke'],
    value: null,
  };
}

/** A window of 150 controls, one of which ("Row 5") contains 3 more. Records every read. */
function bigUi(handle = '9001') {
  const top = Array.from({ length: 150 }, (_, index) => (index === 5 ? control('Row 5', 'listitem', 'row5') : control(`Button ${index}`)));
  const inside = [control('Play Row 5'), control('Like Row 5'), control('More Row 5')];
  const reads: { handle: string | null; options: ObserveOptions }[] = [];
  const acts: string[] = [];
  let rowPresent = true;
  const ui: DesktopUi = {
    uiAvailable: true,
    observeControls: (requested, options = {}) => {
      reads.push({ handle: requested, options });
      const source = options.scope ? (rowPresent && options.scope.automationId === 'row5' ? inside : null) : top;
      if (source === null) {
        return Promise.resolve({
          available: false,
          windowHandle: requested,
          windowTitle: '',
          controls: [],
          truncated: false,
          note: 'The control Axon was asked to read inside is no longer there. Look again.',
          problem: 'STALE_REFERENCE',
        } satisfies DesktopScreenReading);
      }
      const skip = options.skip ?? 0;
      const page = source.slice(skip, skip + OBSERVATION_LIMITS.maxTargets);
      return Promise.resolve({
        available: true,
        windowHandle: requested ?? handle,
        windowTitle: 'Big Window',
        controls: page,
        truncated: skip + page.length < source.length,
        hasMore: skip + page.length < source.length,
        offset: skip,
        note: null,
        problem: null,
      } satisfies DesktopScreenReading);
    },
    actOnControl: (request) => {
      acts.push(request.name);
      return Promise.resolve({ kind: 'ok', value: null });
    },
  };
  return { ui, reads, acts, removeRow: () => (rowPresent = false) };
}

describe('ui.read — pages', () => {
  it('reads 60 at a time and says when there is more, only when there is', async () => {
    const big = bigUi();
    const h = await harness([], big.ui);
    const first = await h.run('ui.read', {});
    expect(out(first)).toMatchObject({ page: 1, pageSize: 60, hasMore: true });
    expect(out(first).targets?.length).toBe(60);

    const second = await h.run('ui.read', { page: 2 });
    expect(out(second)).toMatchObject({ page: 2, hasMore: true });
    expect(out(second).targets?.length).toBe(60);
    expect(big.reads[1]?.options.skip).toBe(60);

    const third = await h.run('ui.read', { page: 3 });
    expect(out(third)).toMatchObject({ hasMore: false });
    expect(out(third).targets?.length).toBe(30);
  });

  it('keeps page-1 references usable after page 2, in one observation', async () => {
    const big = bigUi();
    const h = await harness([], big.ui);
    const first = await h.run('ui.read', {});
    const second = await h.run('ui.read', { page: 2 });
    expect(out(second).observation).toEqual(out(first).observation);

    const ref = (out(first).targets as unknown as { ref: string; name: string }[])[0]!;
    // Activating a control asks first; approved, it acts on page 1's reference.
    const clicked = await h.approve('ui.click', { ref: ref.ref });
    expect(clicked.ok).toBe(true);
    expect(big.acts).toEqual(['Button 0']);
  });

  it('mints distinct references on every page, and none carries a handle or automation id', async () => {
    const h = await harness([], bigUi().ui);
    const one = out(await h.run('ui.read', {}));
    const two = out(await h.run('ui.read', { page: 2 }));
    const refs = [...(one.targets as unknown as { ref: string }[]), ...(two.targets as unknown as { ref: string }[])].map((target) => target.ref);
    expect(new Set(refs).size).toBe(120);
    const text = JSON.stringify([one, two]);
    expect(text).not.toMatch(/9001|automationId|nativeRole|row5|windowHandle/);
  });

  it('refuses every reference after Axon acts — pages do not outlive an action', async () => {
    const h = await harness([], bigUi().ui);
    const first = out(await h.run('ui.read', {}));
    const refs = (first.targets as unknown as { ref: string }[]).map((target) => target.ref);
    expect((await h.approve('ui.click', { ref: refs[0] })).ok).toBe(true);
    expect(kind(await h.run('ui.click', { ref: refs[1] }))).toBe('STALE_REFERENCE');
  });

  it('bounds how far a read may go', async () => {
    const h = await harness([], bigUi().ui);
    expect(kind(await h.run('ui.read', { page: 21 }))).toBe('INVALID_INPUT');
    expect(kind(await h.run('ui.read', { page: 0 }))).toBe('INVALID_INPUT');
    expect(kind(await h.run('ui.read', { page: 1.5 }))).toBe('INVALID_INPUT');
  });

  it('expires page references on their own clock', () => {
    let now = 0;
    const store = new VisualObservationStore({ now: () => now });
    const reading = (controls: DesktopControl[], offset: number): DesktopScreenReading => ({
      available: true,
      windowHandle: '5',
      windowTitle: 'W',
      controls,
      truncated: false,
      offset,
      note: null,
    });
    const first = store.record(null, reading([control('A')], 0));
    now = OBSERVATION_LIMITS.targetTtlMs - 1_000;
    const extended = store.extend(first.id, reading([control('B')], 60));
    expect(extended?.added).toHaveLength(1);
    now = OBSERVATION_LIMITS.targetTtlMs + 1_000;
    expect(store.resolve(first.targets[0]!.ref).ok).toBe(false);
    expect(store.resolve(extended!.added[0]!.ref).ok).toBe(true);
  });

  it('never extends an observation of a different window, or one Axon has acted since', () => {
    const store = new VisualObservationStore();
    const base = (handle: string): DesktopScreenReading => ({
      available: true,
      windowHandle: handle,
      windowTitle: 'W',
      controls: [control('A')],
      truncated: false,
      note: null,
    });
    const first = store.record(null, base('5'));
    expect(store.extend(first.id, base('6'))).toBeNull();
    store.invalidate();
    expect(store.extend(first.id, base('5'))).toBeNull();
  });
});

describe('ui.read — inside one control', () => {
  it('reads only what is beneath a control Axon described, by its reference', async () => {
    const big = bigUi();
    const h = await harness([], big.ui);
    const first = out(await h.run('ui.read', {}));
    const row = (first.targets as unknown as { ref: string; name: string }[]).find((target) => target.name === 'Row 5')!;
    const inside = await h.run('ui.read', { within: row.ref });
    expect(inside.ok).toBe(true);
    expect((out(inside).targets as unknown as { name: string }[]).map((target) => target.name)).toEqual(['Play Row 5', 'Like Row 5', 'More Row 5']);
    // The scope reached the platform as Axon's own record of the control.
    expect(big.reads.at(-1)?.options.scope).toEqual({ nativeRole: 'ControlType.ListItem', name: 'Row 5', automationId: 'row5' });
    expect(out(inside).within).toBe(row.ref);
  });

  it('is STALE_REFERENCE when the control has gone, and never reads something else instead', async () => {
    const big = bigUi();
    const h = await harness([], big.ui);
    const first = out(await h.run('ui.read', {}));
    const row = (first.targets as unknown as { ref: string; name: string }[]).find((target) => target.name === 'Row 5')!;
    big.removeRow();
    expect(kind(await h.run('ui.read', { within: row.ref }))).toBe('STALE_REFERENCE');
  });

  it('refuses a reference Axon never minted, or one in the wrong shape', async () => {
    const h = await harness([], bigUi().ui);
    await h.run('ui.read', {});
    expect(kind(await h.run('ui.read', { within: 't999999' }))).toBe('STALE_REFERENCE');
    for (const within of ['w1', '12345', 'HWND:0x1234', 'e25', '{"automationId":"x"}']) {
      expect(kind(await h.run('ui.read', { within })), within).toBe('INVALID_INPUT');
    }
  });
});

describe('ui.read — by application', () => {
  it('reads the window that application owns, without focusing it', async () => {
    const big = bigUi('7777');
    const song = win('The Weeknd – Blinding Lights', { appUserModelId: SPOTIFY_ID });
    const h = await harness([win('Editor', {}, { foreground: true }), song], big.ui);
    const result = await h.run('ui.read', { app: 'Spotify' });
    expect(result.ok).toBe(true);
    expect(big.reads[0]?.handle).toBe(song.handle);
    expect(out(result).application).toEqual({ id: app('Spotify').id, name: 'Spotify' });
    expect(h.windows().find((window) => window.handle === song.handle)?.foreground).toBe(false);
  });

  it('answers NOT_FOUND, WINDOW_NOT_FOUND, "which one?" and FORBIDDEN as focus does', async () => {
    const h = await harness([win('Command Prompt', { executable: 'c:\\windows\\system32\\cmd.exe' })], bigUi().ui);
    expect(kind(await h.run('ui.read', { app: 'Photoshop' }))).toBe('NOT_FOUND');
    expect(kind(await h.run('ui.read', { app: 'WhatsApp' }))).toBe('WINDOW_NOT_FOUND');
    expect(kind(await h.run('ui.read', { app: 'Claude' }))).toBe('CLARIFICATION_NEEDED');
    expect(kind(await h.run('ui.read', { app: 'Command Prompt' }))).toBe('FORBIDDEN');
    expect(kind(await h.run('ui.read', { app: 'C:\\Windows\\System32\\cmd.exe' }))).toBe('FORBIDDEN');
  });

  it('will not take both an application and a reference', async () => {
    const h = await harness([], bigUi().ui);
    await h.run('ui.read', {});
    expect(kind(await h.run('ui.read', { app: 'Spotify', within: 't1' }))).toBe('INVALID_INPUT');
  });
});

describe('the platform read, paged and scoped', () => {
  it('passes the page and the scope to the program as data, and bounds the page', async () => {
    const invocations: UiInvocation[] = [];
    const desktop = new WindowsDesktop({
      platform: 'win32',
      run: () => Promise.resolve('[]'),
      runUi: (invocation) => {
        invocations.push(invocation);
        return Promise.resolve('{"window":"W","handle":"5","truncated":true,"hasMore":true,"offset":60,"elements":[]}');
      },
    });
    const reading = await desktop.observeControls('5', { skip: 60, scope: { nativeRole: 'ControlType.ListItem', name: 'Row "5"', automationId: '' } });
    expect(invocations[0]).toMatchObject({ mode: 'observe', windowHandle: '5', skip: 60, maxElements: 60 });
    expect(JSON.parse(invocations[0]!.target)).toEqual({ role: 'ControlType.ListItem', name: 'Row "5"', automationId: '' });
    expect(reading).toMatchObject({ hasMore: true, offset: 60 });
    // An empty page past the end is the end of the list — not an inaccessible window.
    expect(reading.problem).toBeNull();

    for (const skip of [-1, 1.5, MAX_OBSERVE_SKIP + 1]) {
      const refused = await desktop.observeControls('5', { skip });
      expect(refused.available, String(skip)).toBe(false);
    }
    expect(invocations).toHaveLength(1);
  });

  it('reports a scope that disappeared as STALE_REFERENCE, distinct from a closed window', () => {
    expect(parseReading('{"error":"scope-gone"}', '5').problem).toBe('STALE_REFERENCE');
    expect(parseReading('{"error":"scope-ambiguous"}', '5').problem).toBe('STALE_REFERENCE');
    expect(parseReading('{"error":"gone"}', '5').problem).toBe('WINDOW_NOT_FOUND');
  });

  // FOUND LIVE. Windows 11 Notepad restores its last session, and that session
  // had the repository's .env open: the editor's value, which a read hands to
  // the model, began "ASSEMBLYAI_API_KEY=". A secret on screen is still a secret.
  it('withholds a control value that is credential-shaped, and marks the control sensitive', () => {
    const elements = [
      { nativeRole: 'ControlType.Document', role: 'textbox', name: 'Text editor', actions: ['setText'], value: 'ASSEMBLYAI_API_KEY=0123456789abcdef0123456789abcdef\r\nOTHER=1' },
      { nativeRole: 'ControlType.Edit', role: 'textbox', name: 'Notes', actions: ['setText'], value: "I'll be there in ten minutes." },
    ];
    const reading = parseReading(JSON.stringify({ window: 'W', handle: '5', elements }), '5');
    expect(reading.controls[0]).toMatchObject({ value: null, sensitive: true });
    expect(reading.controls[1]).toMatchObject({ value: "I'll be there in ten minutes.", sensitive: false });
    expect(JSON.stringify(reading)).not.toContain('0123456789abcdef');
  });

  it('treats "hasMore" as the program\'s finding, not a count', () => {
    expect(parseReading('{"window":"W","handle":"5","hasMore":false,"elements":[]}', '5').hasMore).toBe(false);
    const many = Array.from({ length: 61 }, (_, index) => ({ nativeRole: 'ControlType.Button', role: 'button', name: `B${index}`, actions: ['invoke'] }));
    expect(parseReading(JSON.stringify({ window: 'W', handle: '5', elements: many }), '5').hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security regressions
// ---------------------------------------------------------------------------

describe('Phase 4A security', () => {
  const SRC = path.resolve(__dirname, '../src/main');
  const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('no tool takes a process id, a window handle, a raw automation id or a coordinate', async () => {
    const h = await harness([], bigUi().ui);
    for (const input of [
      { app: 'Spotify', processId: 1234 },
      { app: 'Spotify', handle: '65962' },
      { within: 't1', automationId: 'row5' },
      { x: 10, y: 20 },
    ]) {
      // Unknown keys are stripped by the schema: nothing reaches a lookup.
      const result = await h.run('ui.read', input);
      expect(JSON.stringify(result)).not.toMatch(/1234|65962/);
    }
    for (const rel of ['tools/executors/ui-read.ts', 'tools/executors/windows.ts', 'tools/executors/app-launch.ts', 'tools/executors/web-open.ts']) {
      const schemaText = read(rel);
      expect(schemaText, rel).not.toMatch(/\b(?:processId|pid|hwnd|handle|runtimeId|automationId|x|y)\s*:\s*z\./);
    }
  });

  it('a number the model offers as an application is only ever a name to look up', async () => {
    const song = win('Song', { processId: 4242, appUserModelId: SPOTIFY_ID });
    const h = await harness([song], bigUi().ui);
    expect(kind(await h.run('app.focus', { app: '4242' }))).toBe('NOT_FOUND');
    expect(kind(await h.run('ui.read', { app: song.handle }))).toBe('NOT_FOUND');
  });

  it('keeps identity internal: no tool output projects process, program or package', () => {
    for (const rel of ['tools/executors/ui-read.ts', 'tools/executors/windows.ts']) {
      const source = read(rel);
      expect(source, rel).not.toMatch(/processId\s*:|executable\s*:|appUserModelId\s*:/);
    }
  });

  it('the window program only reads who owns a window: query-limited, no command lines, nothing started', () => {
    const source = read('platform/windows-desktop.ts');
    const program = source.slice(source.indexOf('const SCRIPT = String.raw'), source.indexOf('const APPS_SCRIPT'));
    expect(program).toMatch(/OpenProcess\(0x1000, false, pid\)/);
    expect(program).not.toMatch(/CommandLine|Win32_Process|ReadProcessMemory|TerminateProcess|Start-Process|Invoke-Expression/);
    expect(program).not.toMatch(/SendInput|SetCursorPos|keybd_event|mouse_event/);
  });

  it('the accessibility engine takes its page and scope as validated data, never as text to run', () => {
    // Phase 4B: the engine is native and persistent, so the page and scope
    // arrive as JSON fields on its stdin instead of environment variables —
    // and each is bounded and shape-checked by the engine itself.
    const source = read('platform/uia-program.ts');
    const program = source.slice(source.indexOf('String.raw`'));
    expect(program).toMatch(/Integer\(skipValue, 0, 1140, 0\)/);
    expect(program).toMatch(/Integer\(maxValue, 1, 60, 60\)/);
    expect(program).toMatch(/!Identity\(scopeValue, false, out scope\)/);
    expect(program).not.toMatch(/\$\{/);
  });

  it('the renderer cannot reach identity or deep reads', () => {
    expect(read('../preload/index.ts')).not.toMatch(/ui\.read|observeControls|ownerOf|appUserModelId|processId/);
  });
});

// ---------------------------------------------------------------------------
// A notification count is state, not identity (found live: "(7) WhatsApp")
// ---------------------------------------------------------------------------

describe('a notification count is the window\'s state, never its name', () => {
  it('separates the count from the title, at either end', () => {
    expect(withoutNotificationCount('WhatsApp (7)')).toEqual({ title: 'WhatsApp', unread: 7 });
    expect(withoutNotificationCount('(7) WhatsApp')).toEqual({ title: 'WhatsApp', unread: 7 });
    expect(withoutNotificationCount('WhatsApp (99+)')).toEqual({ title: 'WhatsApp', unread: 99 });
    expect(withoutNotificationCount('WhatsApp')).toEqual({ title: 'WhatsApp', unread: null });
    expect(withoutNotificationCount('Report (final) draft')).toEqual({ title: 'Report (final) draft', unread: null });
  });

  it('resolves "WhatsApp (7)" to WhatsApp — not to nothing, and not to WhatsApp Beta', () => {
    for (const request of ['WhatsApp (7)', '(7) WhatsApp', 'WhatsApp (12+)']) {
      const found = resolveApp(APPS, request);
      expect(found.kind, request).toBe('match');
      expect(found.kind === 'match' && found.app.name).toBe('WhatsApp');
    }
    expect(resolveApp(APPS, 'WhatsApp Beta (3)').kind === 'match' && (resolveApp(APPS, 'WhatsApp Beta (3)') as { app: { name: string } }).app.name).toBe('WhatsApp Beta');
  });

  it('takes WhatsApp\'s frame and its "(7) WhatsApp" content window as ONE window', () => {
    const frame = win('WhatsApp', { appUserModelId: WHATSAPP_ID }, { foreground: true });
    const content = win('(7) WhatsApp', { appUserModelId: WHATSAPP_ID });
    const owned = windowsOf(app('WhatsApp'), [frame, content], APPS);
    expect(owned.windows).toHaveLength(2);
    expect(chooseWindow(owned.windows)).toEqual({ kind: 'one', window: frame });
    // Neither in front: the one without a count.
    const quietFrame = { ...frame, foreground: false };
    expect(chooseWindow([content, quietFrame])).toEqual({ kind: 'one', window: quietFrame });
  });

  it('still asks between two genuinely separate windows', () => {
    const a = win('Untitled - Notepad', { executable: 'c:\\windows\\notepad.exe' });
    const b = win('Untitled - Notepad', { executable: 'c:\\windows\\notepad.exe' });
    expect(chooseWindow([a, b]).kind).toBe('ambiguous');
    expect(chooseWindow([win('WhatsApp (2)'), win('Signal (3)')]).kind).toBe('ambiguous');
  });

  it('never shows the model a count-bearing title as a separate application', async () => {
    const desktop = { available: true, list: () => Promise.resolve([win('(7) WhatsApp', { appUserModelId: WHATSAPP_ID })]), act: () => Promise.resolve(true) };
    const tool = createWindowListTool(desktop as never, new WindowRegistry());
    const output = (await tool.execute({}, { observe: () => undefined } as never)) as { windows: { title: string; unread: number | null }[] };
    expect(output.windows[0]).toMatchObject({ title: 'WhatsApp', unread: 7 });
  });
});
