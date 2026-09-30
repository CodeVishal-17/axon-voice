/**
 * The dedicated local keyword spotter.
 *
 * These tests are about the parts of the wake word that CAN be settled without
 * a microphone: the phrase's spelling, the decision logic, the lifecycle, the
 * process protocol, and the credential boundary. They are necessary and they
 * are not sufficient. The engine this replaced passed a suite like this one
 * and then scored 0/15 on a person speaking into a real microphone, so nothing
 * here may be cited as evidence that the wake word works — that is
 * `npm run wake:live`, and only that.
 *
 * What they DO settle is everything a live test cannot: that "Axon" alone is
 * not a prefix of anything the spotter watches for, that a disarmed detector
 * cannot be woken by a result already in flight, that the spotter's process is
 * started with neither API key, and that a spotter which dies is restarted a
 * bounded number of times and then reported rather than respawned forever.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { LISTENING_LIMITS } from '@axon/core';

import {
  DEFAULT_KEYWORD_THRESHOLD,
  KEYWORD_BOOST_SCORE,
  MAX_KEYWORD_SPAN_MS,
  PRIMARY_KEYWORD_ID,
  WAKE_KEYWORDS,
  keywordById,
  keywordsFileContents,
} from '../src/main/wake/wake-keywords.js';
import {
  AUDIO_STARVED_AFTER_MS,
  KeywordWakeDetector,
  WAKE_REFRACTORY_MS,
  judgeKeywordHit,
} from '../src/main/wake/keyword-wake-detector.js';
import {
  SherpaKeywordEngine,
  spotterEnvironment,
  resolveModelDir,
  type KeywordEngine,
  type KeywordEngineHandlers,
  type KeywordHit,
} from '../src/main/wake/keyword-engine.js';
import { CalibrationKeywordEngine, parseCalibrationThresholds } from '../src/main/wake/calibration-engine.js';
import { createWakeDetector, parseThreshold } from '../src/main/wake/create-wake-detector.js';
import { WakeWordDetector } from '../src/main/wake/wake-word.js';
import type { WakeDetector } from '../src/main/wake/wake-detector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const hit = (over: Partial<KeywordHit> = {}): KeywordHit => ({
  id: PRIMARY_KEYWORD_ID,
  startMs: 400,
  endMs: 1_200,
  behindMs: 0,
  ...over,
});

/** A spotter that never runs a model. Everything below the engine seam is real. */
class FakeEngine implements KeywordEngine {
  available = true;
  unavailableReason: string | null = null;
  readonly detail = 'fake spotter';
  restarts = 0;
  handlers: KeywordEngineHandlers | null = null;
  readonly frames: number[] = [];
  started = 0;
  stopped = 0;

  start(handlers: KeywordEngineHandlers): void {
    this.handlers = handlers;
    this.started += 1;
  }

  stop(): void {
    this.handlers = null;
    this.stopped += 1;
  }

  push(frame: Int16Array): void {
    this.frames.push(frame.length);
  }

  ready(): void {
    this.handlers?.onReady('fake spotter, runtime 0');
  }

  fire(over: Partial<KeywordHit> = {}): void {
    this.handlers?.onHit(hit(over));
  }

  fail(message = 'the spotter died'): void {
    this.handlers?.onFailure(message);
  }
}

interface Harness {
  readonly detector: KeywordWakeDetector;
  readonly engine: FakeEngine;
  readonly wakes: number[];
  readonly armedChanges: boolean[];
  readonly notices: string[];
  readonly debug: string[];
  /** Fire the pending `arm()` timeout by hand. */
  readonly expireArmTimeout: () => void;
  clock: number;
}

