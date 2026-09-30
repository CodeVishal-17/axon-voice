/**
 * The browser control plane: the page in the user's own default browser, as
 * a semantic surface (`web.read`, `web.find`, `web.click`, `web.type`,
 * `web.scroll`).
 *
 * Through the REAL dispatcher, policy and approval broker. The operating
 * system is faked: the default browser is Dia, its window is a list entry, and
 * "the page" is a small in-memory site whose links navigate between pages —
 * exposed the way Chromium exposes a page to UI Automation (a Document with an
 * address and text, controls beneath it, all reached through the page's own
 * render surface rather than the browser window).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry, createDefaultRegistry } from '../src/main/tools/registry.js';
import { AppCatalog } from '../src/main/apps/app-catalog.js';
import { VisualObservationStore } from '../src/main/screen/visual-observation.js';
import {
  MAX_PAGE_TEXT,
  parsePage,
  type DesktopApps,
  type DesktopControl,
  type DesktopControlOutcome,
  type DesktopControlRequest,
  type DesktopUi,
  type DesktopWindow,
  type DesktopWindows,
  type ObserveOptions,
  type RawStartMenuApp,
  type WebPageReading,
} from '../src/main/platform/windows-desktop.js';
import type { AppLauncher, ScreenCapturer } from '../src/main/platform/ports.js';
import { TEXT_PART_CHARS, createWebPageTools } from '../src/main/tools/executors/web-page.js';
import { createUiReadTool } from '../src/main/tools/executors/ui-read.js';
import { toToolSchema } from '../src/main/tools/schema-view.js';

const DIA_ID = 'TheBrowserCompany.Dia_ttt1ap7aakyb4!Dia';
const RAW: readonly RawStartMenuApp[] = [
  { name: 'Dia', appId: DIA_ID },
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
];
const BROWSER_WINDOW = '100';
const SURFACE = '555';

/** A control on a fake page. `to` makes it a link to another page. */
interface FakeControl {
  role: DesktopControl['role'];
  name: string;
  to?: string;
  sensitive?: boolean;
  field?: boolean;
}
interface FakePage {
  title: string;
  text: string;
  controls: FakeControl[];
}

const SITE: Record<string, FakePage> = {
  'https://github.com/': {
    title: 'GitHub',
    text: 'Dashboard\nTop repositories\nCodeVishal-17/axon-voice\nRecent activity',
    controls: [
      { role: 'link', name: 'Pull requests', to: 'https://github.com/pulls' },
      { role: 'link', name: 'CodeVishal-17/axon-voice', to: 'https://github.com/CodeVishal-17/axon-voice' },
      { role: 'textbox', name: 'Search or jump to…', field: true },
      { role: 'button', name: 'New repository' },
      { role: 'link', name: 'Delete this repository', to: 'https://github.com/settings/delete' },
      { role: 'textbox', name: 'Password', field: true, sensitive: true },
    ],
  },
  'https://github.com/pulls': {
    title: 'Pull requests',
    text: 'Pull requests\nCreated\nAdd browser control plane #42 opened 2 hours ago\nFix wake word #41 merged',
    controls: [
      { role: 'link', name: 'Add browser control plane', to: 'https://github.com/CodeVishal-17/axon-voice/pull/42' },
      { role: 'link', name: 'Fix wake word', to: 'https://github.com/CodeVishal-17/axon-voice/pull/41' },
    ],
  },
  'https://github.com/CodeVishal-17/axon-voice/pull/42': {
    title: 'Add browser control plane by CodeVishal-17 · Pull Request #42',
    text: 'Add browser control plane #42\nOpen\nAll checks have passed\nFiles changed 6',
    controls: [{ role: 'button', name: 'Merge pull request' }],
  },
  'http://localhost:3000/': { title: 'Local dev', text: 'secret admin', controls: [] },
};

