/**
 * AXON PREFLIGHT — the thirty seconds before you walk on stage.
 *
 *   npm run preflight
 *
 * Builds the REAL runtime in a REAL Electron process and asks each subsystem
 * one question about the machine as it is right now. Nothing is exercised end
 * to end and no conversation is started: this answers "is the equipment
 * plugged in", not "does Axon work" — the suites and harnesses answer that.
 *
 * WHAT IT WILL AND WILL NOT TELL YOU.
 *
 * - The key check reads the runtime's own status, which reports availability
 *   and a provider NAME. This script never reads the key itself, and the
 *   value is registered as a secret with the report so that a probe which
 *   accidentally interpolated one would still not print it.
 * - The reachability check is a TCP connect to the provider's host. It proves
 *   the venue's network lets Axon out; it does NOT prove the key is accepted,
 *   and the wording says "reachable" rather than "connected" for that reason.
 * - The renderer check is a SKIP, always, and honestly: this process has no
 *   window. The app proves it at startup, and a preflight that claimed it
 *   would be inventing evidence.
 *
 * It leaves nothing behind: a temporary AXON_HOME, removed at the end.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { app, systemPreferences } = require('electron');

/** A TCP connect with a deadline. No TLS, no request, no credential. */
function reachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, why) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt, why });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, `no answer in ${timeoutMs}ms`));
    socket.once('error', (error) => done(false, error.code || error.message));
  });
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const runtime = require(path.join(outDir, 'runtime.js'));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-preflight-'));

  // The product's own `.env` loader, exactly as `index.ts` runs it at
  // bootstrap. The first version of this script skipped it and reported "no
  // key configured" on a machine where the app would have found one — a
  // preflight that disagrees with the product is worse than no preflight.
  const envFile = runtime.loadEnvFile(
    runtime.envFileCandidates(path.resolve(__dirname, '..'), process.cwd()),
    process.env,
  );

  // The real environment, including the real key if one is configured — this
  // is a preflight for a real demo, so it has to look at the real setup. The
  // key's VALUE is handed to the report only as a secret to redact.
  const apiKey = process.env.ASSEMBLYAI_API_KEY ?? '';

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
    env: { ...process.env, AXON_HOME: sandbox },
    sessionData: app.getPath('sessionData'),
    hotkey: null,
  });

  const { orchestrator, sink, wakeWord, speech } = built;
  const endpointHost = runtime.VOICE_AGENT_HOST;

  const probes = {
    'AssemblyAI key': () => {
      const status = orchestrator.voiceAgentStatus();
      return status.available
        ? { status: 'OK', detail: `provider ${status.name}` }
        : { status: 'FAIL', detail: status.reason ?? 'no voice agent configured' };
    },

    'AssemblyAI reachable': async () => {
      const result = await reachable(endpointHost, 443, 4000);
      return result.ok
        ? { status: 'OK', detail: `${endpointHost} answered in ${result.ms}ms` }
        : { status: 'FAIL', detail: `${endpointHost}: ${result.why}` };
    },

    Microphone: () => {
      // Windows reports a permission, not a device list, from the main
      // process. "denied" is the one answer that certainly breaks the demo.
      let access = 'unknown';
      try {
        access = systemPreferences.getMediaAccessStatus('microphone');
      } catch {
        access = 'unknown';
      }
      if (access === 'denied' || access === 'restricted') {
        return { status: 'FAIL', detail: `system access ${access}` };
      }
      return access === 'granted'
        ? { status: 'OK', detail: 'system access granted' }
        : { status: 'SKIP', detail: `system access ${access}; the device is opened by the window` };
    },

    'Audio output': () => {
      const status = speech.status();
      return status.available
        ? { status: 'OK', detail: status.name }
        : { status: 'FAIL', detail: status.reason ?? 'no speech engine' };
    },

    'Wake word': async () => {
      // Name the ENGINE, not just "it worked". There are two, only one of them
      // has ever passed a human microphone test, and a preflight that says OK
      // without saying which one is listening is a preflight that would have
      // passed on the morning of the 0/15.
      const status = wakeWord.getStatus();
      if (!wakeWord.available) {
        return { status: 'FAIL', detail: status.unavailableReason ?? 'no local detector on this machine' };
      }
      const armed = await wakeWord.arm();
      const armedStatus = wakeWord.getStatus();
      wakeWord.disarm();
      return armed
        ? { status: 'OK', detail: `${armedStatus.detail} — started and stopped` }
        : { status: 'FAIL', detail: `${status.detail} would not start` };
    },

    Renderer: () => ({ status: 'SKIP', detail: 'no window in preflight; the app proves this at startup' }),

    'Main process': () => ({
      status: app.isReady() ? 'OK' : 'FAIL',
      detail: `electron ${process.versions.electron}`,
    }),

    'Tool registry': () => {
      const tools = orchestrator.listTools();
      return tools.length > 0
        ? { status: 'OK', detail: `${tools.length} tools` }
        : { status: 'FAIL', detail: 'no tools registered' };
    },

    Policy: () => {
      // A read-only question to the real policy: would submitting text need a
      // human? The ANSWER is the check — a policy that is not loaded cannot
      // answer, and one that answered "no" here would be the wrong policy.
      //
      // Asked about SAVING A MEMORY, not a browser submit: a submit needs an
      // element reference from a page read, and with no page read the
      // dispatcher's precheck refuses it before the policy is ever asked — so
      // that probe reported FAIL on a healthy policy. And the tool must really
      // be registered: `requiresApproval` answers yes for an unknown tool,
      // which would make this check pass on nothing.
      const registered = orchestrator.listTools().some((tool) => tool.name === 'memory.save');
      if (!registered) return { status: 'FAIL', detail: 'memory.save is not registered, so the policy could not be asked' };
      const needsApproval = orchestrator.dispatcher.requiresApproval('memory.save', {
        category: 'preference',
        key: 'preflight',
        value: 'preflight',
      });
      return needsApproval
        ? { status: 'OK', detail: 'a consequential act still asks a human' }
        : { status: 'FAIL', detail: 'the policy did not ask for approval on a consequential act' };
    },

    Browser: () => {
      const status = orchestrator.browserStatus();
      return status.available
        ? { status: 'OK', detail: status.open ? 'available, a window is open' : 'available' }
        : { status: 'FAIL', detail: status.reason ?? 'unavailable' };
    },

    'Desktop accessibility': async () => {
      // The only probe that actually runs a tool, because there is no other
      // way to know whether UI Automation answers on this machine — and it is
      // the subsystem most likely to be broken by a Windows update.
      const startedAt = Date.now();
      const result = await orchestrator.invokeTool('window.list', {});
      const ms = Date.now() - startedAt;
      return result.ok
        ? { status: 'OK', detail: `UI Automation answered in ${ms}ms` }
        : { status: 'FAIL', detail: result.failure ? result.failure.kind : 'window.list failed' };
    },

    'Task ledger': () => {
      // Read-only: it must answer about a task that does not exist without
      // inventing one.
      const unknown = orchestrator.tasks.statusOf('preflight-no-such-task');
      const wanted = orchestrator.tasks.wants('preflight-no-such-task');
      return unknown === null && wanted === false
        ? { status: 'OK', detail: 'answering, with nothing active' }
        : { status: 'FAIL', detail: 'the ledger claimed a task that does not exist' };
    },

    'Approval system': () => {
      // Also read-only, and the answer is a refusal: resolving an approval
      // nobody asked for must fail.
      const resolved = orchestrator.resolveApproval('preflight-no-such-call', 'DENY');
      const pending = orchestrator.snapshot().pendingApprovals;
      return resolved === false && Array.isArray(pending)
        ? { status: 'OK', detail: `${pending.length} pending; unknown ids refused` }
        : { status: 'FAIL', detail: 'the broker accepted a decision for a call it never made' };
    },
  };

  const report = await runtime.runPreflight(probes, { secrets: [apiKey] });
  // The PATH of the file, never its contents: which configuration was read is
  // the first thing to know when a check disagrees with expectations.
  console.log(`\n  configuration: ${envFile.applied} variable(s) from ${envFile.path ?? 'no .env found'}`);
  console.log(`\n${runtime.renderPreflight(report)}\n`);

  orchestrator.shutdown();
  await sink.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the temp directory is disposable */
  }

  app.exit(report.ready ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error('preflight crashed:', error);
  app.exit(1);
});
