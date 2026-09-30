/**
 * The wake word, on a REAL microphone.
 *
 *   npm run wake:live                 you speak each prompt
 *   npm run wake:live -- --loopback   the laptop speaks each prompt aloud,
 *                                     and the microphone hears it
 *   npm run wake:live -- --runs=10    every prompt ten times, with totals
 *   npm run wake:live -- --background Axon started as it is at sign-in: no
 *                                     window, and the orb must appear
 *   npm run wake:live -- --set=brief  only the six original prompts
 *   npm run wake:live -- --only=positive   just the wake phrases
 *   npm run wake:live -- --only=negative   just the things that must not wake
 *
 *   AXON_WAKE_FOCUS=hey_axon          FOCUS MODE: one phrase, ten utterances,
 *                                     and why each was or was not detected
 *                                     (see wake-focus.cjs)
 *
 * npm does not always forward flags through a workspace script, so each flag
 * also has an environment variable: AXON_WAKE_LIVE_LOOPBACK=1,
 * AXON_WAKE_LIVE_RUNS=10, AXON_WAKE_LIVE_BACKGROUND=1, AXON_WAKE_LIVE_SET,
 * AXON_WAKE_LIVE_ONLY.
 *
 * WHY THIS SCRIPT IS THE ONLY THING THAT COUNTS.
 *
 * The previous wake engine passed every unit test, passed a grammar test, and
 * passed a synthesised-voice run — and then scored 0/15 on a person speaking
 * into a real microphone. So this harness is not a formality at the end of the
 * work; it is the measurement the work exists to pass, and nothing else in the
 * repository may be cited as evidence that the wake word works.
 *
 * NOTHING IS FAKED. No audio is injected into the pipeline. This launches the
 * real Axon app — the shipping entry point, its real window, its real
 * microphone capture, its real local detector — with wake diagnostics on.
 *
 * --LOOPBACK CANNOT MEASURE RECALL, AND SAYS SO.
 *
 * In loopback the phrase is played through the speakers and has to cross the
 * room into the microphone. On hardware that cancels echo — which is most
 * laptops, and is this machine — that path does not survive. Axon opens the
 * microphone with `echoCancellation`, `noiseSuppression` and `autoGainControl`
 * on, and echo cancellation exists precisely to remove audio this machine is
 * playing. Measured: BOTH detectors scored 0/3 on loopback while the
 * microphone reported healthy levels, which is the signature of a cancelled
 * reference signal and not of a deaf detector.
 *
 * Those flags are not a bug and are not turned off for a test — they are why
 * Axon can hear you interrupt it while it is speaking. What follows is that
 * loopback is a SMOKE TEST: it proves the app starts, arms, captures and
 * reports, and its recall column is not evidence of anything. The report below
 * refuses to print a target line for it.
 *
 * PRIVACY. Before activation, audio goes only to the local detector. An
 * activation starts a real voice session exactly as the product does; the
 * harness ends it straight away. Nothing is recorded, and the diagnostics
 * printed below go to this terminal only.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

// An environment variable as well as a flag: npm does not reliably forward
// arguments through a workspace script, and a silently ignored flag turns a
// loopback run into prompts nobody answers.
const flag = (name, env) => process.argv.includes(name) || process.env[env] === '1';
const option = (name, env, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return (found ? found.slice(name.length + 1) : process.env[env]) ?? fallback;
};

const LOOPBACK = flag('--loopback', 'AXON_WAKE_LIVE_LOOPBACK');
const BACKGROUND = flag('--background', 'AXON_WAKE_LIVE_BACKGROUND');
const RUNS = Math.max(1, Math.min(20, Number.parseInt(option('--runs', 'AXON_WAKE_LIVE_RUNS', '1'), 10) || 1));
const SET = String(option('--set', 'AXON_WAKE_LIVE_SET', 'full')).toLowerCase();
const ONLY = String(option('--only', 'AXON_WAKE_LIVE_ONLY', 'both')).toLowerCase();

/**
 * What a person is asked to say.
 *
 * `kind` is what the report groups by. The primary phrase is reported on its
 * own because it is the one with a target: a wake word whose recall is carried
 * by "Hi Axon" is a wake word that does not work.
 */
