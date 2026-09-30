/**
 * Axon Voice — main process entry point.
 *
 * AXON RUNS IN THE BACKGROUND. One process, started at sign-in (when the user
 * turns that on) or by hand, holds everything: the runtime, the dispatcher,
 * the voice agent, and the local wake word. It shows nothing until it is
 * needed:
 *
 *   overlay   a hidden, transparent, always-on-top window. It is the one page
 *             that holds the microphone (the local wake phrase, push-to-talk,
 *             the conversation) and plays Axon's voice, and it is where the
 *             small orb appears, bottom centre, when Axon is woken.
 *   panel     the full window — conversation, settings, memory — opened from
 *             the tray, or when Axon is started by hand. Closing it closes the
 *             panel, not Axon.
 *   tray      "Open Axon", "Start with Windows", "Quit Axon". Quitting is the
 *             one explicit way to stop listening for the name.
 *
 * WHAT A WAKE PHRASE CAN REACH. The wake word turns microphone audio into one
 * signal — `onWake` — and that signal can only ask the orchestrator for a voice
 * session. It cannot name a tool, and the recognizer that hears it runs in a
 * separate process with no credentials, no network and no file access (see
 * `voice/windows-stt.ts`). After activation, everything the user asks for goes
 * through the same dispatcher, policy and approval gate as always.
 *
 * Assembly order matters and is not arbitrary:
 *
 *   1. security hooks   installed before any WebContents can exist
 *   2. runtime          config, bus, log sink, registry, orchestrator
 *   3. bridge           IPC handlers registered
 *   4. windows          the overlay (always), the panel (when started by hand)
 */

import path from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, screen, session, Tray, type WebContents } from 'electron';
import { IPC_CHANNELS } from '@axon/core';
import { installRendererBridge, type RendererBridge } from './bus/renderer-bridge.js';
import { envFileCandidates, loadEnvFile } from './env-file.js';
import { createAxonRuntime, type AxonRuntime } from './runtime.js';
import { applySessionSecurity, installSecurityHooks } from './security.js';
import { parseLaunchMode } from './shell/launch-mode.js';
import { StartupRegistration } from './shell/login-item.js';
import { OverlayPresence, overlayBounds, overlayWanted, type OverlayCommand } from './shell/overlay-presence.js';
import { liveContents } from './bus/surface-router.js';
import { orbIconBitmap } from './shell/tray-icon.js';
import { GlobalHotkeyWakeSource } from './wake/global-hotkey.js';
import { applyAppearance, createMainWindow, createOverlayWindow, setOverlayInteractive } from './window.js';

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;
const isDev = !app.isPackaged;
const launch = parseLaunchMode(process.argv);

const preloadPath = path.join(__dirname, '../preload/index.js');
const rendererFile = rendererDevUrl ? null : path.join(__dirname, '../renderer/index.html');

/** How long the orb stays after Axon goes quiet, so the last reply can be read. */
const OVERLAY_LINGER_MS = 3_200;
/** Must match the overlay page's leave transition. */
const OVERLAY_LEAVE_MS = 360;

// A second instance would run a second wake word against the same microphone,
// the same JSONL log and the same workspace. It opens this one's panel instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let runtime: AxonRuntime | null = null;
let bridge: RendererBridge | null = null;
let hotkey: GlobalHotkeyWakeSource | null = null;
let overlay: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;
let presence: OverlayPresence | null = null;
let startup: StartupRegistration | null = null;
let quitting = false;

/**
 * What the push-to-talk key does.
 *
 * Named rather than written inline because the accelerator can be
 * re-registered when the user changes it, and both registrations have to
 * behave identically.
 */
function onWake(): void {
  const orchestrator = runtime?.orchestrator;
  if (!orchestrator) return;

  // One key, both directions, and it prefers a spoken conversation when one is
  // available. The hotkey is the deliberate-activation path that does not
  // depend on the wake word working, on the room being quiet, or on the user
  // being willing to say a name out loud.
  if (orchestrator.voiceAgentStatus().active) {
    orchestrator.stopVoiceSession();
    return;
  }
  if (runtime?.listening.listening) {
    orchestrator.stopListening();
    return;
  }
  if (orchestrator.voiceAgentStatus().available) {
    const result = orchestrator.startVoiceSession('hotkey');
    if (result.accepted) return;
    // Fall through: with no voice session possible, the offline
    // transcribe-then-type path still works and is better than nothing.
  }
  orchestrator.startListening('hotkey');
}

