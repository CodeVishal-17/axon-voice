/**
 * Axon's browser — a real, visible window on the real web.
 *
 * WHY AN ELECTRON WINDOW RATHER THAN PLAYWRIGHT OR THE USER'S CHROME.
 *
 * Playwright would add a second Chromium (a few hundred megabytes) and a
 * download step to a hackathon machine, and its profile starts logged out of
 * everything — so the GitHub demo would begin with "now sign in", in a browser
 * the user has no reason to trust with their password.
 *
 * Attaching to the user's own Chrome means starting it with
 * `--remote-debugging-port`, which is not a thing to do to somebody's daily
 * browser: that port is an unauthenticated, full-privilege control channel
 * that every other process on the machine can also reach, and it would remain
 * open long after Axon exited.
 *
 * Electron already ships a Chromium. Using it means no new dependency, a
 * window the user can watch and take over at any moment, and — through a
 * persistent session partition — a place where the user can sign in to GitHub
 * ONCE, themselves, on the real GitHub login page. Axon never sees the
 * password, never stores a cookie of its own, and never asks for a token. The
 * session lives in Chromium's own storage for the partition, exactly as it
 * would in any browser.
 *
 * WHAT THIS WINDOW IS NOT ALLOWED TO DO.
 *
 * It loads pages written by strangers, so it is the most hostile surface in
 * the application and is configured accordingly:
 *
 *   - no preload, no `window.axon`, no Node, sandboxed, context-isolated;
 *   - its own session partition, so page storage and cookies are nowhere near
 *     Axon's own renderer;
 *   - every permission denied — camera, microphone, geolocation, notifications,
 *     clipboard, MIDI, USB, the lot;
 *   - every download blocked outright;
 *   - `window.open` refused, `<webview>` refused;
 *   - every navigation and every redirect re-checked against the URL policy,
 *     so a page cannot redirect Axon to `file:///` or to a private address
 *     even though no tool call ever named one.
 *
 * The window has no route back into Axon. It cannot send IPC, cannot reach the
 * bridge, and cannot name a tool. Everything it produces arrives here as the
 * return value of one of the constant programs in `page-script.ts`.
 */

import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import {
  BROWSING_LIMITS,
  ELEMENT_ROLES,
  type BrowserStatus,
  type ElementRole,
  type JsonObject,
  type ObservedElement,
  type PageObservation,
} from '@axon/core';
import { BROWSER_PARTITION } from '../config.js';
import { isNavigable } from './url-policy.js';
import { buildProgram, CLICK, OBSERVE, SCROLL, TYPE } from './page-script.js';

/**
 * The session partition.
 *
 * `persist:` is what makes a login survive a restart. It is a separate
 * partition from Axon's own UI, so nothing a page stores can reach the
 * application's origin, and the user can clear it by deleting one folder.
 */
const PARTITION = BROWSER_PARTITION;

/** A blank page to sit on before anything is loaded. */
const BLANK = 'about:blank';

export type BrowserFailureKind =
  | 'NOT_OPEN'
  | 'REFUSED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_SENSITIVE'
  | 'ELEMENT_NOT_EDITABLE'
  | 'BUDGET_EXCEEDED'
  | 'CANCELLED'
  | 'CRASHED';

export class BrowserError extends Error {
  readonly kind: BrowserFailureKind;

  constructor(kind: BrowserFailureKind, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.kind = kind;
  }
}

export interface AxonBrowserOptions {
  /** Injected in tests. */
  readonly navigationTimeoutMs?: number;
  readonly scriptTimeoutMs?: number;
  readonly maxActionsPerTurn?: number;
  readonly maxNavigationsPerTurn?: number;
  /** Notified when the window opens, navigates or closes, for the timeline. */
  onNotice?(summary: string, detail: JsonObject | null): void;
}

/**
 * The port the tools depend on.
 *
 * Declared here alongside its only real implementation, and imported by
 * `platform/ports.ts` so executors depend on an interface rather than on
 * Electron — the same arrangement `AppLauncher` and `ScreenCapturer` use, and
 * what lets the browser tools be tested without opening a window.
 */