const POSITIVES = [
  { say: 'Hey Axon', kind: 'primary', expect: true, set: 'brief' },
  { say: 'Hello Axon', kind: 'secondary', expect: true, set: 'brief' },
  { say: 'Hi Axon', kind: 'secondary', expect: true, set: 'brief' },
];

/**
 * What must never wake Axon.
 *
 * The first block is the brief's list. The second is CONVERSATIONAL: ordinary
 * sentences somebody would really say near a laptop, including several that
 * contain the name. The third is adversarial, and every one of them is there
 * because a measurement put it there — "Hey Jackson" is the one synthesised
 * negative that ever produced a false activation in offline calibration, so it
 * is in the live set permanently.
 */
const NEGATIVES = [
  { say: 'Axon', set: 'brief' },
  { say: 'Hey', set: 'brief' },
  { say: 'Hello', set: 'brief' },
  { say: 'Hi', set: 'brief' },
  { say: 'I was talking about Axon yesterday', set: 'brief' },
  { say: 'Axon is a company', set: 'full' },
  { say: 'Hey there', set: 'full' },
  { say: 'Hello everyone', set: 'full' },
  { say: 'Hi everyone', set: 'full' },
  { say: 'Action', set: 'full' },
  { say: 'Exon', set: 'full' },
  { say: 'Oxen', set: 'full' },
  { say: 'Taxon', set: 'full' },
  // Conversational.
  { say: 'The axon carries signals away from the cell body', set: 'full' },
  { say: 'Hey, can you pass me that', set: 'full' },
  { say: 'Hi, how are you doing today', set: 'full' },
  { say: 'Hey everyone, thanks for joining the call', set: 'full' },
  // Adversarial, and measured: greeting followed by a name that sounds like it.
  { say: 'Hey Jackson', set: 'full' },
  { say: 'Hey Alexa', set: 'full' },
  { say: 'Hi Axel', set: 'full' },
].map((prompt) => ({ ...prompt, kind: 'negative', expect: false }));

function promptList() {
  const wanted = (prompt) => (SET === 'brief' ? prompt.set === 'brief' : true);
  const positives = ONLY === 'negative' ? [] : POSITIVES.filter(wanted);
  const negatives = ONLY === 'positive' ? [] : NEGATIVES.filter(wanted);
  return [...positives, ...negatives];
}

/** How long to wait for an activation after a prompt. */
const LISTEN_MS = 10_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wake diagnostic lines, captured from this process's console. */
const heard = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[wake]')) heard.push({ at: Date.now(), line });
  originalWarn(...args);
};

/**
 * Speak through the speakers, for --loopback. A constant program with the text
 * passed on stdin, never interpolated into the command.
 */
function speakAloud(text) {
  return new Promise((resolve) => {
    const program = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.Rate = -1',
      // Loopback only. Speakers at full volume beside the microphone clip the
      // capture; AXON_WAKE_LIVE_VOLUME (0-100) lowers them. Parsed as a number,
      // so nothing but digits reaches the program.
      `$s.Volume = ${Math.max(0, Math.min(100, Number.parseInt(process.env.AXON_WAKE_LIVE_VOLUME ?? '100', 10) || 100))}`,
      '$text = [Console]::In.ReadToEnd()',
      '$s.Speak($text)',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', program], {
      shell: false,
      windowsHide: true,
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    child.stdin.end(text);
  });
}

/**
 * The detector's own process, as Windows sees it.
 *
 * The keyword spotter runs as a child of Axon, so "what does listening all day
 * cost?" is a question about that process and not about Electron's total. A
 * constant WMI query, and nothing from it is interpolated into a command.
 */
function spotterProcess() {
  const program =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*kws-host*' } | " +
    'Select-Object -First 1 -Property ProcessId,WorkingSetSize | ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', program], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  try {
    const parsed = JSON.parse((result.stdout || '').trim());
    if (!parsed || typeof parsed.ProcessId !== 'number') return null;
    return { pid: parsed.ProcessId, rssBytes: parsed.WorkingSetSize };
  } catch {
    return null;
  }
}

