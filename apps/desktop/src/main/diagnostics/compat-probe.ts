/**
 * The application compatibility probe (Phase 4A) — MEASURE, do not assume.
 *
 * "Electron is inaccessible" and "WebView2 is inaccessible" are both claims
 * the Phase 3 measurements contradicted, so this records, per application,
 * what Axon can actually establish at each stage, separately:
 *
 *   discovered     is it in the Start-menu catalog, and resolvable by name?
 *   identity       do its windows carry an owner Axon can match — package
 *                  identity, owning program — or only a title?
 *   windows        how many windows it owns right now, and on what basis
 *   launch         (only if the caller passes a launcher) did a window appear,
 *                  and by what evidence
 *   accessibility  pages of controls: counts by role, buttons, text fields,
 *                  invokable and settable controls, latency per page, whether
 *                  paging and scoped reading work
 *
 * READ-ONLY. It never types, never clicks, never invokes, never sets a value,
 * never closes anything. What it reports about controls is COUNTS: no control
 * name is copied into the report, because in a messaging app a control's name
 * is somebody's message.
 */

import type { DesktopApps, DesktopUi, DesktopWindow, DesktopWindows, DesktopScreenReading } from '../platform/windows-desktop.js';
import { OBSERVATION_LIMITS } from '@axon/core';
import { browserEntry, buildCatalog, resolveApp, type DiscoveredApp } from '../apps/app-catalog.js';
import { chooseWindow, windowsOf } from '../apps/window-identity.js';

export interface ProbeDesktop extends DesktopWindows, DesktopUi, DesktopApps {}

export interface ProbeOptions {
  /** Pages to read per application, at most. Reading stops earlier when there is no more. */
  readonly maxPages?: number;
  /** Start an application that has no window, and wait this long for one. Absent: never launch. */
  readonly launch?: (appId: string) => Promise<void>;
  readonly launchWaitMs?: number;
  /** Restore a window the probe launched if it started minimized. Never touches one it did not launch. */
  readonly restoreLaunched?: boolean;
  /** Read page 1 this many more times, for latency percentiles. */
  readonly repeat?: number;
  /** After a launch, wait this long before reading, as a person would before asking. */
  readonly settleMs?: number;
  readonly now?: () => number;
}

export interface PageMeasurement {
  readonly page: number;
  readonly controls: number;
  readonly hasMore: boolean;
  readonly ms: number;
  readonly problem: string | null;
}

export interface ControlCounts {
  readonly roles: Readonly<Record<string, number>>;
  /** Named lists, groups, documents and panes: scope targets, never acted on. */
  readonly containers: number;
  /** Fields whose current text the application exposes. A COUNT — the text itself is never reported. */
  readonly withValue: number;
  /** Controls whose name is long enough to be content (a message preview, a title) rather than a label. A count. */
  readonly longNames: number;
  /**
   * Generic interface furniture, recognised by GENERIC label words — not by
   * any application's own wording — and reported as counts only.
   */
  readonly searchFields: number;
  readonly composeFields: number;
  readonly buttons: number;
  readonly textFields: number;
  readonly invokable: number;
  readonly settable: number;
  readonly sensitive: number;
}

export interface ProbeRow {
  readonly request: string;
  readonly resolution: 'match' | 'ambiguous' | 'none' | 'blocked' | 'default-browser-unknown';
  readonly application: { readonly id: string; readonly name: string; readonly kind: string } | null;
  readonly candidates?: readonly { readonly id: string; readonly kind: string }[];
  /** The identity Axon matches on — package family or program FILE NAME, never a full path. */
  readonly identity: { readonly package: string | null; readonly program: string | null };
  readonly windows: { readonly owned: number; readonly basis: 'identity' | 'title' | 'none'; readonly minimized: number };
  readonly launch: { readonly attempted: boolean; readonly evidence: 'identity' | 'title' | null; readonly ms: number | null };
  readonly accessibility: {
    readonly read: boolean;
    readonly pages: readonly PageMeasurement[];
    readonly counts: ControlCounts | null;
    readonly scoped: { readonly tested: boolean; readonly controls: number; readonly ms: number | null; readonly problem: string | null };
    /** A scope that does not exist must come back STALE_REFERENCE, never a read of something else. */
    readonly staleScope: string | null;
    /** Page 1 read again `repeat` times: latency percentiles. */
    readonly repeat: { readonly count: number; readonly p50: number; readonly p95: number } | null;
  };
  readonly notes: readonly string[];
  /**
   * For a caller that cleans up after `launch`: the processes that owned this
   * application's windows when it was measured, and the program file it is
   * expected to run as. Diagnostic output only — never given to a model.
   */
  readonly processIds: readonly number[];
  readonly expectedProgram: string | null;
}

