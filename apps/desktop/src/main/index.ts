/**
 * Axon Voice — main process entry point.
 *
 * Assembly order matters and is not arbitrary:
 *
 *   1. security hooks   installed before any WebContents can exist
 *   2. runtime          config, bus, log sink, registry, orchestrator
 *   3. bridge           IPC handlers registered
 *   4. window           the renderer starts, and finds a system already live
 *
 * The window is last so the UI never renders against a half-built backend.
 */

import path from 'node:path';
import { app, session, type WebContents } from 'electron';
import { installRendererBridge, type RendererBridge } from './bus/renderer-bridge.js';
import { envFileCandidates, loadEnvFile } from './env-file.js';
import { createAxonRuntime, type AxonRuntime } from './runtime.js';
import { applySessionSecurity, installSecurityHooks } from './security.js';
import { GlobalHotkeyWakeSource } from './wake/global-hotkey.js';
import { createMainWindow } from './window.js';

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;
const isDev = !app.isPackaged;

// A second instance would open a second window against the same JSONL log and
// the same workspace, and the two would interleave unpredictably.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let runtime: AxonRuntime | null = null;
let bridge: RendererBridge | null = null;
let hotkey: GlobalHotkeyWakeSource | null = null;

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
     * NARROWER THAN IT USED TO BE, and deliberately so. The old rule was "for
     * as long as a listening session is open", which was fine when sessions
     * lasted seconds. The wake word listens for hours, so the same rule would
     * have left this permanently open — and a compromised renderer could then
     * call `getUserMedia` whenever it liked.
     *
     * The gate instead opens for the moment after MAIN issues a capture
     * command and closes as soon as the renderer reports the device open, or
     * on a deadline regardless. Chromium checks permission at `getUserMedia`
     * time and not continuously, so an already-running stream is unaffected —
     * which is what lets the wake word listen indefinitely through a gate that
     * is shut almost all of the time.
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
  bridge = installRendererBridge(runtime.bus, runtime.orchestrator, {
    persistence: runtime.persistence,
    settings: runtime.settings,
  });
  // The voice layer can now reach a window. Until this line, an utterance
  // would be synthesised and dropped rather than played.
  runtime.speechTransport.attach(bridge);
  // And the inbound twin: until this line, a capture command would be minted
  // and dropped rather than opening a microphone.
  runtime.captureTransport.attach(bridge);

  // The wake word starts listening once the window exists to hold a
  // microphone, and once its renderer is actually ready to receive a capture
  // command. See below.
  const window = createMainWindow({
    preloadPath: path.join(__dirname, '../preload/index.js'),
    rendererUrl: rendererDevUrl,
    rendererFile: rendererDevUrl ? null : path.join(__dirname, '../renderer/index.html'),
    openDevTools: false,
  });

  // Arm the local wake word, once the renderer can actually hear it.
  //
  // WHY AFTER `did-finish-load` AND NOT SIMPLY AFTER THE WINDOW EXISTS.
  // `getUserMedia` lives in a renderer, so arming sends a capture command to
  // the window — and a command broadcast before the page has mounted and
  // subscribed reaches nobody and is dropped. The wake word would then be
  // armed and deaf, and the microphone permission window it opened would sit
  // open with nothing to consume it. Both are exactly the sort of quiet
  // failure this subsystem must not have.
  //
  // The window does NOT need to be visible or focused for any of this, which
  // is what makes hands-free activation work while Axon is minimised. It does
  // need to exist: there is no route to a microphone from a headless main
  // process.
  //
  // Failure is not fatal and not loud: Axon simply is not listening for its
  // name, says so in the UI, and the hotkey and the button still work.
  window.webContents.once('did-finish-load', () => {
    void runtime?.wakeWord.arm().catch(() => {
      /* `arm` reports its own failures through onNotice */
    });
  });
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

app.on('window-all-closed', () => {
  // Axon is a Windows-first desktop app; closing the window means quitting.
  app.quit();
});

app.on('before-quit', () => {
  // Deny anything still awaiting approval before the process goes away, so a
  // quit can never race a pending decision into execution.
  // Stop listening for the name before anything else: a quit that leaves a
  // recognizer holding the microphone is the failure this whole subsystem is
  // written to avoid.
  runtime?.wakeWord.disarm();
  runtime?.orchestrator.shutdown();
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
  void runtime?.sink.close();
});
