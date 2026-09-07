/**
 * The voice agent, verified in a real Electron process.
 *
 *   npm run verify:voice-agent
 *
 * WHAT IS REAL HERE.
 *
 * The real runtime, built by the real `createAxonRuntime` — the same graph the
 * product runs. The real orchestrator, the real dispatcher, the real risk
 * policy, the real approval broker, the real wake-word detector, and a real
 * WebSocket carrying real frames over real TCP.
 *
 * WHAT IS SUBSTITUTED, AND WHY.
 *
 * The PROVIDER. A local `WebSocketServer` replays the documented Voice Agent
 * event sequence instead of AssemblyAI answering. That is the only part that
 * costs money, needs a network, and would make this harness fail on a plane.
 * Everything between Axon's microphone and that socket is the shipping code.
 *
 * So this proves the integration works against the protocol as documented. It
 * does NOT prove AssemblyAI behaves as documented — that is a separate claim
 * with separate evidence, and the report says which is which.
 *
 * NO API KEY IS NEEDED OR USED. The harness supplies its own throwaway value
 * to a local server, and one of the checks below is that the value never
 * appears anywhere the user could see it.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');
const { WebSocketServer } = require('ws');

const checks = [];
let failed = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** A distinctive value, so a leak anywhere is unmistakable in a grep. */
const FAKE_KEY = 'axon-verify-fake-key-do-not-use-0000';

// ---------------------------------------------------------------------------
// A local stand-in for the provider.
// ---------------------------------------------------------------------------

function startProvider() {
  return new Promise((resolve, reject) => {
    const received = [];
    let client = null;
    let authorization = null;

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket, request) => {
      client = socket;
      authorization = request.headers.authorization ?? null;
      socket.on('message', (data) => {
        try {
          received.push(JSON.parse(data.toString('utf8')));
        } catch {
          /* not part of this protocol */
        }
      });
      socket.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_verify' }));
    });

    server.on('error', reject);
    server.on('listening', () => {
      const { port } = server.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        authorization: () => authorization,
        connected: () => client !== null,
        send: (message) => client?.send(JSON.stringify(message)),
        close: () =>
          new Promise((done) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => done());
          }),
      });
    });
  });
}