function harness(over: { engine?: FakeEngine } = {}): Harness {
  const engine = over.engine ?? new FakeEngine();
  const timers: (() => void)[] = [];
  const wakes: number[] = [];
  const armedChanges: boolean[] = [];
  const notices: string[] = [];
  const debug: string[] = [];
  const state = { clock: 1_000 };
  const detector = new KeywordWakeDetector({
    engine,
    onWake: () => wakes.push(state.clock),
    onArmedChanged: (armed) => armedChanges.push(armed),
    onNotice: (message) => notices.push(message),
    debug: (line) => debug.push(line),
    now: () => state.clock,
    armTimeoutMs: 1_000,
    // Timers run by hand: an arm() that waited on a real 30 second timeout
    // would be a slow test that tells you nothing.
    setTimer: (fn) => {
      timers.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });
  return {
    detector,
    engine,
    wakes,
    armedChanges,
    notices,
    debug,
    expireArmTimeout: () => {
      const next = timers.shift();
      if (next) next();
    },
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
  };
}

describe('the wake phrase, as the spotter spells it', () => {
  it('spells every phrase as a greeting piece followed by the name', () => {
    // This is the false-activation story, stated as a property rather than as
    // a hope: the spotter is watching for sequences that BEGIN with a
    // greeting, so there is no path through it that fires on the name alone.
    for (const keyword of WAKE_KEYWORDS) {
      expect(keyword.pieces.length, keyword.phrase).toBeGreaterThanOrEqual(4);
      expect(keyword.pieces[0], keyword.phrase).toMatch(/^\u2581(HE|HI)/);
    }
  });

  it('never watches for the bare name, under any spelling', () => {
    // "AXON" tokenizes to `_A X ON`. If that sequence were ever a whole
    // keyword, "Axon" on its own would wake Axon — which is the single
    // behaviour the brief forbids most emphatically.
    const bareName = ['\u2581A', 'X', 'ON'].join(' ');
    for (const keyword of WAKE_KEYWORDS) {
      expect(keyword.pieces.join(' '), keyword.phrase).not.toBe(bareName);
      expect(keyword.pieces.join(' ').startsWith(bareName), keyword.phrase).toBe(false);
    }
  });

  it('ends every phrase with the name, so no greeting can fire on its own', () => {
    const name = ['\u2581A', 'X', 'ON'].join(' ');
    for (const keyword of WAKE_KEYWORDS) {
      expect(keyword.pieces.join(' ').endsWith(name), keyword.phrase).toBe(true);
    }
  });

  it('puts "Hey Axon" first, because it is the one with a target', () => {
    expect(WAKE_KEYWORDS[0]?.id).toBe(PRIMARY_KEYWORD_ID);
    expect(WAKE_KEYWORDS[0]?.phrase).toBe('Hey Axon');
  });

  it('writes a keywords file the spotter can read, with the threshold in it', () => {
    const contents = keywordsFileContents(0.1);
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(WAKE_KEYWORDS.length);
    for (const [index, line] of lines.entries()) {
      const keyword = WAKE_KEYWORDS[index];
      expect(line).toBe(`${keyword?.pieces.join(' ')} :${KEYWORD_BOOST_SCORE.toFixed(1)} #0.10 @${keyword?.id}`);
    }
  });

  it('resolves only the ids it configured', () => {
    for (const keyword of WAKE_KEYWORDS) expect(keywordById(keyword.id)?.phrase).toBe(keyword.phrase);
    expect(keywordById('axon')).toBeNull();
    expect(keywordById('')).toBeNull();
    expect(keywordById('hey_axon_2')).toBeNull();
  });
});

describe('deciding whether a spotter hit wakes Axon', () => {
  it('wakes on every phrase it configured', () => {
    for (const keyword of WAKE_KEYWORDS) {
      expect(judgeKeywordHit(hit({ id: keyword.id })).wake).toBe(true);
    }
  });

  it('refuses an id Axon never asked for', () => {
    // Cannot happen with the real spotter, which is exactly why it is checked:
    // the vocabulary is bounded by a lookup rather than by trust.
    expect(judgeKeywordHit(hit({ id: 'axon' })).wake).toBe(false);
    expect(judgeKeywordHit(hit({ id: 'ok_google' })).wake).toBe(false);
  });

  it('refuses a match stretched over more audio than the phrase takes', () => {
    const stretched = hit({ startMs: 400, endMs: 400 + MAX_KEYWORD_SPAN_MS + 1 });
    expect(judgeKeywordHit(stretched).wake).toBe(false);
    expect(judgeKeywordHit(stretched).reason).toMatch(/stretched/);
  });

  it('accepts a phrase said slowly, up to the measured ceiling', () => {
    expect(judgeKeywordHit(hit({ startMs: 0, endMs: MAX_KEYWORD_SPAN_MS })).wake).toBe(true);
  });

  it('can only refuse — it never invents a wake', () => {
    // Every rejection path returns wake: false; there is no input that turns a
    // hit Axon did not configure into an activation.
    const ids = ['', 'axon', 'hey', 'HEY_AXON', '../hey_axon'];
    for (const id of ids) expect(judgeKeywordHit(hit({ id })).wake).toBe(false);
  });
});

describe('arming and disarming the keyword detector', () => {
  it('starts the spotter and reports armed as soon as the model is loaded', async () => {
    const test = harness();
    const arming = test.detector.arm();
    expect(test.engine.started).toBe(1);
    expect(test.armedChanges).toEqual([true]);
    test.engine.ready();
    await expect(arming).resolves.toBe(true);
    expect(test.detector.isArmed).toBe(true);
  });

  it('refuses to arm with no spotter on the machine, and says why', async () => {
    const engine = new FakeEngine();
    engine.available = false;
    engine.unavailableReason = 'The local wake-word model is not installed. Run `npm run wake:model`.';
    const test = harness({ engine });
    await expect(test.detector.arm()).resolves.toBe(false);
    expect(test.engine.started).toBe(0);
    expect(test.notices).toEqual([engine.unavailableReason]);
    expect(test.armedChanges).toEqual([]);
  });

  it('is idempotent in both directions', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    await test.detector.arm();
    expect(test.engine.started).toBe(1);

    test.detector.disarm();
    test.detector.disarm();
    expect(test.engine.stopped).toBe(1);
    expect(test.armedChanges).toEqual([true, false]);
  });

  it('never starts a second spotter while it is already armed', async () => {
    // `arm()` answers when its own timeout expires even if the model is still
    // loading — "armed but slow" is a real state and the caller deserves an
    // answer. A caller that then retried used to start a SECOND engine, which
    // bumped the generation and orphaned the first engine's handlers: armed,
    // listening, and permanently unable to act on anything it heard.
    const test = harness();
    const first = test.detector.arm();
    test.expireArmTimeout();
    await expect(first).resolves.toBe(false);
    expect(test.detector.isArmed).toBe(true);

    await test.detector.arm();
    expect(test.engine.started, 'a second spotter was started').toBe(1);

    // The point of the whole thing: the still-loading spotter can still wake Axon.
    test.engine.ready();
    test.engine.fire();
    expect(test.wakes).toHaveLength(1);
  });

  it('answers a caller that arms twice before the model has loaded', async () => {
    const test = harness();
    const first = test.detector.arm();
    const second = test.detector.arm();
    expect(test.engine.started).toBe(1);
    test.engine.ready();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('stops the spotter when disarmed', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.detector.disarm();
    expect(test.engine.stopped).toBe(1);
    expect(test.detector.isArmed).toBe(false);
  });

  it('reports a spotter that will not stay up, once, and stays disarmed', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.fail('Axon could not keep the wake-word engine running, so it has stopped listening.');
    await expect(arming).resolves.toBe(false);
    expect(test.detector.isArmed).toBe(false);
    expect(test.notices).toHaveLength(1);
    expect(test.armedChanges).toEqual([true, false]);
  });
});

