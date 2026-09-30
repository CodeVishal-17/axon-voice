/**
 * Real voice-input verification, against the real application.
 *
 * `verify-tools.cjs` drives the main process. It proved the recognizer, the
 * voice activity detector and the transcript path against real audio, but it
 * has no window, so it could not touch the one stage that exists only in a
 * renderer: the microphone itself.
 *
 * This harness closes that gap by starting AXON ITSELF — it requires the real
 * main entry point, so the real security hooks, the real permission handler,
 * the real Content-Security-Policy, the real preload bridge and the real
 * window are all the ones under test. Nothing is reconstructed. It then drives
 * the running app through `executeJavaScript`, exactly as a user's clicks
 * would, and observes through the same event stream the UI renders from.
 *
 * What it asserts:
 *   - the sandboxed page has no Node, no `require`, no `ipcRenderer`;
 *   - `getUserMedia` is REFUSED when Axon is not listening;
 *   - a camera is refused outright;
 *   - a real microphone opens when main opens a session, real frames cross the
 *     real IPC channel, and the voice activity detector closes the session on
 *     its own when nobody speaks;
 *   - the microphone is refused again the moment the session is over;
 *   - no raw audio appears anywhere in the event stream the renderer receives.
 *
 *   npm run verify:voice
 *
 * WHAT IT CANNOT DO: nobody speaks into the microphone. It verifies that real
 * capture runs, that real frames flow, and that silence is handled correctly.
 * Verifying that a spoken sentence becomes the right transcript needs a person
 * — the demo script in README.md is how that is checked, and the recognizer
 * itself is verified against real speech in `verify-tools.cjs`.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const checks = [];
let failed = 0;

/**
 * True when the microphone probe could not run.
 *
 * A run that skipped the capture probe still exercises every other property,
 * and its error path is worth verifying — but it is a WEAKER result, and a
 * plain "N/N checks passed" would present it as an equal one. The summary says
 * so explicitly instead.
 */
