/**
 * The Axon window.
 *
 * The `webPreferences` block below is the security boundary in five lines.
 * Every flag is deliberate:
 *
 *   sandbox: true            the renderer runs in an OS-level sandbox
 *   contextIsolation: true   preload and page get separate JS contexts, so the
 *                            page cannot reach preload's scope by prototype
 *                            tampering
 *   nodeIntegration: false   no `require`, no `process`, no `fs` in the page
 *   webSecurity: true        same-origin policy stays on
 *   preload                  the single, audited bridge
 *
 * With `sandbox: true` the preload script itself is restricted to a small
 * subset of Electron's API — which is exactly what we want, since our preload
 * only needs `contextBridge` and `ipcRenderer`.
 */

import path from 'node:path';
import { BrowserWindow, shell } from 'electron';

export interface WindowOptions {
  readonly preloadPath: string;
  readonly rendererUrl: string | null;
  readonly rendererFile: string | null;
  readonly openDevTools: boolean;
}

/** Matches --axon-void in the renderer stylesheet, so there is no white flash. */
const BACKGROUND = '#07080A';

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: BACKGROUND,
    // Native controls painted over our own chrome — no custom close button to
    // get wrong, but the title bar belongs to the design.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: BACKGROUND,
      symbolColor: '#8A94A6',
      height: 40,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Nothing in Axon uses <webview>; leaving it enabled would leave an
      // embedding surface that `confineWebContents` then has to police.
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Belt and braces alongside confineWebContents: never let a link inside the
  // UI turn the app window itself into a browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (options.rendererUrl) {
    void window.loadURL(options.rendererUrl);
  } else if (options.rendererFile) {
    void window.loadFile(path.resolve(options.rendererFile));
  } else {
    throw new Error('No renderer URL or file was provided.');
  }

  if (options.openDevTools) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}
