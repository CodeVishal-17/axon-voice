/**
 * Axon's background lifecycle, verified against the real app.
 *
 *   npm run verify:lifecycle
 *
 * WHAT IS REAL HERE. The shipping entry point, started exactly as the per-user
 * sign-in entry starts it (`--background`): the real overlay window, the real
 * microphone capture in it, the real local wake detector, the real tray and
 * the real Windows sign-in registration.
 *
 * WHAT IT CHECKS.
 *   - Started in the background, no Axon window is on screen.
 *   - The wake word is armed from the hidden voice surface, the DEDICATED LOCAL
 *     KEYWORD SPOTTER is what is armed, it loaded its model, and microphone
 *     audio reaches it — with no window open, before and after the UI closes.
 *   - Activity brings a small orb to the bottom centre of a display's work
 *     area without taking focus, with both side auras in the state's colour,
 *     and it leaves once Axon is quiet.
 *   - A second launch opens the panel; capture commands reach only the overlay.
 *   - The sign-in entry is per user, starts Axon in the background, and is
 *     removed again. The user's original setting is put back.
 *   - Closing the panel leaves the wake word listening, and the orb still
 *     comes back.
 *   - Late events — microphone frames, diagnostics, interactivity reports,
 *     state changes, listening, cancellation — arriving after the overlay is
 *     destroyed, during a renderer reload, and after the panel is destroyed,
 *     produce no uncaught exception in main.
 *
 * WHAT IT DOES NOT DO. It does not speak to the microphone or fake audio, so
 * it does not claim the wake phrase is recognised — `npm run wake:live` is that
 * test, with a person. Activity is driven through the development-only state
 * request. It does not reboot Windows.
 *
 * It uses a throwaway AXON_HOME, and it changes the sign-in setting only for a
 * moment and restores it.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, screen, ipcMain } = require('electron');

/**
 * Every uncaught exception in main during the run. A real one reached a user:
 * "TypeError: Object has been destroyed" from a microphone frame that arrived
 * after the overlay was gone. The race checks at the end assert this stays
 * empty, against the real Electron objects.
 */
const uncaught = [];
process.on('uncaughtException', (error) => {
  uncaught.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
});

const checks = [];
let failed = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return false;
    await wait(150);
  }
}

/** Wake-word diagnostics, captured from this process's console. Text only. */
const wakeLines = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[wake]')) wakeLines.push({ at: Date.now(), line });
  originalWarn(...args);
};

function findWindow(pattern) {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && pattern.test(w.webContents.getURL())) ?? null;
}

async function waitForWindow(pattern, timeoutMs) {
  const found = await until(() => Boolean(findWindow(pattern)), timeoutMs);
  return found ? findWindow(pattern) : null;
}

function waitForLoad(window) {
  if (!window.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    window.webContents.once('did-finish-load', resolve);
    setTimeout(resolve, 15_000);
  });
}

/** The per-user sign-in entry Windows holds for Axon, or null. Read-only. */
function readRunValue() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Axon'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split(/\r?\n/).find((entry) => /^\s*Axon\s+REG_/.test(entry));
    return line ? line.replace(/^\s*Axon\s+REG_\w+\s+/, '').trim() : null;
  } catch {
    return null;
  }
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-lifecycle-verify-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_WAKE_DEBUG = '1';
  process.env.AXON_APPROVAL_TIMEOUT_MS = '60000';

  console.log('\nAxon lifecycle verification (started in the background, as at sign-in)\n');

  if (!process.argv.includes('--background')) process.argv.push('--background');
  require(path.join(outDir, 'index.js'));

  const overlay = await waitForWindow(/[?&]surface=overlay/, 20_000);
  if (!overlay) {
    check('the voice surface was created', false);
    finish(sandbox);
    return;
  }
  await waitForLoad(overlay);
  await wait(4_000);

  try {
    await run(overlay);
  } catch (error) {
    check('the harness ran to completion', false, error instanceof Error ? error.stack : String(error));
  }
  finish(sandbox);
}

