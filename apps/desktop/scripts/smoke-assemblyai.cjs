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

/** Timings from the live run. Filled in as it goes; printed at the end. */
const performance = { connectMs: null, lastSpeechEndedAt: null, requests: [] };

function printPerformance() {
  const ms = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.max(0, Math.round(value))}ms` : '-');
  console.log('\nPERFORMANCE (live; every column is milliseconds after the speaker stopped, except execute)');
  console.log(`  AssemblyAI connection   ${ms(performance.connectMs)}`);
  console.log('  request                          transcribe  propose  execute  first sound  answer  utterances');
  for (const r of performance.requests) {
    console.log(
      `  ${r.utterance.padEnd(32)} ${ms(r.transcribeMs).padStart(10)} ${ms(r.proposeMs).padStart(8)} ${ms(r.executeMs).padStart(8)}` +
        ` ${ms(r.firstWordsMs).padStart(12)} ${ms(r.answerMs).padStart(7)} ${String(r.utterances).padStart(11)}`,
    );
  }
  const phases = performance.requests.flatMap((r) => [
    ['transcribe', r.utterance, r.transcribeMs],
    ['propose', r.utterance, r.proposeMs],
    ['execute', r.utterance, r.executeMs],
  ]);
  const slowest = phases.filter((entry) => typeof entry[2] === 'number').sort((a, b) => b[2] - a[2])[0];
  if (slowest) console.log(`  slowest single phase: ${slowest[0]} for "${slowest[1]}", ${ms(slowest[2])}`);
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
  // THE PRESENTER AT THE DIALOG. Any approval this run raises is DENIED after
  // a human-sized pause, through the same resolve call the dialog makes. The
  // canonical demo denies the consequential act on stage; this is that, live.
  // Nothing is ever allowed by this harness.
  bus.subscribe((event) => {
    if (event.type !== 'APPROVAL_REQUIRED') return;
    setTimeout(() => {
      orchestrator.resolveApproval(event.request.callId, 'DENY', event.request.binding.fingerprint);
    }, 1_500);
  });

  console.log('\nAxon — real AssemblyAI voice smoke test');
  console.log('  real key, real socket, real model. Audio is synthesised, not spoken.\n');

  try {
    await run({ orchestrator, speech, speechTransport, wakeWord, events, pushFrame, built });
  } catch (error) {
    step('the smoke test ran to completion', false, error instanceof Error ? error.message : String(error));
  }

  const failed = results.filter((r) => !r.ok).length;
  printPerformance();
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

async function run({ orchestrator, speech, speechTransport, wakeWord, events, pushFrame, built }) {
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
  const activatedAt = Date.now();
  const started = orchestrator.startVoiceSession('manual');
  step('a voice session was accepted', started.accepted, started.error || '');
  if (!started.accepted) return;

  const connected = await until(
    () => events.some((e) => e.type === 'VOICE_SESSION' && e.action === 'connected'),
    25_000,
  );
  if (connected) performance.connectMs = Date.now() - activatedAt;
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

  // --- 6. the Phase 2 conversation ----------------------------------------
  // Six real requests, spoken to a real model over a real socket, each one
  // followed all the way through: transcript -> tool proposal -> dispatcher ->
  // execution -> verification -> spoken answer.
  //
  // NOTHING CONSEQUENTIAL IS ASKED FOR. No account, no password, no purchase,
  // nothing destructive. The two applications it opens are the two the
  // registry classifies SAFE, and the two sites it opens are public pages.
  const say = async (text) => {
    const clip = await synthesise(speech, speechTransport, text);
    if (!clip) return false;
    const body = resamplePcm16(clip.bytes, clip.sampleRate, 24_000);
    const frames = new Int16Array(body.buffer, body.byteOffset, Math.floor(body.byteLength / 2));
    const size = 1024;
    for (let i = 0; i < frames.length; i += size) {
      pushFrame(frames.slice(i, Math.min(i + size, frames.length)));
      await new Promise((resolve) => setTimeout(resolve, (size / 24_000) * 1000));
    }
    // The moment the speaker stopped. Transcription latency is measured from
    // HERE, not from the end of the trailing silence — the first version of
    // this timing measured from after the silence, which is after the
    // transcript had already arrived, and reported 0ms for everything.
    performance.lastSpeechEndedAt = Date.now();
    const quiet = new Int16Array(size);
    for (let i = 0; i < 40; i += 1) {
      pushFrame(quiet);
      await new Promise((resolve) => setTimeout(resolve, (size / 24_000) * 1000));
    }
    return true;
  };

  /**
   * One spoken request, followed the whole way down and back.
   *
   * `expected` is the tool Axon SHOULD reach for. A different tool is not
   * automatically a failure of the pipeline — a model may answer a question
   * without one — so the step reports what actually happened rather than
   * insisting, except where the whole point is that a tool was used.
   */
  /**
   * Wait until Axon has stopped talking.
   *
   * WHY THE HARNESS NEEDS THIS. A slow action produces two utterances — an
   * acknowledgement, then the outcome — and the second arrives on its own
   * clock. Capturing a baseline before that straggler lands attributes it to
   * the NEXT request, which made this harness report one turn's answer as
   * another's. That is a measurement bug, not a product one, but a live test
   * that cannot say which sentence belongs to which request cannot check the
   * one property Phase 3 is about.
   *
   * So each request begins from silence, the way a person would.
   */
  const settle = async (quietMs = 4_000, ceilingMs = 20_000) => {
    const deadline = Date.now() + ceilingMs;
    let lastCount = -1;
    let quietSince = Date.now();
    for (;;) {
      const count = events.filter((e) => e.type === 'ASSISTANT_MESSAGE').length;
      if (count !== lastCount) {
        lastCount = count;
        quietSince = Date.now();
      }
      if (Date.now() - quietSince >= quietMs) return;
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const request = async ({ utterance, expected, requireTool, timeoutMs = 45_000 }) => {
    // From silence, so every utterance below belongs to THIS request.
    await settle();
    const callsBefore = events.filter((e) => e.type === 'TOOL_CALL').length;
    const repliesBefore = events.filter((e) => e.type === 'ASSISTANT_MESSAGE').length;
    const heardBefore = events.filter((e) => e.type === 'USER_MESSAGE').length;

    const spoke = await say(utterance);
    // Every latency below is measured from HERE: the moment the speaker
    // stopped talking, which is when a listener starts waiting.
    const speechEnd = performance.lastSpeechEndedAt;
    if (!spoke) {
      step(`"${utterance}" — audio could be synthesised`, false, 'no synthesiser');
      return null;
    }

    await until(() => events.filter((e) => e.type === 'USER_MESSAGE').length > heardBefore, 25_000);
    const heard = events.filter((e) => e.type === 'USER_MESSAGE').slice(heardBefore)[0];

    // The tool, then the result, then the spoken answer. Waiting for the
    // ASSISTANT_MESSAGE last is what makes this an end-to-end claim rather
    // than a claim about a tool call.
    await until(() => events.filter((e) => e.type === 'TOOL_CALL').length > callsBefore, timeoutMs);
    const calls = events.filter((e) => e.type === 'TOOL_CALL').slice(callsBefore);
    const results = () => events.filter((e) => e.type === 'TOOL_RESULT').slice(
      events.filter((e) => e.type === 'TOOL_RESULT').length - calls.length,
    );

    await until(() => events.filter((e) => e.type === 'ASSISTANT_MESSAGE').length > repliesBefore, timeoutMs);
    // Let the exchange finish. A slow action is acknowledged first and
    // answered second, so the LAST thing said about this request is the
    // answer. Waiting for silence also stops the next phrase being injected
    // while Axon is still speaking, which the provider hears as one garbled
    // utterance.
    await settle();
    // Only what was said AFTER this request was heard belongs to it. A
    // straggler from the previous request that lands after the baseline was
    // taken would otherwise be reported as this request's answer — which is
    // exactly how a live run once scored "Open YouTube" as answered with
    // "GitHub is open."
    const heardAt = heard ? Date.parse(heard.at) : 0;
    const replies = events
      .filter((e) => e.type === 'ASSISTANT_MESSAGE')
      .slice(repliesBefore)
      .filter((e) => Date.parse(e.at) >= heardAt);
    const reply = replies[replies.length - 1];

    const used = calls.map((c) => c.tool);
    const matched = used.includes(expected);
    // THIS request's result: joined by call id to a call this request made.
    // Looking up "the last result for this tool name" let one request inherit
    // another's result — a navigation that never finished was reported as
    // executed because the PREVIOUS navigation had been.
    const ownCallIds = new Set(calls.filter((c) => c.tool === expected).map((c) => c.callId));
    const outcome = events.filter((e) => e.type === 'TOOL_RESULT' && ownCallIds.has(e.callId)).slice(-1)[0];

    // MEASURED, NOT FELT. Every number is a difference between two event
    // timestamps (or the moment the audio finished sending), so it describes
    // what the pipeline did rather than how long the harness waited. Reported
    // only: no step passes or fails on a number.
    const at = (event) => (event ? Date.parse(event.at) : null);
    const timedCall = calls.find((c) => c.tool === expected) ?? calls[0];
    const firstReply = replies[0];
    performance.requests.push({
      utterance,
      transcribeMs: heard && speechEnd ? at(heard) - speechEnd : null,
      proposeMs: timedCall && speechEnd ? at(timedCall) - speechEnd : null,
      executeMs: outcome ? outcome.durationMs : null,
      // First SOUND: the machine entering SPEAKING on real reply audio, which
      // is what a listener hears. The transcript text arrives later, with the
      // end of the reply, and measured the reply's length rather than its
      // start.
      firstWordsMs: (() => {
        if (!speechEnd) return null;
        const speaking = events.find((e) => e.type === 'STATE_CHANGED' && e.to === 'SPEAKING' && Date.parse(e.at) >= speechEnd);
        return speaking ? at(speaking) - speechEnd : firstReply ? at(firstReply) - speechEnd : null;
      })(),
      answerMs: reply && speechEnd ? at(reply) - speechEnd : null,
      utterances: new Set(replies.map((entry) => entry.text)).size,
    });

    step(
      `"${utterance}" was heard`,
      Boolean(heard),
      heard ? `heard: "${heard.text}"` : 'no transcript',
    );

    if (requireTool) {
      step(
        `it went through ${expected}, in the dispatcher`,
        matched,
        used.length > 0 ? `called: ${used.join(', ')}` : 'no tool was called',
      );
      if (outcome) {
        step(
          `${expected} was executed and its result recorded`,
          typeof outcome.ok === 'boolean',
          outcome.ok ? 'ok' : `failed: ${outcome.failure && outcome.failure.kind}`,
        );
      }
    } else {
      step(`it produced a spoken answer`, Boolean(reply), used.length > 0 ? `via ${used.join(', ')}` : 'no tool needed');
    }

    step(
      `Axon answered out loud, briefly`,
      Boolean(reply) && reply.text.length > 0,
      reply
        ? `said: "${reply.text}" (${reply.text.length} chars${
            new Set(replies.map((entry) => entry.text)).size > 1 ? ', after an acknowledgement' : ''
          })`
        : 'no reply',
    );

    // THE PHASE 3 PROPERTY, ASSERTED AGAINST A REAL CONVERSATION.
    //
    // A slow action produces two utterances: an acknowledgement, then the
    // outcome. That is fine and it is the design. What must NEVER happen is
    // the first one claiming an outcome — because the outcome did not exist
    // when it was spoken, so any claim in it is a guess, and in live testing
    // the guess was "it failed" about work that had succeeded.
    //
    // So: whatever the first utterance says, it must not assert that the thing
    // worked or that it failed.
    // DISTINCT sentences. The provider can transcribe one reply more than
    // once, and Axon now collapses those — but the harness compares text
    // rather than counting events, so it is measuring what the user heard
    // rather than what the socket sent.
    const distinct = [...new Set(replies.map((entry) => entry.text))];
    if (distinct.length > 1) {
      const first = distinct[0];
      const claimsOutcome =
        /(is open|opened|captured|did not load|didn.t load|could not|couldn.t|failed|unable)/i.test(first);
      step(
        'the first thing Axon said claimed no outcome it did not have yet',
        !claimsOutcome,
        `first: "${first}"`,
      );
    }

    void results;
    return { reply, calls, outcome };
  };

  // 1. The clock. The whole point is that it goes through the tool.
  const time = await request({ utterance: 'What time is it?', expected: 'system.time', requireTool: true });
  if (time && time.outcome && time.outcome.ok && time.reply) {
    // Compared against WHAT THE TOOL RETURNED, not against the clock now.
    // Reading `new Date()` at assertion time fails whenever the minute rolls
    // over between the tool call and the check, which says nothing about
    // Axon and everything about the harness.
    const reading = time.outcome.output;
    const twentyFour = reading.time.slice(0, 2);
    const twelve = String(((Number(twentyFour) + 11) % 12) + 1);
    const spoken = time.reply.text.toLowerCase();
    const words = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
    const spokenHour =
      spoken.includes(twentyFour) || spoken.includes(twelve) || spoken.includes(words[Number(twelve) % 12]);
    step(
      'the spoken time matches what the tool read off this machine',
      spokenHour,
      `the tool read ${reading.time}; Axon said "${time.reply.text}"`,
    );
  }

  // 2 and 3. Two applications, both SAFE in the registry.
  await request({ utterance: 'Open Calculator.', expected: 'app.open', requireTool: true });
  await request({ utterance: 'Open Notepad.', expected: 'app.open', requireTool: true });

  // 4. A look at the screen, which is now an observation rather than a file.
  const shot = await request({
    utterance: 'Take a screenshot of my screen.',
    expected: 'system.screenshot',
    requireTool: true,
  });
  if (shot && shot.outcome && shot.outcome.ok) {
    const output = shot.outcome.output;
    step('the screenshot produced a visual observation', /^v\d+$/.test(String(output.observation)), String(output.observation));
    step(
      'Axon did not claim to be able to show the picture',
      shot.reply ? !/here (it|is)|attached|have a look at the image/i.test(shot.reply.text) : false,
      shot.reply ? shot.reply.text : '',
    );
  }

  // 5 and 6. Two public pages, through the bounded navigation.
  for (const site of ['Open GitHub.', 'Open YouTube.']) {
    const nav = await request({ utterance: site, expected: 'browser.open', requireTool: true, timeoutMs: 60_000 });
    if (nav && nav.outcome && nav.outcome.ok) {
      const status = nav.outcome.output && nav.outcome.output.navigation && nav.outcome.output.navigation.status;
      step(`${site} reported a navigation status`, Boolean(status), String(status));
      if (status !== 'SUCCESS' && nav.reply) {
        step(
          'it did not claim a page opened that Axon could not confirm',
          !/is open|opened it|it.s open/i.test(nav.reply.text),
          nav.reply.text,
        );
      }
    }
  }

  // 7. CANONICAL BEAT 7, live: arithmetic is answered, not acted out.
  const callsBeforeMath = events.filter((e) => e.type === 'TOOL_CALL').length;
  const math = await request({ utterance: 'Calculate 125 times 48.', expected: null, requireTool: false });
  if (math && math.reply) {
    step(
      'canonical beat "Calculate 125 times 48." gets the right answer',
      /6,?000|six thousand/i.test(math.reply.text),
      `said: "${math.reply.text}"`,
    );
    step(
      'and it pressed nothing on screen to get it',
      !events.slice(0).filter((e) => e.type === 'TOOL_CALL').slice(callsBeforeMath).some((e) => e.tool === 'ui.click' || e.tool === 'keyboard.type'),
    );
  }

  // 8. CANONICAL BEAT 3, live, on the real YouTube page Axon just opened.
  // What the model does here is ITS choice and is reported, not assumed: it
  // may type into the search box and submit (an approval, denied above), or
  // open a results address directly (a page load, which asks nothing). The
  // one thing asserted is the boundary: no submission happened without a
  // human decision, and every decision in this run was a denial.
  const callsBeforeSearch = events.filter((e) => e.type === 'TOOL_CALL').length;
  const approvalsBeforeSearch = events.filter((e) => e.type === 'APPROVAL_REQUIRED').length;
  const search = await request({
    utterance: 'Search for AssemblyAI Voice Agent.',
    expected: 'browser.type',
    requireTool: false,
    timeoutMs: 90_000,
  });
  if (search) {
    const searchCalls = events.filter((e) => e.type === 'TOOL_CALL').slice(callsBeforeSearch);
    const submits = searchCalls.filter((c) => c.tool === 'browser.type' && c.input && c.input.submit === true);
    const submitIds = new Set(submits.map((c) => c.callId));
    const submittedOk = events.filter((e) => e.type === 'TOOL_RESULT' && submitIds.has(e.callId) && e.ok);
    const asked = events.filter((e) => e.type === 'APPROVAL_REQUIRED').slice(approvalsBeforeSearch);
    // What this does NOT establish, stated so the detail line is read right: a
    // script-driven search button (YouTube's is one) is an ordinary click to
    // Axon, so typed text can reach the site through it without an approval.
    // Only form submissions and consequential destinations ask.
    step(
      'canonical beat "Search for AssemblyAI Voice Agent." made no form submission without a person deciding',
      submittedOk.length === 0,
      `path: ${searchCalls.map((c) => c.tool).join(' -> ') || 'no tool'}; approvals asked: ${asked.length}` +
        (asked[0] ? ` ("${asked[0].request.title}")` : ''),
    );
  }

  // --- 9. the demo recording, when this run was asked to make one ---------
  if (built && built.demoRecording) {
    const file = built.demoRecording.close();
    const contents = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const rows = contents.trim() === '' ? [] : contents.trim().split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    step('the demo recording was written, one row per step', rows.length > 0, `${rows.length} rows`);
    // The value is compared, never printed.
    const key = process.env.ASSEMBLYAI_API_KEY || '';
    step('the demo recording contains no API key', key.length < 8 || !contents.includes(key));
    step('the demo recording contains no audio', !/"pcm"|"samples"|"audio"|[A-Za-z0-9+/]{400,}/.test(contents));
    step(
      'the demo recording carries only the recorded fields',
      rows.every((line) => {
        try {
          const keys = Object.keys(JSON.parse(line)).sort().join(',');
          return keys === 'approval,at,goal,latencyMs,risk,status,stepId,taskId,tool,verified';
        } catch {
          return false;
        }
      }),
    );
    step('the demo recording contains no tool arguments or page text', !/"input"|"output"|UNTRUSTED_WEB_CONTENT|"url"/.test(contents));
  }

  // --- 7. nothing leaked --------------------------------------------------
  const stream = JSON.stringify(events);
  step('no event carried audio', !/"pcm"|"samples"|"audio":/i.test(stream));
  step('no event carried a credential', !/Bearer|api[_-]?key/i.test(stream));
  {
    // When a call has no result, the count alone is useless for debugging.
    // Name the call and print the SHAPE of what happened after it — types,
    // state names and Axon's own summaries, never an argument or a page.
    const resultIds = new Set(events.filter((e) => e.type === 'TOOL_RESULT').map((e) => e.callId));
    for (const orphan of events.filter((e) => e.type === 'TOOL_CALL' && !resultIds.has(e.callId))) {
      console.log(`    no result for ${orphan.tool} (${orphan.risk}) — what followed:`);
      const from = events.indexOf(orphan);
      for (const e of events.slice(from, from + 25)) {
        const what = e.type === 'STATE_CHANGED' ? `${e.from}->${e.to} (${e.reason})`
          : e.type === 'OBSERVATION' ? e.summary
          : e.type === 'VOICE_SESSION' ? `${e.action} ${e.phase}`
          : e.type === 'APPROVAL_REQUIRED' ? e.request.title
          : e.type === 'APPROVAL_RESOLVED' ? `${e.decision} by ${e.resolvedBy}`
          : e.type === 'TOOL_CALL' || e.type === 'TOOL_RESULT' ? e.tool
          : e.type === 'ERROR' ? e.message
          : '';
        console.log(`      ${e.at.slice(11, 23)}  ${e.type}  ${String(what).slice(0, 110)}`);
      }
    }
  }
  step(
    'every tool call the agent made has exactly one result',
    events.filter((e) => e.type === 'TOOL_CALL').length === events.filter((e) => e.type === 'TOOL_RESULT').length,
    `${events.filter((e) => e.type === 'TOOL_CALL').length} calls, ${events.filter((e) => e.type === 'TOOL_RESULT').length} results`,
  );
  step(
    'no arbitrary tool name got past the bridge',
    !events.some((e) => e.type === 'TOOL_CALL' && /^(mouse\.|shell|exec|powershell)/i.test(e.tool)),
  );

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
