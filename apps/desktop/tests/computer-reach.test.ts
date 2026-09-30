/**
 * Phase 3 — real computer reach: `app.launch`, `app.focus` by name, and
 * `web.open`, through the real dispatcher.
 *
 *   USER REQUEST → MODEL SELECTS A NAME → AXON RESOLVES → POLICY → APPROVAL
 *   → LAUNCH → WINDOW DISCOVERY → VERIFY → RESULT
 *
 * never MODEL → RAW PATH → EXECUTE. Every test here uses fakes for the OS; the
 * live measurements are in the Phase 3 report, not in CI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AxonEvent, ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry, createDefaultRegistry } from '../src/main/tools/registry.js';
import { AppCatalog } from '../src/main/apps/app-catalog.js';
import { siteName, checkGoalBoundary } from '../src/main/safety/goal-boundary.js';
import { assumeHttps } from '../src/main/browser/url-policy.js';
import type { AppLauncher, LaunchedApp } from '../src/main/platform/ports.js';
import type {
  DefaultBrowser,
  DesktopApps,
  DesktopWindow,
  DesktopWindows,
  RawStartMenuApp,
} from '../src/main/platform/windows-desktop.js';
import { WindowRegistry, createAppFocusTool } from '../src/main/tools/executors/windows.js';
import { APP_KEYS } from '../src/main/tools/executors/app-registry.js';
import { createAppLaunchTool } from '../src/main/tools/executors/app-launch.js';
import { createWebOpenTool } from '../src/main/tools/executors/web-open.js';

const RAW: readonly RawStartMenuApp[] = [
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  { name: 'Claude', appId: 'Claude_pzs8sxrjxfjjc!Claude' },
  { name: 'Claude', appId: 'com.squirrel.AnthropicClaude.claude' },
  { name: 'Command Prompt', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe' },
  { name: 'Anaconda Prompt', appId: 'C:\\Users\\me\\anaconda3\\anaconda-prompt.exe' },
  { name: 'Anaconda Prompt', appId: 'C:\\ProgramData\\anaconda3\\anaconda-prompt.exe' },
  { name: 'Dia', appId: 'TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia' },
];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function win(handle: string, title: string, foreground = false): DesktopWindow {
  return { handle, title, foreground, minimized: false };
}

interface World {
  windows: DesktopWindow[];
  /** What a launch of each AppID makes appear, if anything. */
  opens: Record<string, string>;
  /** What handing each URL to the browser makes appear, if anything. */
  pages: Record<string, string>;
}

function fakeWorld(initial: DesktopWindow[] = []) {
  const world: World = { windows: [...initial], opens: {}, pages: {} };
  let next = 5000;
  const show = (title: string): void => {
    world.windows = [...world.windows.map((window) => ({ ...window, foreground: false })), win(String(next++), title, true)];
  };

  const launched: string[] = [];
  const uris: string[] = [];
  const executables: string[] = [];
  const launcher: AppLauncher = {
    launchExecutable: (file: string): Promise<LaunchedApp> => {
      executables.push(file);
      return Promise.resolve({ pid: 4242 });
    },
    openUri: (uri: string) => {
      uris.push(uri);
      const title = world.pages[uri];
      if (title) show(title);
      return Promise.resolve();
    },
    launchStartMenuApp: (appId: string) => {
      launched.push(appId);
      const title = world.opens[appId];
      if (title) show(title);
      return Promise.resolve();
    },
  };

  const desktop: DesktopWindows = {
    available: true,
    list: () => Promise.resolve([...world.windows]),
    act: (handle, action) => {
      if (action !== 'focus') return Promise.resolve(false);
      if (!world.windows.some((window) => window.handle === handle)) return Promise.resolve(false);
      world.windows = world.windows.map((window) => ({ ...window, foreground: window.handle === handle }));
      return Promise.resolve(true);
    },
  };

  return { world, launcher, desktop, launched, uris, executables };
}

function fakeApps(browser: DefaultBrowser | null, raw: readonly RawStartMenuApp[] = RAW): DesktopApps & { listings: number } {
  const apps = {
    appsAvailable: true,
    listings: 0,
    listStartMenuApps: () => {
      apps.listings += 1;
      return Promise.resolve(raw);
    },
    defaultBrowser: () => Promise.resolve(browser),
  };
  return apps;
}

