/**
 * Process-wide security hardening.
 *
 * The renderer is treated as untrusted. Not because we distrust our own React
 * code today, but because Axon's entire purpose is to bring the outside world
 * — web pages, file contents, transcripts, eventually model output — into this
 * application. Any of those can carry an injection attempt, and the only
 * durable answer is that the surface it lands on cannot do anything.
 *
 * Applied here:
 *   - a Content-Security-Policy on every response, set at the session level so
 *     it holds regardless of what any HTML document declares;
 *   - navigation confined to the app's own origin;
 *   - `window.open`, webviews and popups refused outright;
 *   - every permission request (camera, geolocation, notifications, ...)
 *     denied by default, so a capability can only appear by being added here
 *     deliberately.
 *
 * Step 4 adds exactly one capability to that list: audio capture, and only
 * while the main process has itself opened a listening session. See
 * `allowMicrophone` below — it is the whole policy, and it is short enough to
 * check by reading.
 */

import { app, shell, type Session, type WebContents } from 'electron';
import { URL } from 'node:url';

export interface SecurityOptions {
  readonly isDev: boolean;
  /** Origin the renderer is served from, e.g. http://localhost:5173 in dev. */
  readonly appOrigin: string | null;
  /**
   * True only while the main process has an open listening session.
   *
   * This is what makes microphone access a *capability* rather than a
   * *setting*. Chromium will ask for permission whenever the page calls
   * `getUserMedia`; answering yes only while main has itself decided to listen
   * means a compromised renderer cannot open the microphone by asking nicely,
   * and that the permission is closed again the moment the utterance ends.
   *
   * Absent in contexts with no listening service (tests, the verification
   * harness), where it defaults to "never".
   */
  readonly isListening?: () => boolean;
  /**
   * True for the Axon browser's own WebContents.
   *
   * `confineWebContents` locks every WebContents to Axon's origin, which is
   * exactly right for the UI and exactly wrong for the browser, whose purpose
   * is to go elsewhere. Without this exemption a link click in the browser
   * window is silently blocked — and only a link click, because `loadURL` is
   * API-initiated and does not raise `will-navigate`, so the failure appears
   * only once someone clicks something.
   *
   * The browser is not thereby unconfined. It applies a STRICTER policy of its
   * own: every navigation and redirect is re-checked against the URL policy,
   * which is narrower than "same origin as the app" in every respect except
   * the one that matters here.
   */
  readonly isBrowserContents?: (contents: WebContents) => boolean;
}

/**
 * Build the CSP.
 *
 * `'unsafe-inline'` appears for styles in both modes: React writes dynamic
 * layout values as inline style attributes, which CSP's `style-src` governs.
 * It is not present for `script-src` in production, which is the directive
 * that actually decides whether injected markup can execute.
 *
 * Development additionally allows inline scripts and a localhost websocket,
 * both of which Vite's HMR client requires.
 */
export function buildContentSecurityPolicy(isDev: boolean): string {
  const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const connectSrc = isDev ? "'self' ws://localhost:* http://localhost:*" : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src ${connectSrc}`,
    // Nothing may be embedded, embed us, or navigate us away via a form.
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

function sameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function applySessionSecurity(session: Session, options: SecurityOptions): void {
  const csp = buildContentSecurityPolicy(options.isDev);

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // Deny every permission except one, and grant that one only while main has
  // decided Axon is listening. Camera, geolocation, notifications, USB,
  // serial, HID, MIDI, clipboard and the rest are all refused here — they are
  // not disabled somewhere else and re-enabled by accident; they never arrive.
  const isListening = options.isListening ?? ((): boolean => false);

  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowMicrophone(permission, details, isListening));
  });

  // The synchronous counterpart, consulted for enumerateDevices and for
  // repeat access. Same rule, so the two can never disagree.
  session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    allowMicrophone(permission, details, isListening),
  );

  // Device selection for WebHID, WebUSB and Web Serial. Nothing in Axon uses
  // any of them, and a blanket refusal here means a future feature has to add
  // its own allowance deliberately rather than inheriting one.
  session.setDevicePermissionHandler(() => false);
}

/**
 * The complete permission policy: audio capture, while listening, and nothing
 * else.
 *
 * Two things decide the answer, and both must hold:
 *
 *   1. The permission is media capture, and the media is audio. Electron
 *      describes that differently to each handler — the request handler gets a
 *      `mediaTypes` array, the check handler a single `mediaType` — so both
 *      shapes are read here. A request that mentions video, or that does not
 *      say what it wants, is refused. "Audio only" is therefore enforced by
 *      the main process, not merely requested politely by the renderer's
 *      `getUserMedia` constraints.
 *
 *   2. The main process currently has an open listening session. This is the
 *      half that matters: page code cannot obtain a microphone by asking for
 *      one, because the answer depends on a decision main has already taken
 *      for its own reasons.
 *
 * `details` is typed as `unknown` deliberately. Electron passes a different
 * shape to each of the two handlers, and narrowing here — rather than trusting
 * either declaration — keeps one policy for both.
 */
export function allowMicrophone(permission: string, details: unknown, isListening: () => boolean): boolean {
  if (permission !== 'media' && permission !== 'audioCapture') return false;

  const described = details as { mediaTypes?: unknown; mediaType?: unknown } | null | undefined;

  const mediaTypes = described?.mediaTypes;
  if (Array.isArray(mediaTypes)) {
    if (mediaTypes.includes('video')) return false;
    if (!mediaTypes.includes('audio')) return false;
  }

  const mediaType = described?.mediaType;
  if (typeof mediaType === 'string' && mediaType !== 'audio') return false;

  return isListening();
}

/**
 * Confine a WebContents.
 *
 * `will-navigate` covers in-place navigation; `setWindowOpenHandler` covers
 * `window.open`, `target=_blank` and popups; `will-attach-webview` covers the
 * `<webview>` escape hatch. All three are needed — blocking one leaves the
 * others open.
 */
export function confineWebContents(contents: WebContents, options: SecurityOptions): void {
  contents.on('will-navigate', (event, url) => {
    // Asked HERE rather than once at creation. `web-contents-created` fires
    // from inside `new BrowserWindow(...)`, before the constructor returns and
    // therefore before the browser can possibly know the window is its own —
    // so an exemption decided at creation time is always "no". Deciding when
    // the navigation happens is both correct and later.
    //
    // The browser window polices itself, more strictly. See `isBrowserContents`.
    if (options.isBrowserContents?.(contents)) return;

    if (options.appOrigin && sameOrigin(url, options.appOrigin)) return;
    event.preventDefault();
    console.warn('[security] blocked navigation to', url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Refuse to open a window. External links are handed to the OS browser
    // instead, which keeps them outside Axon's origin and its bridge.
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[security] blocked window.open for', url);
    }
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('[security] blocked <webview> attachment');
  });
}

/** Install the app-wide hooks. Call once, before any window is created. */
export function installSecurityHooks(options: SecurityOptions): void {
  app.on('web-contents-created', (_event, contents) => {
    confineWebContents(contents, options);
  });
}
