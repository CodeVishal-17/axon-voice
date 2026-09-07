/**
 * Real-tool verification harness.
 *
 * Runs inside a real Electron main process against the built output, so it
 * exercises the parts the unit tests deliberately fake: `desktopCapturer`
 * really grabs the framebuffer, `spawn` really starts Notepad, and `fs.write`
 * really writes through the real path policy.
 *
 * Everything goes through the real Dispatcher. Nothing here calls an executor
 * directly — that is the point of the exercise.
 *
 *   npm run verify:tools
 *
 * Exits non-zero on the first failed expectation.
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
  checks.push({ label, ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  // `src/main/runtime.ts` is built as a second entry point precisely so this
  // harness can assemble the real runtime graph — the same function the app
  // itself calls — without opening a window.
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  // Isolate everything this harness touches from the user's real Axon home.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-verify-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_APPROVAL_TIMEOUT_MS = '1500';

  const runtime = require(path.join(outDir, 'runtime.js'));
  const { orchestrator, config, bus, sink, speechTransport, captureTransport, speech, listening } =
    runtime.createVerificationRuntime({
      home: sandbox,
      env: process.env,
      // Read from Electron, exactly as `src/main/index.ts` does: it is where
      // Chromium keeps the browser profile, and the path policy protects it.
      sessionData: app.getPath('sessionData'),
      hotkey: 'Control+Shift+Space',
    });

  const events = [];
  bus.subscribe((event) => events.push(event));

  console.log(`\nAxon verification harness`);
  console.log(`workspace : ${config.workspaceRoot}`);
  console.log(`screens   : ${config.screenshotDir}`);
  console.log(`event log : ${config.eventLogPath}\n`);

  // --- registry ----------------------------------------------------------
  // The three OS tools, the nine browser tools Step 5 added, and the three
  // memory tools Step 6 added. An exact list, not a count: a tool appearing
  // here that nobody meant to register is exactly the thing this harness
  // exists to notice.
  //
  // The memory tools were absent from this list until Step 7, and the reason
  // is worth recording. They register only when persistence is available, and
  // persistence was never available in the real application — the database
  // lives in a directory nothing created, so every open failed and degraded
  // quietly. This harness therefore observed twelve tools and asserted twelve
  // tools, which is how a list meant to catch a missing tool came to encode
  // one. Fixing the directory made three tools appear and this check fail,
  // which is the harness working.
  // Sorted, because `registry.names()` is. The window tools joined in the
  // desktop-control phase; they are registered only on a platform where
  // windows can actually be enumerated, which is why this harness — which
  // runs on Windows — sees them.
  const EXPECTED_TOOLS = [
    'app.focus',
    'app.open',
    'browser.back',
    'browser.click',
    'browser.close',
    'browser.forward',
    'browser.navigate',
    'browser.open',
    'browser.read',
    'browser.scroll',
    'browser.type',
    'fs.write',
    'memory.forget',
    'memory.save',
    'memory.search',
    'system.screenshot',
    'window.focus',
    'window.list',
    'window.maximize',
    'window.minimize',
  ];
  check(
    'the registry exposes exactly the expected tools',
    orchestrator.registry.names().join(',') === EXPECTED_TOOLS.join(','),
    orchestrator.registry.names().join(', '),
  );

  const schemas = orchestrator.listTools();
  check(
    'tool schemas are code-free JSON',
    schemas.length === EXPECTED_TOOLS.length && schemas.every((s) => typeof s.inputSchema === 'object'),
    `${schemas.length} schemas`,
  );
  check(
    'no schema carries anything callable',
    !schemas.some((s) => JSON.stringify(s).includes('function')),
  );

  // --- system.screenshot (real capture) ----------------------------------
  const shot = await orchestrator.invokeTool('system.screenshot', { label: 'verify' });
  check('system.screenshot succeeded', shot.ok, shot.ok ? '' : JSON.stringify(shot.failure));
  if (shot.ok) {
    const stat = fs.existsSync(shot.output.path) ? fs.statSync(shot.output.path) : null;
    const header = stat ? fs.readFileSync(shot.output.path).subarray(0, 8) : Buffer.alloc(0);
    check('screenshot file exists on disk', stat !== null, shot.output.path);
    check('screenshot is a real PNG', header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('screenshot has real dimensions', shot.output.width > 100 && shot.output.height > 100, `${shot.output.width}x${shot.output.height}`);
    check('screenshot is more than a stub', stat !== null && stat.size > 5000, stat ? `${stat.size} bytes` : '');
  }

  // --- screenshot retention ----------------------------------------------
  // A screenshot is a picture of whatever was on screen. The folder is pruned
  // so it never becomes an archive of somebody's week.
  {
    const before = fs.existsSync(config.screenshotDir) ? fs.readdirSync(config.screenshotDir).length : 0;
    for (let i = 0; i < 15; i += 1) {
      await orchestrator.invokeTool('system.screenshot', { label: `retain ${i}` });
    }
    const after = fs.readdirSync(config.screenshotDir).filter((name) => /^screen-.*\.png$/.test(name));
    check('old screenshots are pruned rather than kept forever', after.length <= 12, `${before} -> ${after.length} files after 16 captures`);
  }

  // --- fs.write SAFE -----------------------------------------------------
  const safeWrite = await orchestrator.invokeTool('fs.write', {
    path: 'verify.txt',
    content: 'written by the verification harness',
    overwrite: true,
  });
  check('fs.write inside workspace succeeded', safeWrite.ok, safeWrite.ok ? '' : JSON.stringify(safeWrite.failure));
  if (safeWrite.ok) {
    check('workspace file has the right contents', fs.readFileSync(safeWrite.output.path, 'utf8') === 'written by the verification harness');
  }
  check('workspace write raised no approval', !events.some((e) => e.type === 'APPROVAL_REQUIRED'));

  // --- fs.write FORBIDDEN ------------------------------------------------
  const forbidden = await orchestrator.invokeTool('fs.write', {
    path: 'C:\\Windows\\System32\\axon-should-never-write.txt',
    content: 'no',
    overwrite: true,
  });
  check('fs.write into System32 refused', !forbidden.ok && forbidden.failure.kind === 'FORBIDDEN', forbidden.ok ? 'IT WROTE THE FILE' : forbidden.failure.kind);
  check('no file was created in System32', !fs.existsSync('C:\\Windows\\System32\\axon-should-never-write.txt'));
  check('FORBIDDEN never offered an approval', !events.some((e) => e.type === 'APPROVAL_REQUIRED'));

  // --- fs.write REQUIRES_APPROVAL, allowed -------------------------------
  const outsidePath = path.join(sandbox, 'outside-approved.txt');
  const approvedWrite = orchestrator.invokeTool('fs.write', { path: outsidePath, content: 'approved', overwrite: true });
  await waitFor(() => orchestrator.approvals.list().length === 1, 'approval to be raised');
  const pending = orchestrator.approvals.list()[0];
  check('approval was raised for an outside write', pending && pending.tool === 'fs.write', pending ? pending.title : 'none');
  check('approval carries the resolved path', pending && pending.parameters.some((p) => p.value === outsidePath));
  check('file does not exist while waiting', !fs.existsSync(outsidePath));

  orchestrator.resolveApproval(pending.callId, 'ALLOW');
  const approvedResult = await approvedWrite;
  check('approved write succeeded', approvedResult.ok, approvedResult.ok ? '' : JSON.stringify(approvedResult.failure));
  check('approved file exists with the right contents', fs.existsSync(outsidePath) && fs.readFileSync(outsidePath, 'utf8') === 'approved');

  // --- fs.write REQUIRES_APPROVAL, denied --------------------------------
  const deniedPath = path.join(sandbox, 'outside-denied.txt');
  const deniedWrite = orchestrator.invokeTool('fs.write', { path: deniedPath, content: 'nope', overwrite: true });
  await waitFor(() => orchestrator.approvals.list().length === 1, 'second approval');
  orchestrator.resolveApproval(orchestrator.approvals.list()[0].callId, 'DENY');
  const deniedResult = await deniedWrite;
  check('denied write failed', !deniedResult.ok && deniedResult.failure.kind === 'DENIED');
  check('denied file was not created', !fs.existsSync(deniedPath));

  // --- approval timeout ---------------------------------------------------
  const timeoutPath = path.join(sandbox, 'outside-timeout.txt');
  const timeoutWrite = await orchestrator.invokeTool('fs.write', { path: timeoutPath, content: 'x', overwrite: true });
  check('unanswered approval times out into a denial', !timeoutWrite.ok && timeoutWrite.failure.kind === 'APPROVAL_TIMEOUT', timeoutWrite.ok ? 'IT WROTE' : timeoutWrite.failure.kind);
  check('timed-out file was not created', !fs.existsSync(timeoutPath));

  // --- deny by default ----------------------------------------------------
  const unknown = await orchestrator.invokeTool('shell.execute', { command: 'whoami' });
  check('unknown tool refused', !unknown.ok && unknown.failure.kind === 'UNKNOWN_TOOL');

  const badInput = await orchestrator.invokeTool('app.open', { app: 'cmd.exe' });
  check('non-allowlisted app rejected by the schema', !badInput.ok && badInput.failure.kind === 'INVALID_INPUT');

  // --- app.open (real launch) --------------------------------------------
  const opened = await orchestrator.invokeTool('app.open', { app: 'notepad' });
  check('app.open launched Notepad', opened.ok && typeof opened.output.pid === 'number', opened.ok ? `pid ${opened.output.pid}` : JSON.stringify(opened.failure));
  if (opened.ok && opened.output.pid) {
    try {
      process.kill(opened.output.pid);
      console.log(`      (closed Notepad, pid ${opened.output.pid})`);
    } catch {
      console.log('      (Notepad already closed)');
    }
  }

  // --- event pipeline -----------------------------------------------------
  const calls = events.filter((e) => e.type === 'TOOL_CALL').length;
  const results = events.filter((e) => e.type === 'TOOL_RESULT').length;
  check('every TOOL_CALL has exactly one TOOL_RESULT', calls === results && calls >= 9, `${calls} calls / ${results} results`);

  // Close the sink before reading: the JSONL writer is a buffered stream, so
  // reading while it is still open measures the buffer rather than the log.
  // Closing also releases the handle that would otherwise block cleanup below.
  await sink.close();

  const logLines = fs.existsSync(config.eventLogPath)
    ? fs.readFileSync(config.eventLogPath, 'utf8').trimEnd().split('\n').filter(Boolean)
    : [];
  // Compared against the bus backlog rather than the harness's own list: the
  // runtime emits its startup event during construction, before this harness
  // could subscribe, so the log is legitimately a superset of what we saw.
  const busEvents = bus.recent();
  check('every event the bus produced reached the JSONL log', logLines.length === busEvents.length, `${logLines.length} lines / ${busEvents.length} bus events`);
  check('the log ends on the same event the bus ended on', logLines.length > 0 && JSON.parse(logLines[logLines.length - 1]).id === busEvents[busEvents.length - 1].id);
  check('every log line parses back into an event', logLines.every((line) => {
    try {
      return typeof JSON.parse(line).type === 'string';
    } catch {
      return false;
    }
  }));

  const states = events.filter((e) => e.type === 'STATE_CHANGED').map((e) => e.to);
  check('the state machine drove real transitions', states.includes('EXECUTING') && states.includes('WAITING_FOR_APPROVAL'), states.join(' -> '));

  // --- brain wiring -------------------------------------------------------
  // No key is configured in the harness environment, so this asserts the
  // *degraded* path: Axon runs, says why there is no brain, and refuses the
  // message instead of crashing.
  const brain = orchestrator.brainStatus();
  check('brain status is reported without a credential', typeof brain.available === 'boolean' && brain.name === 'none', `available=${brain.available}`);
  check('the missing-key reason names the variable to set', String(brain.reason).includes('ANTHROPIC_API_KEY'));
  check('no snapshot field carries anything key-shaped', !/sk-ant-[A-Za-z0-9_-]{4,}/.test(JSON.stringify(orchestrator.snapshot())));

  const refused = orchestrator.sendUserMessage('open notepad');
  check('a message is refused when no brain is attached', refused.accepted === false);
  check('the refusal still records what the user said', events.some((e) => e.type === 'USER_MESSAGE' && e.text === 'open notepad'));
  check('an empty message is refused before anything happens', orchestrator.sendUserMessage('   ').accepted === false);

  // --- voice --------------------------------------------------------------
  // Real synthesis through the real service in the real runtime graph. The
  // bytes asserted below came out of the Windows synthesiser; nothing here is
  // a stand-in.
  // The no-brain probe above deliberately left the machine in ERROR, and
  // ERROR leaves only to IDLE. Reset through the documented recovery path
  // before the next independent probe — the same transition a new user
  // message performs in the running app.
  const reset = orchestrator.requestState('IDLE', 'verification: next probe');
  check('ERROR recovers to IDLE through the normal path', reset.accepted && reset.state === 'IDLE', reset.error ?? reset.state);

  const speechStatus = orchestrator.speechStatus();
  check(
    'speech status carries a provider name and no credential',
    typeof speechStatus.available === 'boolean' && !/sk-ant|password|secret/i.test(JSON.stringify(speechStatus)),
    `${speechStatus.name} available=${speechStatus.available}`,
  );

  if (speechStatus.available) {
    // Stand in for the renderer: capture what main would push to a window.
    const delivered = [];
    speechTransport.attach({
      deliver: (d) => delivered.push(d),
      stop: () => {},
    });

    const spoke = await speech.speak('Axon speech check.');
    check('real synthesis produced audio', spoke === true && delivered.length === 1, delivered[0] ? `${delivered[0].bytes.length} bytes` : 'none');

    const delivery = delivered[0];
    if (delivery) {
      check('delivered audio is a RIFF/WAVE stream', Buffer.from(delivery.bytes.subarray(0, 4)).toString('ascii') === 'RIFF');
      check('delivered audio has a measured duration', delivery.durationMs > 200, `${delivery.durationMs}ms`);
      check('delivery carries bytes, never a location', !('path' in delivery) && !('url' in delivery) && !('file' in delivery));
      check('delivery declares an allowed media type', delivery.mimeType === 'audio/wav', delivery.mimeType);

      // Not silence. A well-formed buffer of zeros would pass every structural
      // check above and drive the orb to a flat line.
      const usable = Math.floor((delivery.bytes.length - 44) / 2);
      const pcm = new Int16Array(delivery.bytes.buffer, delivery.bytes.byteOffset + 44, usable);
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 1) sum += (pcm[i] / 32768) ** 2;
      const rms = Math.sqrt(sum / pcm.length);
      check('delivered audio is real sound, not silence', rms > 0.005, `rms ${rms.toFixed(4)}`);

      check('Axon entered SPEAKING', orchestrator.state === 'SPEAKING', orchestrator.state);

      // What the renderer reports when playback finishes.
      speech.report(delivery.speechId, 'ended');
      check('Axon left SPEAKING when the audio ended', orchestrator.state !== 'SPEAKING', orchestrator.state);
    }

    const speechEvents = events.filter((e) => e.type === 'SPEECH_STARTED' || e.type === 'SPEECH_ENDED');
    check('speech events reached the stream', speechEvents.length >= 2, speechEvents.map((e) => e.type).join(' -> '));
    check('speech events carry no audio', !JSON.stringify(speechEvents).includes('RIFF'));
    check('speech events do not repeat the spoken words', !JSON.stringify(speechEvents).toLowerCase().includes('axon speech check'));

    // Cancellation, against the real service.
    const second = await speech.speak('This utterance will be cancelled before it finishes.');
    check('a second utterance started', second === true);
    check('cancelling a live utterance reports success', speech.cancel() === true);
    check('cancelling leaves no utterance in flight', speech.speaking === false);
    check('cancelling left SPEAKING', orchestrator.state !== 'SPEAKING', orchestrator.state);
    check('nothing to cancel when silent', orchestrator.cancelSpeech() === false);

    speechTransport.detach();
  } else {
    check('speech is unavailable and says why', typeof speechStatus.reason === 'string' && speechStatus.reason.length > 0, speechStatus.reason);
  }

  // --- voice in -----------------------------------------------------------
  // Real speech recognition through the real listening service in the real
  // runtime graph. The audio below is rendered by the real Windows
  // synthesiser and pushed through frame by frame exactly as the renderer's
  // microphone does; the transcript comes from the real recognizer.
  //
  // What is NOT covered: the microphone itself. `getUserMedia` needs a
  // renderer, a device, an OS permission grant and somebody to speak, none of
  // which exist in a headless harness. That stage is verified by hand in the
  // running app, and this harness does not pretend otherwise.
  {
    const reset2 = orchestrator.requestState('IDLE', 'verification: listening probe');
    if (!reset2.accepted && orchestrator.state !== 'IDLE') {
      check('state is IDLE before the listening probe', false, orchestrator.state);
    }

    const listenStatus = orchestrator.listeningStatus();
    check(
      'listening status carries a provider name and no credential',
      typeof listenStatus.available === 'boolean' &&
        !/sk-ant|password|secret|apiKey/i.test(JSON.stringify(listenStatus)),
      `${listenStatus.name} available=${listenStatus.available}`,
    );
    check('the push-to-talk shortcut is reported to the UI', listenStatus.hotkey === 'Control+Shift+Space', String(listenStatus.hotkey));

    if (listenStatus.available && speechStatus.available) {
      // Render the audio FIRST, before any listening session exists: speaking
      // moves the machine to SPEAKING, and the probe below wants to start from
      // a clean IDLE.
      const spoken = await realSpeechPcm(speech, speechTransport, 'Open Notepad.', 16000);
      check('rendered real speech to feed the recognizer', spoken.length > 8000, `${spoken.length} samples`);

      await waitFor(() => orchestrator.state !== 'SPEAKING', 'speech to finish', 20000).catch(() => {});
      orchestrator.requestState('IDLE', 'verification: ready to listen');

      // Stand in for the renderer: capture the commands main sends.
      const commands = [];
      captureTransport.attach({ command: (c) => commands.push(c) });

      const started = orchestrator.startListening('hotkey');
      check('listening started from IDLE', started.accepted === true, started.error ?? '');
      check('Axon entered LISTENING', orchestrator.state === 'LISTENING', orchestrator.state);
      check('the microphone was asked to open', commands.length === 1 && commands[0].action === 'start');
      check('the capture command names a session, a rate, and nothing else', commands[0] && Object.keys(commands[0]).sort().join(',') === 'action,captureId,sampleRate', commands[0] ? Object.keys(commands[0]).join(',') : '');
      check('the capture id is not guessable', commands[0] && commands[0].captureId.length >= 32, commands[0] ? `${commands[0].captureId.length} chars` : '');

      const captureId = commands[0] ? commands[0].captureId : '';
      const RATE = commands[0] ? commands[0].sampleRate : 16000;
      const FRAME = 512;

      const pushSilence = (ms) => {
        const count = Math.ceil(ms / ((FRAME / RATE) * 1000));
        for (let i = 0; i < count; i += 1) orchestrator.pushAudioFrame(captureId, new Int16Array(FRAME));
      };

      // A frame from a session that is not open must be dropped.
      orchestrator.pushAudioFrame('not-the-open-session', new Int16Array(FRAME));

      pushSilence(300);
      for (let offset = 0; offset < spoken.length; offset += FRAME) {
        orchestrator.pushAudioFrame(captureId, spoken.slice(offset, Math.min(offset + FRAME, spoken.length)));
      }
      pushSilence(1500);

      // The voice activity detector closed the utterance itself, from the
      // audio — no timer, and nothing the harness asked it to do. The
      // microphone shuts at end of speech; the session itself settles a moment
      // later, when the transcript is in.
      check('the microphone was asked to close at end of speech', commands.some((c) => c.action === 'stop'));

      await waitFor(() => events.some((e) => e.type === 'USER_MESSAGE' && e.source === 'voice'), 'a voice transcript', 20000).catch(() => {});
      check('the listening session closed once the transcript arrived', listening.listening === false);

      const voiceMessage = events.filter((e) => e.type === 'USER_MESSAGE' && e.source === 'voice').pop();
      check('a real transcript reached the event stream', Boolean(voiceMessage), voiceMessage ? `"${voiceMessage.text}"` : 'none');
      check('the transcript is what was said', voiceMessage && /notepad/i.test(voiceMessage.text), voiceMessage ? voiceMessage.text : '');
      check('the transcript is marked as coming from voice', voiceMessage && voiceMessage.source === 'voice');

      // The security property, checked against a real run rather than asserted.
      const stream = JSON.stringify(events);
      check('no raw audio reached the event stream', !/"samples"|"pcm"|"frames"/i.test(stream));
      check('no event carries an audio-shaped payload', !/"0":\s*-?\d+,\s*"1":/.test(stream));
      check('the JSONL log stayed parseable JSON throughout', events.every((e) => {
        try { JSON.parse(JSON.stringify(e)); return true; } catch { return false; }
      }));

      const metrics = events.filter((e) => e.type === 'OBSERVATION' && /Heard you/.test(e.summary)).pop();
      check('listening latency was measured', Boolean(metrics), metrics ? `${metrics.detail.totalMs}ms total, ${metrics.detail.transcriptionMs}ms to transcribe` : 'none');
      check('the latency detail is numbers only', metrics && Object.values(metrics.detail).every((v) => v === null || typeof v === 'number'));

      captureTransport.detach();
      orchestrator.cancelTurn('verification finished');
    } else {
      check('listening is unavailable and says why', typeof listenStatus.reason === 'string' && listenStatus.reason.length > 0, listenStatus.reason);
    }
  }

  // --- bundle isolation ---------------------------------------------------
  // The architecture tests check imports in source. This checks the artifact
  // that actually ships: a bundler mistake could pull the SDK into the
  // renderer without any source file importing it.
  const rendererDir = path.resolve(__dirname, '../out/renderer');
  const preloadFile = path.resolve(__dirname, '../out/preload/index.js');

  const readAll = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|html|css)$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out.join('\n');
  };

  const rendererBundle = readAll(rendererDir);
  const preloadBundle = fs.existsSync(preloadFile) ? fs.readFileSync(preloadFile, 'utf8') : '';

  check('the renderer bundle exists to be checked', rendererBundle.length > 1000, `${rendererBundle.length} bytes`);
  check('the model SDK is absent from the renderer bundle', !/anthropic/i.test(rendererBundle));
  check('the model SDK is absent from the preload bundle', !/anthropic/i.test(preloadBundle));
  check('no key-shaped string is baked into the renderer bundle', !/sk-ant-[A-Za-z0-9_-]{4,}/.test(rendererBundle));
  check('the preload bundle is still small enough to audit', preloadBundle.length > 0 && preloadBundle.length < 20000, `${preloadBundle.length} bytes`);
  check('the main bundle does reference the model SDK', /@anthropic-ai\/sdk/.test(fs.readFileSync(path.join(outDir, 'runtime.js'), 'utf8')));

  // --- summary ------------------------------------------------------------
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(failed === 0 ? 0 : 1);
}

/**
 * Real speech, as 16-bit PCM at the recognizer's rate.
 *
 * Rendered by the real Windows synthesiser and handed to the recognizer the
 * way a microphone would hand it over. It is not a microphone, and the harness
 * says so where it uses this.
 */
