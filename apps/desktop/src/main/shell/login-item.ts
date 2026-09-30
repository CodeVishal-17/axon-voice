/**
 * Starting with Windows, per user.
 *
 * WHY THIS MECHANISM. Electron's login item writes one value under the user's
 * own `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key. It needs no
 * administrator rights, installs no service, and is visible and removable in
 * Task Manager's Startup tab like any other app. A Windows service would need
 * elevation and would run in session 0, which has no microphone access for
 * the signed-in user — the opposite of what a wake word needs.
 *
 * WHAT IS REGISTERED. The Electron executable with the `--background` flag,
 * and, in a development build, the app directory before it. Nothing else:
 * no environment, no script, no path the user supplied.
 *
 * WHAT IS TRUE. The operating system is the source of truth. Axon keeps no
 * copy of this setting, so if the user turns it off in Task Manager, Axon
 * reports it off.
 */

import type { StartupStatus } from '@axon/core';
import { BACKGROUND_FLAG } from './launch-mode.js';

export interface LoginItemTarget {
  /** The executable Windows should start. */
  readonly execPath: string;
  /** The app directory, passed first in a development build. */
  readonly appDir: string;
  readonly isPackaged: boolean;
}

export interface LoginItemSettings {
  readonly openAtLogin: boolean;
  readonly path: string;
  readonly args: string[];
  readonly name: string;
}

/** One sign-in entry Windows reports for this executable. */
export interface LaunchItem {
  readonly name: string;
  readonly args: readonly string[];
  readonly scope: string;
  /** False when the user turned it off in Task Manager's Startup tab. */
  readonly enabled: boolean;
}

/** The part of Electron's `app` this module uses. Injected, so it can be tested. */
export interface LoginItemHost {
  readonly platform: NodeJS.Platform;
  getLoginItemSettings(options: { path: string; args: string[] }): {
    openAtLogin: boolean;
    launchItems?: readonly LaunchItem[];
  };
  setLoginItemSettings(settings: LoginItemSettings): void;
}

/** The name shown in Task Manager's Startup tab. */
export const LOGIN_ITEM_NAME = 'Axon';

/** Exactly what gets registered. Pure. */
export function loginItemFor(target: LoginItemTarget, enabled: boolean): LoginItemSettings {
  return {
    openAtLogin: enabled,
    path: target.execPath,
    args: target.isPackaged ? [BACKGROUND_FLAG] : [target.appDir, BACKGROUND_FLAG],
    name: LOGIN_ITEM_NAME,
  };
}

export class StartupRegistration {
  private readonly host: LoginItemHost;
  private readonly target: LoginItemTarget;

  constructor(host: LoginItemHost, target: LoginItemTarget) {
    this.host = host;
    this.target = target;
  }

  status(): StartupStatus {
    if (this.host.platform !== 'win32') {
      return { available: false, enabled: false, reason: 'Starting with Windows is only available on Windows.' };
    }
    try {
      const item = loginItemFor(this.target, true);
      const current = this.host.getLoginItemSettings({ path: item.path, args: item.args });
      // On Windows `openAtLogin` matches the registry value by Electron's
      // default name, not the one Axon registers under — measured: the entry
      // was written and `openAtLogin` still said false. The named, per-user
      // launch item is the truth, including whether Task Manager allows it.
      const entry = current.launchItems?.find((launch) => launch.name === LOGIN_ITEM_NAME && launch.scope === 'user');
      if (entry) {
        return entry.enabled
          ? { available: true, enabled: true, reason: null }
          : { available: true, enabled: false, reason: 'Axon’s sign-in entry is turned off in Task Manager’s Startup tab.' };
      }
      if (current.launchItems) return { available: true, enabled: false, reason: null };
      return { available: true, enabled: current.openAtLogin === true, reason: null };
    } catch {
      return { available: false, enabled: false, reason: 'Windows did not report whether Axon starts at sign-in.' };
    }
  }

  set(enabled: boolean): StartupStatus {
    const before = this.status();
    if (!before.available) return before;
    try {
      this.host.setLoginItemSettings(loginItemFor(this.target, enabled));
    } catch {
      return { ...this.status(), reason: 'Windows refused to change whether Axon starts at sign-in.' };
    }
    return this.status();
  }
}