describe('audio handling', () => {
  it('forwards frames to the local spotter only while armed', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;

    test.detector.pushFrame(new Int16Array(320));
    test.detector.pushFrame(new Int16Array(320));
    expect(test.engine.frames).toEqual([320, 320]);

    test.detector.disarm();
    test.detector.pushFrame(new Int16Array(320));
    expect(test.engine.frames).toEqual([320, 320]);
  });

  it('drops an empty or oversized frame rather than clamping it', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;

    test.detector.pushFrame(new Int16Array(0));
    // One sample over the capture contract's ceiling: the boundary is what
    // matters, and allocating something absurd would only test the allocator.
    test.detector.pushFrame(new Int16Array(LISTENING_LIMITS.maxFrameSamples + 1));
    expect(test.engine.frames).toEqual([]);

    test.detector.pushFrame(new Int16Array(LISTENING_LIMITS.maxFrameSamples));
    expect(test.engine.frames).toEqual([LISTENING_LIMITS.maxFrameSamples]);
  });

  it('holds no audio of its own — a frame is forwarded and forgotten', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    const frame = new Int16Array(320).fill(1_234);
    test.detector.pushFrame(frame);
    // The detector records lengths, never samples: the fake engine is the only
    // thing that ever saw the array, and the detector returned nothing.
    expect(test.engine.frames).toEqual([320]);
    expect(JSON.stringify(test.detector.getStatus())).not.toContain('1234');
  });
});

