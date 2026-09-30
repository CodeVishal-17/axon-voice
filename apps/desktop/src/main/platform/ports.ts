/**
 * Platform ports.
 *
 * The executors depend on these interfaces, not on Electron or `child_process`
 * directly. Two reasons, both practical:
 *
 * - Tool logic (risk resolution, argument handling, error shaping) becomes
 *   testable without launching a browser process or opening Notepad.
 * - The one place that actually touches the operating system is small enough
 *   to read in a sitting, which is what makes "we never build a shell string
 *   from model output" a claim rather than a hope.
 */

export interface LaunchedApp {
  readonly pid: number | null;
}

export interface AppLauncher {
  /** Start an executable by name/path with no arguments. */
  launchExecutable(file: string): Promise<LaunchedApp>;
  /** Hand a URI to the OS handler (used for `ms-settings:`, and by `web.open`). */
  openUri(uri: string): Promise<void>;
  /**
   * Start an application Axon DISCOVERED, by its Start-menu AppID.
   *
   * The AppID is never model-supplied: it comes from Axon's own catalog
   * (`apps/app-catalog.ts`), which read it from the OS. Optional, so a
   * platform without a Start menu simply has no discovered applications.
   */
  launchStartMenuApp?(appId: string): Promise<void>;
}

/**
 * The clipboard, for one purpose: handing Paint a picture to paste (Drawing).
 *
 * `save` takes what the user had on the clipboard so `restore` can put it
 * back when the drawing is done. What is saved stays in memory, opaque to
 * every caller: it is never read, logged or sent anywhere.
 */
export interface ClipboardImages {
  save(): Promise<ClipboardSnapshot>;
  /**
   * Puts the saved content back. True when it is back; false when it could
   * not be, in which case the clipboard is left EMPTY — never holding Axon's
   * own content. Throws only if even clearing failed.
   */
  restore(snapshot: ClipboardSnapshot): Promise<boolean>;
  clear(): Promise<void>;
  writePng(png: Uint8Array): Promise<void>;
  /** The image on the clipboard, as RGBA pixels, or null when there is none. */
  readImage(): Promise<{ readonly width: number; readonly height: number; readonly rgba: Uint8Array } | null>;
}

/** Opaque: only `restore` knows what is inside. */
export interface ClipboardSnapshot {
  readonly __clipboardSnapshot: true;
}

export interface CapturedScreen {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly displayLabel: string;
}

export interface ScreenCapturer {
  capturePrimaryDisplay(): Promise<CapturedScreen>;
}

/**
 * The browser port.
 *
 * Re-exported from where the real implementation lives so the executors depend
 * on this module, like every other platform capability, while the interface
 * stays next to the class that has to satisfy it. The browser tools can then
 * be tested against a stand-in controller without opening a window.
 */
export type { BrowserController } from '../browser/axon-browser.js';