const DIA: DefaultBrowser = { progId: 'DiaHTML', name: 'Dia', appUserModelId: 'TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia' };

async function harness(options: { windows?: DesktopWindow[]; browser?: DefaultBrowser | null; goal?: string | null; warm?: boolean } = {}) {
  const fake = fakeWorld(options.windows ?? []);
  const apps = fakeApps(options.browser === undefined ? DIA : options.browser);
  const catalog = new AppCatalog(() => apps.listStartMenuApps());
  if (options.warm !== false) await catalog.refresh();

  const registry = new ToolRegistry();
  const windows = new WindowRegistry();
  registry.register(createAppLaunchTool(fake.launcher, { catalog, desktop: fake.desktop, verifyTimeoutMs: 120, verifyIntervalMs: 10 }));
  registry.register(createAppFocusTool(fake.desktop, windows, APP_KEYS, catalog));
  registry.register(
    createWebOpenTool(fake.launcher, { apps, catalog, desktop: fake.desktop, verifyTimeoutMs: 120, verifyIntervalMs: 10 }),
  );

  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const approvals = new ApprovalBroker();
  const states: StateController = { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} };
  const dispatcher = new Dispatcher({ registry, policy: new Policy(), approvals, bus, states, approvalTimeoutMs: 2_000 });
  dispatcher.beginTurn(new TurnBudget(), options.goal ?? null);

  const run = (tool: string, input: unknown): Promise<ToolResult> =>
    dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });

  /** Dispatch, wait for the approval it must raise, answer it. */
  const approve = async (tool: string, input: unknown, decision: 'ALLOW' | 'DENY' = 'ALLOW'): Promise<ToolResult> => {
    const pending = run(tool, input);
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    approvals.settle(approvals.list()[0]!.callId, decision, 'user');
    return pending;
  };

  const requiresApproval = (tool: string, input: unknown): boolean => dispatcher.requiresApproval(tool, input as never);

  return { ...fake, apps, catalog, run, approve, approvals, events, requiresApproval };
}

const failure = (result: ToolResult) => (result.ok ? null : result.failure);
/** A result's output, loosely typed for assertions. */
type Loose = { readonly [key: string]: Loose } & { readonly summary?: string; readonly id?: string };
const output = (result: ToolResult): Loose | null => (result.ok ? (result.output as unknown as Loose) : null);

// ---------------------------------------------------------------------------
// app.launch
// ---------------------------------------------------------------------------