export interface BrowserController {
  status(): BrowserStatus;
  /** Open the window (if needed) and go to `url`. Returns what it landed on. */
  open(url: string): Promise<PageObservation>;
  navigate(url: string): Promise<PageObservation>;
  read(): Promise<PageObservation>;
  click(ref: string): Promise<PageObservation>;
  type(ref: string, text: string, submit: boolean): Promise<PageObservation>;
  scroll(pages: number): Promise<PageObservation>;
  history(direction: 'back' | 'forward'): Promise<PageObservation>;
  close(): void;
  /** Axon's own record of the last page it read. Never the model's account. */
  lastObservation(): PageObservation | null;
  /** Look up an element from that record, for the risk policy. */
  describeElement(ref: string): ObservedElement | null;
  /**
   * Whether the stored observation still describes the page.
   *
   * False once the page has navigated, reloaded or crashed since the last
   * read. An element reference from a superseded reading names a position in
   * a document that no longer exists, and acting on one is how an agent
   * clicks the wrong button with complete confidence.
   */
  observationFresh(): boolean;
  /** Reset the per-turn action budget. Called when an agent turn begins. */
  beginTurn(): void;
  /** Abandon anything in flight. Called on cancellation and shutdown. */
  cancel(): void;
}

export class AxonBrowser implements BrowserController {
  private readonly navigationTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly maxActionsPerTurn: number;
  private readonly maxNavigationsPerTurn: number;
  private readonly onNotice: (summary: string, detail: JsonObject | null) => void;

  private window: BrowserWindow | null = null;
  private observation: PageObservation | null = null;
  /**
   * Which reading the stored observation is.
   *
   * Bumped by every read, so an observation can be identified rather than
   * merely held. Monotonic for the life of the browser: reusing a number
   * would let a reference from an old page match a new one.
   */
  private observationEpoch = 0;
  /**
   * True when the page moved under us since that reading.
   *
   * Set by Chromium's own navigation events rather than inferred, so a
   * redirect, a meta refresh, a single-page transition and a crash all
   * invalidate the element list without Axon having to notice them itself.
   */
  private observationStale = true;

  private actionsThisTurn = 0;
  private navigationsThisTurn = 0;
  /** Bumped on cancel, so an operation in flight knows it was abandoned. */
  private generation = 0;

  constructor(options: AxonBrowserOptions = {}) {
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? BROWSING_LIMITS.navigationTimeoutMs;
    this.scriptTimeoutMs = options.scriptTimeoutMs ?? BROWSING_LIMITS.scriptTimeoutMs;
    this.maxActionsPerTurn = options.maxActionsPerTurn ?? BROWSING_LIMITS.maxActionsPerTurn;
    this.maxNavigationsPerTurn = options.maxNavigationsPerTurn ?? BROWSING_LIMITS.maxNavigationsPerTurn;
    this.onNotice = options.onNotice ?? ((): void => {});
  }

  /**
   * Whether a WebContents is this browser's page.
   *
   * Asked by the app-wide security hooks, which confine every WebContents to
   * Axon's own origin. That rule is right for the UI and catastrophic here —
   * the browser's whole job is to navigate elsewhere — so the hooks skip a
   * WebContents this owns, and it applies the stricter policy in
   * `ensureWindow` instead.
   */
  owns(contents: WebContents): boolean {
    const window = this.window;
    return window !== null && !window.isDestroyed() && window.webContents === contents;
  }

  status(): BrowserStatus {
    return {
      available: true,
      reason: null,
      open: this.isOpen(),
      url: this.observation?.url ?? null,
    };
  }

  lastObservation(): PageObservation | null {
    return this.observation;
  }

  describeElement(ref: string): ObservedElement | null {
    return this.observation?.elements.find((element) => element.ref === ref) ?? null;
  }

  observationFresh(): boolean {
    return this.observation !== null && !this.observationStale && this.isOpen();
  }

  beginTurn(): void {
    this.actionsThisTurn = 0;
    this.navigationsThisTurn = 0;
  }

