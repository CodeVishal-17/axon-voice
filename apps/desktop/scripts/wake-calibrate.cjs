/**
 * Choosing the wake threshold by measurement.
 *
 *   npm run wake:calibrate
 *   npm run wake:calibrate -- --thresholds=0.05,0.10,0.15,0.20,0.25
 *   npm run wake:calibrate -- --runs=5
 *
 * Also as environment variables, because npm does not reliably forward flags
 * through a workspace script: AXON_WAKE_CALIBRATE, AXON_WAKE_LIVE_RUNS.
 *
 * WHAT THIS PRODUCES.
 *
 *     threshold   Hey Axon   all positives   false activations
 *     0.05        10/10      29/30           0/60
 *     0.10        10/10      29/30           0/60
 *     0.15         9/10      27/30           0/60
 *     ...
 *
 * and names a threshold that satisfies both targets — primary recall at or
 * above 90%, and zero false activations — or says plainly that none does. A
 * threshold that cannot satisfy both is a finding about the DETECTOR, and the
 * brief is explicit that it must be reported rather than papered over with
 * heuristics.
 *
 * HOW IT SWEEPS WITHOUT RECORDING ANYBODY.
 *
 * The obvious way to sweep a threshold is to record the phrase and replay it
 * at each setting. Axon does not record anybody, and that rule has no
 * exception for measurement. So every threshold runs AT THE SAME TIME, on the
 * same live microphone frames: the person says "Hey Axon" once and the whole
 * column answers. See `calibration-engine.ts`. Nothing is stored, and there is
 * no recording to delete at the end because there never was one.
 *
 * The cost is CPU — one speech model per threshold, about three per cent of
 * one core each — which is why this is a session a developer starts, not
 * something Axon ever does.
 *
 * THIS IS A HUMAN TEST. Like `wake:live`, and for the same reason: the engine
 * this replaced passed every synthetic check and then scored 0/15 on a person.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const option = (name, env, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return (found ? found.slice(name.length + 1) : process.env[env]) ?? fallback;
};

/**
 * The thresholds measured by default.
 *
 * Chosen to bracket the range measured offline on synthesised speech, where
 * recall was perfect at and below 0.05 and fell away above it while false
 * activation did not move at all. The FIRST entry is the one that actually
 * wakes Axon during the session — it is the shipping default — and the rest
 * are observers, which is why the list is not in numeric order.
 */
const DEFAULT_THRESHOLDS = '0.05,0.02,0.08,0.10,0.15,0.20,0.25';
const THRESHOLDS = String(option('--thresholds', 'AXON_WAKE_CALIBRATE', DEFAULT_THRESHOLDS));
const RUNS = Math.max(1, Math.min(20, Number.parseInt(option('--runs', 'AXON_WAKE_LIVE_RUNS', '3'), 10) || 3));

const POSITIVES = [
  { say: 'Hey Axon', primary: true },
  { say: 'Hello Axon', primary: false },
  { say: 'Hi Axon', primary: false },
];

/**
 * The negatives that decide the floor.
 *
 * Deliberately the hard ones rather than the whole live list: a threshold sweep
 * is bounded by whatever fires first, and "Axon" on its own has never fired at
 * any threshold measured. "Hey Jackson" has.
 */
const NEGATIVES = [
  'Axon',
  'Hey',
  'I was talking about Axon yesterday',
  'Hey there',
  'Hey Jackson',
  'Hey Alexa',
  'Hi Axel',
  'Taxon',
];

const LISTEN_MS = 8_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wake diagnostics from this process's console. */
const heard = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[wake]')) heard.push({ at: Date.now(), line });
  originalWarn(...args);
};

