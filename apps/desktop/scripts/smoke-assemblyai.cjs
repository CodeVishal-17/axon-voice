/**
 * A real AssemblyAI smoke test.
 *
 *   npm run smoke:assemblyai
 *
 * WHAT IS REAL HERE — all of it, except the physical microphone.
 *
 *   - The real `ASSEMBLYAI_API_KEY` from `.env`.
 *   - A real WebSocket to wss://agents.assemblyai.com/v1/ws.
 *   - The real runtime, the real orchestrator, the real dispatcher.
 *   - Real audio: Windows SAPI synthesises the spoken phrases to real PCM,
 *     which is fed in exactly where microphone frames arrive.
 *   - A real reply from AssemblyAI's managed model, in real synthesised audio.
 *
 * WHAT IS NOT REAL, STATED PLAINLY: nobody speaks into a microphone. The audio
 * is generated on this machine and injected at the frame boundary rather than
 * captured from a device. That covers the network, the protocol, the key, the
 * transcription, the model and the returned audio — and it does NOT cover the
 * microphone hardware, the renderer's capture path, or acoustic wake-word
 * recognition in a room. Those need a person, and the report says so.
 *
 * THE KEY IS NEVER PRINTED. It is read by the runtime from the environment and
 * never touched by this file; every line below prints only shapes and counts.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const results = [];
function step(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** Resample 16-bit PCM between rates. Linear, which is fine for speech. */
function resamplePcm16(bytes, fromRate, toRate) {
  if (fromRate === toRate) return bytes;
  const input = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const ratio = toRate / fromRate;
  const out = new Int16Array(Math.floor(input.length * ratio));
  for (let i = 0; i < out.length; i += 1) {
    const source = i / ratio;
    const low = Math.floor(source);
    const high = Math.min(low + 1, input.length - 1);
    const t = source - low;
    out[i] = Math.round(input[low] * (1 - t) + input[high] * t);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-smoke-'));
  process.env.AXON_HOME = sandbox;

  const runtime = require(path.join(outDir, 'runtime.js'));

  // The product's own loader, before anything reads the environment — exactly
  // as `index.ts` does at bootstrap. The key is placed in `process.env` and
  // read from there by the runtime; this file never touches its value.
  const envFile = runtime.loadEnvFile(
    runtime.envFileCandidates(path.resolve(__dirname, '..'), process.cwd()),
    process.env,
  );
  console.log(`  configuration: ${envFile.applied} variable(s) from ${envFile.path ?? 'no .env found'}
`);

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

  const { orchestrator, bus, sink, speech, speechTransport, captureTransport, wakeWord } = built;

  /**
   * The capture id main mints for the voice session.
   *
   * Learned the way the renderer learns it — by receiving the capture command
   * — rather than by reaching into the orchestrator. Frames are then pushed
   * back through `pushAudioFrame`, which is the same public method the IPC
   * bridge calls, so this audio takes exactly the path microphone audio takes.
   */
  let voiceCaptureId = null;
  captureTransport.attach({
    command: (command) => {
      if (command.action === 'start') voiceCaptureId = command.captureId;
      else if (command.captureId === voiceCaptureId) voiceCaptureId = null;
    },
  });
  const pushFrame = (samples) => {
    if (voiceCaptureId) orchestrator.pushAudioFrame(voiceCaptureId, samples);
  };
  const events = [];
  bus.subscribe((event) => events.push(event));

  console.log('\nAxon — real AssemblyAI voice smoke test');
  console.log('  real key, real socket, real model. Audio is synthesised, not spoken.\n');

  try {
    await run({ orchestrator, speech, speechTransport, wakeWord, events, pushFrame });
  } catch (error) {
    step('the smoke test ran to completion', false, error instanceof Error ? error.message : String(error));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);

  orchestrator.shutdown();
  await sink.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

async function run({ orchestrator, speech, speechTransport, wakeWord, events, pushFrame }) {
  // --- 0. configuration ---------------------------------------------------
  const status = orchestrator.voiceAgentStatus();
  step('ASSEMBLYAI_API_KEY loaded and a provider built', status.available, status.reason || status.name);
  if (!status.available) return;

  // --- 1. the wake phrase, through the real local recognizer --------------
  // Real Windows speech recognition, real synthesised audio, real matcher.
  // What this does not cover is a microphone in a room.
  const wakeAudio = await synthesise(speech, speechTransport, 'Hey Axon');
  if (wakeAudio) {
    let heard = false;
    const detector = wakeWord;
    const originalArm = detector.isArmed;
    void originalArm;

    // Arm, feed the phrase in frames, and see whether it fires.
    const armed = await detector.arm();
    step('the local wake-word recognizer started', armed);

    if (armed) {
      // The detector's own onWake goes to the orchestrator; observe the
      // VOICE_SESSION event instead of reaching inside it.
      const before = events.filter((e) => e.type === 'VOICE_SESSION' && e.action === 'activated').length;

      // 16 kHz for the local recognizer, in ~64ms frames as the renderer sends,
      // AT ROUGHLY REAL TIME. A recognizer fed twelve times faster than speech
      // is a recognizer being handed something that does not sound like
      // speech, and the first attempt at this test failed for exactly that
      // reason rather than because the matcher was wrong.
      const pcm = resamplePcm16(wakeAudio.bytes, wakeAudio.sampleRate, 16_000);
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const wakeFrame = 1024;
      const frameMs = (wakeFrame / 16_000) * 1000;

      for (let i = 0; i < samples.length; i += wakeFrame) {
        detector.pushFrame(samples.slice(i, Math.min(i + wakeFrame, samples.length)));
        await new Promise((resolve) => setTimeout(resolve, frameMs));
      }

      // And then silence. `System.Speech.Recognition` finalises a phrase when
      // it hears the end of one; with no trailing silence it keeps waiting for
      // more words and never reports what it already has.
      const quiet = new Int16Array(wakeFrame);
      for (let i = 0; i < 25; i += 1) {
        detector.pushFrame(quiet);
        await new Promise((resolve) => setTimeout(resolve, frameMs));
      }

      heard = await until(
        () => events.filter((e) => e.type === 'VOICE_SESSION' && e.action === 'activated').length > before,
        12_000,
      );
      step(
        'saying "Hey Axon" activated a session',
        heard,
        heard ? 'the wake phrase was recognised locally' : 'the local recognizer did not report the phrase',
      );
      detector.disarm();

    }

    // Whether or not the wake word fired, the conversation itself is tested
    // below through explicit activation — the two are separate claims.
    if (heard) orchestrator.stopVoiceSession();
    await until(() => orchestrator.voiceAgentStatus().active === false, 5_000);
  } else {
    step('speech synthesis is available to generate test audio', false, 'no synthesiser on this machine');
  }

  // --- 2. a real conversation with AssemblyAI -----------------------------
  const started = orchestrator.startVoiceSession('manual');
  step('a voice session was accepted', started.accepted, started.error || '');
  if (!started.accepted) return;

  const connected = await until(
    () => events.some((e) => e.type === 'VOICE_SESSION' && e.action === 'connected'),
    25_000,
  );
  step('the real AssemblyAI socket connected and the session is ready', connected);

  if (!connected) {
    const failure = events.filter((e) => e.type === 'ERROR' || e.type === 'OBSERVATION').slice(-3);
    console.log('    last events:', failure.map((e) => e.message ?? e.summary).join(' | '));
    orchestrator.stopVoiceSession();
    return;
  }

  // --- 3. speak to it -----------------------------------------------------
  const phrase = 'Hello Axon, can you hear me?';
  const audio = await synthesise(speech, speechTransport, phrase);
  step('test audio was synthesised', Boolean(audio), audio ? `${audio.bytes.length} bytes` : 'none');
  if (!audio) {
    orchestrator.stopVoiceSession();
    return;
  }

  // Injected exactly where microphone frames arrive, at the agent's rate, in
  // real time — a burst would be discarded by the provider's turn detection.
  const pcm = resamplePcm16(audio.bytes, audio.sampleRate, 24_000);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const frame = 1024;
  for (let i = 0; i < samples.length; i += frame) {
    pushFrame(samples.slice(i, Math.min(i + frame, samples.length)));
    await new Promise((resolve) => setTimeout(resolve, (frame / 24_000) * 1000));
  }
  // Trailing silence, so the provider's turn detector sees the end of speech.
  const silence = new Int16Array(frame);
  for (let i = 0; i < 40; i += 1) {
    pushFrame(silence);
    await new Promise((resolve) => setTimeout(resolve, (frame / 24_000) * 1000));
  }

  // --- 4. did it hear us? -------------------------------------------------
  const transcribed = await until(() => events.some((e) => e.type === 'USER_MESSAGE'), 25_000);
  const said = events.find((e) => e.type === 'USER_MESSAGE');
  step(
    'AssemblyAI transcribed the spoken phrase',
    transcribed,
    said ? `heard: "${said.text}"` : 'no transcript arrived',
  );

  // --- 5. did it answer? --------------------------------------------------
  const replied = await until(() => events.some((e) => e.type === 'ASSISTANT_MESSAGE'), 30_000);
  const reply = events.find((e) => e.type === 'ASSISTANT_MESSAGE');
  step('the agent replied', replied, reply ? `said: "${reply.text}"` : 'no reply arrived');

  const spoke = events.some((e) => e.type === 'STATE_CHANGED' && e.to === 'SPEAKING');
  step('the reply came back as audio', spoke, spoke ? 'entered SPEAKING on real reply audio' : 'no audio phase');

  // --- 6. nothing leaked --------------------------------------------------
  const stream = JSON.stringify(events);
  step('no event carried audio', !/"pcm"|"samples"|"audio":/i.test(stream));
  step('no event carried a credential', !/Bearer|api[_-]?key/i.test(stream));

  orchestrator.stopVoiceSession();
  await until(() => orchestrator.voiceAgentStatus().active === false, 8_000);
  step('the session closed cleanly', orchestrator.voiceAgentStatus().active === false);
}

/**
 * Synthesise a phrase to PCM with the real Windows synthesiser.
 *
 * Goes through the REAL speech service and the REAL transport — the harness
 * attaches a sink exactly as the renderer bridge does, and reads the bytes
 * main chose to deliver. No test-only method was added to the product for
 * this: a hook that exists only for a harness is a hook that can be called by
 * something else, and this milestone does not add one.
 */
async function synthesise(speech, speechTransport, text) {
  let delivered = null;
  speechTransport.attach({
    deliver: (payload) => {
      delivered = payload;
    },
    chunk: () => {},
    stop: () => {},
  });

  try {
    const started = await speech.speak(text);
    if (!started) return null;
    const arrived = await until(() => delivered !== null, 20_000);
    if (!arrived || !delivered) return null;
    return parseWavForTest(delivered.bytes);
  } catch {
    return null;
  } finally {
    speech.cancel('cancelled');
    speechTransport.detach();
  }
}

/**
 * Pull the sample rate and the PCM body out of a WAV.
 *
 * Written here rather than imported so the harness reads the bytes the product
 * actually produced, with no shared code that could agree with a bug.
 */
function parseWavForTest(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 44) return null;

  let offset = 12; // past "RIFF" + size + "WAVE"
  let sampleRate = 0;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') sampleRate = view.getUint32(body + 4, true);
    if (id === 'data') {
      return {
        sampleRate,
        bytes: Buffer.from(bytes.buffer, bytes.byteOffset + body, Math.min(size, view.byteLength - body)),
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

app.on('window-all-closed', () => {});

app.whenReady().then(
  () => {
    main().catch((error) => {
      console.error('\nSmoke test crashed:', error);
      app.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
