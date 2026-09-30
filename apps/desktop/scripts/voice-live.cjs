/**
 * The ACTIVE voice session, on a real microphone, spoken by a person.
 *
 *   npm run voice:live
 *   npm run voice:live -- --runs=3
 *
 * Also AXON_VOICE_LIVE_RUNS, because npm does not reliably forward flags
 * through a workspace script.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * `wake:live` asks: does the LOCAL detector hear "Hey Axon"? This asks the other
 * half: once Axon is active, does AssemblyAI receive usable audio and
 * understand what the person actually said? The two are independent — the wake
 * detector hearing the microphone proves nothing about the audio a voice
 * session sends — so this never involves the wake word. It opens a voice
 * session directly, asks for one controlled phrase, and compares AssemblyAI's
 * final transcript with what was asked for.
 *
 * For every utterance it prints, from AXON_VOICE_DEBUG diagnostics:
 *
 *   capture page   pipeline, source rate, resampling, track settings, whether
 *                  the page produced real-time audio, level, silence, clipping
 *   main           frames and audio received
 *   AssemblyAI     chunks and audio sent, largest gap between sends, socket
 *                  queue, audio dropped before session.ready
 *
 * so a failure answers its own question: bad audio, late audio, or a recognizer
 * that heard good audio wrong.
 *
 * PRIVACY AND SIDE EFFECTS. This streams the microphone to AssemblyAI exactly as
 * a real activation does, only while a prompt is open. Nothing is recorded; the
 * transcript is printed to this terminal. The session is stopped the moment a
 * final transcript arrives, but the agent may already have begun acting on it —
 * "Open Calculator" can open Calculator. Every action still goes through the
 * dispatcher, policy and approvals, as in the product.
 *
 * Synthetic speech is not a substitute. This is a human test.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const RUNS = Math.max(
  1,
  Math.min(10, Number.parseInt(runsArg ? runsArg.slice('--runs='.length) : (process.env.AXON_VOICE_LIVE_RUNS ?? '1'), 10) || 1),
);

const PHRASES = ['Hello Axon', 'Open Calculator', 'Open YouTube', 'What time is it?', 'Calculate 125 times 48'];

/** How long a person has to start and finish the phrase. */
const LISTEN_MS = 12_000;
/** After the first final transcript, how long to wait for a second one before scoring. */
const SETTLE_MS = 1_200;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `[voice]` diagnostics, captured from this process's console. */
const lines = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[voice]')) lines.push({ at: Date.now(), line });
  originalWarn(...args);
};

async function until(condition, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await wait(150);
  }
}