/** Which thresholds fired since a moment, from the calibration debug lines. */
function firedSince(since) {
  const fired = new Set();
  for (const entry of heard) {
    if (entry.at < since) continue;
    const match = /\[wake\] calibration (\d+\.\d+) (\w+)/.exec(entry.line);
    if (match) fired.add(match[1]);
  }
  return fired;
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-wake-calibrate-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_WAKE_DEBUG = '1';
  process.env.AXON_WAKE_CALIBRATE = THRESHOLDS;

  const thresholds = THRESHOLDS.split(',').map((value) => Number.parseFloat(value).toFixed(2));
  const prompts = [
    ...POSITIVES.map((prompt) => ({ ...prompt, expect: true })),
    ...NEGATIVES.map((say) => ({ say, primary: false, expect: false })),
  ];

  console.log('\nAxon wake word — threshold calibration on a REAL microphone');
  console.log(`  thresholds: ${thresholds.join(', ')}   (the first one is what wakes Axon during this session)`);
  console.log(`  runs: ${RUNS}   prompts: ${prompts.length}   utterances asked for: ${prompts.length * RUNS}`);
  console.log('  every threshold hears every utterance at the same time; nothing is recorded.\n');

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
  const armed = await until(
    async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.armed)`)) === true,
    40_000,
  );
  const status = await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.wake)`);
  console.log(`${armed ? '✓' : '✗'} armed — ${status?.detail ?? 'unknown detector'}`);
  if (!armed) {
    console.error(`  ${status?.unavailableReason ?? 'the detector did not arm'}`);
    app.exit(1);
    return;
  }
  // Every arm needs its model loaded, and there are several.
  await wait(3_000);

  /** threshold -> { heyHits, heyTotal, posHits, posTotal, falseHits, falseTotal } */
  const table = new Map(
    thresholds.map((threshold) => [
      threshold,
      { heyHits: 0, heyTotal: 0, posHits: 0, posTotal: 0, falseHits: 0, falseTotal: 0, firedOn: new Set() },
    ]),
  );

  for (let runIndex = 1; runIndex <= RUNS; runIndex += 1) {
    console.log(`\n=== run ${runIndex} of ${RUNS}`);
    for (const prompt of prompts) {
      await until(async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.active)`)) === false, 15_000);
      await wait(1_500);
      const since = Date.now();
      console.log(`\n→ SAY NOW: "${prompt.say}"   (${prompt.expect ? 'a wake phrase' : 'must NOT wake'})`);
      await wait(LISTEN_MS);

      const fired = firedSince(since);
      console.log(`    fired at: ${fired.size > 0 ? [...fired].sort().join(', ') : '(no threshold)'}`);

      for (const threshold of thresholds) {
        const row = table.get(threshold);
        const hit = fired.has(threshold);
        if (prompt.expect) {
          row.posTotal += 1;
          if (hit) row.posHits += 1;
          if (prompt.primary) {
            row.heyTotal += 1;
            if (hit) row.heyHits += 1;
          }
        } else {
          row.falseTotal += 1;
          if (hit) {
            row.falseHits += 1;
            row.firedOn.add(prompt.say);
          }
        }
      }

      // An activation starts a real session; end it as a user would.
      if ((await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.active)`)) === true) {
        await run('window.axon.stopVoiceSession()');
        await until(async () => (await run(`window.axon.getSnapshot().then((s) => s.voiceAgent.active)`)) === false, 8_000);
      }
    }
  }

  console.log('\n\nWAKE THRESHOLD CALIBRATION\n');
  console.log('  threshold   Hey Axon      all positives   false activations');
  const viable = [];
  for (const threshold of thresholds) {
    const row = table.get(threshold);
    const recall = row.heyTotal === 0 ? 0 : row.heyHits / row.heyTotal;
    const ok = recall >= 0.9 && row.falseHits === 0;
    if (ok) viable.push({ threshold, recall });
    console.log(
      `  ${threshold.padEnd(11)} ${`${row.heyHits}/${row.heyTotal}`.padEnd(13)} ` +
        `${`${row.posHits}/${row.posTotal}`.padEnd(15)} ${row.falseHits}/${row.falseTotal}` +
        `${row.firedOn.size > 0 ? `   <- ${[...row.firedOn].map((s) => `"${s}"`).join(', ')}` : ''}` +
        `${ok ? '   MEETS BOTH TARGETS' : ''}`,
    );
  }

  console.log('\nTargets: primary recall >= 90%, false activations = 0\n');
  if (viable.length === 0) {
    console.log('  NO THRESHOLD MEETS BOTH TARGETS.');
    console.log('  This is a finding about the detector, not a reason to add heuristics.');
    console.log('  Report it, and evaluate the model — see `create-wake-detector.ts` for the');
    console.log('  alternatives that were weighed, and which one is next.');
  } else {
    // The highest viable threshold: the most margin against false activation
    // that still keeps recall, which is the side to err on for a microphone.
    const best = viable[viable.length - 1];
    console.log(`  Highest threshold meeting both: ${best.threshold} (primary recall ${Math.round(best.recall * 100)}%)`);
    console.log('  Set DEFAULT_KEYWORD_THRESHOLD in `wake-keywords.ts` to it, and record this');
    console.log('  table in `docs/wake-word.md` beside the run it came from.');
  }
  console.log('');

  leave(sandbox, viable.length > 0 ? 0 : 1);
}

/**
 * Leave, whatever Electron thinks.
 *
 * Same reason as `wake-live.cjs`, and more so: a calibration session runs
 * several speech models at once, so it has that many more children to outlive.
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
      console.error('\nThreshold calibration crashed:', error);
      app.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
