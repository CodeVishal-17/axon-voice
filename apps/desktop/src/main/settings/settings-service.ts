/**
 * Applying a settings change, and undoing it when it does not take.
 *
 * Validation is pure and lives in `settings-schema.ts`. This file owns the
 * part that has consequences: re-registering a global hotkey, checking that a
 * workspace directory exists, and putting everything back if either fails.
 *
 * WHY ROLLBACK MATTERS HERE SPECIFICALLY.
 *
 * A hotkey is not a value, it is a claim on a key combination the whole
 * operating system shares — and the claim can be refused, because another
 * application already holds it. The naive sequence (store the new value,
 * unregister the old, register the new) leaves a user with a setting that says
 * `Ctrl+Alt+K` and a push-to-talk key that does nothing at all, and no way to
 * tell which of those is the truth.
 *
 * So the order here is: validate, try to register, and only then store. If the
 * registration fails, the previous hotkey is restored and the change is
 * refused with a reason the user can act on. The setting and the behaviour
 * never disagree.
 */

import fs from 'node:fs';
import type { AxonSettings, SettingsUpdateResult } from '@axon/core';
import { checkHotkey, checkWorkspacePath, type SettingsPatch } from '../persistence/settings-schema.js';

/** What the service needs from the world. Injected so this is testable. */
export interface SettingsEffects {
  /**
   * Register `accelerator` as the push-to-talk key, releasing the previous
   * one. Returns the accelerator actually in force, or null if none took.
   *
   * Passing null asks for the built-in candidates.
   */
  applyHotkey(accelerator: string | null): string | null;
  /** True when the path exists and is a directory. */
  directoryExists(path: string): boolean;
}

export interface SettingsServiceOptions {
  readonly effects: SettingsEffects;
  /** Persists the accepted settings and emits SETTINGS_UPDATED. */
  commit(settings: AxonSettings, changedKeys: readonly string[]): void;
  /** Applied to speech and memory toggles, which take effect immediately. */
  onChanged?(settings: AxonSettings, changedKeys: readonly string[]): void;
}

export class SettingsService {
  private readonly options: SettingsServiceOptions;
  private settings: AxonSettings;

  constructor(initial: AxonSettings, options: SettingsServiceOptions) {
    this.settings = initial;
    this.options = options;
  }

  current(): AxonSettings {
    return this.settings;
  }

  /**
   * Apply a partial change.
   *
   * All-or-nothing: if any field in the patch is refused, none of it is
   * applied. A half-accepted settings update is a state the user cannot
   * reason about — they pressed Save once and would have to work out which
   * halves took.
   */
  update(patch: SettingsPatch): SettingsUpdateResult {
    const next: { -readonly [K in keyof AxonSettings]: AxonSettings[K] } = { ...this.settings };
    const changed: string[] = [];

    if ('voiceHotkey' in patch) {
      const check = checkHotkey(patch.voiceHotkey ?? null);
      if (!check.ok) return this.refuse(check.reason);
      if (check.value !== this.settings.voiceHotkey) {
        next.voiceHotkey = check.value;
        changed.push('voiceHotkey');
      }
    }

    if ('workspacePath' in patch) {
      const check = checkWorkspacePath(patch.workspacePath ?? null);
      if (!check.ok) return this.refuse(check.reason);

      if (check.value !== null && !this.options.effects.directoryExists(check.value)) {
        return this.refuse('That folder does not exist. Create it first, or choose another one.');
      }
      if (check.value !== this.settings.workspacePath) {
        next.workspacePath = check.value;
        changed.push('workspacePath');
      }
    }

    for (const key of ['speechEnabled', 'restoreLastSession', 'memoryEnabled'] as const) {
      const value = patch[key];
      if (value === undefined || value === this.settings[key]) continue;
      next[key] = value;
      changed.push(key);
    }

    if (changed.length === 0) {
      return { accepted: true, settings: this.settings, error: null };
    }

    // The one change with a side effect that can be refused by something
    // outside Axon. Attempted BEFORE anything is stored.
    if (changed.includes('voiceHotkey')) {
      const previous = this.settings.voiceHotkey;
      const inForce = this.options.effects.applyHotkey(next.voiceHotkey);

      if (inForce === null) {
        // Nothing took. Put the old one back so the user is not left without
        // push-to-talk because they tried a shortcut somebody else owns.
        this.options.effects.applyHotkey(previous);
        return this.refuse(
          'That shortcut could not be registered — another application is probably using it. ' +
            'Your previous shortcut is still active.',
        );
      }

      // What Windows actually gave us, which may be a fallback candidate
      // rather than the exact request. Storing the request instead would make
      // the settings screen lie about which key works.
      next.voiceHotkey = inForce;
    }

    this.settings = next;
    this.options.commit(next, changed);
    this.options.onChanged?.(next, changed);

    return { accepted: true, settings: next, error: null };
  }

  /** Put everything back to the defaults, through the same path as an update. */
  reset(): SettingsUpdateResult {
    return this.update({
      voiceHotkey: null,
      workspacePath: null,
      speechEnabled: true,
      restoreLastSession: true,
      memoryEnabled: true,
    });
  }

  private refuse(reason: string | null): SettingsUpdateResult {
    return { accepted: false, settings: this.settings, error: reason ?? 'That setting could not be applied.' };
  }
}

/** The real effects. Kept apart so the service can be tested without Electron. */
export function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
