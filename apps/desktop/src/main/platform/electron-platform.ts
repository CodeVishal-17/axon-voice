/**
 * The real platform adapters — the only modules in Axon that touch the OS
 * directly.
 *
 * Security note, and the reason `app.open` looks the way it does:
 *
 * There is no shell here. No `exec`, no `-Command "..."`, no string built from
 * caller-supplied text. `spawn` takes an executable and an (empty) argument
 * vector, so nothing a caller provides can ever be parsed as shell syntax.
 * Combined with the enum in `app-open.ts` — which restricts callers to picking
 * one of four constants rather than naming a program — model output never
 * reaches an interpreter at all.
 */

import { spawn } from 'node:child_process';
import { desktopCapturer, screen, shell } from 'electron';
import type { AppLauncher, CapturedScreen, LaunchedApp, ScreenCapturer } from './ports.js';
// The one definition of what may reach explorer; see `app-catalog.ts`.
import { isLaunchableAppId } from '../apps/app-catalog.js';

export class ElectronAppLauncher implements AppLauncher {
  launchExecutable(file: string): Promise<LaunchedApp> {
    return new Promise<LaunchedApp>((resolve, reject) => {
      // `shell: false` is the default and is load-bearing — see the note above.
      const child = spawn(file, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });

      child.once('error', reject);
      child.once('spawn', () => {
        // Detach so the launched app outlives Axon; the user asked for the app,
        // not for a child process tied to our lifetime.
        child.unref();
        resolve({ pid: child.pid ?? null });
      });
    });
  }

  async openUri(uri: string): Promise<void> {
    await shell.openExternal(uri);
  }

  /**
   * Start a Start-menu application by its AppID.
   *
   * MEASURED, NOT ASSUMED. `shell.openExternal('shell:AppsFolder\\<AppID>')`
   * was tried first and rejected by Windows ("The system cannot find the path
   * specified") — the URL is canonicalised on the way. `explorer.exe` given
   * that path as its ONE argument launches it, the same way the Start menu
   * does, for desktop programs and Store packages alike.
   *
   * THE SHAPE IS STILL THE SECURITY:
   *
   *   - `explorer.exe` is a constant. The AppID is never the program.
   *   - One argument, always prefixed `shell:AppsFolder\`, so it is a
   *     namespace path to explorer and never a switch (`/select,` and the like
   *     would need to BE the argument, and this one cannot start with `/`).
   *   - No shell, so nothing in it is ever parsed as syntax.
   *   - The AppID is re-validated here even though the catalog already did:
   *     this is the last line before a process starts.
   *
   * NOT DETACHED, deliberately, and also measured: explorer started detached
   * exits without launching anything. It does not need to be — it hands the
   * request to the running shell and exits at once, so the application is
   * the shell's child, never Axon's.
   *
   * Resolves once explorer has started. Explorer's exit code says nothing
   * about success (it is 1 either way), which is why the caller VERIFIES by
   * looking for the window.
   */
  launchStartMenuApp(appId: string): Promise<void> {
    if (!isLaunchableAppId(appId)) {
      return Promise.reject(new Error('That application identifier is not one Axon will launch.'));
    }
    return new Promise<void>((resolve, reject) => {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}


export class ElectronScreenCapturer implements ScreenCapturer {
  async capturePrimaryDisplay(): Promise<CapturedScreen> {
    const display = screen.getPrimaryDisplay();

    // Ask for the full physical resolution. `desktopCapturer` scales the
    // thumbnail to whatever size is requested, so requesting the display size
    // is what makes this a screenshot rather than a preview.
    const width = Math.round(display.size.width * display.scaleFactor);
    const height = Math.round(display.size.height * display.scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });

    const primary =
      sources.find((source) => source.display_id === String(display.id)) ?? sources[0];

    if (!primary) {
      throw new Error('No screen source was available to capture.');
    }
    if (primary.thumbnail.isEmpty()) {
      throw new Error('The captured screen image was empty.');
    }

    const size = primary.thumbnail.getSize();
    return {
      png: new Uint8Array(primary.thumbnail.toPNG()),
      width: size.width,
      height: size.height,
      displayLabel: primary.name,
    };
  }
}