function leave(sandbox, code) {
  // See wake-live.cjs: Electron teardown has been measured blocking for
  // minutes after a report printed. Exit on a timer nothing can lengthen.
  setTimeout(() => process.exit(code), 1_500);
  fs.rm(sandbox, { recursive: true, force: true, maxRetries: 0 }, () => process.exit(code));
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    process.exit(1);
  }
  const { matchTranscript } = require(path.join(outDir, 'transcript-match.js'));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-voice-live-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_VOICE_DEBUG = '1';

  console.log('\nAxon active voice — live microphone test (a person speaking)');
  console.log(`  phrases: ${PHRASES.length}   runs: ${RUNS}   utterances: ${PHRASES.length * RUNS}`);
  console.log('  Each prompt opens a real AssemblyAI session. Wait for SAY NOW, then speak normally.\n');

  require(path.join(outDir, 'index.js'));

  // The panel, not the overlay: it has the same bridge, and it is the surface a
  // person would press "talk" on.
  let panel = null;
  await until(() => {
    panel = BrowserWindow.getAllWindows().find((w) => !/[?&]surface=overlay/.test(w.webContents.getURL())) ?? null;
    return panel !== null;
  }, 20_000);
  if (!panel) {
    console.error('The panel did not open.');
    leave(sandbox, 1);
    return;
  }
  if (panel.webContents.isLoading()) await new Promise((resolve) => panel.webContents.once('did-finish-load', resolve));
  await wait(2_000);
  const run = (script) => panel.webContents.executeJavaScript(script, true);
  const snapshot = () => run('window.axon.getSnapshot()');

  const first = await snapshot();
  if (!first.voiceAgent.available) {
    console.error(`  ✗ no voice agent: ${first.voiceAgent.reason ?? 'unavailable'}`);
    leave(sandbox, 1);
    return;
  }

  const results = [];
  for (let runIndex = 1; runIndex <= RUNS; runIndex += 1) {
    if (RUNS > 1) console.log(`\n=== run ${runIndex} of ${RUNS}`);
    for (const phrase of PHRASES) {
      await until(async () => (await snapshot()).voiceAgent.active === false, 15_000);
      await wait(1_000);

      const openedAt = Date.now();
      const started = await run('window.axon.startVoiceSession()');
      if (!started.accepted) {
        console.log(`\n  ✗ could not open a voice session: ${started.error}`);
        results.push({ phrase, match: matchTranscript(phrase, null), note: 'no session' });
        continue;
      }
      const ready = await until(async () => (await snapshot()).voiceAgent.phase === 'LISTENING', 15_000);
      if (!ready) {
        console.log('\n  ✗ the session never reached LISTENING (session.ready)');
        await run('window.axon.stopVoiceSession()');
        results.push({ phrase, match: matchTranscript(phrase, null), note: 'not ready' });
        continue;
      }
      const readyAfterMs = Date.now() - openedAt;
      const since = Date.now();
      console.log(`\n→ SAY NOW: "${phrase}"`);

      let firstFinalAt = null;
      await until(() => {
        const finals = lines.filter((e) => e.at >= since && e.line.startsWith('[voice] final:'));
        if (finals.length > 0 && firstFinalAt === null) firstFinalAt = Date.now();
        return firstFinalAt !== null && Date.now() - firstFinalAt >= SETTLE_MS;
      }, LISTEN_MS);
      await run('window.axon.stopVoiceSession()');

      const window = lines.filter((e) => e.at >= since);
      const finals = window.filter((e) => e.line.startsWith('[voice] final:')).map((e) => e.line.slice('[voice] final:'.length).trim());
      const partials = window.filter((e) => e.line.startsWith('[voice] partial:'));
      const recognized = finals.length > 0 ? finals.join(' ') : null;
      const match = matchTranscript(phrase, recognized);
      const capture = window.filter((e) => e.line.includes('capture page')).pop()?.line ?? '(no capture report)';
      const received = window.filter((e) => e.line.includes('main received (voice)')).pop()?.line ?? '(no main report)';
      const sent = window.filter((e) => e.line.includes('sent to AssemblyAI')).pop()?.line ?? '(no send report)';

      console.log(`  spoken:     "${phrase}"`);
      console.log(`  recognized: ${recognized === null ? '(nothing final)' : `"${recognized}"`}${partials.length > 0 ? `   (${partials.length} partials)` : ''}`);
      console.log(`  result:     ${match.verdict}   (word error rate ${Math.round(match.wordErrorRate * 100)}%)`);
      console.log(`  session.ready after ${readyAfterMs} ms`);
      console.log(`  ${capture.replace('[voice] ', '')}`);
      console.log(`  ${received.replace('[voice] ', '')}`);
      console.log(`  ${sent.replace('[voice] ', '')}`);
      results.push({ phrase, match });
    }
  }

  console.log('\n\nACTIVE VOICE LIVE RESULT\n');
  for (const phrase of PHRASES) {
    const attempts = results.filter((r) => r.phrase === phrase);
    const pass = attempts.filter((r) => r.match.verdict === 'PASS').length;
    const heard = attempts.map((r) => `"${r.match.recognized || '—'}"`).join(', ');
    console.log(`  ${pass === attempts.length ? '✓' : '✗'} "${phrase}": ${pass}/${attempts.length} PASS   heard: ${heard}`);
  }
  const passed = results.filter((r) => r.match.verdict === 'PASS').length;
  const failed = results.filter((r) => r.match.verdict === 'FAIL').length;
  console.log(`\n  PASS ${passed}/${results.length}   CLOSE ${results.length - passed - failed}   FAIL ${failed}`);
  console.log('  (human voice; PASS = word error rate <= 25% after normalising case, punctuation and numbers)\n');

  leave(sandbox, failed === 0 && results.length > 0 ? 0 : 1);
}

app.whenReady().then(
  () => {
    main().catch((error) => {
      console.error('\nActive voice live test crashed:', error);
      process.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