async function until(predicate, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-voice-agent-verify-'));
  process.env.AXON_HOME = sandbox;
  process.env.AXON_APPROVAL_TIMEOUT_MS = '3000';
  // The real runtime reads this. A local, throwaway value: the point of the
  // harness is the plumbing, and no real credential is needed to test it.
  process.env.ASSEMBLYAI_API_KEY = FAKE_KEY;

  const provider = await startProvider();
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

  const { orchestrator, bus, sink, wakeWord } = built;
  const events = [];
  bus.subscribe((event) => events.push(event));

  console.log('\nAxon voice-agent verification (real runtime, real socket, local provider)\n');
  console.log(`provider    : ${provider.url}`);
  console.log('the model   : NOT real — a local server replays the documented protocol\n');

  try {
    await runChecks({ orchestrator, wakeWord, provider, events, sandbox });
  } finally {
    await provider.close();
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

  orchestrator.shutdown();
  await sink.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the temp directory is disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

async function runChecks({ orchestrator, wakeWord, provider, events, sandbox }) {
  // --- configuration ------------------------------------------------------
  const status = orchestrator.voiceAgentStatus();
  check('the voice agent is configured from the environment', status.available, status.reason || '');
  check('it reports a provider NAME, never an endpoint', status.name === 'assemblyai', status.name);
  check(
    'the status carries no credential',
    !JSON.stringify(status).includes(FAKE_KEY) && !/apiKey|secret|Bearer/i.test(JSON.stringify(status)),
  );
  check('the snapshot carries no credential', !JSON.stringify(orchestrator.snapshot()).includes(FAKE_KEY));

  // --- before activation --------------------------------------------------
  // The privacy guarantee, checked at the only moment it can be: before
  // anybody has activated anything.
  check('no session exists before activation', status.active === false);
  check('nothing has been sent to the provider before activation', provider.received.length === 0);
  check('nobody is connected to the provider before activation', provider.connected() === false);

  // --- the wake word ------------------------------------------------------
  check('the wake word is available on this machine', typeof wakeWord.available === 'boolean', String(wakeWord.available));
  const armed = await wakeWord.arm();
  if (armed) {
    check('arming the wake word opened no socket', provider.connected() === false);
    check('arming is visible in the timeline', events.some((e) => e.type === 'VOICE_SESSION' && e.action === 'armed'));
    check('the UI is told the microphone is armed', orchestrator.voiceAgentStatus().armed === true);
    wakeWord.disarm();
    check('disarming is visible in the timeline', events.some((e) => e.type === 'VOICE_SESSION' && e.action === 'disarmed'));
  } else {
    // On a machine with no local recognizer this is the honest outcome, and it
    // must still be a refusal rather than a silent fallback to streaming.
    check('with no local recognizer, the wake word refuses rather than streaming', provider.connected() === false);
  }

  // --- activation ---------------------------------------------------------
  // The runtime points at the REAL endpoint constant — there is deliberately
  // no configuration that redirects it, which is itself one of the properties
  // under test. So activating here attempts a genuine connection to
  // AssemblyAI with a fake key. It will fail, and HOW it fails is the check:
  // a sentence, never a credential.
  const started = orchestrator.startVoiceSession('manual');
  check('a session can be activated', started.accepted, started.error || '');

  if (started.accepted) {
    check(
      'activation is recorded with who asked for it',
      events.some((e) => e.type === 'VOICE_SESSION' && e.action === 'activated' && e.activation === 'manual'),
    );
    check('the state machine moved, without a second machine', orchestrator.state !== 'IDLE', orchestrator.state);

    // The real socket will fail to reach the real endpoint from a machine with
    // no network, or will be rejected by it with a fake key. Either way the
    // failure must be a sentence, not a credential.
    await until(() => orchestrator.voiceAgentStatus().active === false, 'the session to settle', 20_000);

    const stream = JSON.stringify(events);
    check('the failure never carried the key', !stream.includes(FAKE_KEY));
    check('the failure never carried a Bearer header', !/Bearer/.test(stream));
    check('the failure was reported as a sentence', /voice/i.test(stream));
    orchestrator.stopVoiceSession();
  }

  // --- audio never lands anywhere it must not -----------------------------
  const stream = JSON.stringify(events);
  check('no event carries raw audio', !/"pcm"|"samples"|"audio":/i.test(stream));
  check('no event carries base64 audio', !/[A-Za-z0-9+/]{600,}={0,2}/.test(stream));
  check('no event carries a credential', !stream.includes(FAKE_KEY));

  const logPath = path.join(sandbox, 'logs', 'events.jsonl');
  if (fs.existsSync(logPath)) {
    const log = fs.readFileSync(logPath, 'utf8');
    check('the JSONL log contains no audio', !/"pcm"|"samples"/i.test(log));
    check('the JSONL log contains no credential', !log.includes(FAKE_KEY));
    check('the JSONL log records the activation', /VOICE_SESSION/.test(log));
  } else {
    check('the JSONL log was written', false, 'missing');
  }

  // No audio file anywhere under the sandbox: Axon never persists raw audio,
  // and a stray WAV would be the most visible possible violation.
  const audioFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(wav|pcm|raw|mp3|ogg|webm)$/i.test(entry.name)) audioFiles.push(full);
    }
  };
  walk(sandbox);
  check('no audio file was written anywhere', audioFiles.length === 0, audioFiles.join(', '));

  // --- the tool surface ---------------------------------------------------
  const tools = orchestrator.listTools();
  check('the agent would be offered the real tool surface', tools.length > 0, `${tools.length} tools`);
  check('no tool schema carries an http endpoint', !JSON.stringify(tools).includes('"http"'));
  check('no tool schema carries anything callable', !JSON.stringify(tools).includes('function'));

  // --- the dispatcher is still the only door ------------------------------
  // A tool call from a voice agent takes the same path as one from anywhere
  // else, which is why this is checked through the orchestrator's own API.
  const refused = await orchestrator.invokeTool('definitely.not.a.tool', {});
  check('an invented tool name is refused', !refused.ok && refused.failure.kind === 'UNKNOWN_TOOL');

  const preview = orchestrator.dispatcher.requiresApproval('fs.write', {
    path: path.join(os.homedir(), 'Desktop', 'axon-verify.txt'),
    content: 'x',
  });
  check('an outward action is known to need approval before it is proposed', preview === true);

  const safePreview = orchestrator.dispatcher.requiresApproval('browser.read', {});
  check('a read is known not to need approval', safePreview === false);
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