async function run(overlay) {
  const inOverlay = (script) => overlay.webContents.executeJavaScript(script, true);
  const state = (to, reason) => inOverlay(`window.axon.requestState(${JSON.stringify(to)}, ${JSON.stringify(reason)})`);
  const snapshot = () => inOverlay('window.axon.getSnapshot()');

  // --- started in the background -----------------------------------------------
  const visible = BrowserWindow.getAllWindows().filter((w) => w.isVisible());
  check('no Axon window is on screen', visible.length === 0, `${visible.length} visible`);
  check('no panel was opened', findWindow(/[?&]surface=panel/) === null);
  check('the voice surface exists, hidden', !overlay.isVisible());

  // --- the wake service ----------------------------------------------------------
  check(
    'the local wake word is armed with no window open',
    await until(async () => (await snapshot()).voiceAgent.armed === true, 15_000),
  );
  // WHICH detector is armed, from the snapshot rather than from a log line.
  // Axon has two and only one of them has ever passed a human microphone test,
  // so "armed" on its own is not the thing worth checking.
  const wake = (await snapshot()).voiceAgent.wake;
  check('the armed detector is the dedicated local keyword spotter', wake.engine === 'keyword-spotter', wake.detail);
  check('it reports itself as usable, with nothing to fix', wake.available === true && wake.unavailableReason === null);
  check(
    'the spotter loaded its model and said it is listening',
    await until(() => wakeLines.some((e) => /keyword spotter is listening/.test(e.line)), 25_000),
  );
  check('the spotter has not had to be restarted', wake.restarts === 0, `restarts=${wake.restarts}`);
  check(
    'microphone audio reaches the local detector from the hidden surface',
    await until(() => wakeLines.some((e) => /microphone audio is arriving/.test(e.line)), 15_000),
  );
  check('the detector is not starved of audio', (await snapshot()).voiceAgent.wake.starvedOfAudio === false);
  check('listening for the name opens no voice session', (await snapshot()).voiceAgent.active === false);

  // --- activity brings the orb -----------------------------------------------------
  const listening = await state('LISTENING', 'lifecycle check');
  check('activity can be requested (development build)', listening && listening.accepted === true, JSON.stringify(listening));
  check('the orb comes on screen', await until(() => overlay.isVisible(), 3_000));
  check('the orb does not take focus from the user’s application', !overlay.isFocused());
  const bounds = overlay.getBounds();
  check(
    "the overlay covers a display's work area, so the orb sits above the taskbar",
    screen.getAllDisplays().some((d) => d.workArea.x === bounds.x && d.workArea.y === bounds.y && d.workArea.width === bounds.width && d.workArea.height === bounds.height),
    JSON.stringify(bounds),
  );
  await wait(900);
  const look = await inOverlay(`(() => {
    const orb = document.querySelector('.dock-orb').getBoundingClientRect();
    const left = getComputedStyle(document.querySelector('.aura-left'));
    const right = getComputedStyle(document.querySelector('.aura-right'));
    return {
      entered: document.querySelector('.overlay').classList.contains('phase-enter'),
      cx: orb.left + orb.width / 2, fromBottom: window.innerHeight - orb.bottom, width: window.innerWidth, size: orb.width,
      leftOpacity: Number(left.opacity), rightOpacity: Number(right.opacity),
      leftImage: left.backgroundImage, rightImage: right.backgroundImage,
      caption: document.querySelector('.dock-caption[role="status"]')?.textContent ?? '',
    };
  })()`);
  check('the page was told to materialise', look.entered);
  check('the orb is centred', Math.abs(look.cx - look.width / 2) <= 2, `${Math.round(look.cx)} of ${look.width}`);
  check('the orb is at the bottom', look.fromBottom >= 8 && look.fromBottom <= 60, `${Math.round(look.fromBottom)}px up`);
  check('the orb is small (60–90 px)', look.size >= 60 && look.size <= 90, `${Math.round(look.size)}px`);
  check('both side auras are lit', look.leftOpacity > 0.3 && look.rightOpacity > 0.3, `${look.leftOpacity.toFixed(2)} / ${look.rightOpacity.toFixed(2)}`);
  check('the auras take the listening colour', look.leftImage.includes('74, 150, 255') && look.rightImage.includes('74, 150, 255'));
  check('the caption says what Axon is doing', /Listening/.test(look.caption), look.caption);

  await state('THINKING', 'lifecycle check');
  await state('EXECUTING', 'Opening Calculator');
  await wait(800);
  const executing = await inOverlay(`[getComputedStyle(document.querySelector('.aura-left')).backgroundImage, document.querySelector('.dock-caption[role="status"]')?.textContent ?? '']`);
  check('the auras change colour with the orb', executing[0].includes('34, 206, 188'));
  check('the caption follows the task in plain words', /Opening Calculator/.test(executing[1]), executing[1]);
  await state('SPEAKING', 'lifecycle check');
  await state('IDLE', 'lifecycle check');
  check('the orb leaves once Axon is quiet', await until(() => !overlay.isVisible(), 7_000));

  // --- a second launch opens the panel; audio stays with the overlay --------------------
  app.emit('second-instance');
  const panel = await waitForWindow(/[?&]surface=panel/, 10_000);
  check('launching Axon again opens its panel', Boolean(panel));
  if (!panel) return;
  await waitForLoad(panel);
  await wait(2_500);
  const inPanel = (script) => panel.webContents.executeJavaScript(script, true);

  const counter = `(() => { window.__captureCommands = 0; window.axon.onCaptureCommand(() => { window.__captureCommands += 1; }); return true; })()`;
  await inPanel(counter);
  await inOverlay(counter);
  const start = await inPanel('window.axon.startListening()');
  check('the panel can ask Axon to listen', start.accepted === true, start.error ?? '');
  const opened = await until(async () => (await snapshot()).listening.active === true, 6_000);
  check('a listening session opened from the panel’s request', opened);
  await wait(1_500);
  await inPanel('window.axon.stopListening()');
  await wait(1_500);
  const panelCommands = await inPanel('window.__captureCommands');
  const overlayCommands = await inOverlay('window.__captureCommands');
  check('capture commands reach only the voice surface', panelCommands === 0 && overlayCommands > 0, `panel ${panelCommands}, overlay ${overlayCommands}`);
  await until(async () => (await snapshot()).state === 'IDLE', 10_000);
  await until(() => !overlay.isVisible(), 8_000);

  // --- start with Windows ------------------------------------------------------------
  const original = await inPanel('window.axon.getStartup()');
  const originalValue = readRunValue();
  check('Windows reports whether Axon starts at sign-in', original.available === true, original.reason ?? `enabled=${original.enabled}`);
  if (original.available) {
    const on = await inPanel('window.axon.setStartup(true)');
    const value = readRunValue();
    check('turning it on registers a per-user sign-in entry (HKCU\\…\\Run)', on.enabled === true && value !== null, value ?? 'no entry');
    check('the entry starts Axon in the background', Boolean(value && /--background/.test(value)));
    check('the entry names this build’s executable', Boolean(value && value.toLowerCase().includes(path.basename(process.execPath).toLowerCase())));
    const off = await inPanel('window.axon.setStartup(false)');
    check('turning it off removes the entry', off.enabled === false && readRunValue() === null);
    if (original.enabled) await inPanel('window.axon.setStartup(true)');
    const restored = await inPanel('window.axon.getStartup()');
    check('the original setting is restored', restored.enabled === original.enabled && (readRunValue() === null) === (originalValue === null));
  }

  // --- closing the UI does not stop the wake service ------------------------------------
  panel.close();
  await wait(2_000);
  check('closing the panel closes only the panel', panel.isDestroyed() && !overlay.isDestroyed());
  check('Axon is still running with no window', !overlay.isDestroyed() && findWindow(/[?&]surface=panel/) === null);
  check(
    'the wake word is still armed after the UI is closed',
    await until(async () => (await snapshot()).voiceAgent.armed === true, 8_000),
  );
  const closedAt = Date.now();
  check(
    'microphone audio still reaches the detector after the UI is closed',
    await until(() => wakeLines.some((e) => e.at > closedAt && /microphone level/.test(e.line)), 12_000),
  );
  check(
    'and the detector is still the spotter, still unrestarted',
    await (async () => {
      const after = (await snapshot()).voiceAgent.wake;
      return after.engine === 'keyword-spotter' && after.starvedOfAudio === false && after.restarts === 0;
    })(),
  );
  await state('LISTENING', 'lifecycle check');
  check('the orb comes back with no window open', await until(() => overlay.isVisible(), 3_000));
  await state('IDLE', 'lifecycle check');
  check('and leaves again', await until(() => !overlay.isVisible(), 7_000));

  // --- late events after windows are destroyed ------------------------------------------
  // LAST, because it destroys the voice surface. Every one of these used to be
  // able to read `overlay.webContents` on a destroyed BrowserWindow.
  app.emit('second-instance');
  const survivor = await waitForWindow(/[?&]surface=panel/, 10_000);
  check('a panel is available to drive late events from', Boolean(survivor));
  if (!survivor) return;
  await waitForLoad(survivor);
  await wait(2_000);
  const inSurvivor = (script) => survivor.webContents.executeJavaScript(script, true);
  const deadContents = overlay.webContents;
  const frame = () => ({ captureId: 'late-capture', samples: new Int16Array(160) });
  const late = (sender) => {
    const event = { sender };
    ipcMain.emit('axon:listen:audio', event, frame());
    ipcMain.emit('axon:listen:diagnostics', event, { captureId: 'late-capture' });
    ipcMain.emit('axon:overlay:interactive', event, true);
  };
  const before = uncaught.length;

  // A session in flight: activity, so presence timers and capture commands are live.
  await inSurvivor('window.axon.requestState("LISTENING", "lifecycle race")');
  await wait(300);
  overlay.destroy();
  // Same tick as the destroy, before the `closed` handler can clear main's reference.
  late(deadContents);
  check('a late frame in the same tick as the overlay is destroyed does not crash main', uncaught.length === before, uncaught.slice(before).join(' | '));
  await wait(500);
  // After `closed`: session teardown, cancellation, completion — all emit toward the dead surface.
  late(deadContents);
  await inSurvivor('window.axon.requestState("IDLE", "lifecycle race")').catch(() => null);
  const listen = await inSurvivor('window.axon.startListening()').catch(() => null);
  await wait(400);
  await inSurvivor('window.axon.stopListening()').catch(() => null);
  await inSurvivor('window.axon.cancelSpeech ? window.axon.cancelSpeech() : null').catch(() => null);
  await wait(1_500);
  check('late session, cancel and completion events after the overlay is gone do not crash main', uncaught.length === before, uncaught.slice(before).join(' | '));
  check('main still answers after the voice surface is destroyed', (await inSurvivor('window.axon.getSnapshot()').catch(() => null)) !== null, listen ? `listen: ${listen.accepted}` : '');

  // A renderer reload of the surviving window, with events arriving during it.
  survivor.webContents.reload();
  late(survivor.webContents);
  await waitForLoad(survivor);
  await wait(1_000);
  // And the panel destroyed with a late event right behind it.
  const panelContents = survivor.webContents;
  survivor.destroy();
  late(panelContents);
  await wait(800);
  check('renderer reload and panel destruction with late events do not crash main', uncaught.length === before, uncaught.slice(before).join(' | '));
}

function finish(sandbox) {
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  for (const open of BrowserWindow.getAllWindows()) open.destroy();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(
  () => {
    main().catch((error) => {
      console.error('\nLifecycle verification crashed:', error);
      app.exit(1);
    });
  },
  () => app.exit(1),
);
