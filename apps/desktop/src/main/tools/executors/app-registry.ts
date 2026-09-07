/**
 * The applications Axon is permitted to launch.
 *
 * THE SHAPE IS THE SECURITY, and it is worth being precise about why.
 *
 * The model never supplies a program. It supplies a KEY, and the key is an
 * enum member derived from this table. "powershell -Command ..." is not
 * rejected by a filter here — it is unrepresentable, because there is no field
 * in the schema that could carry it. A value outside the enum fails schema
 * validation in the dispatcher and never reaches an executor at all.
 *
 * That distinction matters more than it looks. A validator that rejects bad
 * program strings is only as good as the person who wrote its rules, and every
 * shell on earth has more quoting corners than that person had afternoons. A
 * table has no corners.
 *
 * WHY THIS IS A SEPARATE FILE FROM `app.open`.
 *
 * Adding an application should be one obvious edit in one obvious place, and
 * reviewing "what can Axon launch?" should mean reading one short list rather
 * than reading a tool. Separating them also lets `app.focus` and any future
 * capability resolve the SAME table, so two tools can never disagree about
 * what is permitted.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * No arbitrary path. No arguments. No working directory. No environment. An
 * entry names a well-known Windows executable or a registered URI scheme, and
 * a launcher that takes no arguments is a launcher that cannot be turned into
 * a shell by a cleverly chosen file name.
 */

import type { RiskLevel } from '@axon/core';

/** How a target is started. Adding a kind means adding a launcher method. */
export type LaunchTarget =
  | { readonly kind: 'exe'; readonly file: string }
  | { readonly kind: 'uri'; readonly uri: string };

export interface AppEntry {
  /** What a person calls it. Shown in the approval dialog and spoken aloud. */
  readonly label: string;
  readonly target: LaunchTarget;
  /**
   * How consequential launching it is.
   *
   * Not every application is a Notepad. `SAFE` means "visible, reversible, and
   * incapable of changing anything by merely being open" — which is true of a
   * text editor and a calculator, and NOT true of something that can alter
   * system configuration. Anything above SAFE reaches the existing approval
   * gate like any other risky act; there is no second mechanism here.
   */
  readonly risk: RiskLevel;
  /** Why it carries that level, in words the approval dialog can show. */
  readonly reason: string;
  /**
   * Window titles this application is recognised by, lowercased.
   *
   * Used to VERIFY that a launch actually produced a window, and by
   * `app.focus` to find one. Matching is a substring test against the title
   * the operating system reports, which is the only handle available without
   * asking for process-level privileges Axon does not want.
   */
  readonly windowHints: readonly string[];
}

/**
 * The table.
 *
 * Short on purpose. Every entry is a capability granted to a language model,
 * and the right instinct when adding one is reluctance.
 */
const APPS = {
  notepad: {
    label: 'Notepad',
    target: { kind: 'exe', file: 'notepad.exe' },
    risk: 'SAFE',
    reason: 'Notepad is a text editor. Opening it is visible and changes nothing.',
    windowHints: ['notepad'],
  },
  calculator: {
    label: 'Calculator',
    target: { kind: 'exe', file: 'calc.exe' },
    risk: 'SAFE',
    reason: 'Calculator is visible and changes nothing.',
    windowHints: ['calculator'],
  },
  'file-explorer': {
    label: 'File Explorer',
    target: { kind: 'exe', file: 'explorer.exe' },
    risk: 'SAFE',
    reason: 'File Explorer opens a window onto the user\'s own files and changes nothing by opening.',
    windowHints: ['file explorer', 'explorer', 'this pc'],
  },
  settings: {
    label: 'Windows Settings',
    target: { kind: 'uri', uri: 'ms-settings:' },
    // Opening Settings changes nothing by itself — but it is the front door to
    // everything that does, and the user should know Axon opened it. This is
    // the level where "visible and reversible" stops being obviously true.
    risk: 'REQUIRES_APPROVAL',
    reason: 'Windows Settings is where system configuration is changed, so Axon asks before opening it.',
    windowHints: ['settings'],
  },
  'task-manager': {
    label: 'Task Manager',
    target: { kind: 'exe', file: 'taskmgr.exe' },
    risk: 'REQUIRES_APPROVAL',
    reason: 'Task Manager can end running programs, so Axon asks before opening it.',
    windowHints: ['task manager'],
  },
} as const satisfies Record<string, AppEntry>;

export type AppKey = keyof typeof APPS;

/**
 * The permitted keys, as a tuple for `z.enum`.
 *
 * Derived from the table rather than written twice, so a key can never exist
 * in the schema without an entry behind it — which would be a name the model
 * could pass validation with and nothing could launch.
 */
export const APP_KEYS = Object.keys(APPS) as [AppKey, ...AppKey[]];

export function isAppKey(value: unknown): value is AppKey {
  return typeof value === 'string' && (APP_KEYS as readonly string[]).includes(value);
}

/**
 * Resolve a key to its entry.
 *
 * Returns null for anything unrecognised rather than throwing. Callers are
 * tools, and a tool that throws during risk resolution escalates to
 * REQUIRES_APPROVAL — which is safe, but "unknown application" deserves a
 * plain refusal and a clear message rather than a dialog.
 */
export function resolveApp(key: string): AppEntry | null {
  return isAppKey(key) ? APPS[key] : null;
}

/** Every entry, for the tool description and for tests that enumerate them. */
export function listApps(): readonly (AppEntry & { readonly key: AppKey })[] {
  return APP_KEYS.map((key) => ({ key, ...APPS[key] }));
}

/**
 * Which permitted application a window title belongs to, if any.
 *
 * Used to verify a launch and to resolve `app.focus`. Returns null when the
 * title matches nothing Axon knows — a window Axon cannot name is a window
 * Axon has no business focusing.
 */
export function appForWindowTitle(title: string): (AppEntry & { readonly key: AppKey }) | null {
  const haystack = title.toLowerCase();
  for (const entry of listApps()) {
    if (entry.windowHints.some((hint) => haystack.includes(hint))) return entry;
  }
  return null;
}