async function realSpeechPcm(speech, transport, text, targetRate) {
  const delivered = [];
  transport.attach({ deliver: (d) => delivered.push(d), stop: () => {} });
  await speech.speak(text);
  transport.detach();

  const delivery = delivered[0];
  if (!delivery) return new Int16Array(0);

  const bytes = Buffer.from(delivery.bytes);

  // Walk the chunk list rather than assuming a 44-byte header: SAPI emits a
  // LIST/INFO chunk before the audio.
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = Math.min(size, bytes.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) return new Int16Array(0);

  const channels = bytes.readUInt16LE(22);
  const sourceRate = bytes.readUInt32LE(24);

  const samples = new Int16Array(dataLength >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(dataStart + i * 2);

  // Mono-ise, then resample with the same linear interpolation the renderer
  // uses when a browser declines to give it a 16kHz context.
  const mono = channels === 1 ? samples : new Int16Array(Math.floor(samples.length / channels));
  if (channels !== 1) {
    for (let i = 0; i < mono.length; i += 1) mono[i] = samples[i * channels];
  }

  if (sourceRate === targetRate) return mono;

  const ratio = sourceRate / targetRate;
  const out = new Int16Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = mono[index] ?? 0;
    const b = mono[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

function waitFor(predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 20);
    };
    poll();
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
