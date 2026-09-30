/**
 * The background shell: how Axon starts, when its orb is on screen, and what
 * it registers with Windows.
 *
 * The Electron wiring itself runs in `scripts/verify-lifecycle.cjs`, against
 * the real app. These are the decisions underneath it, which are pure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_FLAG, parseLaunchMode } from '../src/main/shell/launch-mode.js';
import { LOGIN_ITEM_NAME, loginItemFor, StartupRegistration, type LoginItemSettings } from '../src/main/shell/login-item.js';
import {
  OverlayPresence,
  overlayBounds,
  overlayWanted,
  type OverlayCommand,
} from '../src/main/shell/overlay-presence.js';
import { orbIconBitmap } from '../src/main/shell/tray-icon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('launch mode', () => {
  it('starts in the background only when asked to', () => {
    expect(parseLaunchMode(['electron.exe', 'C:\\app', BACKGROUND_FLAG]).background).toBe(true);
    expect(parseLaunchMode(['electron.exe', 'C:\\app']).background).toBe(false);
    expect(parseLaunchMode(['axon.exe', '--backgroundish']).background).toBe(false);
  });
});

describe('starting with Windows', () => {
  const dev = { execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', appDir: 'C:\\repo\\apps\\desktop', isPackaged: false };
  const packaged = { execPath: 'C:\\Program Files\\Axon\\Axon.exe', appDir: 'C:\\ignored', isPackaged: true };

  it('registers the executable with the background flag, and nothing else', () => {
    expect(loginItemFor(packaged, true)).toEqual({
      openAtLogin: true,
      path: packaged.execPath,
      args: [BACKGROUND_FLAG],
      name: LOGIN_ITEM_NAME,
    });
    expect(loginItemFor(dev, true).args).toEqual([dev.appDir, BACKGROUND_FLAG]);
  });

  function fakeHost(platform: NodeJS.Platform = 'win32') {
    const registry = new Map<string, boolean>();
    const key = (p: string, args: string[]): string => [p, ...args].join('|');
    return {
      registry,
      host: {
        platform,
        getLoginItemSettings: (options: { path: string; args: string[] }) => ({
          openAtLogin: registry.get(key(options.path, options.args)) ?? false,
        }),
        setLoginItemSettings: (settings: LoginItemSettings) => {
          registry.set(key(settings.path, settings.args), settings.openAtLogin);
        },
      },
    };
  }

  it('reports what Windows reports, and turns it on and off', () => {
    const { host } = fakeHost();
    const registration = new StartupRegistration(host, dev);
    expect(registration.status()).toEqual({ available: true, enabled: false, reason: null });
    expect(registration.set(true).enabled).toBe(true);
    expect(registration.status().enabled).toBe(true);
    expect(registration.set(false).enabled).toBe(false);
  });

  it('reads the named per-user entry, which is what Windows actually starts', () => {
    // Measured on Windows: after registering under the name "Axon",
    // `openAtLogin` still reported false. The launch items are the truth.
    const settings = (launchItems: { name: string; args: string[]; scope: string; enabled: boolean }[]) => ({
      platform: 'win32' as const,
      getLoginItemSettings: () => ({ openAtLogin: false, launchItems }),
      setLoginItemSettings: () => {},
    });
    const axon = { name: LOGIN_ITEM_NAME, args: [dev.appDir, BACKGROUND_FLAG], scope: 'user', enabled: true };

    expect(new StartupRegistration(settings([axon]), dev).status()).toEqual({ available: true, enabled: true, reason: null });
    expect(new StartupRegistration(settings([]), dev).status().enabled).toBe(false);
    expect(new StartupRegistration(settings([{ ...axon, name: 'SomethingElse' }]), dev).status().enabled).toBe(false);
    expect(new StartupRegistration(settings([{ ...axon, scope: 'machine' }]), dev).status().enabled).toBe(false);

    const blocked = new StartupRegistration(settings([{ ...axon, enabled: false }]), dev).status();
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/Task Manager/);
  });

  it('is unavailable, not pretended, off Windows', () => {
    const { host } = fakeHost('linux');
    const registration = new StartupRegistration(host, dev);
    expect(registration.set(true)).toMatchObject({ available: false, enabled: false });
  });

  it('says so when Windows refuses', () => {
    const { host } = fakeHost();
    const registration = new StartupRegistration(
      {
        ...host,
        setLoginItemSettings: () => {
          throw new Error('access denied');
        },
      },
      dev,
    );
    const status = registration.set(true);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/refused/);
  });
});

describe('when the orb is on screen', () => {
  const idle = { state: 'IDLE' as const, voiceActive: false, listeningActive: false, approvalPending: false };

  it('is wanted while Axon is doing anything a person should see', () => {
    expect(overlayWanted(idle)).toBe(false);
    expect(overlayWanted({ ...idle, voiceActive: true })).toBe(true);
    expect(overlayWanted({ ...idle, listeningActive: true })).toBe(true);
    expect(overlayWanted({ ...idle, approvalPending: true })).toBe(true);
    for (const state of ['LISTENING', 'THINKING', 'EXECUTING', 'SPEAKING', 'WAITING_FOR_APPROVAL'] as const) {
      expect(overlayWanted({ ...idle, state }), state).toBe(true);
    }
  });

  it('does not hold the orb up on an error alone', () => {
    expect(overlayWanted({ ...idle, state: 'ERROR' })).toBe(false);
  });

  function presence() {
    const applied: OverlayCommand[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const subject = new OverlayPresence({
      lingerMs: 3_000,
      leaveMs: 300,
      schedule: (run, ms) => {
        const timer = { run, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      apply: (command) => applied.push(command),
    });
    const fire = (): void => {
      const next = timers.find((timer) => !timer.cancelled);
      if (!next) throw new Error('no timer pending');
      next.cancelled = true;
      next.run();
    };
    return { subject, applied, fire, timers };
  }

  it('shows and enters, lingers, leaves, then hides', () => {
    const { subject, applied, fire } = presence();
    subject.update(true);
    expect(applied).toEqual(['show', 'enter']);
    subject.update(true);
    expect(applied).toEqual(['show', 'enter']);

    subject.update(false);
    expect(applied).toEqual(['show', 'enter']);
    expect(subject.visible).toBe(true);
    fire();
    expect(applied).toEqual(['show', 'enter', 'leave']);
    fire();
    expect(applied).toEqual(['show', 'enter', 'leave', 'hide']);
    expect(subject.visible).toBe(false);
  });

  it('comes straight back if Axon is needed again while lingering', () => {
    const { subject, applied, timers } = presence();
    subject.update(true);
    subject.update(false);
    subject.update(true);
    expect(timers.every((timer) => timer.cancelled)).toBe(true);
    expect(applied).toEqual(['show', 'enter']);
  });

  it('re-enters, without re-showing, if needed again while leaving', () => {
    const { subject, applied, fire } = presence();
    subject.update(true);
    subject.update(false);
    fire();
    subject.update(true);
    expect(applied).toEqual(['show', 'enter', 'leave', 'enter']);
  });

  it('covers the work area, so the orb sits above the taskbar', () => {
    expect(overlayBounds({ x: 0, y: 0, width: 1920, height: 1032 })).toEqual({ x: 0, y: 0, width: 1920, height: 1032 });
    expect(overlayBounds({ x: -1280.4, y: 12.6, width: 1280.2, height: 984.9 })).toEqual({
      x: -1280,
      y: 13,
      width: 1280,
      height: 985,
    });
  });
});

describe('the tray icon', () => {
  it('is a round, opaque-centred orb on a transparent square', () => {
    const size = 32;
    const pixels = orbIconBitmap(size);
    expect(pixels.length).toBe(size * size * 4);
    const alphaAt = (x: number, y: number): number => pixels[(y * size + x) * 4 + 3] ?? -1;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(size - 1, size - 1)).toBe(0);
    expect(alphaAt(16, 16)).toBe(255);
  });
});

describe('BOUNDARY: the background shell reaches nothing that acts', () => {
  const shellDir = path.join(HERE, '../src/main/shell');
  const files = fs.readdirSync(shellDir).filter((name) => name.endsWith('.ts'));

  it('exists, so this rule is not vacuous', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('imports only core types and its own siblings', () => {
    const allowed = new Set(['@axon/core', './launch-mode.js']);
    for (const file of files) {
      const source = fs.readFileSync(path.join(shellDir, file), 'utf8');
      const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(imports.filter((specifier) => !allowed.has(specifier ?? '')), file).toEqual([]);
    }
  });
});