interface HarnessOptions {
  start?: string;
  /** No web page in the window (a new-tab page, a PDF…). */
  noPage?: boolean;
  /** The browser is not open. */
  closed?: boolean;
  /** Clicking does nothing. */
  inert?: boolean;
  longText?: boolean;
  /** The page's accessibility lives in the browser window itself (no separate render surface). */
  surfaceIsWindow?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  let url = options.start ?? 'https://github.com/';
  const surface = options.surfaceIsWindow ? BROWSER_WINDOW : SURFACE;
  let scroll = 0;
  let clock = 1_000_000;
  const observed: { handle: string | null; options?: ObserveOptions }[] = [];
  const acts: DesktopControlRequest[] = [];
  const scrolls: string[] = [];
  const typed = new Map<string, string>();

  const windows: DesktopWindow[] = options.closed
    ? []
    : [
        { handle: BROWSER_WINDOW, title: 'Work: GitHub', foreground: true, minimized: false, appUserModelId: DIA_ID },
        { handle: '200', title: 'Spotify', foreground: false, minimized: false, appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
      ];
  const desktop: DesktopWindows = { available: true, list: () => Promise.resolve(windows), act: () => Promise.resolve(true) };
  const apps: DesktopApps = {
    appsAvailable: true,
    listStartMenuApps: () => Promise.resolve(RAW),
    defaultBrowser: () => Promise.resolve({ progId: 'AppXdia', name: 'Dia', appUserModelId: DIA_ID }),
  };

  const page = (): FakePage => {
    const base = SITE[url]!;
    return options.longText ? { ...base, text: 'x'.repeat(TEXT_PART_CHARS * 2 + 10) } : base;
  };
  const toControl = (control: FakeControl): DesktopControl => ({
    nativeRole: control.role === 'link' ? 'ControlType.Hyperlink' : control.role === 'textbox' ? 'ControlType.Edit' : 'ControlType.Button',
    role: control.role,
    name: control.name,
    automationId: '',
    sensitive: control.sensitive === true,
    actions: control.field ? ['setText', 'focus'] : ['invoke', 'focus'],
    value: control.field && !control.sensitive ? (typed.get(control.name) ?? '') : null,
    runtimeId: `42.${control.name.length}.${control.role.length}`,
  });

  const ui: DesktopUi & Required<Pick<DesktopUi, 'readPage' | 'scrollPage'>> = {
    uiAvailable: true,
    readPage: (handle): Promise<WebPageReading> => {
      if (handle !== BROWSER_WINDOW) return Promise.resolve({ kind: 'none', reason: 'gone' });
      if (options.noPage) return Promise.resolve({ kind: 'none', reason: 'no-page' });
      const current = page();
      return Promise.resolve({
        kind: 'page',
        title: current.title,
        url,
        text: current.text,
        scroll,
        surface,
        identity: { title: current.title, automationId: '', runtimeId: '42.1.1' },
      });
    },
    observeControls: (handle, observeOptions) => {
      observed.push({ handle, options: observeOptions });
      const skip = observeOptions?.skip ?? 0;
      // The render surface holds only the page. The browser window holds the page
      // AND the sidebar — unless the read is scoped to the page's Document.
      const pageControls = page().controls.map(toControl);
      const sidebar = [toControl({ role: 'button', name: 'Sidebar tab: private' })];
      const controls =
        handle === SURFACE ? pageControls : observeOptions?.scope?.nativeRole === 'ControlType.Document' ? pageControls : [...sidebar, ...pageControls];
      return Promise.resolve({
        available: true,
        windowHandle: handle,
        windowTitle: 'Work: GitHub',
        controls: controls.slice(skip, skip + 60),
        truncated: false,
        hasMore: false,
        note: null,
      });
    },
    actOnControl: (request): Promise<DesktopControlOutcome> => {
      acts.push(request);
      if (request.windowHandle !== surface) return Promise.resolve({ kind: 'gone' });
      const control = page().controls.find((entry) => entry.name === request.name);
      if (!control) return Promise.resolve({ kind: 'gone' });
      if (control.sensitive) return Promise.resolve({ kind: 'sensitive' });
      if (request.action === 'setText') {
        typed.set(control.name, request.text ?? '');
        return Promise.resolve({ kind: 'ok', value: request.text ?? '' });
      }
      if (!options.inert && control.to) url = control.to;
      return Promise.resolve({ kind: 'ok', value: null });
    },
    scrollPage: (handle, _page, direction) => {
      scrolls.push(`${handle}:${direction}`);
      scroll = direction === 'down' ? Math.min(100, scroll + 40) : Math.max(0, scroll - 40);
      return Promise.resolve({ kind: 'ok', value: null });
    },
  };

  const catalog = new AppCatalog(() => apps.listStartMenuApps());
  await catalog.refresh();
  const store = new VisualObservationStore({ now: () => clock });
  const registry = new ToolRegistry();
  for (const tool of createWebPageTools({ apps, catalog, desktop, ui, store, wait: () => Promise.resolve(), settleMs: 30, settleIntervalMs: 1, now: () => clock }))
    registry.register(tool);
  registry.register(createUiReadTool({ ui, store, desktop, catalog }));

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus: new EventBus(),
    states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} },
    approvalTimeoutMs: 2_000,
  });
  dispatcher.beginTurn(new TurnBudget(), 'open github and check my latest pull request');
  const run = (tool: string, input: unknown): Promise<ToolResult> => dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });
  const decide = async (tool: string, input: unknown, decision: 'ALLOW' | 'DENY'): Promise<ToolResult> => {
    const pending = run(tool, input);
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    approvals.settle(approvals.list()[0]!.callId, decision, 'user');
    return pending;
  };
  return {
    run,
    decide,
    approvals,
    acts,
    observed,
    scrolls,
    url: () => url,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** The fields of a web tool's output these tests read; what the model sees. */
interface PageControl { readonly ref: string; readonly role: string; readonly name: string }
interface WebOutput {
  readonly title: string;
  readonly url: string;
  readonly found: boolean;
  readonly moreText: boolean;
  readonly untrustedPageText: string;
  readonly untrustedMatchingText: string;
  readonly controls: readonly PageControl[];
  readonly targets: readonly PageControl[];
  readonly verified: Readonly<Record<string, unknown>>;
}
const out = (result: ToolResult): WebOutput => (result.ok ? result.output : {}) as unknown as WebOutput;
const kind = (result: ToolResult): string | null => (result.ok ? null : result.failure.kind);
const refOf = (result: ToolResult, name: string): string => out(result).controls.find((control) => control.name === name)!.ref;

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

describe('web.read — the page in the user\'s own browser', () => {
  it('returns the title, address, fenced text and the page\'s controls as references', async () => {
    const h = await harness();
    const result = await h.run('web.read', {});
    expect(result.ok).toBe(true);
    const page = out(result);
    expect(page).toMatchObject({ browser: 'Dia', title: 'GitHub', url: 'https://github.com/' });
    expect(page.untrustedPageText).toMatch(/^<<<UNTRUSTED_WEB_CONTENT>>>\n[\s\S]*Top repositories[\s\S]*\n<<<UNTRUSTED_WEB_CONTENT>>>$/);
    expect(page.controls.map((control) => control.name)).toContain('Pull requests');
    for (const control of page.controls) expect(control.ref).toMatch(/^t\d+$/);
  });

  it('reads ONLY the page through the Chromium render surface — never the browser sidebar', async () => {
    const h = await harness();
    const result = await h.run('web.read', {});
    expect(h.observed.every((call) => call.handle === SURFACE)).toBe(true);
    expect(JSON.stringify(out(result))).not.toContain('Sidebar tab');
  });

  it('scopes the read to the page Document where the page lives in the browser window itself', async () => {
    const h = await harness({ surfaceIsWindow: true });
    const result = await h.run('web.read', {});
    expect(h.observed[0]).toMatchObject({ handle: BROWSER_WINDOW, options: { scope: { nativeRole: 'ControlType.Document', name: 'GitHub' } } });
    expect(JSON.stringify(out(result))).not.toContain('Sidebar tab');
  });

  it('gives the model no handle, runtime id, surface or automation id', async () => {
    const h = await harness();
    const text = JSON.stringify(out(await h.run('web.read', {})));
    expect(text).not.toContain(SURFACE);
    expect(text).not.toContain(BROWSER_WINDOW);
    expect(text).not.toMatch(/runtimeId|automationId|nativeRole|hwnd|"pid"|nodeId/i);
  });

  it('bounds the text and pages it', async () => {
    const h = await harness({ longText: true });
    const first = out(await h.run('web.read', {}));
    expect(first.untrustedPageText.length).toBeLessThanOrEqual(TEXT_PART_CHARS + 80);
    expect(first.moreText).toBe(true);
    const third = out(await h.run('web.read', { part: 3 }));
    expect(third.moreText).toBe(false);
    expect(kind(await h.run('web.read', { part: 99 }))).toBe('INVALID_INPUT');
  });

  it('does not read a page on a local or private address', async () => {
    const h = await harness({ start: 'http://localhost:3000/' });
    expect(kind(await h.run('web.read', {}))).toBe('FORBIDDEN');
  });

  it('says plainly when the browser is not open, or shows no page', async () => {
    expect(kind(await (await harness({ closed: true })).run('web.read', {}))).toBe('WINDOW_NOT_FOUND');
    expect(kind(await (await harness({ noPage: true })).run('web.read', {}))).toBe('UI_NOT_ACCESSIBLE');
  });
});

describe('web.find', () => {
  it('returns the matching lines and the controls whose names match, as references', async () => {
    const h = await harness();
    const found = out(await h.run('web.find', { text: 'pull requests' }));
    expect(found.found).toBe(true);
    expect(found.controls.map((control) => control.name)).toEqual(['Pull requests']);
    const lines = out(await h.run('web.find', { text: 'repositories' }));
    expect(lines.untrustedMatchingText).toContain('Top repositories');
  });
});

// ---------------------------------------------------------------------------
// Acting, verified
// ---------------------------------------------------------------------------

describe('web.click — acting by reference, verified by reading again', () => {
  it('returns the page a click led to, with fresh references that work for the next click', async () => {
    const h = await harness();
    const list = await h.run('web.click', { ref: refOf(await h.run('web.read', {}), 'Pull requests') });
    const landed = out(list) as WebOutput & { page: WebOutput };
    expect(landed.page.url).toBe('https://github.com/pulls');
    expect(landed.page.untrustedPageText).toContain('#42 opened 2 hours ago');
    expect(JSON.stringify(landed.page)).not.toMatch(/555|100|42\.1\.1|runtimeId|surface/);
    const pr = await h.run('web.click', { ref: landed.page.controls.find((control) => control.name === 'Add browser control plane')!.ref });
    expect((out(pr) as WebOutput & { page: WebOutput }).page.untrustedPageText).toContain('All checks have passed');
  });

  it('keeps references alive when the same page is read again, and only then', async () => {
    const h = await harness();
    const list = out(await h.run('web.click', { ref: refOf(await h.run('web.read', {}), 'Pull requests') })) as WebOutput & { page: WebOutput };
    const again = out(await h.run('web.read', {}));
    const prRef = list.page.controls.find((control) => control.name === 'Add browser control plane')!.ref;
    expect(again.controls.map((control) => control.ref)).toContain(prRef);
    expect((await h.run('web.click', { ref: prRef })).ok).toBe(true);
    // A different page mints new references; the old ones are refused.
    const pr = out(await h.run('web.read', {}));
    expect(pr.controls.map((control) => control.ref)).not.toContain(prRef);
    expect(kind(await h.run('web.click', { ref: prRef }))).toBe('STALE_REFERENCE');
  });

  it('takes page calls one at a time, even when the model sends them together', async () => {
    // Seen live: the model sent a read and a click in the same breath. On one
    // tab they would race; queued, the read sees the page the click led to.
    const h = await harness();
    const ref = refOf(await h.run('web.read', {}), 'Pull requests');
    const [click, read] = await Promise.all([h.run('web.click', { ref }), h.run('web.read', {})]);
    expect(click.ok).toBe(true);
    expect(out(read).url).toBe('https://github.com/pulls');
  });

  it('follows a link without asking, on the page surface, and reports where the browser went', async () => {
    const h = await harness();
    const ref = refOf(await h.run('web.read', {}), 'Pull requests');
    const result = await h.run('web.click', { ref });
    expect(result.ok).toBe(true);
    expect(h.approvals.list()).toEqual([]);
    expect(h.acts[0]).toMatchObject({ windowHandle: SURFACE, name: 'Pull requests', action: 'invoke' });
    expect(out(result).verified).toMatchObject({ changed: true, navigated: true, url: 'https://github.com/pulls' });
  });

  it('does the whole "latest pull request" walk generically: read, click, read, click, read', async () => {
    const h = await harness();
    await h.run('web.click', { ref: refOf(await h.run('web.read', {}), 'Pull requests') });
    const list = await h.run('web.read', {});
    expect(out(list).untrustedPageText).toContain('#42 opened 2 hours ago');
    await h.run('web.click', { ref: refOf(list, 'Add browser control plane') });
    const pr = out(await h.run('web.read', {}));
    expect(pr.title).toContain('Pull Request #42');
    expect(pr.untrustedPageText).toContain('All checks have passed');
  });

  it('asks before pressing a button — and a denial presses nothing', async () => {
    const h = await harness();
    const ref = refOf(await h.run('web.read', {}), 'New repository');
    const result = await h.decide('web.click', { ref }, 'DENY');
    expect(kind(result)).toBe('DENIED');
    expect(h.acts).toEqual([]);
  });

  it('asks before a link whose label is consequential', async () => {
    const h = await harness();
    const ref = refOf(await h.run('web.read', {}), 'Delete this repository');
    const pending = h.run('web.click', { ref });
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    expect(h.approvals.list()[0]!.title).toBe('Axon wants to click "Delete this repository" on github.com');
    h.approvals.settle(h.approvals.list()[0]!.callId, 'DENY', 'user');
    await pending;
    expect(h.acts).toEqual([]);
  });

  it('never claims a click worked when the page did not change', async () => {
    const h = await harness({ inert: true });
    const ref = refOf(await h.run('web.read', {}), 'Pull requests');
    const verified = out(await h.run('web.click', { ref })).verified;
    expect(verified).toMatchObject({ changed: false, navigated: false });
    expect(verified.summary).toMatch(/Do not say it worked/);
  });

  it('refuses a stale reference: expired, used after acting, or from a page the browser has left', async () => {
    const expired = await harness();
    const ref = refOf(await expired.run('web.read', {}), 'Pull requests');
    expired.advance(60_000);
    expect(kind(await expired.run('web.click', { ref }))).toBe('STALE_REFERENCE');

    const reused = await harness();
    const page = await reused.run('web.read', {});
    await reused.run('web.click', { ref: refOf(page, 'Pull requests') });
    expect(kind(await reused.run('web.click', { ref: refOf(page, 'CodeVishal-17/axon-voice') }))).toBe('STALE_REFERENCE');
    expect(reused.acts).toHaveLength(1);
  });

  it('refuses a reference that did not come from a web page', async () => {
    const h = await harness();
    const desktop = await h.run('ui.read', {});
    const ref = out(desktop).targets[0]!.ref;
    expect(kind(await h.run('web.click', { ref }))).toBe('STALE_REFERENCE');
    expect(h.acts).toEqual([]);
  });
});

describe('web.type — fields, never credentials', () => {
  it('fills an ordinary field and verifies what it holds', async () => {
    const h = await harness();
    const ref = refOf(await h.run('web.read', {}), 'Search or jump to…');
    const result = await h.run('web.type', { ref, text: 'axon-voice' });
    expect(out(result).verified).toMatchObject({ valueMatches: true });
    expect(h.acts[0]).toMatchObject({ action: 'setText', windowHandle: SURFACE });
  });

  it('refuses a password field and credential-shaped text before anything is typed', async () => {
    const h = await harness();
    const read = await h.run('web.read', {});
    expect(kind(await h.run('web.type', { ref: refOf(read, 'Password'), text: 'hunter2' }))).toBe('FORBIDDEN');
    expect(kind(await h.run('web.type', { ref: refOf(read, 'Search or jump to…'), text: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))).toBe('FORBIDDEN');
    expect(h.acts).toEqual([]);
  });
});

describe('web.scroll', () => {
  it('scrolls the page surface by a direction and reports the new position', async () => {
    const h = await harness();
    const result = await h.run('web.scroll', { direction: 'down' });
    expect(h.scrolls).toEqual([`${SURFACE}:down`]);
    expect(out(result).verified).toMatchObject({ moved: true, scrolledPercent: 40 });
  });
});

// ---------------------------------------------------------------------------
// What the model cannot say
// ---------------------------------------------------------------------------

describe('the model has no low-level vocabulary', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['web.click', { ref: 't1', x: 400, y: 200 }],
    ['web.click', { ref: 't1', selector: '#submit' }],
    ['web.click', { ref: 't1', nodeId: 42 }],
    ['web.click', { ref: 'e1' }],
    ['web.click', { ref: '12345' }],
    ['web.type', { ref: 't1', text: 'x', script: 'document.forms[0].submit()' }],
    ['web.read', { javascript: 'alert(1)' }],
    ['web.read', { cdp: 'Runtime.evaluate' }],
    ['web.read', { hwnd: '100' }],
    ['web.scroll', { direction: 'down', x: 900, y: 600 }],
    ['web.scroll', { direction: 'sideways' }],
    ['web.find', { text: 'x', surface: '555' }],
  ];

  it.each(invalid)('%s rejects %j as invalid input, before anything runs', async (tool, input) => {
    const h = await harness();
    expect(kind(await h.run(tool, input))).toBe('INVALID_INPUT');
    expect(h.acts).toEqual([]);
    expect(h.scrolls).toEqual([]);
  });

  it('offers only semantic fields in every schema', async () => {
    const h = await harness();
    void h;
    const tools = createWebPageTools({
      apps: { appsAvailable: true, listStartMenuApps: () => Promise.resolve(RAW), defaultBrowser: () => Promise.resolve(null) },
      catalog: new AppCatalog(() => Promise.resolve(RAW)),
      desktop: { available: true, list: () => Promise.resolve([]), act: () => Promise.resolve(true) },
      ui: { uiAvailable: true, observeControls: () => Promise.reject(new Error('x')), actOnControl: () => Promise.reject(new Error('x')), readPage: () => Promise.reject(new Error('x')), scrollPage: () => Promise.reject(new Error('x')) },
      store: new VisualObservationStore(),
    });
    const fields = Object.fromEntries(tools.map((tool) => [tool.name, Object.keys((toToolSchema(tool).inputSchema as { properties: object }).properties).sort()]));
    expect(fields).toEqual({
      'web.read': ['part'],
      'web.find': ['text'],
      'web.click': ['ref'],
      'web.type': ['ref', 'text'],
      'web.scroll': ['amount', 'direction'],
    });
  });
});