describe('app.launch — a discovered application', () => {
  it('asks first, launches by the catalog AppID, and verifies by the window title', async () => {
    const h = await harness();
    h.world.opens['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'] = 'Spotify Premium';

    expect(h.requiresApproval('app.launch', { app: 'Spotify' })).toBe(true);
    const result = await h.approve('app.launch', { app: 'Spotify' });

    expect(result.ok).toBe(true);
    expect(h.launched).toEqual(['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']);
    expect(output(result)?.verified).toMatchObject({ opened: true, evidence: 'title', window: 'Spotify Premium' });
    expect(output(result)?.app).toMatchObject({ name: 'Spotify', kind: 'Microsoft Store app' });
    expect(output(result)?.app?.id).toMatch(/^app_[0-9a-f]{10}$/);
  });

  it('never puts the AppID into a result, an approval or an event', async () => {
    const h = await harness();
    h.world.opens['Microsoft.VisualStudioCode'] = 'Welcome - Visual Studio Code';
    const pending = h.run('app.launch', { app: 'VS Code' });
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    const request = JSON.stringify(h.approvals.list()[0]);
    expect(request).toContain('Visual Studio Code');
    expect(request).not.toContain('Microsoft.VisualStudioCode');
    h.approvals.settle(h.approvals.list()[0]!.callId, 'ALLOW', 'user');
    const result = await pending;

    expect(h.launched).toEqual(['Microsoft.VisualStudioCode']);
    expect(JSON.stringify(result)).not.toContain('Microsoft.VisualStudioCode');
    expect(JSON.stringify(h.events)).not.toContain('Microsoft.VisualStudioCode');
  });

  it('launches nothing when the user says no', async () => {
    const h = await harness();
    const result = await h.approve('app.launch', { app: 'WhatsApp' }, 'DENY');
    expect(result.ok).toBe(false);
    expect(h.launched).toEqual([]);
  });

  it('reports "started, window not seen" as unverified — never as open', async () => {
    const h = await harness();
    const result = await h.approve('app.launch', { app: 'WhatsApp' });
    expect(result.ok).toBe(true);
    expect(h.launched).toHaveLength(1);
    expect(output(result)?.verified).toMatchObject({ opened: false, evidence: null });
    expect(output(result)?.verified?.summary).toMatch(/Do not say it is open/);
  });

  it('accepts a new window in front as weaker evidence, and says so', async () => {
    const h = await harness({ windows: [win('1', 'Something else', true)] });
    h.world.opens['5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'] = 'Chats';
    const result = await h.approve('app.launch', { app: 'WhatsApp' });
    expect(output(result)?.verified).toMatchObject({ opened: true, evidence: 'new-window' });
    expect(output(result)?.verified?.summary).toMatch(/appears to be open/);
  });

  it('answers NOT_FOUND before any approval for an application that is not installed', async () => {
    const h = await harness();
    expect(h.requiresApproval('app.launch', { app: 'Photoshop' })).toBe(false);
    const result = await h.run('app.launch', { app: 'Photoshop' });
    expect(failure(result)?.kind).toBe('NOT_FOUND');
    expect(h.approvals.list()).toHaveLength(0);
    expect(h.launched).toEqual([]);
  });

  it('asks which one — never picks — when two applications share the name', async () => {
    const h = await harness();
    const result = await h.run('app.launch', { app: 'Claude' });
    expect(failure(result)?.kind).toBe('CLARIFICATION_NEEDED');
    expect(failure(result)?.message).toMatch(/Which one do you mean\?/);
    expect(h.approvals.list()).toHaveLength(0);
    expect(h.launched).toEqual([]);
  });

  it('resolves the answer to a clarification by the id it offered', async () => {
    const h = await harness();
    const question = failure(await h.run('app.launch', { app: 'Claude' }))?.message ?? '';
    const id = /is (app_[0-9a-f]{10})/.exec(question)?.[1];
    expect(id).toBeDefined();
    const result = await h.approve('app.launch', { app: id });
    expect(result.ok).toBe(true);
    expect(h.launched).toHaveLength(1);
  });

  it('refuses blocked applications outright — FORBIDDEN, no approval dialog', async () => {
    const h = await harness();
    for (const app of ['Command Prompt', 'Anaconda Prompt']) {
      const result = await h.run('app.launch', { app });
      expect(failure(result)?.kind, app).toBe('FORBIDDEN');
    }
    expect(h.approvals.list()).toHaveLength(0);
    expect(h.launched).toEqual([]);
  });

  it('refuses a path or a command as FORBIDDEN before looking anything up', async () => {
    const h = await harness();
    for (const app of [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Users\\me\\AppData\\Local\\evil.exe',
      'powershell.exe -c whoami',
      'spotify --remote-debugging-port=9222',
      'shell:AppsFolder\\Microsoft.VisualStudioCode',
      '\\\\attacker\\share\\payload',
    ]) {
      const result = await h.run('app.launch', { app });
      expect(failure(result)?.kind, app).toBe('FORBIDDEN');
    }
    expect(h.launched).toEqual([]);
    expect(h.executables).toEqual([]);
  });

  it('refuses a raw AppID the model copied from somewhere: it is not a name', async () => {
    const h = await harness();
    // Not a name in the catalog, and not an Axon id — so it is looked up, found
    // nowhere, and nothing starts. The AppID is never a launch target on its own.
    const result = await h.run('app.launch', { app: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' });
    expect(result.ok).toBe(false);
    expect(h.launched).toEqual([]);
  });

  it('refuses a made-up Axon id as NOT_FOUND', async () => {
    const h = await harness();
    const result = await h.run('app.launch', { app: 'app_0123456789' });
    expect(failure(result)?.kind).toBe('NOT_FOUND');
    expect(h.launched).toEqual([]);
  });

  it('keeps the built-in applications on their own path and risk', async () => {
    const h = await harness();
    expect(h.requiresApproval('app.launch', { app: 'Notepad' })).toBe(false);
    const result = await h.run('app.launch', { app: 'notepad' });
    expect(result.ok).toBe(true);
    expect(h.executables).toEqual(['notepad.exe']);
    expect(h.launched).toEqual([]);
    // Task Manager is gated by the registry, and stays gated here.
    expect(h.requiresApproval('app.launch', { app: 'Task Manager' })).toBe(true);
  });

  it('looks before it answers when the catalog has never been taken', async () => {
    const h = await harness({ warm: false });
    h.world.opens['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'] = 'Spotify';
    // Unknown at approval time — asked about, not refused and not waved through.
    expect(h.requiresApproval('app.launch', { app: 'Spotify' })).toBe(true);
    const result = await h.approve('app.launch', { app: 'Spotify' });
    expect(result.ok).toBe(true);
    expect(h.apps.listings).toBe(1);
  });

  it('says UNSUPPORTED where there is no way to start a discovered application', async () => {
    const fake = fakeWorld();
    const catalog = new AppCatalog(() => Promise.resolve(RAW));
    await catalog.refresh();
    const { launchStartMenuApp: _omitted, ...withoutStartMenu } = fake.launcher;
    const registry = new ToolRegistry();
    registry.register(createAppLaunchTool(withoutStartMenu, { catalog, desktop: fake.desktop, verifyTimeoutMs: 50, verifyIntervalMs: 10 }));
    const approvals = new ApprovalBroker();
    const dispatcher = new Dispatcher({
      registry,
      policy: new Policy(),
      approvals,
      bus: new EventBus(),
      states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} },
      approvalTimeoutMs: 2_000,
    });
    dispatcher.beginTurn(new TurnBudget());
    const pending = dispatcher.dispatch({ callId: newCallId(), tool: 'app.launch', input: { app: 'Spotify' } as never });
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    approvals.settle(approvals.list()[0]!.callId, 'ALLOW', 'user');
    expect(failure(await pending)?.kind).toBe('UNSUPPORTED');
  });
});

