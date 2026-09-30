/**
 * Where main may send to, and whom it may listen to — with windows that die.
 *
 * A REAL CRASH, AND WHY IT HAPPENED.
 *
 *     Uncaught Exception
 *     TypeError: Object has been destroyed
 *       at Object.voiceSurface
 *       at voiceSurface
 *       at fromVoice
 *       at ipcMain.emit
 *
 * The overlay is destroyed on quit, by a harness, or by a renderer that goes
 * away underneath it. Main kept its `BrowserWindow` reference, and a microphone
 * frame that was already in flight arrived afterwards. Checking whether that
 * frame came from the voice surface read `overlay.webContents` — and on a
 * destroyed `BrowserWindow` that property access itself throws. The throw
 * happened inside an `ipcMain.on` listener, which makes it an uncaught
 * exception in the main process.
 *
 * The fix is not a `try/catch` around the IPC handler. It is that nothing in
 * main reads a window's contents without first asking whether the window, and
 * then its contents, still exist — and that this question is asked in ONE
 * place, which is this file, which imports nothing from Electron and so can be
 * tested against a stand-in that throws exactly the way Electron does.
 *
 * Checks, not catches. Electron destroys objects on the main thread, between
 * tasks; nothing can be destroyed in the middle of a synchronous call here, so
 * an explicit check is complete and a catch would only hide the next bug.
 */

/** The part of `WebContents` routing needs. */
export interface ContentsLike {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/**
 * The part of `BrowserWindow` routing needs.
 *
 * `webContents` is a getter that THROWS once the window is destroyed. That is
 * the whole reason this type exists: it must never be read before
 * `isDestroyed()` has said no.
 */
export interface WindowLike<C extends ContentsLike = ContentsLike> {
  isDestroyed(): boolean;
  readonly webContents: C;
}

/**
 * A window's contents, if both the window and its contents are still alive.
 *
 * The only safe way to go from a window to something you can send to. Reading
 * `window.webContents` directly is the bug this file exists to prevent.
 */
export function liveContents<C extends ContentsLike>(window: WindowLike<C> | null | undefined): C | null {
  if (!window || window.isDestroyed()) return null;
  const contents = window.webContents;
  return contents.isDestroyed() ? null : contents;
}

export interface SurfaceRouterOptions<C extends ContentsLike> {
  /**
   * The voice surface — the overlay's contents — or null. Called fresh every
   * time, never cached: a reference kept across a destroy is exactly how a
   * dead window stays a valid target.
   */
  readonly voiceSurface?: (() => C | null) | undefined;
  /** Every window, for events that go to all of them. */
  readonly windows: () => readonly WindowLike<C>[];
}

/**
 * Routing for main -> renderer and the voice surface's inbound guard.
 *
 * Every late event — a frame after the overlay closed, speech after a session
 * ended, a bus event during quit — lands here and is either delivered to a
 * live surface or dropped. None of them can throw.
 */
export class SurfaceRouter<C extends ContentsLike> {
  private readonly options: SurfaceRouterOptions<C>;

  constructor(options: SurfaceRouterOptions<C>) {
    this.options = options;
  }

  /** Whether a voice surface is configured at all (as opposed to currently alive). */
  get hasVoiceSurface(): boolean {
    return this.options.voiceSurface !== undefined;
  }

  /** The live voice surface, or null if there is none or it has been destroyed. */
  voiceSurface(): C | null {
    const contents = this.options.voiceSurface?.() ?? null;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /** Send to every live window. A destroyed window or destroyed contents is skipped. */
  broadcast(channel: string, payload: unknown): void {
    for (const window of this.options.windows()) {
      liveContents(window)?.send(channel, payload);
    }
  }

  /**
   * Audio, speech and capture commands: to the voice surface.
   *
   * With a voice surface configured but dead, the message is DROPPED rather than
   * broadcast — sending a capture command to whatever other window happens to
   * be open would open a microphone in a window that is not the voice surface.
   * Returns whether it was delivered.
   */
  toVoice(channel: string, payload: unknown): boolean {
    const target = this.voiceSurface();
    if (target) {
      target.send(channel, payload);
      return true;
    }
    if (!this.hasVoiceSurface) {
      this.broadcast(channel, payload);
      return true;
    }
    return false;
  }

  /**
   * Whether an inbound message may speak for the microphone or the speaker.
   *
   * A dead voice surface authorises nobody. In particular a message whose
   * sender is the destroyed overlay — a frame that was in flight when it went
   * away — is refused here, quietly, instead of crashing main.
   */
  fromVoice(sender: C): boolean {
    if (!this.hasVoiceSurface) return true;
    const live = this.voiceSurface();
    return live !== null && live === sender;
  }
}