/** Show the panel, creating it if it was closed. */
function openPanel(): void {
  if (quitting) return;
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    return;
  }
  panel = createMainWindow({ preloadPath, rendererUrl: rendererDevUrl, rendererFile, openDevTools: false });
  panel.on('closed', () => {
    panel = null;
  });
}

/** Carry out what the overlay presence decided. */
function applyOverlay(command: OverlayCommand): void {
  const window = overlay;
  if (!window || window.isDestroyed()) return;
  switch (command) {
    case 'show': {
      // The display the user is working on: the one under the pointer. The
      // overlay covers its work area, so the orb sits just above the taskbar.
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      window.setBounds(overlayBounds(display.workArea));
      setOverlayInteractive(window, false);
      window.setAlwaysOnTop(true, 'floating');
      // Never steals focus: the user's application keeps the keyboard.
      window.showInactive();
      return;
    }
    case 'enter':
    case 'leave':
      // The presence timers that call this outlive nothing: the page can be
      // gone (reload, crash) while the window stands.
      liveContents(window)?.send(IPC_CHANNELS.OVERLAY_PHASE, command);
      return;
    case 'hide':
      setOverlayInteractive(window, false);
      window.hide();
      return;
  }
}

/** Re-derive whether the orb should be up. Coalesced: many events, one check. */
let overlayCheckPending = false;
function scheduleOverlayCheck(): void {
  if (overlayCheckPending) return;
  overlayCheckPending = true;
  setImmediate(() => {
    overlayCheckPending = false;
    const orchestrator = runtime?.orchestrator;
    if (!orchestrator || !presence) return;
    const snapshot = orchestrator.snapshot();
    presence.update(
      overlayWanted({
        state: snapshot.state,
        voiceActive: snapshot.voiceAgent.active,
        listeningActive: snapshot.listening.active,
        approvalPending: snapshot.pendingApprovals.length > 0,
      }),
    );
  });
}

