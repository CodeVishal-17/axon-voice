/**
 * What a persisted setting is allowed to mean.
 *
 * The database stores rows of text. This file decides which of those rows are
 * a hotkey, a path or a flag, and what happens when one is not — which matters
 * more than it sounds, because a persisted value is an input that arrives
 * BEFORE the user can intervene. A malformed row is read during startup, and
 * anything that crashes there makes the application unopenable by the person
 * whose data it is.
 *
 * So every field here has three things: a validator, a normalizer, and a safe
 * default. A row that fails validation is discarded and the default is used,
 * loudly enough to be visible in the timeline and quietly enough not to
 * prevent the app from starting.
 *
 * Nothing persisted is ever executed, interpolated, or used as a path without
 * being resolved and checked first.
 */

import path from 'node:path';
import { z } from 'zod';
import type { AxonSettings } from '@axon/core';

/**
 * The defaults.
 *
 * `null` means "Axon decides": the hotkey falls back to its built-in
 * candidates, the workspace to the one under the Axon home. Storing null
 * rather than a concrete value keeps a user who never touched the setting on
 * whatever the current build considers sensible.
 */
export const DEFAULT_SETTINGS: AxonSettings = {
  voiceHotkey: null,
  workspacePath: null,
  speechEnabled: true,
  restoreLastSession: true,
  memoryEnabled: true,
};

/**
 * Accelerators Axon refuses to register.
 *
 * A bare key, or a single modifier, would swallow that key for every
 * application on the machine — the user could no longer type a space, or use
 * Ctrl for anything. `Alt+Space` opens the window menu on Windows and taking
 * it hijacks a system affordance. F-keys alone are used by other software.
 *
 * This is a refusal list, not a preference: a setting that can make a computer
 * unusable is one the settings layer declines to accept.
 */
const FORBIDDEN_ACCELERATORS = new Set(['alt+space', 'ctrl+alt+delete', 'ctrl+esc', 'alt+tab', 'alt+f4', 'ctrl+shift+esc']);

const MODIFIERS = new Set(['ctrl', 'control', 'cmd', 'command', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'shift', 'super', 'meta', 'altgr']);

export interface HotkeyCheck {
  readonly ok: boolean;
  /** The normalized accelerator, when valid. */
  readonly value: string | null;
  readonly reason: string | null;
}

/**
 * Validate a push-to-talk accelerator.
 *
 * Structural only — whether the shortcut is already taken by another
 * application is not knowable here, and is discovered by trying to register
 * it. That attempt is what the settings service rolls back on.
 */
export function checkHotkey(raw: unknown): HotkeyCheck {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null, reason: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, value: null, reason: 'A shortcut must be text.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length > 64) {
    return { ok: false, value: null, reason: 'That shortcut is too long to be real.' };
  }
  if (!/^[A-Za-z0-9+ ]+$/.test(trimmed)) {
    return { ok: false, value: null, reason: 'A shortcut may only contain letters, digits and "+".' };
  }

  const parts = trimmed
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length < 2) {
    return {
      ok: false,
      value: null,
      reason: 'A shortcut needs at least one modifier and a key, for example Ctrl+Shift+Space.',
    };
  }

  const keys = parts.filter((part) => !MODIFIERS.has(part.toLowerCase()));
  const modifiers = parts.filter((part) => MODIFIERS.has(part.toLowerCase()));

  if (modifiers.length === 0) {
    return { ok: false, value: null, reason: 'A shortcut needs at least one modifier, such as Ctrl or Alt.' };
  }
  if (keys.length !== 1) {
    return { ok: false, value: null, reason: 'A shortcut needs exactly one key alongside its modifiers.' };
  }

  const normalized = [...modifiers, ...keys].join('+');
  if (FORBIDDEN_ACCELERATORS.has(normalized.toLowerCase())) {
    return {
      ok: false,
      value: null,
      reason: `${normalized} belongs to Windows. Choose a different shortcut so Axon does not take it over.`,
    };
  }

  return { ok: true, value: normalized, reason: null };
}

