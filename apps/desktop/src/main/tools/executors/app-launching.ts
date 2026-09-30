/**
 * Launch, then look — shared by every tool that starts something.
 *
 * `app.open` (the five built-in applications), `app.launch` (applications
 * Axon discovered) and `web.open` (the default browser) all end the same way:
 * the operating system agreed to start something, and that is not the same as
 * something having started. So each of them then LOOKS at the desktop, and
 * this is the one place that looking is written.
 *
 * WHAT COUNTS AS EVIDENCE, and what each one lets Axon say:
 *
 *   identity    a window whose OWNING PROCESS is the application — its
 *               package identity or its program (Phase 4A). Exact, and true
 *               whatever the title says. Axon may say it is open.
 *   title       a window whose title names the application ("Spotify",
 *               "... - Visual Studio Code"). Axon may say it is open.
 *   new-window  a window that was not there before the launch, now in front.
 *               Very likely the application — some never put their name in
 *               a title (a browser shows the page; Spotify shows the song) —
 *               and said as "appears to be open", not as a certainty.
 *   activated   a window that was already there, now in front. The usual sign
 *               the application was already running and was brought forward.
 *
 * Nothing found by the deadline is not a failure of the launch: the result
 * says "started, but no window seen", and the model is told not to claim it
 * opened. A window is never invented, and never named as an application's
 * unless its title says so.
 */

import type { DesktopWindow, DesktopWindows } from '../../platform/windows-desktop.js';

export type WindowEvidence = 'identity' | 'title' | 'new-window' | 'activated';

export interface WindowSighting {
  /** The window's title. UNTRUSTED: written by whatever owns the window. */
  readonly title: string;
  readonly evidence: WindowEvidence;
  /** The window itself — only where the evidence says whose it is (identity or title). */
  readonly handle?: string;
}

export interface WatchOptions {
  readonly desktop: DesktopWindows | null;
  /**
   * Does this window's OWNER — its process or package, as the operating
   * system reports it — say it is what was launched? The strongest evidence
   * there is (Phase 4A). Absent where there is no identity to compare.
   */
  readonly owns?: (window: DesktopWindow) => boolean;
  /**
   * Does this title name what was launched? Given the window too, so a caller
   * can refuse a title on a window the OS attributes to something else.
   */
  readonly matches: (title: string, window: DesktopWindow) => boolean;
  /**
   * The desktop just before the launch, when it could be taken. Without it
   * only a title can be evidence — which is exactly how `app.open` has always
   * verified, and still does.
   */
  readonly before: readonly DesktopWindow[] | null;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** The desktop right now, or null if it could not be listed. Never throws. */
export async function snapshotWindows(desktop: DesktopWindows | null): Promise<readonly DesktopWindow[] | null> {
  if (!desktop?.available) return null;
  try {
    return await desktop.list();
  } catch {
    return null;
  }
}

/**
 * Wait for evidence that the launch produced a window.
 *
 * A title match is the strongest evidence and is preferred whenever one is
 * seen, even if a new window turned up first. A listing that fails has
 * established nothing, so it is retried until the deadline rather than read
 * as "no window".
 */
export async function watchForWindow(options: WatchOptions): Promise<WindowSighting | null> {
  const { desktop, owns, matches, before, timeoutMs, intervalMs } = options;
  if (!desktop?.available) return null;
  const known = new Set((before ?? []).map((window) => window.handle));
  const wasInFront = before?.find((window) => window.foreground)?.handle ?? null;
  const deadline = Date.now() + timeoutMs;
  let fallback: WindowSighting | null = null;

  for (;;) {
    let windows: readonly DesktopWindow[] = [];
    try {
      windows = await desktop.list();
    } catch {
      windows = [];
    }

    // Strongest first: the operating system's word on who owns the window,
    // then the window's own title, then where a window appeared.
    const owned = owns ? windows.find((window) => owns(window)) : undefined;
    if (owned) return { title: owned.title, evidence: 'identity', handle: owned.handle };
    const named = windows.find((window) => matches(window.title, window));
    if (named) return { title: named.title, evidence: 'title', handle: named.handle };

    if (before !== null) {
      const front = windows.find((window) => window.foreground) ?? null;
      if (front && !known.has(front.handle)) fallback = { title: front.title, evidence: 'new-window' };
      else if (front && front.handle !== wasInFront && fallback === null) fallback = { title: front.title, evidence: 'activated' };
    }

    if (Date.now() >= deadline) return fallback;
    // A new window in front is good evidence, but a title may follow a moment
    // later; keep looking for the title until half the deadline has gone.
    if (fallback?.evidence === 'new-window' && Date.now() >= deadline - timeoutMs / 2) return fallback;
    await delay(intervalMs);
  }
}

/** What the model is told it may say, for each outcome. */
export function describeSighting(
  label: string,
  sighting: WindowSighting | null,
  checked: boolean,
  timeoutMs: number,
): { opened: boolean; summary: string } {
  if (sighting?.evidence === 'identity') {
    return { opened: true, summary: `${label} is open — confirmed by the process that owns its window.` };
  }
  if (sighting?.evidence === 'title') return { opened: true, summary: `${label} is open.` };
  if (sighting?.evidence === 'new-window') {
    return {
      opened: true,
      summary: `${label} appears to be open: a new window came to the front right after Axon started it. Say it is open.`,
    };
  }
  if (sighting?.evidence === 'activated') {
    return {
      opened: true,
      summary: `${label} was probably already running: a window came to the front when Axon asked for it. Say it is in front.`,
    };
  }
  if (checked) {
    return {
      opened: false,
      summary:
        `Axon started ${label} but did not see its window within ${Math.round(timeoutMs / 1000)} seconds. ` +
        'Do not say it is open — say it did not appear.',
    };
  }
  return {
    opened: false,
    summary: `Axon started ${label} but cannot check the desktop on this platform. Do not claim it is open; say you started it.`,
  };
}

/** Moved to `apps/window-identity.ts` with the rest of window ownership; re-exported for callers here. */
export { titleNames } from '../../apps/window-identity.js';