// ---------------------------------------------------------------------------
// The platform's page answer, and registration
// ---------------------------------------------------------------------------

describe('parsePage — the engine\'s page answer, validated', () => {
  it('accepts an http(s) page with a render surface, and bounds and cleans its text', () => {
    const page = parsePage(JSON.stringify({ title: 'T', url: 'https://example.com/', text: `a\u202Eb\uFFFC\r\n\n\n\nc${'x'.repeat(MAX_PAGE_TEXT)}`, scroll: 12.4, runtimeId: '42.1', automationId: '', surface: '555' }));
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.surface).toBe('555');
    expect(page.scroll).toBe(12);
    expect(page.text!.length).toBeLessThanOrEqual(MAX_PAGE_TEXT);
    expect(page.text).not.toContain('\u202E');
    // Chromium's object-replacement character, where an image or widget sits: noise to a reader.
    expect(page.text).not.toContain('\uFFFC');
    expect(page.text!.startsWith('a b\n\nc')).toBe(true);
  });

  it('refuses anything that is not a web page on a real surface', () => {
    for (const raw of [
      { title: 'T', url: 'file:///C:/secret.txt', surface: '555' },
      { title: 'T', url: 'javascript:alert(1)', surface: '555' },
      { title: 'T', url: 'https://example.com/', surface: '' },
      { title: 'T', url: 'https://example.com/', surface: '0' },
      { title: 'T', url: 'https://example.com/', surface: '5; rm' },
      { error: 'no-page' },
    ]) {
      expect(parsePage(JSON.stringify(raw)).kind, JSON.stringify(raw)).toBe('none');
    }
    expect(parsePage('not json').kind).toBe('none');
  });
});