  cancel(): void {
    // Bumping the generation is what makes an awaited navigation resolve as
    // cancelled rather than continuing to completion and then acting.
    this.generation += 1;
    const window = this.window;
    if (window && !window.isDestroyed()) {
      try {
        window.webContents.stop();
      } catch {
        /* nothing in flight */
      }
    }
  }

  close(): void {
    this.cancel();
    const window = this.window;
    this.window = null;
    this.observation = null;
    this.observationStale = true;
    if (window && !window.isDestroyed()) {
      window.destroy();
      this.onNotice('Closed the browser', null);
    }
  }

  async open(url: string): Promise<PageObservation> {
    this.ensureWindow();
    return this.navigate(url);
  }

  async navigate(url: string): Promise<PageObservation> {
    this.spendNavigation();
    const window = this.ensureWindow();
    const generation = this.generation;

    // Checked here as well as in the tool's risk resolution. The tool gate is
    // the policy; this is the mechanism refusing to do it anyway.
    if (!isNavigable(url)) {
      throw new BrowserError('REFUSED', 'That address is not one Axon will open.');
    }

    this.onNotice(`Opening ${hostOf(url)}`, { url });

    try {
      await this.withTimeout(
        window.loadURL(url),
        this.navigationTimeoutMs,
        `Loading ${hostOf(url)} took longer than ${Math.round(this.navigationTimeoutMs / 1000)} seconds.`,
      );
    } catch (error) {
      if (generation !== this.generation) throw new BrowserError('CANCELLED', 'Browsing was cancelled.');
      if (error instanceof BrowserError) throw error;
      // Electron rejects loadURL with codes like ERR_NAME_NOT_RESOLVED. The
      // code is useful; the stack and the internal detail are not.
      throw new BrowserError('NAVIGATION_FAILED', `Could not open ${hostOf(url)}: ${navigationReason(error)}`);
    }

    if (generation !== this.generation) throw new BrowserError('CANCELLED', 'Browsing was cancelled.');
    return this.read();
  }

  async history(direction: 'back' | 'forward'): Promise<PageObservation> {
    this.spendNavigation();
    const window = this.requireWindow();
    const history = window.webContents.navigationHistory;

    // Both the check and the move are done by INDEX rather than through
    // `canGoBack()`/`goBack()`.
    //
    // After a navigation the renderer started — which is what following a link
    // is, and therefore the overwhelmingly common case for an agent —
    // `canGoBack()` returns false and `goBack()` silently does nothing, even
    // with two entries and an active index of 1. `goToOffset` moves correctly
    // in exactly the same state. Verified against Electron 44 in
    // `verify-browser.cjs`, which is how this was found: the tool reported
    // success while the page had not moved.
    const index = history.getActiveIndex();
    const count = history.length();
    const canGo = direction === 'back' ? index > 0 : index < count - 1;

    if (!canGo) {
      throw new BrowserError('NAVIGATION_FAILED', `There is no page to go ${direction} to.`);
    }

    history.goToOffset(direction === 'back' ? -1 : 1);

    // The same settle a click uses. Waiting only for the navigation event is
    // not enough: `did-navigate` fires before the restored document is the one
    // a read would see, so the read comes back describing the page we just
    // left. The extra grace is the difference between "went back" and "went
    // back and noticed".
    await this.settleAfterAction();

    return this.read();
  }

  async read(): Promise<PageObservation> {
    this.spendAction();
    const raw = await this.runProgram(OBSERVE, {
      maxElements: BROWSING_LIMITS.maxElements,
      maxLabelCharacters: BROWSING_LIMITS.maxLabelCharacters,
      maxTextCharacters: BROWSING_LIMITS.maxTextCharacters,
      maxUrlCharacters: BROWSING_LIMITS.maxUrlCharacters,
    });

    // The page's return value is untrusted input like everything else it
    // produces: reshaped field by field, never spread into our own type.
    this.observationEpoch += 1;
    const observation = toObservation(raw, this.observationEpoch);
    this.observation = observation;
    // Cleared only here. A read is the one thing that can establish that
    // Axon's record and the page agree.
    this.observationStale = false;
    return observation;
  }

