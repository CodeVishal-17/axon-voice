/**
 * Visual QA for the desktop window, in the real app.
 *
 *   npm run ui:shots
 *
 * DEVELOPMENT ONLY. Launches the shipping entry point, walks the window through
 * its visible states in both themes, and saves a PNG of each to
 * `out/ui-shots/` (or AXON_UI_SHOTS_DIR). Alongside the pictures it checks the
 * things a picture cannot prove: that no internal name reaches the screen, that
 * every control has an accessible name, that a Deny click really denies, that
 * the theme survives a reload, and that a reload leaves Axon idle and listening
 * for its name again.
 *
 * HOW THE STATES ARE REACHED. Through the development-only `requestState` and
 * `invokeTool` calls, which main refuses in a packaged build. Only legal
 * transitions are requested. The approval is a real one — a real `fs.write`
 * outside the workspace, held by the real dispatcher — and it is DENIED, so no
 * file is written. No microphone audio is faked, and no voice session starts.
 *
 * The theme is kept in this app's own browser storage, which a development run
 * shares with your normal one, so the harness puts back whatever you had.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, screen } = require('electron');

const checks = [];
let failed = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What must never be on screen: tool names, ids, internal states, policy words. */
const LEAKS = [
  /\b(?:browser|app|fs|system|window|memory|ui|keyboard)\.[a-z][A-Za-z]+\b/,
  /\b(?:call|task|step)_[A-Za-z0-9]+/,
  /\b(?:WAITING_FOR_APPROVAL|EXECUTING|THINKING|LISTENING|SPEAKING)\b/,
  /\b(?:dispatcher|fingerprint|orchestrator|risk policy)\b/i,
  /\bat [\w.<>]+ \(.*:\d+:\d+\)/,
];

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not yet */
    }
    await wait(150);
  }
  return false;
}

async function waitForWindow() {
  // The panel: the full window. The overlay is walked separately, below.
  const find = () => BrowserWindow.getAllWindows().find((w) => /[?&]surface=panel/.test(w.webContents.getURL()));
  const found = await until(() => Boolean(find()), 20_000);
  return found ? find() : null;
}

