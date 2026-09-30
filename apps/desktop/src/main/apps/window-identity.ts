/**
 * Which application owns a window — from the operating system, not the title.
 *
 * WHY. Until Phase 4A a window was matched to an application by its TITLE,
 * and titles are the application's to write. Measured on a real machine:
 * WhatsApp and WhatsApp Beta both title their window "WhatsApp", and Spotify
 * retitles its window to the song that is playing. A title cannot tell the
 * first pair apart and loses the second entirely.
 *
 * WHAT IS USED INSTEAD, strongest first:
 *
 *   package      the owning process's package identity (AppUserModelID) is
 *                exactly a catalog entry's AppID. Store apps — Spotify,
 *                WhatsApp, WhatsApp Beta, Claude — are recognised this way,
 *                and it is exact: two packages cannot share one.
 *   executable   the owning process's program is the program a Start-menu
 *                shortcut points at (VS Code's Code.exe). Exact when one entry
 *                points there; when two do, Axon says it cannot tell.
 *   title        ONLY when neither of the above identifies a window, and never
 *                for a window the operating system says belongs to a DIFFERENT
 *                application — so WhatsApp Beta's window called "WhatsApp" is
 *                never taken for WhatsApp's.
 *
 * All of it is internal. Package identities, program paths and process ids are
 * compared here and never leave the main process; what a model sees is Axon's
 * own application id and name.
 */

import type { DesktopWindow } from '../platform/windows-desktop.js';
import type { DiscoveredApp } from './app-catalog.js';

export type OwnershipEvidence = 'package' | 'executable';

export interface Ownership {
  readonly app: DiscoveredApp;
  readonly evidence: OwnershipEvidence;
}

/** Whole words of the title contain the whole name: "spotify premium" names Spotify. */
export function titleNames(title: string, name: string): boolean {
  const words = (text: string): string =>
    ` ${text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
  const wanted = words(name);
  return wanted.trim() !== '' && words(title).includes(wanted);
}

/** Did the listing say anything about who owns this window? */
export function hasIdentity(window: DesktopWindow): boolean {
  return window.processId !== undefined || window.executable !== undefined || window.appUserModelId !== undefined;
}

/**
 * The catalog entry that owns a window, by operating-system identity, or null.
 *
 * Null covers three different facts, all of which mean "do not claim it": the
 * listing had no identity for the window, the identity matches nothing in the
 * catalog, or it matches more than one entry.
 */
export function ownerOf(window: DesktopWindow, apps: readonly DiscoveredApp[]): Ownership | null {
  if (window.appUserModelId) {
    const wanted = window.appUserModelId.toLowerCase();
    const app = apps.find((entry) => entry.appId.toLowerCase() === wanted);
    // A packaged process is identified by its package or not at all: its
    // program lives in a versioned WindowsApps folder no shortcut points at.
    return app ? { app, evidence: 'package' } : null;
  }
  if (window.executable) {
    const matches = apps.filter((entry) => entry.executable !== null && entry.executable === window.executable);
    if (matches.length === 1 && matches[0]) return { app: matches[0], evidence: 'executable' };
  }
  return null;
}

export type CandidateBasis = 'identity' | 'title';

export interface WindowCandidates {
  readonly windows: readonly DesktopWindow[];
  /** How they were found. 'title' is the fallback and is reported as weaker. */
  readonly basis: CandidateBasis;
}

/**
 * Every listed window that belongs to one application.
 *
 * Identity first. Only if no window is identified as this application's does
 * the title decide — and then only among windows the operating system does not
 * attribute to some other application.
 */
export function windowsOf(app: DiscoveredApp, windows: readonly DesktopWindow[], apps: readonly DiscoveredApp[]): WindowCandidates {
  const owned = windows.filter((window) => ownerOf(window, apps)?.app.id === app.id);
  if (owned.length > 0) return { windows: owned, basis: 'identity' };
  const titled = windows.filter((window) => titleNames(window.title, app.name) && ownerOf(window, apps) === null);
  return { windows: titled, basis: 'title' };
}

export type WindowChoice =
  | { readonly kind: 'one'; readonly window: DesktopWindow }
  | { readonly kind: 'ambiguous'; readonly windows: readonly DesktopWindow[] }
  | { readonly kind: 'none' };

/**
 * One window out of an application's windows, by rules that never guess.
 *
 *   exactly one                       that one
 *   exactly one not minimized         that one — the one a person can see
 *   otherwise                         ambiguous: the caller ASKS
 *
 * Deliberately not "the most recent" or "the biggest": two VS Code windows are
 * two projects, and choosing between them is the user's decision.
 */
export function chooseWindow(candidates: readonly DesktopWindow[]): WindowChoice {
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1 && candidates[0]) return { kind: 'one', window: candidates[0] };
  const visible = candidates.filter((window) => !window.minimized);
  if (visible.length === 1 && visible[0]) return { kind: 'one', window: visible[0] };
  return { kind: 'ambiguous', windows: candidates };
}