  async click(ref: string): Promise<PageObservation> {
    this.spendAction();
    // Checked here as well as in the tool's `precheck`. The tool gate is the
    // policy; this is the mechanism refusing to act on a page it has not
    // looked at, whatever route reached it.
    this.requireFreshObservation('click');
    const outcome = await this.runProgram(CLICK, { ref });
    assertActionOk(outcome, 'click');

    // A click frequently navigates. Waiting briefly for that, rather than
    // reading immediately, is the difference between observing the new page
    // and observing the old one mid-teardown.
    await this.settleAfterAction();
    return this.read();
  }

  async type(ref: string, text: string, submit: boolean): Promise<PageObservation> {
    this.spendAction();
    this.requireFreshObservation('type');
    const outcome = await this.runProgram(TYPE, { ref, text });
    assertActionOk(outcome, 'type');

    if (submit) {
      const window = this.requireWindow();
      // Synthesised at the input layer rather than dispatched as a fake DOM
      // event: a page that listens for a real Enter keypress should see one.
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await this.settleAfterAction();
    }

    return this.read();
  }

  async scroll(pages: number): Promise<PageObservation> {
    this.spendAction();
    await this.runProgram(SCROLL, { pages });
    return this.read();
  }

  // --- internals ----------------------------------------------------------

  private isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /**
   * Refuse to act on an element list the page has already invalidated.
   *
   * A structured `ELEMENT_NOT_FOUND` rather than a crash: it reaches the model
   * as a readable failure whose remedy — read the page again — is stated in
   * the message.
   */
  private requireFreshObservation(action: string): void {
    if (this.observationFresh()) return;
    throw new BrowserError(
      'ELEMENT_NOT_FOUND',
      `The page has changed since Axon last read it, so it will not ${action} an element from the old reading. ` +
        'Read the page again and use a current reference.',
    );
  }

  private requireWindow(): BrowserWindow {
    if (!this.isOpen()) {
      throw new BrowserError('NOT_OPEN', 'The browser is not open. Open a page first.');
    }
    return this.window as BrowserWindow;
  }

  /**
   * Create the window, or return the existing one.
   *
   * Everything security-relevant about the browser is in this method.
   */
  private ensureWindow(): BrowserWindow {
    if (this.isOpen()) return this.window as BrowserWindow;

    const partition = session.fromPartition(PARTITION);
    hardenSession(partition);

    const window = new BrowserWindow({
      width: 1180,
      height: 860,
      show: true,
      title: 'Axon Browser',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        // No preload. The page has no `window.axon`, no bridge, and no route
        // back into Axon of any kind.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
      },
    });

    const contents = window.webContents;

    // Every navigation re-checked, however it started — a tool call, a link
    // the page followed, a redirect, a meta refresh, a script.
    contents.on('will-navigate', (event, url) => {
      if (isNavigable(url)) return;
      event.preventDefault();
      this.onNotice(`Blocked a navigation to an address Axon does not open`, { url: hostOf(url) });
    });

    contents.on('will-redirect', (event, url) => {
      if (isNavigable(url)) return;
      event.preventDefault();
      this.onNotice(`Blocked a redirect to an address Axon does not open`, { url: hostOf(url) });
    });