// ---------------------------------------------------------------------------
// app.focus, by name
// ---------------------------------------------------------------------------

describe('app.focus — a discovered application', () => {
  it('brings a running discovered application to the front', async () => {
    const h = await harness({ windows: [win('1', 'Spotify Premium'), win('2', 'Inbox', true)] });
    expect(h.requiresApproval('app.focus', { app: 'Spotify' })).toBe(false);
    const result = await h.run('app.focus', { app: 'Spotify' });
    expect(result.ok).toBe(true);
    expect(output(result)?.verified).toMatchObject({ changed: true });
    expect(h.world.windows.find((window) => window.handle === '1')?.foreground).toBe(true);
  });

  it('still focuses the built-in applications by key', async () => {
    const h = await harness({ windows: [win('1', 'Untitled - Notepad')] });
    const result = await h.run('app.focus', { app: 'notepad' });
    expect(result.ok).toBe(true);
  });

  it('WINDOW_NOT_FOUND when it is installed but not running', async () => {
    const h = await harness({ windows: [win('2', 'Inbox', true)] });
    expect(failure(await h.run('app.focus', { app: 'WhatsApp' }))?.kind).toBe('WINDOW_NOT_FOUND');
  });

  it('NOT_FOUND when it is not installed', async () => {
    const h = await harness();
    expect(failure(await h.run('app.focus', { app: 'Photoshop' }))?.kind).toBe('NOT_FOUND');
  });

  it('refuses blocked applications and paths', async () => {
    const h = await harness({ windows: [win('9', 'Command Prompt')] });
    expect(failure(await h.run('app.focus', { app: 'Command Prompt' }))?.kind).toBe('FORBIDDEN');
    expect(failure(await h.run('app.focus', { app: 'C:\\Windows\\System32\\cmd.exe' }))?.kind).toBe('FORBIDDEN');
    expect(h.world.windows.find((window) => window.handle === '9')?.foreground).toBe(false);
  });

  it('matches whole words of the title, never a fragment of another name', async () => {
    const h = await harness({ windows: [win('1', 'Spotifyish Clone')] });
    expect(failure(await h.run('app.focus', { app: 'Spotify' }))?.kind).toBe('WINDOW_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// web.open
// ---------------------------------------------------------------------------

describe('web.open — the default browser', () => {
  it('hands a public address to the default browser and verifies by title', async () => {
    const h = await harness({ goal: 'open youtube in my browser' });
    h.world.pages['https://www.youtube.com/'] = 'YouTube - Dia';
    expect(h.requiresApproval('web.open', { url: 'https://www.youtube.com' })).toBe(false);
    const result = await h.run('web.open', { url: 'https://www.youtube.com' });
    expect(result.ok).toBe(true);
    expect(h.uris).toEqual(['https://www.youtube.com/']);
    expect(output(result)).toMatchObject({ handedTo: 'default-browser', defaultBrowser: 'Dia' });
    expect(output(result)?.verified).toMatchObject({ opened: true, evidence: 'title' });
    expect(output(result)?.verified?.summary).toMatch(/open in Dia/);
  });

  it('accepts a bare hostname as https', async () => {
    const h = await harness({ goal: 'open github' });
    const result = await h.run('web.open', { url: 'github.com' });
    expect(result.ok).toBe(true);
    expect(h.uris).toEqual(['https://github.com/']);
  });

  it('says only that the address was handed over when no window is seen — and names no browser as open', async () => {
    const h = await harness({ goal: 'open youtube' });
    const result = await h.run('web.open', { url: 'https://youtube.com' });
    expect(output(result)?.verified).toMatchObject({ opened: false });
    expect(output(result)?.verified?.summary).toMatch(/handed it to your default browser/);
    expect(output(result)?.verified?.summary).toMatch(/not that the page is open/);
  });

  it('never claims a browser Windows did not name', async () => {
    const h = await harness({ goal: 'open youtube', browser: null });
    h.world.pages['https://youtube.com/'] = 'YouTube';
    const result = await h.run('web.open', { url: 'https://youtube.com' });
    expect(output(result)?.defaultBrowser).toBeNull();
    expect(output(result)?.verified?.summary).not.toMatch(/Chrome|Edge|Firefox|Dia/);
  });

  it('refuses every address the URL policy refuses — and opens none of them', async () => {
    const h = await harness({ goal: 'open it' });
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'http://localhost:3000',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://[::1]/',
      'ms-settings:privacy',
      'data:text/html,hi',
      'https://user:pass@example.com/',
      'not a url at all',
    ]) {
      const result = await h.run('web.open', { url });
      expect(failure(result)?.kind, url).toBe('FORBIDDEN');
    }
    expect(h.uris).toEqual([]);
  });

  it('asks before opening a site the user did not name', async () => {
    const h = await harness({ goal: 'find me a pasta recipe' });
    expect(h.requiresApproval('web.open', { url: 'https://www.allrecipes.com/' })).toBe(true);
    const denied = await h.approve('web.open', { url: 'https://www.allrecipes.com/' }, 'DENY');
    expect(denied.ok).toBe(false);
    expect(h.uris).toEqual([]);
  });

  it('keeps the consequential-page boundary: a sign-up page is escalated even on a named site', async () => {
    const h = await harness({ goal: 'open github' });
    expect(h.requiresApproval('web.open', { url: 'https://github.com/signup' })).toBe(true);
  });

  it('opens the default browser itself, found in the Start menu by its AppID', async () => {
    const h = await harness({ goal: 'open my browser' });
    h.world.opens['TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia'] = 'New Tab - Dia';
    const result = await h.run('web.open', {});
    expect(result.ok).toBe(true);
    expect(h.launched).toEqual(['TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia']);
    expect(output(result)?.verified).toMatchObject({ opened: true, evidence: 'title' });
  });

  it('is UNSUPPORTED — not a guess — when the default browser is unknown or not in the Start menu', async () => {
    const unknown = await harness({ browser: null });
    expect(failure(await unknown.run('web.open', {}))?.kind).toBe('UNSUPPORTED');

    const missing = await harness({ browser: { progId: 'X', name: 'Mystery Browser', appUserModelId: 'Nope.Nope_x!App' } });
    expect(failure(await missing.run('web.open', {}))?.kind).toBe('UNSUPPORTED');
    expect(missing.launched).toEqual([]);
  });
});

describe('the goal boundary for web.open', () => {
  it('names a site the way a person says it', () => {
    expect(siteName('https://www.youtube.com/watch?v=1')).toBe('youtube');
    expect(siteName('https://docs.google.com/')).toBe('google');
    expect(siteName('https://www.bbc.co.uk/news')).toBe('bbc');
    expect(siteName('github.com')).toBe('github');
    expect(siteName('http://1.2.3.4/')).toBeNull();
  });

  it('escalates only — a named site is left to the URL policy', () => {
    expect(checkGoalBoundary({ tool: 'web.open', input: { url: 'https://youtube.com' }, goal: 'open YouTube' })).toBeNull();
    expect(checkGoalBoundary({ tool: 'web.open', input: { url: 'https://you-tube.example' }, goal: 'open YouTube' })?.level).toBe(
      'REQUIRES_APPROVAL',
    );
    expect(checkGoalBoundary({ tool: 'web.open', input: { url: 'https://youtube.com' }, goal: null })?.level).toBe('REQUIRES_APPROVAL');
    // Axon's own browser is not changed by this rule.
    expect(checkGoalBoundary({ tool: 'browser.open', input: { url: 'https://youtube.com' }, goal: null })).toBeNull();
  });

  it('assumes https only for a bare hostname, never over another scheme', () => {
    expect(assumeHttps('youtube.com')).toBe('https://youtube.com');
    expect(assumeHttps('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(assumeHttps('file:///c:/x')).toBe('file:///c:/x');
    expect(assumeHttps('http://example.com')).toBe('http://example.com');
    expect(assumeHttps('localhost')).toBe('localhost');
  });
});

// ---------------------------------------------------------------------------
// Security regressions
// ---------------------------------------------------------------------------

describe('Phase 3 security regressions', () => {
  const SRC = path.resolve(__dirname, '../src/main');
  const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
  const code = (rel: string): string => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the new executors start nothing themselves: no shell, no PowerShell, no process API', () => {
    for (const rel of ['tools/executors/app-launch.ts', 'tools/executors/web-open.ts', 'tools/executors/app-launching.ts', 'apps/app-catalog.ts']) {
      const source = code(rel);
      expect(source, rel).not.toMatch(/child_process|\bspawn\s*\(|execFile|openExternal|cmd\.exe|\.ps1\b|\.bat\b/i);
      if (rel !== 'apps/app-catalog.ts') expect(source, rel).not.toMatch(/powershell/i);
    }
  });

  it('no tool takes an executable path, a command line or a launch target', () => {
    for (const rel of ['tools/executors/app-launch.ts', 'tools/executors/web-open.ts', 'tools/executors/windows.ts']) {
      const source = code(rel);
      expect(source, rel).not.toMatch(/\b(?:path|exe|executable|command|commandLine|args|argv|appId|launchTarget)\s*:\s*z\./);
    }
  });

  it('the model-facing schemas carry no AppID field', async () => {
    const fake = fakeWorld();
    const apps = fakeApps(DIA);
    const catalog = new AppCatalog(() => apps.listStartMenuApps());
    const registry = createDefaultRegistry({
      launcher: fake.launcher,
      capturer: { capture: () => Promise.reject(new Error('unused')) } as never,
      screenshotDir: '.',
      pathPolicy: { workspaceRoot: '.', forbiddenRoots: [] },
      desktop: fake.desktop,
      apps,
      catalog,
    });
    expect(registry.has('app.launch')).toBe(true);
    expect(registry.has('web.open')).toBe(true);
    for (const name of ['app.launch', 'web.open', 'app.focus']) {
      const tool = registry.get(name)!;
      const shape = Object.keys((tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
      expect(shape, name).not.toContain('appId');
      expect(shape.every((key) => key === 'app' || key === 'url'), name).toBe(true);
    }
  });

  it('adds no input synthesis anywhere', () => {
    for (const rel of ['tools/executors/app-launch.ts', 'tools/executors/web-open.ts', 'tools/executors/app-launching.ts', 'platform/electron-platform.ts']) {
      expect(code(rel), rel).not.toMatch(/SendInput|SendKeys|SetCursorPos|mouse_event|keybd_event/);
    }
  });

  it('the renderer cannot reach any of it', () => {
    const preload = read('../preload/index.ts');
    expect(preload).not.toMatch(/app\.launch|web\.open|launchStartMenuApp|listStartMenuApps|AppCatalog/);
  });

  it('the discovery program is chosen by a constant mode and runs nothing it is given', () => {
    const source = read('platform/windows-desktop.ts');
    const program = source.slice(source.indexOf('const APPS_SCRIPT'), source.indexOf('`;', source.indexOf('const APPS_SCRIPT')));
    expect(program).toMatch(/\$env:AXON_APPS_MODE/);
    expect(program).not.toMatch(/Invoke-Expression|\biex\b|Start-Process|Invoke-Item|\.InvokeVerb|ShellExecute/i);
  });
});
