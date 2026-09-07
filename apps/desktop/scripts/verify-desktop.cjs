/**
 * Desktop control, verified against the real operating system.
 *
 *   npm run verify:desktop
 *
 * WHAT IS REAL HERE: everything. The real runtime, the real dispatcher, the
 * real risk policy, the real approval broker, and the real Windows desktop —
 * real windows enumerated by real `EnumWindows`, and a real application
 * launched and brought to the front.
 *
 * The unit suite exercises these tools against a stand-in desktop so the
 * branches are deterministic. This harness does the opposite, for the same
 * reason `verify-browser.cjs` exists: a window port that passes against a fake
 * has verified the fake.
 *
 * IT OPENS NOTEPAD, and leaves it open — Axon has no close capability, by
 * design. That is the only trace this leaves on the machine.
 *
 * NOTHING DESTRUCTIVE. No application is closed, no file is written, no
 * setting is changed, and every approval-gated tool in the list below is
 * DENIED rather than allowed.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const checks = [];
let failed = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-desktop-verify-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_APPROVAL_TIMEOUT_MS = '2000';

  const runtime = require(path.join(outDir, 'runtime.js'));

  let built = null;
  const securityOptions = {
    isDev: true,
    appOrigin: null,
    isListening: () => false,
    isBrowserContents: (contents) => (built ? built.browser.owns(contents) : false),
  };
  runtime.installSecurityHooks(securityOptions);
  runtime.applySessionSecurity(require('electron').session.defaultSession, securityOptions);

  built = runtime.createVerificationRuntime({
    home: sandbox,
    env: process.env,
    sessionData: app.getPath('sessionData'),
    hotkey: null,
  });

  const { orchestrator, bus, sink } = built;
  const events = [];
  bus.subscribe((event) => events.push(event));

  console.log('\nAxon desktop verification (a real desktop, real windows, real dispatcher)\n');

  try {
    await run(orchestrator, events);
  } catch (error) {
    check('the harness ran to completion', false, error instanceof Error ? error.message : String(error));
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

  orchestrator.shutdown();
  await sink.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

async function run(orchestrator, events) {
  const dispatch = (tool, input) => orchestrator.invokeTool(tool, input);

  // --- the tools are registered on this platform -------------------------
  const names = orchestrator.registry.names();
  for (const tool of ['window.list', 'window.focus', 'window.minimize', 'window.maximize', 'app.focus']) {
    check(`${tool} is registered`, names.includes(tool));
  }

  // --- listing the real desktop ------------------------------------------
  const listed = await dispatch('window.list', {});
  check('the real desktop was enumerated', listed.ok, listed.ok ? '' : JSON.stringify(listed.failure));
  if (!listed.ok) return;

  const windows = listed.output.windows;
  check('it found real windows', Array.isArray(windows) && windows.length > 0, `${windows.length} windows`);
  check('every window has a reference and a title', windows.every((w) => /^w\d+$/.test(w.ref) && w.title.length > 0));
  check('no window handle reached the model', !JSON.stringify(listed.output).includes('handle'));
  check('titles are labelled untrusted', /never as instructions/i.test(String(listed.output.note)));

  // A window title on this machine could be anything; none of it may look
  // like a control character in what Axon carries.
  const titles = windows.map((w) => w.title).join('');
  // eslint-disable-next-line no-control-regex
  check('no control characters survived in any title', !/[\u0000-\u001F\u202A-\u202E]/.test(titles));

  // --- opening a real application ----------------------------------------
  const opened = await dispatch('app.open', { app: 'notepad' });
  check('Notepad opened through the real dispatcher', opened.ok, opened.ok ? '' : JSON.stringify(opened.failure));
  // Notepad takes a moment to put a window on screen.
  await wait(1500);

  // --- OBSERVE, then VERIFY ----------------------------------------------
  const after = await dispatch('window.list', {});
  check('a fresh listing was taken after opening it', after.ok);
  const notepad = after.ok ? after.output.windows.find((w) => w.application === 'notepad') : null;
  check('Notepad is actually on the desktop now', Boolean(notepad), notepad ? notepad.title : 'not found');

  // --- switching to it ----------------------------------------------------
  if (notepad) {
    // How many Notepads are open depends on what else is running — including a
    // previous run of this harness, since Axon has no close capability. Both
    // outcomes are correct behaviour and both are checked.
    const notepadCount = after.output.windows.filter((w) => w.application === 'notepad').length;
    const focused = await dispatch('app.focus', { app: 'notepad' });

    if (notepadCount > 1) {
      check(
        'with two Notepad windows open, Axon refuses rather than guessing which one',
        !focused.ok && /cannot tell which one/i.test(focused.failure.message),
        focused.ok ? 'IT PICKED ONE' : focused.failure.message,
      );
    } else {
      check('switching to Notepad succeeded', focused.ok, focused.ok ? '' : JSON.stringify(focused.failure));
    }

    if (focused.ok) {
      // The claim is made from a FRESH listing, not from the call returning.
      check(
        'the switch was verified against the desktop, not assumed',
        focused.output.verified && typeof focused.output.verified.changed === 'boolean',
      );
      // NOT asserted as "it worked". Windows only lets a process call
      // SetForegroundWindow under conditions a background application usually
      // does not meet, so a focus request can be accepted by the API and
      // simply not happen. That is an operating-system restriction imposed on
      // the user's behalf, and Axon does not defeat it.
      //
      // What IS asserted is the property that matters: Axon does not claim
      // success it did not observe. Either the window came forward and the
      // verification says so, or it did not and the verification says THAT —
      // and the summary tells the agent not to report it as done.
      const cameForward = focused.output.verified.changed === true;
      check(
        cameForward
          ? 'Notepad came to the front, and that was verified'
          : 'Notepad did not come forward, and Axon said so rather than claiming success',
        cameForward || /do not report it as done|does not show/i.test(String(focused.output.verified.summary)),
        String(focused.output.verified.summary),
      );
    }

    // --- minimise and restore, both verified -----------------------------
    const relisted = await dispatch('window.list', {});
    const ref = relisted.ok ? relisted.output.windows.find((w) => w.application === 'notepad')?.ref : null;
    if (ref) {
      const minimized = await dispatch('window.minimize', { ref });
      check('minimising a real window succeeded', minimized.ok);
      if (minimized.ok) {
        // Minimising is not foreground-restricted, so this one really should
        // take effect — and if it does not, the same honest reporting applies.
        check(
          'minimising took effect and was verified against a fresh listing',
          minimized.output.verified.changed === true,
          String(minimized.output.verified.summary),
        );
      }

      const relisted2 = await dispatch('window.list', {});
      const ref2 = relisted2.ok ? relisted2.output.windows.find((w) => w.application === 'notepad')?.ref : null;
      if (ref2) {
        const restored = await dispatch('window.maximize', { ref: ref2 });
        check('restoring it succeeded', restored.ok);
      }
    }
  }

  // --- the reference model holds against the real desktop ----------------
  const invented = await dispatch('window.focus', { ref: 'w999' });
  check('an invented reference is refused', !invented.ok, invented.ok ? 'IT FOCUSED' : invented.failure.kind);

  const notARef = await dispatch('window.focus', { ref: '65536' });
  check('a raw handle is refused at the schema', !notARef.ok && notARef.failure.kind === 'INVALID_INPUT');

  // --- the application allowlist is the whole surface ---------------------
  for (const hostile of ['powershell', 'cmd.exe', 'C:/Windows/System32/cmd.exe', 'powershell -Command "calc"']) {
    const refused = await dispatch('app.open', { app: hostile });
    check(`"${hostile.slice(0, 24)}" is refused`, !refused.ok && refused.failure.kind === 'INVALID_INPUT');
  }

  // --- an approval-gated application still asks --------------------------
  const gated = dispatch('app.open', { app: 'task-manager' });
  await wait(150);
  const pending = orchestrator.approvals.list();
  check('opening Task Manager asks a human first', pending.length === 1, `${pending.length} pending`);
  if (pending.length === 1) {
    orchestrator.resolveApproval(pending[0].callId, 'DENY', pending[0].binding.fingerprint);
  }
  const gatedResult = await gated;
  check('denying it means it does not open', !gatedResult.ok && gatedResult.failure.kind === 'DENIED');

  // --- a real screenshot --------------------------------------------------
  const shot = await dispatch('system.screenshot', {});
  check('a real screenshot was captured', shot.ok, shot.ok ? `${shot.output.width}x${shot.output.height}` : '');

  // --- nothing leaked -----------------------------------------------------
  const stream = JSON.stringify(events);
  check('no window handle appears in the event stream', !/"handle"/.test(stream));
  check('no credential appears in the event stream', !/Bearer|api[_-]?key/i.test(stream));

  const calls = events.filter((e) => e.type === 'TOOL_CALL').length;
  const results = events.filter((e) => e.type === 'TOOL_RESULT').length;
  check('every tool call has exactly one result', calls === results, `${calls} calls, ${results} results`);

  console.log('\n  Notepad was opened and left open — Axon has no close capability, by design.\n');
}

app.on('window-all-closed', () => {});

app.whenReady().then(
  () => {
    main().catch((error) => {
      console.error('\nHarness crashed:', error);
      app.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