    // Popups are refused, and NOT handed to the user's own browser.
    //
    // Axon's UI does forward external links to the OS browser, because those
    // come from Axon. These come from a web page, and turning a page's
    // `window.open` into "a new tab in the user's real, logged-in browser"
    // would make Axon a launcher that any site it visits can aim. A page that
    // wants a new tab simply does not get one.
    contents.setWindowOpenHandler(({ url }) => {
      this.onNotice('Blocked a page from opening a new window', { url: hostOf(url) });
      return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    // Anything that moves the document invalidates the element list. These
    // are Chromium's own events, so a redirect, a meta refresh, a script
    // navigation and a single-page transition all land here — including the
    // ones no tool call caused, which are exactly the ones Axon could not
    // otherwise know about.
    const invalidate = (): void => {
      this.observationStale = true;
    };
    contents.on('did-start-navigation', invalidate);
    contents.on('did-navigate', invalidate);
    contents.on('did-navigate-in-page', invalidate);
    contents.on('did-finish-load', invalidate);

    // A crashed renderer must not leave a window Axon believes in.
    contents.on('render-process-gone', () => {
      this.onNotice('The browser page stopped responding', null);
      this.observation = null;
      this.observationStale = true;
    });

    window.on('closed', () => {
      // The user closed it. That is an instruction, not an error: forget the
      // window and let the next tool call say the browser is not open.
      if (this.window === window) {
        this.window = null;
        this.observation = null;
        this.observationStale = true;
      }
    });

    void window.loadURL(BLANK);
    this.window = window;
    this.onNotice('Opened the browser', null);
    return window;
  }

  /** Run one of the constant page programs and return its value. */
  private async runProgram(body: string, args: JsonObject): Promise<unknown> {
    const window = this.requireWindow();
    const generation = this.generation;

    const program = buildProgram(body, args);

    let value: unknown;
    try {
      value = await this.withTimeout(
        // `false` for userGesture: nothing here should be able to trigger the
        // browser behaviours that are gated on a real user interaction.
        window.webContents.executeJavaScript(program, false),
        this.scriptTimeoutMs,
        'The page did not respond in time.',
      );
    } catch (error) {
      if (generation !== this.generation) throw new BrowserError('CANCELLED', 'Browsing was cancelled.');
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('CRASHED', 'The page could not be read.');
    }

    if (generation !== this.generation) throw new BrowserError('CANCELLED', 'Browsing was cancelled.');
    return value;
  }

  /**
   * Give a click or a submit a moment to navigate.
   *
   * Resolves either when a navigation finishes or after a short grace period —
   * most clicks do not navigate at all, and waiting the full navigation
   * timeout for every one of them would make the agent feel broken.
   */
  private async settleAfterAction(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    await Promise.race([this.waitForNavigation(), delay(600)]);
    // Let a single-page application finish rendering whatever the click did.
    await delay(300);
  }

  private waitForNavigation(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const contents = window.webContents;
      const done = (): void => {
        clearTimeout(timer);
        contents.off('did-finish-load', done);
        contents.off('did-fail-load', done);
        contents.off('did-navigate', done);
        resolve();
      };
      const timer = setTimeout(done, this.navigationTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      contents.once('did-finish-load', done);
      contents.once('did-fail-load', done);
      contents.once('did-navigate', done);
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserError('TIMEOUT', message)), ms);
      if (typeof timer.unref === 'function') timer.unref();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * Spend one action from the turn's budget.
   *
   * The bound that stops "click, observe, click, observe" forever — whether
   * the loop comes from a confused model or from a page engineered to produce
   * one. Exceeding it is a structured failure the model can read and report,
   * not a crash.
   */
  private spendAction(): void {
    this.actionsThisTurn += 1;
    if (this.actionsThisTurn > this.maxActionsPerTurn) {
      throw new BrowserError(
        'BUDGET_EXCEEDED',
        `Axon has taken ${this.maxActionsPerTurn} browser actions for this request, which is the limit. ` +
          'Stop and tell the user what you found.',
      );
    }
  }

  private spendNavigation(): void {
    this.navigationsThisTurn += 1;
    if (this.navigationsThisTurn > this.maxNavigationsPerTurn) {
      throw new BrowserError(
        'BUDGET_EXCEEDED',
        `Axon has navigated ${this.maxNavigationsPerTurn} times for this request, which is the limit. ` +
          'Stop and tell the user what you found.',
      );
    }
    this.spendAction();
  }
}

/**
 * Lock down the browser's session.
 *
 * Applied to the partition rather than to the window, so it holds for every
 * page, frame and worker that partition ever loads.
 */
function hardenSession(partition: Session): void {
  // Every permission refused. A web page in Axon's browser gets no camera, no
  // microphone, no location, no notifications, no clipboard, no MIDI, no USB.
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.setDevicePermissionHandler(() => false);

  // No downloads, at all. "Download then execute" is the shortest path from
  // browsing to code execution, and Axon has no feature that needs a file from
  // the web — so the capability is absent rather than guarded.
  partition.on('will-download', (event) => {
    event.preventDefault();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** The host of a URL, for a message. Never the query string, which can carry
 *  tokens, and never the full URL in a log line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'that address';
  }
}

/** A short reason from an Electron navigation failure. */
function navigationReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /(ERR_[A-Z_]+)/.exec(message)?.[1];
  switch (code) {
    case 'ERR_NAME_NOT_RESOLVED':
      return 'that address does not exist';
    case 'ERR_INTERNET_DISCONNECTED':
      return 'there is no internet connection';
    case 'ERR_CONNECTION_REFUSED':
      return 'the site refused the connection';
    case 'ERR_CONNECTION_TIMED_OUT':
      return 'the site did not respond';
    case 'ERR_CERT_AUTHORITY_INVALID':
    case 'ERR_CERT_COMMON_NAME_INVALID':
      return 'the site has an invalid security certificate';
    case 'ERR_ABORTED':
      return 'the page load was interrupted';
    default:
      return code ? code.replace('ERR_', '').toLowerCase().replace(/_/g, ' ') : 'the page could not be loaded';
  }
}

function assertActionOk(raw: unknown, action: string): void {
  const outcome = raw as { ok?: unknown; reason?: unknown } | null;
  if (outcome?.ok === true) return;

  switch (outcome?.reason) {
    case 'not-found':
      throw new BrowserError(
        'ELEMENT_NOT_FOUND',
        'That element is no longer on the page. Read the page again and use a current reference.',
      );
    case 'sensitive':
      throw new BrowserError(
        'ELEMENT_SENSITIVE',
        'That is a credential or payment field. Axon does not interact with those.',
      );
    case 'not-editable':
      throw new BrowserError('ELEMENT_NOT_EDITABLE', 'That element is not a text field.');
    default:
      throw new BrowserError('CRASHED', `The ${action} did not complete.`);
  }
}

/**
 * Rebuild an observation from whatever the page returned.
 *
 * Field by field, with every bound reapplied on this side. The page program is
 * ours, but it runs in a context a hostile page also controls — a page can
 * redefine `Array.prototype.map`, `String.prototype.slice` or the getters the
 * program reads. So its output is treated as untrusted input, and nothing is
 * carried across that was not explicitly copied here.
 */
function toObservation(raw: unknown, epoch: number): PageObservation {
  const value = (raw ?? {}) as Record<string, unknown>;

  const elements: ObservedElement[] = [];
  const rawElements = Array.isArray(value.elements) ? value.elements : [];

  for (const entry of rawElements.slice(0, BROWSING_LIMITS.maxElements)) {
    const element = (entry ?? {}) as Record<string, unknown>;
    const ref = str(element.ref, 16);
    // A reference Axon cannot address is worse than useless: it would let the
    // model name an element the risk policy could not look up.
    if (!/^e\d{1,5}$/.test(ref)) continue;

    elements.push({
      ref,
      role: role(element.role),
      label: str(element.label, BROWSING_LIMITS.maxLabelCharacters),
      href: element.href == null ? null : str(element.href, BROWSING_LIMITS.maxUrlCharacters),
      sensitive: element.sensitive === true,
      submits: element.submits === true,
      value: element.value == null ? null : str(element.value, BROWSING_LIMITS.maxLabelCharacters),
    });
  }

  return {
    epoch,
    url: str(value.url, BROWSING_LIMITS.maxUrlCharacters),
    title: str(value.title, BROWSING_LIMITS.maxLabelCharacters),
    text: str(value.text, BROWSING_LIMITS.maxTextCharacters),
    textTruncated: value.textTruncated === true,
    elements,
    elementsTruncated: value.elementsTruncated === true || rawElements.length > BROWSING_LIMITS.maxElements,
    loading: value.loading === true,
  };
}

function str(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit);
}

function role(value: unknown): ElementRole {
  return (ELEMENT_ROLES as readonly string[]).includes(value as string) ? (value as ElementRole) : 'other';
}
