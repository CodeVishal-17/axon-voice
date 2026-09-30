/**
 * The main window.
 *
 * A compact, floating companion window rather than a full-screen app: the orb
 * is the interface, and it does not need a desktop's worth of room. The window
 * is resizable within sensible bounds, keeps the native Windows controls
 * (minimise, maximise, close) painted over a custom title bar, and is dragged
 * by that title bar.
 *
 * SECURITY POSTURE — unchanged, and asserted by `architecture.test.ts`. The
 * renderer is sandboxed, context-isolated, has no Node integration anywhere,
 * keeps web security on and has no <webview>. The redesign changed the size and
 * the colours of this window, and nothing about what runs inside it.
 */

import path from 'node:path';
import { BrowserWindow, shell } from 'electron';

export interface WindowOptions {
  readonly preloadPath: string;
  readonly rendererUrl: string | null;
  readonly rendererFile: string | null;
  readonly openDevTools: boolean;
}

/** Which of the renderer's two faces a window shows. */
export type RendererSurface = 'panel' | 'overlay';

/** Load the renderer, telling it which surface it is. The query is a constant, never page input. */
function loadSurface(
  window: BrowserWindow,
  source: { readonly rendererUrl: string | null; readonly rendererFile: string | null },
  surface: RendererSurface,
): void {
  if (source.rendererUrl) {
    const url = new URL(source.rendererUrl);
    url.searchParams.set('surface', surface);
    void window.loadURL(url.toString());
  } else if (source.rendererFile) {
    void window.loadFile(path.resolve(source.rendererFile), { query: { surface } });
  } else {
    throw new Error('No renderer URL or file was provided.');
  }
}

/** The two looks the window can take. Chosen by the page; applied here. */
export type WindowAppearance = 'dark' | 'light';

/** Must match `--titlebar-height` in the renderer's stylesheet. */
const TITLEBAR_HEIGHT = 44;

/**
 * Fixed colours for the native parts of the window, per appearance.
 *
 * A closed table: the page names an appearance and main picks the colours, so
 * nothing the page sends becomes a colour string handed to the OS.
 */
const APPEARANCE: Readonly<Record<WindowAppearance, { readonly background: string; readonly symbol: string }>> = {
  dark: { background: '#0B0C10', symbol: '#9AA3B2' },
  light: { background: '#F4F1EC', symbol: '#5E6572' },
};

export function isWindowAppearance(value: unknown): value is WindowAppearance {
  return value === 'dark' || value === 'light';
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 380,
    minHeight: 600,
    show: false,
    backgroundColor: APPEARANCE.dark.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: APPEARANCE.dark.background,
      symbolColor: APPEARANCE.dark.symbol,
      height: TITLEBAR_HEIGHT,
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
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Links open in the user's browser, never in Axon's own window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  loadSurface(window, options, 'panel');

  if (options.openDevTools) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
}

export interface OverlayWindowOptions {
  readonly preloadPath: string;
  readonly rendererUrl: string | null;
  readonly rendererFile: string | null;
}

/**
 * The overlay: Axon's voice surface, and the bottom-centre orb.
 *
 * A frameless, transparent, always-on-top window the size of the display's
 * work area, created hidden when Axon starts and shown only while Axon is
 * active. While hidden it is still the page that holds the microphone for the
 * local wake phrase and plays Axon's voice — which is what lets the wake word
 * work with no Axon window open. It is click-through except over its own
 * controls (see `setOverlayInteractive`), so it never takes a click meant for
 * the application underneath.
 *
 * SECURITY POSTURE — identical to the panel, and asserted by
 * `architecture.test.ts` against this file: sandboxed, context-isolated, no
 * Node anywhere, web security on, no <webview>. The one difference is
 * `backgroundThrottling: false`, because a hidden window's timers are
 * otherwise slowed and the wake word must keep hearing while nothing is shown.
 */
export function createOverlayWindow(options: OverlayWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: 'Axon',
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
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  window.setIgnoreMouseEvents(true, { forward: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadSurface(window, options, 'overlay');
  return window;
}

/**
 * Let the overlay's window take clicks (over one of its controls) or pass them
 * through to whatever is underneath. `forward` keeps pointer movement arriving
 * while clicks pass through, which is how the page knows when to ask again.
 */
export function setOverlayInteractive(window: BrowserWindow, interactive: boolean): void {
  if (window.isDestroyed()) return;
  window.setIgnoreMouseEvents(!interactive, { forward: true });
}

/** Recolour the native parts of a window to match the page's appearance. */
export function applyAppearance(window: BrowserWindow, appearance: WindowAppearance): void {
  if (window.isDestroyed()) return;
  const colors = APPEARANCE[appearance];
  window.setBackgroundColor(colors.background);
  try {
    window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT });
  } catch {
    /* no title bar overlay on this platform: the page's own colours still apply */
  }
}