export interface PathCheck {
  readonly ok: boolean;
  /** Absolute, normalized. Null means "use the default". */
  readonly value: string | null;
  readonly reason: string | null;
}

/**
 * Validate a workspace directory.
 *
 * Normalized to an absolute path before anything else sees it, and refused if
 * it has a shape Axon declines to reason about — the same rules `paths.ts`
 * applies to a write destination, for the same reason: a UNC share is not on
 * this machine, and an alternate data stream is a way to write somewhere other
 * than the file that was named.
 *
 * Existence is checked by the caller, which has a filesystem; this stays pure
 * so it can be exercised exhaustively.
 */
export function checkWorkspacePath(raw: unknown): PathCheck {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null, reason: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, value: null, reason: 'A workspace must be a path.' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null, reason: null };
  if (trimmed.length > 400) return { ok: false, value: null, reason: 'That path is too long.' };
  if (trimmed.includes('\0')) return { ok: false, value: null, reason: 'That path contains a null byte.' };

  const separators = trimmed.replace(/\//g, '\\');
  if (separators.startsWith('\\\\')) {
    return { ok: false, value: null, reason: 'Network and device paths are not permitted as a workspace.' };
  }
  if (separators.slice(2).includes(':')) {
    return { ok: false, value: null, reason: 'That path is not a plain directory.' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, value: null, reason: 'A workspace must be an absolute path.' };
  }

  return { ok: true, value: path.resolve(trimmed), reason: null };
}

/**
 * The wire shape of a settings update.
 *
 * A partial: the renderer sends only what changed. `.strict()` rejects unknown
 * keys outright rather than ignoring them, so a typo is an error the user sees
 * instead of a setting that silently does nothing.
 */
export const settingsPatchSchema = z
  .object({
    voiceHotkey: z.string().max(64).nullable().optional(),
    workspacePath: z.string().max(400).nullable().optional(),
    speechEnabled: z.boolean().optional(),
    restoreLastSession: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export interface SettingsLoad {
  readonly settings: AxonSettings;
  /** Keys whose stored value was unusable and fell back to the default. */
  readonly repaired: readonly string[];
}

/**
 * Turn stored rows into settings.
 *
 * Every value is validated, and an unusable one falls back rather than
 * propagating. This is the function that decides a corrupted database cannot
 * stop Axon from starting.
 */
export function loadSettings(rows: Readonly<Record<string, string>>): SettingsLoad {
  const repaired: string[] = [];
  const settings: {
    -readonly [K in keyof AxonSettings]: AxonSettings[K];
  } = { ...DEFAULT_SETTINGS };

  const hotkey = checkHotkey(rows.voiceHotkey ?? null);
  if (hotkey.ok) settings.voiceHotkey = hotkey.value;
  else if (rows.voiceHotkey !== undefined) repaired.push('voiceHotkey');

  const workspace = checkWorkspacePath(rows.workspacePath ?? null);
  if (workspace.ok) settings.workspacePath = workspace.value;
  else if (rows.workspacePath !== undefined) repaired.push('workspacePath');

  for (const key of ['speechEnabled', 'restoreLastSession', 'memoryEnabled'] as const) {
    const stored = rows[key];
    if (stored === undefined) continue;
    if (stored === 'true') settings[key] = true;
    else if (stored === 'false') settings[key] = false;
    else repaired.push(key);
  }

  return { settings, repaired };
}

/** Settings as storable rows. The inverse of `loadSettings`. */
export function toRows(settings: AxonSettings): Record<string, string> {
  const rows: Record<string, string> = {
    speechEnabled: settings.speechEnabled ? 'true' : 'false',
    restoreLastSession: settings.restoreLastSession ? 'true' : 'false',
    memoryEnabled: settings.memoryEnabled ? 'true' : 'false',
  };
  if (settings.voiceHotkey !== null) rows.voiceHotkey = settings.voiceHotkey;
  if (settings.workspacePath !== null) rows.workspacePath = settings.workspacePath;
  return rows;
}