/** Total CPU seconds a process has used, or null if it is gone. */
function cpuSeconds(pid) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).CPU`],
    { encoding: 'utf8', shell: false, windowsHide: true },
  );
  const value = Number.parseFloat((result.stdout || '').trim());
  return Number.isFinite(value) ? value : null;
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-wake-live-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_WAKE_DEBUG = '1';

  const prompts = promptList();
  console.log('\nAxon wake word — live microphone test');
  console.log(`  mode: ${LOOPBACK ? 'LOOPBACK — a smoke test, NOT a measurement' : 'YOU SPEAK each prompt'}`);
  if (LOOPBACK) {
    console.log('        Axon captures with echo cancellation on, so audio played by this');
    console.log('        machine is cancelled before the detector ever sees it. Both engines');
    console.log('        score zero here. This run proves the pipeline works, and nothing else.');
  }
  console.log(`  runs: ${RUNS}   prompts: ${prompts.length} (${SET} set, ${ONLY})`);
  console.log(`  start: ${BACKGROUND ? 'in the background, as at sign-in (no Axon window)' : 'by hand (panel open)'}`);
  console.log(`  this session will ask for ${prompts.length * RUNS} utterances\n`);

  // The shipping entry point: security hooks, runtime, bridge, windows.
  if (BACKGROUND && !process.argv.includes('--background')) process.argv.push('--background');
  require(path.join(outDir, 'index.js'));

  const window = await waitForWindow();
  if (!window) {
    console.error('The app did not open a window.');
    app.exit(1);
    return;
  }
  await waitForLoad(window);
  await wait(2_000);

  const run = (script) => window.webContents.executeJavaScript(script, true);
  await run(`(() => {
    window.__activations = [];
    window.axon.onEvent((event) => {
      if (event.type === 'VOICE_SESSION' && event.action === 'activated') window.__activations.push(event.activation);
    });
    return true;
  })()`);

  // Armed, and hearing audio?
  const armed = await until(
    async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.armed)`)) === true,
    25_000,
  );
  const audio = await until(
    () => heard.some((entry) => /microphone audio is arriving|keyword spotter is listening/.test(entry.line)),
    25_000,
  );
  const wakeStatus = await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.wake)`);
  console.log(`${armed ? '✓' : '✗'} wake word armed`);
  console.log(`${audio ? '✓' : '✗'} microphone audio reaching the local detector`);
  console.log(`  detector: ${wakeStatus?.detail ?? 'unknown'} [${wakeStatus?.engine ?? '?'}]`);
  if (wakeStatus && wakeStatus.unavailableReason) console.log(`  ✗ ${wakeStatus.unavailableReason}`);

  // Focus mode: one phrase, measured instruments, no pass/fail. See wake-focus.cjs.
  const focus = (process.env.AXON_WAKE_FOCUS ?? '').trim();
  if (focus !== '') {
    if (!armed || !audio) {
      leave(sandbox, 1);
      return;
    }
    const { runFocusSession } = require('./wake-focus.cjs');
    const code = await runFocusSession({ focus, outDir, run, window, heard, wait, until, loopback: LOOPBACK, speakAloud });
    leave(sandbox, code);
    return;
  }

  const spotter = spotterProcess();
  const cpuAtStart = spotter ? cpuSeconds(spotter.pid) : null;
  const wallAtStart = Date.now();

  const results = [];
  const orbChecks = [];
  if (armed && audio) {
    for (let runIndex = 1; runIndex <= RUNS; runIndex += 1) {
      if (RUNS > 1) console.log(`\n=== run ${runIndex} of ${RUNS}`);
      for (const prompt of prompts) {
        // Settle: no session running, detector listening.
        await until(async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.active)`)) === false, 15_000);
        await wait(2_000);

        const before = await run('window.__activations.length');
        const since = Date.now();
        console.log(`\n→ ${LOOPBACK ? 'playing' : 'SAY NOW'}: "${prompt.say}"   (${prompt.expect ? 'should activate' : 'should NOT activate'})`);
        if (LOOPBACK) await speakAloud(prompt.say);

        const activated = await until(async () => (await run('window.__activations.length')) > before, LISTEN_MS);
        const lines = heard
          .filter((entry) => entry.at >= since && /heard \[/.test(entry.line))
          .map((entry) => entry.line.replace(/^\[wake\] (heard )?/, ''));
        // `behind Nms` is the detector's own measurement: how far behind live
        // audio the spotter was when it fired. It is NOT end-of-phrase latency
        // — see `kws-host.ts` for why that cannot be computed honestly — and it
        // is reported under a name that says so.
        const lags = lines
          .map((line) => /behind (\d+)ms/.exec(line))
          .filter(Boolean)
          .map((match) => Number.parseInt(match[1], 10));

        const pass = activated === prompt.expect;
        results.push({ ...prompt, activated, pass, lines, lags });
        console.log(`  ${pass ? '✓' : '✗'} ${activated ? 'activated' : 'did not activate'}`);
        console.log(`    detector said: ${lines.length > 0 ? lines.join(' | ') : '(nothing)'}`);

        if (activated) {
          // The orb must have materialised at the bottom of the screen.
          const orbShown = await until(async () => window.isVisible(), 3_000);
          orbChecks.push(orbShown);
          console.log(`    ${orbShown ? '✓ the orb appeared' : '✗ the orb did NOT appear'}`);
          // End the real session the activation started, as a user would.
          await run('window.axon.stopVoiceSession()');
          await until(async () => !window.isVisible(), 8_000);
        }
      }
    }
  }

  const cpuAtEnd = spotter ? cpuSeconds(spotter.pid) : null;
  const elapsedSeconds = (Date.now() - wallAtStart) / 1000;
  const spotterNow = spotterProcess();

  // --- the report ---------------------------------------------------------

  const tally = (predicate) => {
    const attempts = results.filter(predicate);
    return { hits: attempts.filter((result) => result.activated).length, total: attempts.length };
  };
  const pct = ({ hits, total }) => (total === 0 ? '—' : `${Math.round((hits / total) * 100)}%`);
  const line = (label, counts) => `  ${label.padEnd(38)} ${counts.hits}/${counts.total} (${pct(counts)})`;

  const primary = tally((result) => result.kind === 'primary');
  const negatives = tally((result) => !result.expect);

  console.log('\n\nWAKE WORD LIVE RESULT\n');
  console.log('Primary wake phrase:');
  console.log(line('Hey Axon', primary));
  const secondaries = POSITIVES.filter((prompt) => prompt.kind === 'secondary');
  if (secondaries.some((prompt) => results.some((result) => result.say === prompt.say))) {
    console.log('\nSecondary:');
    for (const prompt of secondaries) console.log(line(prompt.say, tally((result) => result.say === prompt.say)));
  }
  console.log('\nFalse activation:');
  console.log(`  ${String(negatives.hits)}/${negatives.total}`);
  for (const prompt of NEGATIVES) {
    const counts = tally((result) => result.say === prompt.say);
    if (counts.hits > 0) console.log(`    ✗ "${prompt.say}" activated ${counts.hits}/${counts.total}`);
  }

  const primaryOk = primary.total > 0 && primary.hits / primary.total >= 0.9;
  const negativesOk = negatives.hits === 0;
  if (LOOPBACK) {
    // No target line at all. A pass here would be meaningless and a failure
    // here would be a lie: printing "✗ 0%" beside the word "target" invites
    // somebody to act on a number that measures an echo canceller.
    console.log('\nTarget:  NOT ASSESSED — loopback cannot measure recall on this capture path.');
    console.log('         Run `npm run wake:live` without --loopback, and say the phrases yourself.');
  } else {
    console.log('\nTarget:');
    console.log(`  ${primaryOk ? '✓' : '✗'} >= 90% primary recognition   (measured ${pct(primary)})`);
    console.log(`  ${negativesOk ? '✓' : '✗'} 0 false activations          (measured ${negatives.hits})`);
  }

  const allLags = results.flatMap((result) => result.lags).sort((a, b) => a - b);
  const median = allLags.length > 0 ? allLags[Math.floor(allLags.length / 2)] : null;
  console.log('\nHow it was measured:');
  console.log(
    `  voice:                 ${
      LOOPBACK ? 'SYNTHESISED, into an echo canceller — NOT a measurement of recall' : 'a human speaking'
    }`,
  );
  console.log(`  start:                 ${BACKGROUND ? 'background, as at sign-in' : 'panel open'}`);
  console.log(`  detector:              ${wakeStatus?.detail ?? 'unknown'}`);
  console.log(`  threshold:             ${process.env.AXON_WAKE_THRESHOLD ?? 'the built-in default'}`);
  console.log('  microphone format:     16000 Hz, 16-bit, mono (LISTENING_LIMITS)');
  console.log(
    `  detector backlog:      ${
      median === null
        ? '(no activation to measure)'
        : `median ${median} ms, range ${allLags[0]}-${allLags[allLags.length - 1]} ms behind live audio when it fired`
    }`,
  );
  if (spotter && cpuAtStart !== null && cpuAtEnd !== null && elapsedSeconds > 0) {
    const cores = os.cpus().length || 1;
    console.log(
      `  detector CPU:          ${(((cpuAtEnd - cpuAtStart) / elapsedSeconds / cores) * 100).toFixed(1)}% of the machine ` +
        `(${(((cpuAtEnd - cpuAtStart) / elapsedSeconds) * 100).toFixed(0)}% of one core, ${cores} cores)`,
    );
  } else {
    console.log('  detector CPU:          (the spotter process was not found — in-process detector?)');
  }
  if (spotterNow) console.log(`  detector memory:       ${(spotterNow.rssBytes / 1e6).toFixed(0)} MB resident`);
  console.log(`  restarts during test:  ${wakeStatus?.restarts ?? 0}`);
  if (orbChecks.length > 0) {
    console.log(`  orb appeared:          ${orbChecks.filter(Boolean).length}/${orbChecks.length} activations`);
  }
  if (LOOPBACK) {
    console.log('\n  NOTE: loopback is a smoke test. The recall numbers above measure this');
    console.log("        machine's echo canceller, not Axon's detector, and they satisfy");
    console.log('        nothing at all. Say the phrases yourself.');
  }
  console.log('');

  const orbOk = orbChecks.length === 0 || orbChecks.every(Boolean);
  // In loopback, "did it work" means the PIPELINE ran: armed, capturing,
  // reporting. The recall columns are not allowed to decide an exit code.
  const passed = LOOPBACK
    ? armed && audio && results.length > 0
    : armed && audio && results.length > 0 && primaryOk && negativesOk && orbOk;

  leave(sandbox, passed ? 0 : 1);
}

/**
 * Leave, whatever Electron thinks.
 *
 * A harness that prints its answer and then never returns the prompt is a
 * harness nobody runs ten times, and running it ten times is the entire point
 * of this file.
 */
function leave(sandbox, code) {
  // The exit is on a timer that nothing below can lengthen.
  setTimeout(() => process.exit(code), 1_500);
  // Best effort, ASYNCHRONOUS, and deliberately not awaited. This directory is
  // the run's AXON_HOME: an open SQLite database, an open event log, and a
  // Chromium profile of several thousand files. A synchronous recursive delete
  // over that was measured blocking the event loop for minutes — long enough
  // that a watchdog timer never got a turn — so it is handed to the platform
  // and the process leaves on the timer whether or not it finishes. What is
  // left behind is a temporary directory in the OS temp folder.
  fs.rm(sandbox, { recursive: true, force: true, maxRetries: 0 }, () => process.exit(code));
  // `process.exit`, NOT `app.exit`, and no `BrowserWindow.destroy()`: both were
  // measured hanging after the report had printed in full. Chromium's helper
  // processes live in a Windows job object and go when this one does.
}

async function until(condition, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await wait(200);
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
      console.error('\nWake-word live test crashed:', error);
      app.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
