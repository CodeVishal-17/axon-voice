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