function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = startup?.status() ?? { available: false, enabled: false, reason: null };
  tray.setToolTip(runtime?.wakeWord.isArmed ? 'Axon — say “Hey Axon”' : 'Axon');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Axon', click: openPanel },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: status.enabled,
        enabled: status.available,
        click: (item) => {
          startup?.set(item.checked);
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Axon',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function bootstrap(): void {
  // Before anything reads the environment. A real environment variable always
  // wins over the file; nothing about the values is logged.
  const envFile = loadEnvFile(envFileCandidates(app.getAppPath(), process.cwd()), process.env);
  if (envFile.path) {
    console.warn(`[axon] loaded ${envFile.applied} variable(s) from ${envFile.path}`);
  }

  // Microphone access is granted only while the main process has an open
  // listening session. The closure reads `runtime` lazily because security is
  // installed before the runtime exists — deliberately, so no WebContents can
  // be created against an unhardened session.
  const securityOptions = {
    isDev,
    appOrigin: rendererDevUrl,
    /**
     * When page code may obtain a microphone.
     *
     * The gate opens for the moment after MAIN issues a capture command and
     * closes as soon as the renderer reports the device open, or on a deadline
     * regardless. Chromium checks permission at `getUserMedia` time and not
     * continuously, so an already-running stream is unaffected — which is what
     * lets the wake word listen indefinitely through a gate that is shut almost
     * all of the time.
     */
    // CONSUMES the grant. The permission handler is the only caller, and a
    // capture command permits exactly one device open — see `MicGate.consume`.
    isListening: (): boolean => runtime?.micGate.consume() ?? false,
    isBrowserContents: (contents: WebContents): boolean => runtime?.browser.owns(contents) ?? false,
  };
  installSecurityHooks(securityOptions);
  applySessionSecurity(session.defaultSession, securityOptions);

  // Registered before the runtime so the accelerator that actually took can be
  // handed to it, and shown in the UI. The callback resolves the orchestrator
  // lazily for the same reason.
  hotkey = new GlobalHotkeyWakeSource({ preferred: process.env['AXON_VOICE_HOTKEY'] });
  hotkey.start(onWake);

  runtime = createAxonRuntime({
    home: app.getPath('home'),
    env: process.env,
    isDev,
    // Where Chromium keeps the browser profile. Read from Electron rather than
    // assumed, so the path policy protects the directory that really exists.
    sessionData: app.getPath('sessionData'),
    hotkey: hotkey.accelerator,
    // Re-registering a global shortcut is the one settings change the
    // operating system can refuse. The old registration is released first and
    // the accelerator actually in force is returned, which is what the
    // settings service rolls back on when nothing takes.
    applyHotkey: (accelerator): string | null => {
      hotkey?.stop();
      const next = new GlobalHotkeyWakeSource({ preferred: accelerator ?? undefined });
      next.start(onWake);
      hotkey = next;
      return next.accelerator;
    },
  });

  // Per-user start at sign-in. The app directory is derived from where this
  // bundle is (out/main -> the app), not from how Electron was launched.
  startup = new StartupRegistration(
    {
      platform: process.platform,
      getLoginItemSettings: (options) => app.getLoginItemSettings(options),
      setLoginItemSettings: (settings) => {
        app.setLoginItemSettings(settings);
      },
    },
    { execPath: process.execPath, appDir: path.resolve(__dirname, '../..'), isPackaged: app.isPackaged },
  );

  bridge = installRendererBridge(runtime.bus, runtime.orchestrator, {
    persistence: runtime.persistence,
    settings: runtime.settings,
    // Only the panel's frame is recoloured. The overlay is transparent, and a
    // background colour would turn it into a rectangle over the desktop.
    setAppearance: (sender, appearance): void => {
      const owner = BrowserWindow.fromWebContents(sender);
      if (owner && owner !== overlay && !owner.isDestroyed()) applyAppearance(owner, appearance);
    },
    // `liveContents`, never `overlay?.webContents`: on a destroyed BrowserWindow
    // that property read THROWS, and this runs inside `ipcMain` listeners for
    // frames that can still be in flight when the overlay goes away. That was
    // a real uncaught exception — see `surface-router.ts`.
    voiceSurface: () => liveContents(overlay),
    setOverlayInteractive: (sender, interactive): void => {
      const contents = liveContents(overlay);
      if (overlay && contents !== null && sender === contents) {
        setOverlayInteractive(overlay, interactive);
      }
    },
    startup: {
      get: () => startup?.status() ?? { available: false, enabled: false, reason: 'Not ready.' },
      set: (enabled) => {
        const status = startup?.set(enabled) ?? { available: false, enabled: false, reason: 'Not ready.' };
        rebuildTrayMenu();
        return status;
      },
    },
  });
  // The voice layer can now reach a window. Until this line, an utterance
  // would be synthesised and dropped rather than played.
  runtime.speechTransport.attach(bridge);
  // And the inbound twin: until this line, a capture command would be minted
  // and dropped rather than opening a microphone.
  runtime.captureTransport.attach(bridge);

  // --- the overlay: voice surface and orb -----------------------------------
  const voice = createOverlayWindow({ preloadPath, rendererUrl: rendererDevUrl, rendererFile });
  overlay = voice;

  // The overlay is not closed by anything but quitting: it is where the
  // microphone lives. (A harness may still destroy it.)
  voice.on('close', (event) => {
    if (!quitting) event.preventDefault();
  });
  // Once it is gone it is not a voice surface, a send target, or anything else.
  // A reference kept past this point is how a dead window stays "valid".
  voice.on('closed', () => {
    if (overlay === voice) overlay = null;
  });

  presence = new OverlayPresence({
    lingerMs: OVERLAY_LINGER_MS,
    leaveMs: OVERLAY_LEAVE_MS,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    apply: applyOverlay,
  });
  runtime.bus.subscribe(() => {
    scheduleOverlayCheck();
    // The tray tooltip follows whether the wake word is listening.
    rebuildTrayMenu();
  });

  // Arm the local wake word, once the overlay page can actually hear it.
  //
  // WHY AFTER `did-finish-load` AND NOT SIMPLY AFTER THE WINDOW EXISTS.
  // `getUserMedia` lives in a renderer, so arming sends a capture command to
  // the overlay — and a command sent before the page has mounted and
  // subscribed reaches nobody and is dropped. The wake word would then be armed
  // and deaf.
  //
  // The overlay does NOT need to be visible for any of this, which is what
  // makes hands-free activation work with no Axon window on screen.
  //
  // Failure is not fatal and not loud: Axon simply is not listening for its
  // name, says so in the panel, and the hotkey and the tray still work.
  voice.webContents.once('did-finish-load', () => {
    void runtime?.wakeWord.arm().catch(() => {
      /* `arm` reports its own failures through onNotice */
    });
  });

  // A RELOAD OR A RENDERER CRASH TAKES THE MICROPHONE WITH IT.
  //
  // Every capture is a `getUserMedia` stream inside the overlay page, and a
  // reload destroys it without the page getting a chance to say so. Main ends
  // what the page was holding — honestly, as ended — and re-arms the wake word
  // once the new page can receive a capture command. Nothing pending is
  // approved or resumed by this: approvals stay with the broker and reappear
  // from the snapshot, still awaiting a human.
  let loadedOnce = false;
  const releaseCaptures = (why: string): void => {
    if (!runtime) return;
    console.warn(`[axon] ${why}; ending microphone sessions the page was holding`);
    runtime.orchestrator.stopVoiceSession();
    runtime.orchestrator.stopListening();
    runtime.wakeWord.disarm();
  };
  voice.webContents.on('did-start-loading', () => {
    if (loadedOnce) releaseCaptures('the voice surface is reloading');
  });
  voice.webContents.on('render-process-gone', (_event, details) => {
    releaseCaptures(`the voice surface's renderer stopped (${details.reason})`);
    // Nobody is looking at a hidden page to reload it by hand, so it comes
    // back on its own, and the wake word re-arms when it has.
    if (!quitting && !voice.isDestroyed()) voice.webContents.reload();
  });
  voice.webContents.on('did-finish-load', () => {
    if (!loadedOnce) {
      loadedOnce = true;
      return;
    }
    void runtime?.wakeWord.arm().catch(() => {
      /* `arm` reports its own failures through onNotice */
    });
  });

  // --- tray -----------------------------------------------------------------
  tray = new Tray(nativeImage.createFromBitmap(orbIconBitmap(32), { width: 32, height: 32 }));
  tray.on('click', openPanel);
  rebuildTrayMenu();

  // Started by hand: show the panel. Started at sign-in: show nothing.
  if (!launch.background) openPanel();
}