let degraded = false;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** When the harness last saw a listening session close. See the reload check. */
let listeningClosedAt = 0;

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  // Isolate everything from the user's real Axon home, before the app reads it.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-voice-verify-'));
  process.env.AXON_HOME = sandbox;

  console.log('\nAxon voice-input verification (the real app, a real microphone)\n');

  // Start Axon. This is the shipping entry point: it installs the security
  // hooks, builds the runtime, registers the hotkey, installs the bridge and
  // opens the window. Nothing below reconstructs any of it.
  require(path.join(outDir, 'index.js'));

  const window = await waitForWindow();
  if (!window) {
    console.error('The app did not open a window.');
    app.exit(1);
    return;
  }
  await waitForLoad(window);
  // The renderer mounts, fetches its snapshot and subscribes.
  await wait(2_000);

  const run = (script) => window.webContents.executeJavaScript(script, true);

  // Collect events on the RENDERER side: this is the same stream the UI draws
  // from, so anything asserted about it is a property of what the user's
  // window actually received.
  await run(`(() => {
    window.__probe = [];
    window.__probeOff = window.axon.onEvent((event) => window.__probe.push(event));
    return true;
  })()`);

  // --- the sandbox holds ---------------------------------------------------
  const escapes = await run(`(() => ({
    require: typeof require,
    process: typeof process,
    module: typeof module,
    Buffer: typeof Buffer,
    ipcRenderer: typeof window.ipcRenderer,
    axon: typeof window.axon,
    keys: window.axon ? Object.keys(window.axon).sort() : [],
  }))()`);

  check('the page has no require', escapes.require === 'undefined');
  check('the page has no process', escapes.process === 'undefined');
  check('the page has no Buffer', escapes.Buffer === 'undefined');
  check('the page has no module', escapes.module === 'undefined');
  check('the page has no raw ipcRenderer', escapes.ipcRenderer === 'undefined');
  check('the bridge is installed', escapes.axon === 'object');

  // The complete bridge surface, grouped by what it is for. An exact list, not
  // a count: a member appearing here that nobody meant to add is precisely
  // what this check exists to catch, and updating it is meant to be a
  // deliberate act.
  const EXPECTED_SURFACE = [
    // core
    'getSnapshot',
    'invokeTool',
    'listTools',
    'onEvent',
    'requestState',
    'resolveApproval',
    'sendMessage',
    // speech
    'cancelSpeech',
    'onSpeech',
    'onSpeechStop',
    'reportSpeech',
    // listening
    'onCaptureCommand',
    'reportCapture',
    // Numeric capture diagnostics: format, timing and loudness numbers, no
    // audio, no reply, dropped by main unless a debug build asked for them.
    'reportCaptureDiagnostics',
    'sendAudioFrame',
    'startListening',
    'stopListening',
    // voice agent: one inbound audio stream, two verbs, and nothing that
    // names a provider, an endpoint, a model or a credential.
    'onSpeechChunk',
    'startVoiceSession',
    'stopVoiceSession',
    // persistence: conversations, memory, settings, profile
    'clearMemories',
    'createSession',
    'deleteMemory',
    'deleteSession',
    'getSettings',
    'listMemories',
    'listSessions',
    'renameSession',
    'resetSettings',
    'selectSession',
    'setMemoryEnabled',
    'updateProfile',
    'updateSettings',
    // appearance: one of two words, recolours the native frame only
    'setAppearance',
    // overlay and startup: an animation cue in, one boolean out, and a per-user
    // sign-in toggle that main applies
    'getStartup',
    'onOverlayPhase',
    'setOverlayInteractive',
    'setStartup',
  ];
  check(
    'the bridge exposes exactly the audited surface',
    escapes.keys.join(',') === [...EXPECTED_SURFACE].sort().join(','),
    escapes.keys.join(', '),
  );

  const status = await run(`window.axon.getSnapshot().then((s) => s.listening)`);
  check('the app reports whether it can listen', typeof status.available === 'boolean', `${status.name} available=${status.available}`);
  check('the listening status carries no credential', !/sk-ant|apiKey|secret|password/i.test(JSON.stringify(status)));

  // --- the microphone is refused when Axon is not listening ---------------
  const before = await run(`window.axon.getSnapshot().then((s) => s.state)`);
  check('Axon starts idle', before === 'IDLE', before);

  const uninvited = await run(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks().length;
      stream.getTracks().forEach((t) => t.stop());
      return { opened: true, tracks };
    } catch (error) {
      return { opened: false, name: error.name };
    }
  })()`);
  check(
    'page code cannot open the microphone on its own',
    uninvited.opened === false,
    uninvited.opened ? `IT OPENED ${uninvited.tracks} TRACK(S)` : uninvited.name,
  );

  const camera = await run(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      return { opened: true };
    } catch (error) {
      return { opened: false, name: error.name };
    }
  })()`);
  check('page code cannot open a camera', camera.opened === false, camera.name);

  // --- a real listening session, driven the way the UI drives it -----------
  const startResult = await run(`window.axon.startListening()`);

  if (!status.available) {
    degraded = true;
    check('an unavailable recognizer refuses politely', startResult.accepted === false, startResult.error);
    console.log('\n  NOTE: no speech recognizer on this machine; the capture probe was skipped.\n');
  } else {
    check('the app accepted the request to listen', startResult.accepted === true, startResult.error ?? '');

    await wait(1_500);
    let listeningState = await run(`window.axon.getSnapshot().then((s) => s.state)`);
    check('Axon entered LISTENING', listeningState === 'LISTENING', listeningState);

    // Real permission decision, real device open, real frames.
    await wait(2_000);

    let probe = await run(`window.__probe.map((e) => ({ type: e.type, to: e.to, message: e.message, summary: e.summary }))`);
    let failure = probe.find((e) => e.type === 'ERROR');

    if (failure) {
      // Opening a capture device immediately after another process released it
      // can fail transiently, which is a property of the machine rather than
      // of Axon. Retry once before concluding there is no microphone — a
      // harness that reports "no microphone" for a busy one would quietly stop
      // testing the thing it exists to test.
      console.log(`  (first capture attempt failed: "${failure.message}" — retrying once)`);
      await wait(3_000);
      await run(`(() => { window.__probe.length = 0; return true; })()`);
      // No state reset needed, and deliberately none attempted: a failed
      // capture leaves Axon in ERROR, and asking to listen is itself the
      // documented recovery from ERROR. Reaching for the dev-console state
      // affordance here would test a path the product does not take.
      await run(`window.axon.startListening()`);
      await wait(3_500);

      listeningState = await run(`window.axon.getSnapshot().then((s) => s.state)`);
      probe = await run(`window.__probe.map((e) => ({ type: e.type, to: e.to, message: e.message, summary: e.summary }))`);
      failure = probe.find((e) => e.type === 'ERROR');
    }

    if (failure) {
      degraded = true;
      // A machine with no usable microphone is a legitimate configuration, and
      // the error path is worth verifying — but say so loudly rather than
      // reporting a pass that means nothing.
      console.log(`\n  NOTE: no usable microphone on this machine.`);
      console.log(`  "${failure.message}"\n`);
      check('a microphone failure is a sentence, not a device string', !/[A-Za-z]:\\/.test(failure.message), failure.message);
      check('a failed capture leaves no session open', (await run(`window.axon.getSnapshot().then((s) => s.listening.active)`)) === false);
    } else {
      check('a real microphone opened and stayed open', listeningState === 'LISTENING');

      // Nobody is talking. This is the accidental-activation path, and it has
      // to close itself — from the audio, not from a fixed timer.
      //
      // Polled rather than sampled once: the timeout is six seconds of AUDIO,
      // and on a loaded machine six seconds of audio takes longer than six
      // seconds of wall clock to arrive. Sampling at a fixed moment would make
      // this check fail for a reason that has nothing to do with the property
      // it is testing.
      const closed = await until(
        async () => (await run(`window.axon.getSnapshot().then((s) => s.listening.active)`)) === false,
        20_000,
      );
      if (closed) listeningClosedAt = Date.now();

      const after = await run(`window.axon.getSnapshot().then((s) => ({ state: s.state, active: s.listening.active }))`);
      check('the session closed itself when nothing was said', closed && after.active === false);
      check('Axon returned to IDLE', after.state === 'IDLE', after.state);

      // Either explanation is a correct outcome, and which one you get depends
      // on the room rather than on the code. Silence gives "didn't hear
      // anything". A room with enough noise to trip the detector gives
      // "didn't catch that", because the recognizer was handed some audio and
      // found no words in it — which is exactly what should happen, and is why
      // this check accepts both rather than demanding the quiet-room one.
      const saidSo = await until(async () => {
        const probe = await run(`window.__probe.map((e) => ({ type: e.type, summary: e.summary }))`);
        return probe.some((e) => e.type === 'OBSERVATION' && /didn't hear|didn't catch/i.test(e.summary ?? ''));
      }, 8_000);

      const finalProbe = await run(`window.__probe.map((e) => ({ type: e.type, message: e.message, summary: e.summary }))`);
      const explanation = finalProbe.find(
        (e) => e.type === 'OBSERVATION' && /didn't hear|didn't catch/i.test(e.summary ?? ''),
      );

      // A THIRD correct outcome, added when the wake word arrived.
      //
      // This check is about the SESSION: that it closes itself and accounts
      // for what happened, rather than ending silently or hanging. There are
      // three ways for it to do that, and which one you get depends entirely
      // on the room:
      //
      //   silence          -> "didn't hear anything"
      //   noise, no words  -> "didn't catch that"
      //   actual speech    -> a transcript, and a turn
      //
      // The third was previously treated as a failure, which was wrong: a
      // recognizer that transcribed real speech from a real microphone is the
      // subsystem working perfectly. It became common once Axon started
      // listening for its name, because a machine that is always listening is
      // a machine that eventually hears somebody talking.
      //
      // Note what is NOT accepted: an ERROR from the listening subsystem
      // itself. The ERROR that follows a transcript here comes from the brain
      // being unconfigured in this harness, which is a different subsystem and
      // is asserted separately below.
      const transcribed = finalProbe.some((e) => e.type === 'OBSERVATION' && /Heard you in/i.test(e.summary ?? ''));
      const listeningError = finalProbe.some(
        (e) => e.type === 'ERROR' && /microphone|audio|listen|recognizer/i.test(e.message ?? ''),
      );

      check(
        'it accounted for the session, without a listening failure',
        (saidSo || transcribed) && !listeningError,
        explanation
          ? explanation.summary
          : finalProbe.map((e) => `${e.type}${e.summary ? `: ${e.summary}` : ''}`).join(' | '),
      );
      // Had no frames arrived, main's no-audio timer would have fired with a
      // different message — so this passing means real audio really crossed
      // the real IPC channel from a real device.
      check(
        'real audio frames crossed the IPC boundary',
        !finalProbe.some((e) => e.type === 'ERROR' && /did not receive any audio/i.test(e.message ?? '')),
      );
    }

    // --- the microphone is released -------------------------------------
    const afterSession = await run(`(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return { opened: true };
      } catch (error) {
        return { opened: false, name: error.name };
      }
    })()`);
    check(
      'the microphone is refused again once the session is over',
      afterSession.opened === false,
      afterSession.opened ? 'IT OPENED' : afterSession.name,
    );
  }

  // --- nothing raw leaked --------------------------------------------------
  const stream = await run(`JSON.stringify(window.__probe)`);
  check('no raw audio reached the renderer event stream', !/"samples"|"pcm"|"frames"/i.test(stream));
  check('no event carries an audio-shaped payload', !/"0":\s*-?\d+,\s*"1":/.test(stream));
  check('the renderer received a real event stream, so that was not vacuous', JSON.parse(stream).length > 0, `${JSON.parse(stream).length} events`);

  const logPath = path.join(sandbox, 'logs', 'events.jsonl');
  const logLines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
  check('the JSONL log was written', logLines.length > 0, `${logLines.length} lines`);
  check('no log line contains audio', !logLines.some((line) => /"samples"|"pcm"/i.test(line)));

  // --- the window reloads mid-session ---------------------------------------
  // A reload destroys every microphone stream the page held without the page
  // getting to say so. Main must notice, end what the page was holding, and
  // come back ready: the orb must not sit on LISTENING with no audio, and the
  // wake word must not stay "armed" and deaf.
  if (status.available && !degraded) {
    const before = await run(`window.axon.getSnapshot().then((s) => ({ armed: s.voiceAgent.armed }))`);
    // From a quiet Axon. The session above may have heard real speech in the
    // room and started a turn; asking to listen while that turn is finishing
    // is refused — correctly — and would test the refusal, not the reload.
    await until(async () => (await run(`window.axon.getSnapshot().then((s) => s.busy)`)) === false, 20_000);
    // And past the listening service's restart cooldown (300 ms after a session
    // ends). A request inside it is refused on purpose — no person asks again
    // that fast — so making one would test the cooldown, not the reload. The
    // steps above can now finish inside that window, which is how this check
    // came to fail for a reason unrelated to reloading.
    const sinceClosed = listeningClosedAt === 0 ? null : Date.now() - listeningClosedAt;
    if (sinceClosed !== null && sinceClosed < 500) await wait(500 - sinceClosed);
    const again = await run(`window.axon.startListening()`);
    // Established, not assumed: the property is about a session that WAS
    // open, so wait until one is before reloading.
    const listeningBefore = await until(
      async () => (await run(`window.axon.getSnapshot().then((s) => s.listening.active)`)) === true,
      6_000,
    );
    check(
      'a listening session was open before the reload',
      listeningBefore,
      `startListening: ${again.accepted ? 'accepted' : `refused (${again.error ?? 'no reason'})`}; ${sinceClosed ?? 'n/a'}ms after the last session closed`,
    );

    window.webContents.reload();
    await wait(500);
    await waitForLoad(window);
    await wait(2_500);

    const afterReload = await run(`window.axon.getSnapshot().then((s) => ({ state: s.state, active: s.listening.active, armed: s.voiceAgent.armed }))`);
    check(
      'a reload ends the listening session the page was holding',
      listeningBefore && afterReload.active === false,
      `after: active=${afterReload.active}`,
    );
    check('the orb does not stay on LISTENING after a reload', afterReload.state !== 'LISTENING', afterReload.state);

    if (before.armed) {
      const rearmed = await until(
        async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.armed)`)) === true,
        10_000,
      );
      check('the wake word is listening again after the reload', rearmed);
    }

    // And the next ordinary request works without restarting anything.
    const next = await run(`window.axon.startListening()`);
    check('listening works again after the reload, with no restart', next.accepted === true, next.error ?? '');
    await wait(1_500);
    await run(`window.axon.stopListening()`);
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (degraded) {
    console.log(
      'DEGRADED: the microphone probe did not run, so real capture was NOT verified on this run.\n' +
        '          Everything above still holds, but the capture path was exercised only through\n' +
        '          its failure branch. Re-run with a working microphone for the full result.',
    );
  }

  for (const open of BrowserWindow.getAllWindows()) open.destroy();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // The log stream may still hold a handle; the temp directory is disposable.
  }
  app.exit(failed === 0 ? 0 : 1);
}

/**
 * Poll an asynchronous condition until it holds, or the deadline passes.
 *
 * Used for anything whose timing depends on audio arriving: those limits are
 * expressed in milliseconds of audio, and on a loaded machine that is not the
 * same as milliseconds of wall clock.
 */
async function until(condition, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await wait(250);
  }
}

function waitForWindow(timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      // The overlay is the voice surface: the one page main sends capture
      // commands and speech to, and accepts microphone audio from.
      const first = BrowserWindow.getAllWindows().find((w) => /[?&]surface=overlay/.test(w.webContents.getURL()));
      if (first) return resolve(first);
      if (Date.now() - startedAt > timeoutMs) return resolve(null);
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForLoad(window) {
  if (!window.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    window.webContents.once('did-finish-load', resolve);
    setTimeout(resolve, 15_000);
  });
}

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