describe('registration', () => {
  const base = () => ({
    launcher: { launchExecutable: () => Promise.resolve({ pid: 1 }), openUri: () => Promise.resolve(), launchStartMenuApp: () => Promise.resolve() } as AppLauncher,
    capturer: { capturePrimaryDisplay: () => Promise.reject(new Error('no')) } as ScreenCapturer,
    screenshotDir: 'C:\\x',
    pathPolicy: { workspaceRoot: 'C:\\w', forbiddenRoots: [] },
  });
  const apps: DesktopApps = { appsAvailable: true, listStartMenuApps: () => Promise.resolve(RAW), defaultBrowser: () => Promise.resolve(null) };
  const desktop: DesktopWindows = { available: true, list: () => Promise.resolve([]), act: () => Promise.resolve(true) };
  const plainUi: DesktopUi = { uiAvailable: true, observeControls: () => Promise.reject(new Error('x')), actOnControl: () => Promise.reject(new Error('x')) };
  const pageUi: DesktopUi = { ...plainUi, readPage: () => Promise.reject(new Error('x')), scrollPage: () => Promise.reject(new Error('x')) };
  const webTools = (registry: ToolRegistry) => registry.names().filter((name) => /^web\.(read|find|click|type|scroll)$/.test(name));

  it('registers the page tools only where Axon can find the browser and read a page', () => {
    const catalog = new AppCatalog(() => Promise.resolve(RAW));
    expect(webTools(createDefaultRegistry({ ...base(), apps, catalog, desktop, ui: pageUi }))).toEqual(['web.click', 'web.find', 'web.read', 'web.scroll', 'web.type']);
    expect(webTools(createDefaultRegistry({ ...base(), apps, catalog, desktop, ui: plainUi }))).toEqual([]);
    expect(webTools(createDefaultRegistry({ ...base(), apps, desktop, ui: pageUi }))).toEqual([]);
  });

  it('leaves Axon\'s own browser tools as they were', () => {
    const catalog = new AppCatalog(() => Promise.resolve(RAW));
    const registry = createDefaultRegistry({ ...base(), apps, catalog, desktop, ui: pageUi });
    expect(registry.names()).toContain('web.open');
  });
});