function waitForLoad(window) {
  return new Promise((resolve) => {
    if (!window.webContents.isLoading()) resolve();
    else window.webContents.once('did-finish-load', () => resolve());
  });
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }
  const shotsDir = process.env.AXON_UI_SHOTS_DIR
    ? path.resolve(process.env.AXON_UI_SHOTS_DIR)
    : path.resolve(__dirname, '../out/ui-shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-ui-shots-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_APPROVAL_TIMEOUT_MS = '120000';

  require(path.join(outDir, 'index.js'));

  const window = await waitForWindow();
  if (!window) {
    console.error('The app did not open a window.');
    app.exit(1);
    return;
  }
  await waitForLoad(window);
  await wait(2_500);

  const run = (script) => window.webContents.executeJavaScript(script, true);
  const originalTheme = await run(`(() => { try { return localStorage.getItem('axon.theme'); } catch { return null; } })()`);

  console.log(`\nAxon window — visual QA (screenshots in ${shotsDir})\n`);

  try {
    await walk(window, run, shotsDir, sandbox);
  } catch (error) {
    check('the harness ran to completion', false, error instanceof Error ? error.stack : String(error));
  }

  // Put the viewer's own theme back.
  await run(`(() => {
    try {
      ${originalTheme === null ? `localStorage.removeItem('axon.theme');` : `localStorage.setItem('axon.theme', ${JSON.stringify(originalTheme)});`}
    } catch {}
    return true;
  })()`).catch(() => undefined);

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

async function walk(window, run, shotsDir, sandbox) {
  const shot = async (name, settleMs = 1_400) => {
    await wait(settleMs);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(shotsDir, `${name}.png`), image.toPNG());
  };
  const state = (to, reason) => run(`window.axon.requestState(${JSON.stringify(to)}, ${JSON.stringify(reason)})`);
  const snapshot = () => run('window.axon.getSnapshot()');
  const visibleText = () => run('document.body.innerText');
  const click = (selector) =>
    run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  const noLeaks = async (where) => {
    const text = await visibleText();
    const leak = LEAKS.map((pattern) => text.match(pattern)).find(Boolean);
    check(`${where}: no internal names on screen`, !leak, leak ? `found "${leak[0]}"` : '');
  };
  const headline = () => run(`document.querySelector('.presence-headline')?.textContent ?? ''`);
  const setThemeTo = async (theme) => {
    if ((await run('document.documentElement.dataset.theme')) !== theme) await click('.titlebar button[aria-label^="Switch to"]');
    await until(async () => (await run('document.documentElement.dataset.theme')) === theme, 3_000);
  };

  const themes = ['dark', 'light'];
  for (const theme of themes) {
    const current = await run('document.documentElement.dataset.theme');
    if (current !== theme) {
      check(`${theme}: the title bar toggle switches theme`, await click('.titlebar button[aria-label^="Switch to"]'));
      await until(async () => (await run('document.documentElement.dataset.theme')) === theme, 3_000);
    }
    check(`${theme}: theme applied to the document`, (await run('document.documentElement.dataset.theme')) === theme);

    // --- idle -------------------------------------------------------------
    await until(async () => (await snapshot()).voiceAgent.armed === true, 15_000);
    await shot(`${theme}-01-idle`);
    const idleText = await headline();
    check(`${theme}: idle invites the wake phrase or a click`, /Hey Axon|Ready/.test(idleText), idleText);
    await noLeaks(`${theme} idle`);

    // --- the conversational states, in a legal order --------------------------
    const beats = [
      ['LISTENING', 'ui check', '02-listening', /Listening/],
      ['THINKING', 'ui check', '03-thinking', /Thinking|Connecting/],
      ['EXECUTING', 'Opening YouTube', '04-executing', /Opening YouTube/],
      ['SPEAKING', 'ui check', '05-speaking', /Speaking/],
      ['IDLE', 'ui check', null, null],
      ['ERROR', 'ui check', '06-error', /Something went wrong/],
      ['IDLE', 'ui check', null, null],
    ];
    for (const [to, reason, name, expected] of beats) {
      const result = await state(to, reason);
      check(`${theme}: ${to} was a legal request`, result && result.accepted === true, JSON.stringify(result));
      if (!name) continue;
      await shot(`${theme}-${name}`);
      const text = await headline();
      check(`${theme}: ${to} reads as "${expected.source}"`, expected.test(text), text);
      const label = await run(`document.querySelector('.orb-button')?.getAttribute('aria-label') ?? ''`);
      check(`${theme}: the orb has a spoken label in ${to}`, label.length > 0, label);
      if (to === 'THINKING' || to === 'EXECUTING') {
        const inert = await run(`document.querySelector('.orb-button')?.disabled === true`);
        check(`${theme}: the orb does nothing while Axon is ${to.toLowerCase()}`, inert === true);
      }
      await noLeaks(`${theme} ${to}`);
    }

    // --- a real approval, denied ----------------------------------------------
    const target = path.join(os.tmpdir(), `axon-ui-shots-${theme}-${Date.now()}.txt`);
    await run(`(() => {
      window.__uiPending = window.axon.invokeTool('fs.write', { path: ${JSON.stringify(target)}, content: 'Axon UI check', overwrite: false });
      return true;
    })()`);
    const appeared = await until(async () => (await run(`Boolean(document.querySelector('.approval'))`)) === true, 10_000);
    check(`${theme}: a real approval request shows the card`, appeared);
    if (appeared) {
      await shot(`${theme}-07-approval`);
      const card = await run(`document.querySelector('.approval').innerText`);
      check(`${theme}: the card says approval is required`, /Action requires your approval/.test(card));
      check(`${theme}: the card offers Deny and Allow`, /Deny/.test(card) && /Allow/.test(card));
      const focusables = await run(`[...document.querySelectorAll('.approval button')].every((b) => b.tabIndex >= 0)`);
      check(`${theme}: approval buttons are keyboard reachable`, focusables === true);
      await noLeaks(`${theme} approval`);

      check(`${theme}: Deny is clickable`, await click('.approval .btn-deny'));
      const outcome = await run('window.__uiPending');
      check(`${theme}: Deny really denied the call`, outcome && outcome.ok === false, JSON.stringify(outcome?.failure ?? outcome));
      check(`${theme}: nothing was written`, !fs.existsSync(target));
      await until(async () => (await run(`Boolean(document.querySelector('.approval'))`)) === false, 5_000);
      await shot(`${theme}-08-after-denial`);
      const after = await snapshot();
      if (after.state !== 'IDLE') await state('IDLE', 'ui check').catch(() => undefined);
    }

    // --- settings --------------------------------------------------------------
    check(`${theme}: settings open`, await click('.titlebar button[aria-label="Settings"]'));
    await until(async () => (await run(`Boolean(document.querySelector('.settings'))`)) === true, 3_000);
    await shot(`${theme}-09-settings-appearance`, 600);
    await run(`[...document.querySelectorAll('.settings-tab')].find((t) => t.textContent === 'Wake word')?.click()`);
    await shot(`${theme}-10-settings-wake`, 600);
    const wakePage = await run(`document.querySelector('.settings-body')?.innerText ?? ''`);
    check(
      `${theme}: the wake word page states the privacy boundary`,
      wakePage.includes('Axon listens locally for your wake phrase. Audio is sent to the voice service only after activation.'),
    );
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    check(
      `${theme}: Escape closes settings`,
      await until(async () => (await run(`Boolean(document.querySelector('.settings'))`)) === false, 3_000),
    );

    // --- activity drawer ------------------------------------------------------------
    check(`${theme}: the developer activity drawer opens`, await click('.titlebar button[aria-label="Developer activity"]'));
    await shot(`${theme}-11-activity`, 700);
    await click('.titlebar button[aria-label="Developer activity"]');

    // --- accessibility basics -------------------------------------------------------
    const unnamed = await run(
      `[...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim())).length`,
    );
    check(`${theme}: every button has an accessible name`, unnamed === 0, `${unnamed} unnamed`);
    check(`${theme}: state is announced as text, not only by the orb`, await run(`Boolean(document.querySelector('.presence [role="status"]'))`));
  }

  // --- reload recovery (light theme is current) ------------------------------------------
  const armedBefore = (await snapshot()).voiceAgent.armed;
  window.webContents.reload();
  await waitForLoad(window);
  await wait(3_000);
  check('reload: the theme persisted', (await run('document.documentElement.dataset.theme')) === 'light');
  const afterReload = await snapshot();
  check('reload: Axon is idle', afterReload.state === 'IDLE', afterReload.state);
  check('reload: no voice session survived', afterReload.voiceAgent.active === false);
  if (armedBefore) {
    check(
      'reload: the wake word re-armed',
      await until(async () => (await snapshot()).voiceAgent.armed === true, 15_000),
    );
  }
  await shot('light-12-after-reload');

  // --- the overlay: the bottom-centre orb, the auras, the docked card ------------------
  const overlay = BrowserWindow.getAllWindows().find((w) => /[?&]surface=overlay/.test(w.webContents.getURL()));
  check('overlay: the voice surface exists', Boolean(overlay));
  if (overlay) {
    const inOverlay = (script) => overlay.webContents.executeJavaScript(script, true);
    const setTheme = async (theme) => {
      if ((await run('document.documentElement.dataset.theme')) !== theme) await click('.titlebar button[aria-label^="Switch to"]');
      await until(async () => (await run('document.documentElement.dataset.theme')) === theme, 3_000);
    };
    const overlayShot = async (name, settleMs = 1_100) => {
      await wait(settleMs);
      const { width, height } = overlay.getBounds();
      const screenImage = await overlay.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, `${name}-screen.png`), screenImage.resize({ width: 960 }).toPNG());
      const dock = await overlay.webContents.capturePage({
        x: Math.max(0, Math.round(width / 2 - 320)),
        y: Math.max(0, height - 440),
        width: Math.min(640, width),
        height: Math.min(440, height),
      });
      fs.writeFileSync(path.join(shotsDir, `${name}-dock.png`), dock.toPNG());
    };
    const overlayLeaks = async (where) => {
      const text = await inOverlay('document.body.innerText');
      const leak = LEAKS.map((pattern) => text.match(pattern)).find(Boolean);
      check(`${where}: no internal names on the overlay`, !leak, leak ? `found "${leak[0]}"` : '');
    };
    const aura = () => inOverlay(`(() => {
      const left = getComputedStyle(document.querySelector('.aura-left'));
      const right = getComputedStyle(document.querySelector('.aura-right'));
      return { left: left.backgroundImage, right: right.backgroundImage, leftOpacity: Number(left.opacity), rightOpacity: Number(right.opacity) };
    })()`);
    const captionText = () => inOverlay(`document.querySelector('.dock-caption[role="status"]')?.textContent ?? ''`);
    const COLOURS = { LISTENING: '74, 150, 255', THINKING: '150, 126, 255', EXECUTING: '34, 206, 188', SPEAKING: '96, 190, 255' };

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      check(
        `overlay ${theme}: the theme reaches the overlay too`,
        await until(async () => (await inOverlay('document.documentElement.dataset.theme')) === theme, 3_000),
      );
      // A stand-in desktop behind the transparent overlay, for the pictures only.
      await inOverlay(`(() => {
        document.documentElement.style.background = ${JSON.stringify(
          theme === 'dark'
            ? 'linear-gradient(135deg, #1c2a44 0%, #37304f 50%, #1d3a3b 100%)'
            : 'linear-gradient(135deg, #cddff6 0%, #f2dbe8 50%, #d7eee4 100%)',
        )};
        return true;
      })()`);

      const listening = await state('LISTENING', 'ui check');
      check(`overlay ${theme}: LISTENING was a legal request`, listening && listening.accepted === true);
      check(`overlay ${theme}: activity brings the orb on screen`, await until(async () => overlay.isVisible(), 3_000));
      check(`overlay ${theme}: the orb does not take focus`, !overlay.isFocused());
      const bounds = overlay.getBounds();
      check(
        `overlay ${theme}: it covers a display's work area`,
        screen.getAllDisplays().some((d) => d.workArea.x === bounds.x && d.workArea.y === bounds.y && d.workArea.width === bounds.width && d.workArea.height === bounds.height),
        JSON.stringify(bounds),
      );
      await wait(900);
      const geometry = await inOverlay(`(() => {
        const orb = document.querySelector('.dock-orb').getBoundingClientRect();
        return { cx: orb.left + orb.width / 2, fromBottom: window.innerHeight - orb.bottom, width: window.innerWidth, size: orb.width };
      })()`);
      check(`overlay ${theme}: the orb is centred`, Math.abs(geometry.cx - geometry.width / 2) <= 2, `${Math.round(geometry.cx)} of ${geometry.width}`);
      check(`overlay ${theme}: the orb sits at the bottom`, geometry.fromBottom >= 8 && geometry.fromBottom <= 60, `${Math.round(geometry.fromBottom)}px up`);
      check(`overlay ${theme}: the orb is small`, geometry.size >= 60 && geometry.size <= 90, `${Math.round(geometry.size)}px`);

      for (const [to, reason, expected] of [
        ['LISTENING', 'ui check', /Listening/],
        ['THINKING', 'ui check', /Thinking/],
        ['EXECUTING', 'Opening Calculator', /Opening Calculator/],
        ['SPEAKING', 'ui check', /Speaking/],
      ]) {
        if (to !== 'LISTENING') await state(to, reason);
        await wait(800);
        const light = await aura();
        check(
          `overlay ${theme}: both auras carry the ${to.toLowerCase()} colour`,
          light.left.includes(COLOURS[to]) && light.right.includes(COLOURS[to]) && light.leftOpacity > 0.3 && light.rightOpacity > 0.3,
          `${light.leftOpacity.toFixed(2)} / ${light.rightOpacity.toFixed(2)}`,
        );
        const caption = await captionText();
        check(`overlay ${theme}: ${to} reads as "${expected.source}"`, expected.test(caption), caption);
        await overlayShot(`overlay-${theme}-${to.toLowerCase()}`, 200);
        await overlayLeaks(`overlay ${theme} ${to}`);
      }

      await state('IDLE', 'ui check');
      check(`overlay ${theme}: the orb leaves once Axon is quiet`, await until(async () => !overlay.isVisible(), 7_000));

      // A real approval, docked beside the orb, denied from the overlay.
      const target = path.join(os.tmpdir(), `axon-ui-shots-overlay-${theme}-${Date.now()}.txt`);
      await run(`(() => {
        window.__overlayPending = window.axon.invokeTool('fs.write', { path: ${JSON.stringify(target)}, content: 'Axon overlay check', overwrite: false });
        return true;
      })()`);
      const docked = await until(async () => overlay.isVisible() && (await inOverlay(`Boolean(document.querySelector('.approval-docked'))`)), 10_000);
      check(`overlay ${theme}: a real approval docks beside the orb`, docked);
      if (docked) {
        await overlayShot(`overlay-${theme}-approval`);
        const card = await inOverlay(`document.querySelector('.approval-docked').innerText`);
        check(`overlay ${theme}: the docked card asks for approval`, /Action requires your approval/.test(card) && /Deny/.test(card) && /Allow/.test(card));
        check(`overlay ${theme}: the docked card has no scrim over the desktop`, !(await inOverlay(`Boolean(document.querySelector('.approval-scrim'))`)));
        await overlayLeaks(`overlay ${theme} approval`);
        await inOverlay(`document.querySelector('.approval-docked .btn-deny').click()`);
        const outcome = await run('window.__overlayPending');
        check(`overlay ${theme}: Deny from the overlay really denied`, outcome && outcome.ok === false, JSON.stringify(outcome?.failure ?? outcome));
        check(`overlay ${theme}: nothing was written`, !fs.existsSync(target));
        const after = await snapshot();
        if (after.state !== 'IDLE') await state('IDLE', 'ui check').catch(() => undefined);
        await until(async () => !overlay.isVisible(), 8_000);
      }

      // An error is shown by the linger after whatever failed, then the orb leaves.
      await state('LISTENING', 'ui check');
      await until(async () => overlay.isVisible(), 3_000);
      await state('ERROR', 'ui check');
      await overlayShot(`overlay-${theme}-error`, 700);
      check(`overlay ${theme}: the error reads plainly`, /Something went wrong/.test(await captionText()));
      await state('IDLE', 'ui check');
      check(`overlay ${theme}: after an error the orb still leaves`, await until(async () => !overlay.isVisible(), 7_000));

      const unnamed = await inOverlay(
        `[...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim())).length`,
      );
      check(`overlay ${theme}: every control has an accessible name`, unnamed === 0, `${unnamed} unnamed`);
      await inOverlay(`(() => { document.documentElement.style.background = ''; return true; })()`);
    }
  }

  // Back to dark, the default, for a final look.
  await setThemeTo('dark');
  await shot('dark-13-back-to-dark');
  void sandbox;
}

app.whenReady().then(main);