export interface ProbeReport {
  readonly catalog: { readonly entries: number; readonly blocked: number; readonly ms: number };
  readonly windowListing: { readonly windows: number; readonly withIdentity: number; readonly ms: number };
  readonly defaultBrowser: { readonly name: string | null; readonly ms: number };
  readonly rows: readonly ProbeRow[];
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function countControls(readings: readonly DesktopScreenReading[]): ControlCounts {
  const roles: Record<string, number> = {};
  let buttons = 0;
  let textFields = 0;
  let invokable = 0;
  let settable = 0;
  let sensitive = 0;
  let containers = 0;
  let withValue = 0;
  let longNames = 0;
  let searchFields = 0;
  let composeFields = 0;
  for (const control of readings.flatMap((reading) => reading.controls)) {
    roles[control.role] = (roles[control.role] ?? 0) + 1;
    if (control.role === 'container') containers += 1;
    if (control.value !== null && control.value !== '') withValue += 1;
    if (control.name.length >= 40) longNames += 1;
    if (control.role === 'textbox' && /\bsearch\b/i.test(control.name)) searchFields += 1;
    if (control.role === 'textbox' && /\b(?:type|write|compose|message|reply)\b/i.test(control.name)) composeFields += 1;
    if (control.role === 'button') buttons += 1;
    if (control.role === 'textbox') textFields += 1;
    if (control.actions.includes('invoke')) invokable += 1;
    if (control.actions.includes('setText') && !control.sensitive) settable += 1;
    if (control.sensitive) sensitive += 1;
  }
  return { roles, containers, withValue, longNames, searchFields, composeFields, buttons, textFields, invokable, settable, sensitive };
}

/** The part of an identity safe to print: the package family, or the program's file name. */
function identityOf(windows: readonly DesktopWindow[]): { package: string | null; program: string | null } {
  const first = windows.find((window) => window.appUserModelId || window.executable);
  return {
    package: first?.appUserModelId ? (first.appUserModelId.split('!')[0] ?? null) : null,
    program: first?.executable ? (first.executable.split('\\').pop() ?? null) : null,
  };
}

export async function runCompatibilityProbe(
  desktop: ProbeDesktop,
  requests: readonly string[],
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const now = options.now ?? ((): number => Date.now());
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 5, 20));

  let started = now();
  const apps = buildCatalog(await desktop.listStartMenuApps());
  const catalog = { entries: apps.length, blocked: apps.filter((app) => app.blocked).length, ms: now() - started };

  started = now();
  const browser = await desktop.defaultBrowser().catch(() => null);
  const defaultBrowser = { name: browser?.name || null, ms: now() - started };

  started = now();
  let windows = await desktop.list();
  const windowListing = {
    windows: windows.length,
    withIdentity: windows.filter((window) => window.appUserModelId || window.executable).length,
    ms: now() - started,
  };

  const rows: ProbeRow[] = [];
  for (const request of requests) {
    const notes: string[] = [];
    let app: DiscoveredApp | null = null;
    let resolution: ProbeRow['resolution'];
    let candidates: ProbeRow['candidates'];

    // "default browser" means whatever Windows says it is — never a name Axon picked.
    if (request === 'default browser') {
      app = browser ? browserEntry(browser, apps) : null;
      resolution = app ? 'match' : 'default-browser-unknown';
    } else {
      // "Name#N" picks the Nth of several same-named entries, for measuring each.
      const [name = '', pick] = request.split('#');
      const found = resolveApp(apps, name);
      if (found.kind === 'match') {
        app = found.app;
        resolution = app.blocked ? 'blocked' : 'match';
      } else if (found.kind === 'ambiguous') {
        candidates = found.candidates.map((entry) => ({ id: entry.id, kind: entry.kind }));
        const index = pick === undefined ? NaN : Number(pick);
        app = Number.isInteger(index) ? (found.candidates[index] ?? null) : null;
        resolution = 'ambiguous';
      } else {
        resolution = 'none';
      }
    }

    if (!app || app.blocked) {
      rows.push({
        request,
        resolution,
        application: app ? { id: app.id, name: app.name, kind: app.kind } : null,
        ...(candidates ? { candidates } : {}),
        identity: { package: null, program: null },
        windows: { owned: 0, basis: 'none', minimized: 0 },
        launch: { attempted: false, evidence: null, ms: null },
        accessibility: { read: false, pages: [], counts: null, scoped: { tested: false, controls: 0, ms: null, problem: null }, staleScope: null, repeat: null },
        notes: app?.blocked ? ['Blocked: never opened or read by Axon.'] : notes,
        processIds: [],
        expectedProgram: null,
      });
      continue;
    }

    let owned = windowsOf(app, windows, apps);
    const launch: { attempted: boolean; evidence: 'identity' | 'title' | null; ms: number | null } = {
      attempted: false,
      evidence: null,
      ms: null,
    };
    if (owned.windows.length === 0 && options.launch) {
      launch.attempted = true;
      const launchedAt = now();
      await options.launch(app.appId);
      const deadline = launchedAt + (options.launchWaitMs ?? 15_000);
      while (now() < deadline) {
        await delay(500);
        windows = await desktop.list().catch(() => windows);
        owned = windowsOf(app, windows, apps);
        if (owned.windows.length > 0) {
          launch.evidence = owned.basis;
          launch.ms = now() - launchedAt;
          break;
        }
      }
      if (!launch.evidence) notes.push('Launched, but no window was seen before the deadline.');
    }

    // A fresh look after the application has had time to settle: a window's
    // state at the moment it first appeared (often minimized, often a
    // loading shell) is not the state a person would be asking about.
    if (launch.attempted && launch.evidence && options.settleMs) {
      await delay(options.settleMs);
      windows = await desktop.list().catch(() => windows);
      owned = windowsOf(app, windows, apps);
    }
    const choice = chooseWindow(owned.windows);
    const target = choice.kind === 'one' ? choice.window : choice.kind === 'ambiguous' ? choice.windows[0] : undefined;
    if (choice.kind === 'ambiguous') notes.push(`${choice.windows.length} windows; measured the first listed.`);
    if (target?.minimized) {
      // Restoring is a WINDOW operation — the same as app.focus — not a click
      // or a keystroke, and only for a window this probe itself launched.
      if (options.restoreLaunched && launch.attempted && (await desktop.act(target.handle, 'focus'))) {
        notes.push('Its window started minimized; the probe restored it before reading.');
        await delay(options.settleMs ?? 1_500);
      } else {
        notes.push('Its window is minimized; some applications expose nothing while minimized.');
      }
    }

    const pages: PageMeasurement[] = [];
    const readings: DesktopScreenReading[] = [];
    let scoped: ProbeRow['accessibility']['scoped'] = { tested: false, controls: 0, ms: null, problem: null };
    let staleScope: string | null = null;
    let repeat: ProbeRow['accessibility']['repeat'] = null;
    if (target) {
      for (let page = 1; page <= maxPages; page += 1) {
        let at = now();
        let reading = await desktop.observeControls(target.handle, { skip: (page - 1) * OBSERVATION_LIMITS.maxTargets });
        // Chromium-based applications build their accessibility tree when
        // first asked, so a first read can run out of time. Recorded, and
        // retried once — the retry is what a second request would see.
        const coldEmpty = reading.problem === 'UI_NOT_ACCESSIBLE' && launch.attempted;
        if ((reading.problem === 'TIMEOUT' || coldEmpty) && page === 1) {
          notes.push(`First read ${coldEmpty ? 'found no controls' : 'timed out'} after ${now() - at} ms; retried once.`);
          await delay(options.settleMs ?? 1_500);
          at = now();
          reading = await desktop.observeControls(target.handle, { skip: 0 });
        }
        pages.push({ page, controls: reading.controls.length, hasMore: reading.hasMore === true, ms: now() - at, problem: reading.problem ?? null });
        readings.push(reading);
        if (reading.hasMore !== true) break;
      }
      // Scoped reads beneath up to five containers from page 1 (else controls
      // likely to hold others); the one that held the most is reported.
      const firstPage = readings[0]?.controls ?? [];
      const scopes = [
        ...firstPage.filter((control) => control.role === 'container'),
        ...firstPage.filter((control) => ['listitem', 'tab', 'textbox', 'combobox'].includes(control.role)),
      ].slice(0, 5);
      for (const container of scopes) {
        const at = now();
        const inside = await desktop.observeControls(target.handle, {
          scope: {
            nativeRole: container.nativeRole,
            name: container.name,
            automationId: container.automationId,
            ...(container.runtimeId ? { runtimeId: container.runtimeId } : {}),
          },
        });
        const tried = { tested: true, controls: inside.controls.length, ms: now() - at, problem: inside.problem ?? null };
        if (!scoped.tested || tried.controls > scoped.controls) scoped = tried;
      }
      const stale = await desktop.observeControls(target.handle, {
        scope: { nativeRole: 'ControlType.List', name: 'axon-probe: no such control', automationId: 'axon-probe-none' },
      });
      staleScope = stale.problem ?? 'read something';
      if (options.repeat && options.repeat > 0) {
        const times: number[] = [];
        for (let i = 0; i < options.repeat; i += 1) {
          const at = now();
          await desktop.observeControls(target.handle);
          times.push(now() - at);
        }
        const sorted = [...times].sort((a, b) => a - b);
        const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
        repeat = { count: times.length, p50: pick(0.5), p95: pick(0.95) };
      }
    }

    rows.push({
      request,
      resolution,
      application: { id: app.id, name: app.name, kind: app.kind },
      ...(candidates ? { candidates } : {}),
      identity: identityOf(owned.windows),
      windows: {
        owned: owned.windows.length,
        basis: owned.windows.length === 0 ? 'none' : owned.basis,
        minimized: owned.windows.filter((window) => window.minimized).length,
      },
      launch,
      accessibility: { read: readings.some((reading) => reading.available), pages, counts: readings.length ? countControls(readings) : null, scoped, staleScope, repeat },
      notes,
      processIds: [...new Set(owned.windows.flatMap((window) => (window.processId === undefined ? [] : [window.processId])))],
      expectedProgram: app.executable ? (app.executable.split('\\').pop() ?? null) : null,
    });
  }

  return { catalog, windowListing, defaultBrowser, rows };
}