app.whenReady().then(
  () => {
    try {
      bootstrap();
    } catch (error) {
      console.error('[axon] failed to start', error);
      app.quit();
    }
  },
  (error: unknown) => {
    console.error('[axon] Electron failed to become ready', error);
    app.quit();
  },
);

app.on('second-instance', () => {
  // Launched again (a shortcut, the Start menu): open this instance's panel.
  if (app.isReady()) openPanel();
});

app.on('window-all-closed', () => {
  // Deliberately empty. Closing the panel is not quitting: Axon keeps
  // listening for its name locally. "Quit Axon" in the tray is how it stops.
});

app.on('before-quit', () => {
  quitting = true;
  presence?.dispose();
  tray?.destroy();
  tray = null;
  // Deny anything still awaiting approval before the process goes away, so a
  // quit can never race a pending decision into execution.
  // Stop listening for the name before anything else: a quit that leaves a
  // recognizer holding the microphone is the failure this whole subsystem is
  // written to avoid.
  runtime?.wakeWord.disarm();
  runtime?.orchestrator.shutdown();
  // The native accessibility engine: a child process reading other
  // applications' controls has no business outliving Axon.
  runtime?.desktopEngine.dispose();
  runtime?.speechTransport.detach();
  runtime?.captureTransport.detach();
  // Releases the system-wide key hook. Left registered, it would outlive the
  // process that was meant to answer it.
  hotkey?.stop();
  bridge?.dispose();
  // Bounded and synchronous. WAL means a close is a checkpoint rather than a
  // flush of unwritten data, so there is nothing to wait for — which is what
  // keeps a quit from hanging on a busy database.
  runtime?.persistence.close();
  // Written here, at the very end, because a row cannot be built until the
  // events after it have arrived. Null unless a developer asked for a
  // recording; the path is printed so it can be found without guessing.
  const recordingPath = runtime?.demoRecording?.close() ?? null;
  // `warn`, because the lint rule reserves stdout for nothing: this is a
  // developer notice, printed once at quit, and only when they asked for it.
  if (recordingPath) console.warn(`[axon] demo recording written to ${recordingPath}`);
  void runtime?.sink.close();
});