describe('hearing the phrase', () => {
  it('fires once when the spotter hears a wake phrase', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire();
    expect(test.wakes).toHaveLength(1);
  });

  it('does not fire twice for one phrase', async () => {
    // The microphone moves to the conversation on activation, but frames
    // already in flight can still arrive and the spotter's stream may report
    // the same phrase again from the following block.
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire();
    test.clock += WAKE_REFRACTORY_MS - 1;
    test.engine.fire();
    expect(test.wakes).toHaveLength(1);
  });

  it('lets a person try again once the refractory window has passed', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire();
    test.clock += WAKE_REFRACTORY_MS + 1;
    test.engine.fire();
    expect(test.wakes).toHaveLength(2);
  });

  it('never fires after being disarmed, even for a hit already in flight', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    // Keep the handlers the engine was started with, then disarm: this is a
    // result that was on its way when the microphone was taken away.
    const handlers = test.engine.handlers;
    test.detector.disarm();
    handlers?.onHit(hit());
    expect(test.wakes).toEqual([]);
  });

  it('never fires on a hit the spotter was not configured to report', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire({ id: 'axon' });
    test.engine.fire({ id: 'hey' });
    expect(test.wakes).toEqual([]);
  });
});

describe('what the detector reports about itself', () => {
  it('names the engine and carries the spotter restart count', async () => {
    const test = harness();
    test.engine.restarts = 3;
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;

    const status = test.detector.getStatus();
    expect(status.engine).toBe('keyword-spotter');
    expect(status.armed).toBe(true);
    expect(status.available).toBe(true);
    expect(status.restarts).toBe(3);
    expect(status.unavailableReason).toBeNull();
  });

  it('says when the microphone has stopped arriving rather than pretending to fix it', async () => {
    // The detector does not own the microphone, so the honest thing when audio
    // stops is a status line, not a recovery it cannot perform.
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.detector.pushFrame(new Int16Array(320));
    expect(test.detector.getStatus().starvedOfAudio).toBe(false);
    test.clock += AUDIO_STARVED_AFTER_MS + 1;
    expect(test.detector.getStatus().starvedOfAudio).toBe(true);
  });

  it('carries no transcript and no audio in anything it reports', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire();
    const everything = JSON.stringify(test.detector.getStatus()) + test.debug.join('\n');
    // The spotter produces no text, so there is nothing to leak; this holds
    // the line anyway, because the next engine might.
    expect(everything).not.toMatch(/hey axon|hello axon|hi axon/i);
  });

  it('prints how far behind live audio the spotter was, for the live test to read', async () => {
    const test = harness();
    const arming = test.detector.arm();
    test.engine.ready();
    await arming;
    test.engine.fire({ behindMs: 137 });
    expect(test.debug.join('\n')).toMatch(/behind 137ms/);
  });

  it('says nothing at all unless it was asked to', async () => {
    const engine = new FakeEngine();
    const lines: string[] = [];
    const detector = new KeywordWakeDetector({
      engine,
      onWake: () => undefined,
      onArmedChanged: () => undefined,
      onNotice: () => undefined,
      // No debug callback: the shipping configuration.
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const arming = detector.arm();
    engine.ready();
    await arming;
    detector.pushFrame(new Int16Array(320));
    engine.fire();
    spy.mockRestore();
    expect(lines).toEqual([]);
  });
});

describe('the spotter process', () => {
  it('is given an environment with no credential on it', () => {
    const env = spotterEnvironment({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ASSEMBLYAI_API_KEY: 'aai-secret',
      AXON_HOME: 'C:\\axon',
    });
    expect(Object.keys(env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'Path', 'SystemRoot', 'TEMP']);
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });

  it('omits what is not set rather than inventing it', () => {
    expect(spotterEnvironment({})).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(spotterEnvironment({ SystemRoot: '' })).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('matches environment names the way Windows does, case-insensitively', () => {
    expect(spotterEnvironment({ systemroot: 'C:\\Windows' }).SystemRoot).toBe('C:\\Windows');
  });

  it('reads the model from a directory, and an override names a directory rather than a program', () => {
    const chosen = resolveModelDir({ AXON_WAKE_MODEL_DIR: 'C:\\models\\wake' });
    expect(chosen).toBe(path.resolve('C:\\models\\wake'));
    // The default resolves inside the app, not from the working directory.
    expect(resolveModelDir({})).toMatch(/wake-model$/);
  });
});

/**
 * The parent half of the spotter, against a stand-in child.
 *
 * The same seam `windows-stt.ts` uses, for the same reason: it lets the
 * protocol be exercised on any machine, with no model, no native runtime and
 * no microphone. What is under test is the parsing and the restart policy —
 * whether the model hears anything is a question for a microphone.
 */
describe('the spotter protocol, against a stand-in child', () => {
  /**
   * A real child process, a real pipe, no model.
   *
   * The same tests-only seam `windows-stt.ts` uses: `executable` and `args`
   * together let the protocol be exercised on any machine. What is under test
   * is the parsing and the restart policy — whether the model hears anything is
   * a question only a microphone can answer.
   */
  function speaking(program: string, over: Record<string, unknown> = {}): SherpaKeywordEngine {
    return new SherpaKeywordEngine({
      threshold: 0.1,
      executable: process.execPath,
      args: ['-e', program],
      ...over,
    });
  }

  function listen(engine: SherpaKeywordEngine) {
    const hits: KeywordHit[] = [];
    const ready: string[] = [];
    const failures: string[] = [];
    const debug: string[] = [];
    engine.start({
      onHit: (value) => hits.push(value),
      onReady: (detail) => ready.push(detail),
      onFailure: (message) => failures.push(message),
      onDebug: (line) => debug.push(line),
    });
    return { hits, ready, failures, debug };
  }

  const settle = (ms = 1_500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Waits for what the test is actually about, bounded, instead of a fixed
   * sleep: a child process's start-up time is the machine's, and under a full
   * parallel suite it is several times what it is alone. A fixed window that
   * fits the quiet case fails the loaded one (measured: both tests below).
   */
  async function until(condition: () => boolean, limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (!condition() && Date.now() < deadline) await settle(25);
  }

  it('reads READY and WAKE, and carries the timing through', async () => {
    const engine = speaking(
      "process.stdout.write('READY 1.13.8 0.10\\n');" +
        "setTimeout(() => process.stdout.write('WAKE hey_axon 4200 5000 130\\n'), 150);" +
        'setTimeout(() => {}, 5000);',
    );
    const seen = listen(engine);
    await settle();
    engine.stop();

    expect(seen.ready).toHaveLength(1);
    expect(seen.ready[0]).toMatch(/1\.13\.8/);
    expect(seen.hits).toEqual([{ id: 'hey_axon', startMs: 4_200, endMs: 5_000, behindMs: 130 }]);
    expect(seen.failures).toEqual([]);
  });

  it('ignores anything that is not one of the three line shapes', async () => {
    // A child that starts saying something new does not get to be interesting
    // by default.
    const engine = speaking(
      "process.stdout.write('READY 1 0.10\\n');" +
        "process.stdout.write('TRANSCRIPT hey axon open calculator\\n');" +
        "process.stdout.write('{\"text\":\"hey axon\"}\\n');" +
        "process.stdout.write('WAKE\\n');" +
        'setTimeout(() => {}, 5000);',
    );
    const seen = listen(engine);
    await settle();
    engine.stop();
    expect(seen.hits).toEqual([]);
  });

  it('does not push audio to a spotter that has not said it is ready', async () => {
    const engine = speaking("setTimeout(() => {}, 5000);");
    listen(engine);
    // No READY: the frame must go nowhere rather than into a pipe nobody reads.
    expect(() => engine.push(new Int16Array(320))).not.toThrow();
    await settle(400);
    engine.stop();
  });

  it('restarts a spotter that dies, and counts it', async () => {
    const engine = speaking("process.stdout.write('READY 1 0.10\\n'); setTimeout(() => process.exit(1), 100);");
    const seen = listen(engine);
    await settle(2_500);
    engine.stop();
    // It came back at least once rather than leaving Axon silently deaf.
    expect(engine.restarts).toBeGreaterThan(0);
    expect(seen.ready.length).toBeGreaterThan(1);
    expect(seen.failures).toEqual([]);
  });

  it('gives up after a bounded number of restarts rather than respawning forever', async () => {
    // An assistant that respawns a broken model forever is a laptop fan, not a
    // feature. Timers are driven by hand so the backoff does not make this a
    // sixteen-second test.
    const pending: (() => void)[] = [];
    const engine = speaking('process.exit(2);', {
      setTimer: (fn: () => void) => {
        pending.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    const seen = listen(engine);
    // Each round: wait for the child to die and a restart to be scheduled,
    // then fire it by hand. The bound on rounds is the assertion's teeth: a
    // respawn-forever engine would never report a failure within them.
    for (let round = 0; round < 12 && seen.failures.length === 0; round += 1) {
      await until(() => pending.length > 0 || seen.failures.length > 0, 5_000);
      pending.shift()?.();
    }
    engine.stop();
    expect(seen.failures.length).toBeGreaterThan(0);
    expect(seen.failures[0]).toMatch(/could not keep the wake-word engine running/);
  }, 30_000);

  it('reports an ERR line as a diagnostic without taking Axon down for it', async () => {
    const engine = speaking("process.stdout.write('ERR MODEL the wake model would not load\\n'); setTimeout(() => {}, 3000);");
    const seen = listen(engine);
    await until(() => seen.debug.some((line) => /MODEL/.test(line)), 8_000);
    engine.stop();
    expect(seen.debug.join('\n')).toMatch(/MODEL/);
    expect(seen.failures).toEqual([]);
  }, 15_000);

  it('is unavailable, with an actionable reason, when the model is not installed', () => {
    const engine = new SherpaKeywordEngine({ threshold: 0.1, modelDir: path.join(HERE, 'no-such-model') });
    expect(engine.available).toBe(false);
    expect(engine.unavailableReason).toMatch(/npm run wake:model|npm run build/);
  });

  it('never puts a credential or an outside string into the argv', () => {
    const engine = new SherpaKeywordEngine({ threshold: 0.1, modelDir: path.join(HERE, 'no-such-model') });
    const argv = (engine as unknown as { argv(): readonly string[] }).argv();
    // Every keyword line comes from `wake-keywords.ts` and nowhere else.
    const keywords = argv.filter((_, index) => argv[index - 1] === '--keyword');
    expect(keywords).toEqual(keywordsFileContents(0.1).trim().split('\n'));
    expect(argv.join(' ')).not.toMatch(/sk-ant|aai-|API_KEY/);
    expect(argv[0]).toMatch(/kws-host\.js$/);
  });
});

describe('measuring the threshold instead of guessing it', () => {
  it('parses a sweep list and drops anything outside the useful range', () => {
    expect(parseCalibrationThresholds('0.05,0.10,0.25')).toEqual([0.05, 0.1, 0.25]);
    expect(parseCalibrationThresholds('0.05, 0.05 ,0.10')).toEqual([0.05, 0.1]);
    // A typo costs a row of the table, never a silently moved threshold.
    expect(parseCalibrationThresholds('0,1,1.5,-0.2,banana')).toEqual([]);
    expect(parseCalibrationThresholds('')).toEqual([]);
    expect(parseCalibrationThresholds(undefined)).toEqual([]);
  });

  it('is bounded, because each threshold is a whole speech model', () => {
    expect(parseCalibrationThresholds('0.01,0.02,0.03,0.04,0.05,0.06,0.07,0.08,0.09,0.11')).toHaveLength(8);
  });

  it('lets only the first arm wake Axon, and reports the rest', () => {
    const arms: FakeEngine[] = [];
    const engine = new CalibrationKeywordEngine({
      thresholds: [0.1, 0.2, 0.3],
      build: () => {
        const arm = new FakeEngine();
        arms.push(arm);
        return arm;
      },
    });
    const hits: KeywordHit[] = [];
    const debug: string[] = [];
    engine.start({
      onHit: (value) => hits.push(value),
      onReady: () => undefined,
      onFailure: () => undefined,
      onDebug: (line) => debug.push(line),
    });

    arms[1]?.fire();
    arms[2]?.fire();
    expect(hits, 'an observer must not be able to wake Axon').toEqual([]);
    expect(debug.join('\n')).toMatch(/calibration 0\.20 hey_axon/);

    arms[0]?.fire();
    expect(hits).toHaveLength(1);
  });

  it('feeds every arm the same frames, and keeps none of them', () => {
    const arms: FakeEngine[] = [];
    const engine = new CalibrationKeywordEngine({
      thresholds: [0.1, 0.2],
      build: () => {
        const arm = new FakeEngine();
        arms.push(arm);
        return arm;
      },
    });
    engine.start({ onHit: () => undefined, onReady: () => undefined, onFailure: () => undefined });
    engine.push(new Int16Array(320));
    expect(arms.map((arm) => arm.frames)).toEqual([[320], [320]]);
  });

  it('does not let a dead observer stop Axon listening', () => {
    const arms: FakeEngine[] = [];
    const failures: string[] = [];
    const engine = new CalibrationKeywordEngine({
      thresholds: [0.1, 0.2],
      build: () => {
        const arm = new FakeEngine();
        arms.push(arm);
        return arm;
      },
    });
    engine.start({
      onHit: () => undefined,
      onReady: () => undefined,
      onFailure: (message) => failures.push(message),
      onDebug: () => undefined,
    });
    arms[1]?.fail('observer died');
    expect(failures).toEqual([]);
    arms[0]?.fail('the real one died');
    expect(failures).toHaveLength(1);
  });
});

describe('choosing an engine', () => {
  const base = {
    stt: null,
    activity: () => ({ push: () => ({ event: 'idle' }), threshold: 0.02 }),
    onWake: () => undefined,
    onArmedChanged: () => undefined,
    onNotice: () => undefined,
  };

  it('defaults to the dedicated keyword spotter', () => {
    const created = createWakeDetector({ ...base, engine: undefined, keywordEngine: new FakeEngine() });
    expect(created.engineName).toBe('keyword-spotter');
    expect(created.detector.getStatus().engine).toBe('keyword-spotter');
  });

  it('keeps the Windows recognizer reachable as the control arm', () => {
    const created = createWakeDetector({ ...base, engine: 'windows' });
    expect(created.engineName).toBe('windows-speech');
    expect(created.detector.getStatus().engine).toBe('windows-speech');
  });

  it('never silently falls back to the engine the human microphone test failed', () => {
    // A spotter that cannot run reports itself unavailable and says so. It does
    // NOT quietly become the Windows recognizer, which would leave Axon looking
    // as though it were listening.
    const engine = new FakeEngine();
    engine.available = false;
    engine.unavailableReason = 'The local wake-word model is not installed. Run `npm run wake:model`.';
    const created = createWakeDetector({ ...base, engine: 'keyword', keywordEngine: engine });
    expect(created.engineName).toBe('keyword-spotter');
    expect(created.unavailableReason).toBe(engine.unavailableReason);
  });

  it('turns off cleanly, and an unknown engine is off rather than a guess', async () => {
    for (const name of ['none', 'off', 'porcupine', '../../etc']) {
      const created = createWakeDetector({ ...base, engine: name });
      expect(created.engineName).toBe('disabled');
      expect(created.detector.available).toBe(false);
      await expect(created.detector.arm()).resolves.toBe(false);
      created.detector.pushFrame(new Int16Array(320));
      expect(created.detector.isArmed).toBe(false);
      expect(created.unavailableReason).not.toBeNull();
    }
  });

  it('bounds what an unknown engine name can print', () => {
    const created = createWakeDetector({ ...base, engine: 'x'.repeat(500) });
    expect((created.unavailableReason ?? '').length).toBeLessThan(120);
  });

  it('falls back to the measured threshold rather than a number nobody chose', () => {
    expect(parseThreshold(undefined)).toBe(DEFAULT_KEYWORD_THRESHOLD);
    expect(parseThreshold('nonsense')).toBe(DEFAULT_KEYWORD_THRESHOLD);
    expect(parseThreshold('0')).toBe(DEFAULT_KEYWORD_THRESHOLD);
    expect(parseThreshold('1')).toBe(DEFAULT_KEYWORD_THRESHOLD);
    expect(parseThreshold('-0.5')).toBe(DEFAULT_KEYWORD_THRESHOLD);
    expect(parseThreshold('0.08')).toBeCloseTo(0.08);
  });
});

describe('both detectors are the same kind of thing', () => {
  it('satisfies one interface, so the lifecycle exists once', () => {
    // Structural, deliberately. `wake-word.ts` may import nothing but
    // `@axon/core` — `architecture.test.ts` holds that — so it cannot say
    // `implements WakeDetector`. TypeScript checks the shape here instead, and
    // a drift in either class is a compile error in this file.
    const keyword: WakeDetector = new KeywordWakeDetector({
      engine: new FakeEngine(),
      onWake: () => undefined,
      onArmedChanged: () => undefined,
      onNotice: () => undefined,
    });
    const windows: WakeDetector = new WakeWordDetector({
      stt: null,
      activity: () => ({ push: () => ({ event: 'idle' }), threshold: 0.02 }),
      onWake: () => undefined,
      onArmedChanged: () => undefined,
      onNotice: () => undefined,
    });

    for (const detector of [keyword, windows]) {
      expect(typeof detector.arm).toBe('function');
      expect(typeof detector.disarm).toBe('function');
      expect(typeof detector.pushFrame).toBe('function');
      expect(typeof detector.getStatus).toBe('function');
      expect(typeof detector.isArmed).toBe('boolean');
      expect(typeof detector.available).toBe('boolean');
    }
    expect(windows.getStatus().engine).toBe('windows-speech');
    expect(keyword.getStatus().engine).toBe('keyword-spotter');
  });
});
