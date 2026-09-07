/**
 * Security properties of the voice input path.
 *
 * The microphone is the most sensitive capability Axon has acquired so far, so
 * these are written as properties rather than as examples: not "this input
 * produces that output", but "no run of this system can ever do X".
 *
 * The claims under test:
 *
 *   1. Raw audio never reaches an event, a log, the brain, or the UI.
 *   2. The renderer cannot open a microphone Axon did not open, cannot keep
 *      one open, and cannot describe how one should be opened.
 *   3. Malformed input on the audio channel is dropped, not interpreted.
 *   4. A transcript is data. It cannot name a tool, reach a shell, or bypass
 *      the dispatcher.
 *   5. No credential and no endpoint exists to leak, because the recognizer is
 *      local — and nothing in the tree quietly introduces one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LISTENING_LIMITS,
  type AxonEvent,
  type SpeechToText,
  type SpeechToTextSession,
  type ToolCall,
  type TranscriptChunk,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { validAudioFrame } from '../src/main/bus/renderer-bridge.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { allowMicrophone } from '../src/main/security.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { createSpeechToText } from '../src/main/voice/create-stt.js';
import { ListeningService } from '../src/main/voice/listening-service.js';
import { prepareTranscript } from '../src/main/voice/transcript-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = path.resolve(HERE, '../src');
const RATE = LISTENING_LIMITS.sampleRate;
const FRAME = 512;
const FRAME_MS = (FRAME / RATE) * 1000;

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A frame of loud, distinctive audio.
 *
 * The sample value is a marker: if any of it ever appears in an event, a log
 * line or a status object, the tests below will find it.
 */
function markedAudio(): Int16Array {
  const frame = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) frame[i] = i % 2 === 0 ? 31337 : -31337;
  return frame;
}

const silence = (): Int16Array => new Int16Array(FRAME);

function fakeStt(phrases: string[]): SpeechToText {
  return {
    name: 'fake-stt',
    sampleRate: RATE,
    isAvailable: () => true,
    start: async (onChunk: (chunk: TranscriptChunk) => void): Promise<SpeechToTextSession> => ({
      push: () => {},
      end: async () => {
        for (const text of phrases) onChunk({ text, isFinal: true, confidence: 0.8 });
      },
      close: () => {},
    }),
  };
}

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  readonly dispatched: ToolCall[];
  readonly listening: ListeningService;
  captureId(): string;
  speak(): void;
}

function harness(phrases: string[]): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  const dispatched: ToolCall[] = [];
  const commands: { action: string; captureId: string }[] = [];

  bus.subscribe((event) => events.push(event));

  const listening = new ListeningService({
    stt: fakeStt(phrases),
    command: (command) => commands.push(command),
    onStarted: (trigger) => orchestrator.onListeningStarted(trigger),
    onEnded: (reason) => orchestrator.onListeningEnded(reason),
    onTranscript: (text, metrics) => orchestrator.onTranscript(text, metrics),
    onNotice: (message) => orchestrator.onListeningNotice(message),
    onFailure: (message) => orchestrator.onListeningFailure(message),
  });

  const orchestrator = new Orchestrator({
    bus,
    registry: new ToolRegistry(),
    approvalTimeoutMs: 500,
    devConsoleEnabled: false,
    listening,
    brain: {
      name: 'fake-brain',
      // Records what the brain tried to do with the transcript, and reaches
      // tools only through the dispatch callback it is handed.
      run: async (input, dispatch) => {
        const call: ToolCall = { callId: 'c1', tool: 'app.open', input: { app: input.utterance } };
        dispatched.push(call);
        await dispatch(call);
        return { reply: null, detail: null };
      },
    },
  });

  return {
    orchestrator,
    events,
    dispatched,
    listening,
    captureId: () => commands.filter((c) => c.action === 'start').pop()?.captureId ?? '',
    speak(): void {
      const id = commands.filter((c) => c.action === 'start').pop()?.captureId ?? '';
      const push = (frame: Int16Array, ms: number): void => {
        for (let i = 0; i < Math.ceil(ms / FRAME_MS); i += 1) listening.pushFrame(id, frame);
      };
      push(silence(), 300);
      push(markedAudio(), 500);
      push(silence(), 1_200);
    },
  };
}

describe('raw audio never leaves the voice subsystem', () => {
  it('appears in no event, in any form', async () => {
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    // Every event, serialized exactly as the JSONL log would write it.
    const log = h.events.map((event) => JSON.stringify(event)).join('\n');

    // The marker sample value.
    expect(log).not.toContain('31337');
    // And no typed array survived serialization as an object of indices.
    expect(log).not.toMatch(/"0":\s*\d+,\s*"1":/);
    for (const key of ['samples', 'frame', 'frames', 'pcm', 'audio', 'buffer']) {
      expect(log.toLowerCase()).not.toContain(`"${key}":`);
    }
  });

  it('produced events that are all still valid JSON, which audio could not be', async () => {
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    // The bus validates every event against the schema on the way out, and a
    // typed array is not a JsonValue. This asserts the run really did emit
    // events, so the check above was not vacuous.
    expect(h.events.length).toBeGreaterThan(3);
    for (const event of h.events) {
      expect(() => JSON.parse(JSON.stringify(event))).not.toThrow();
    }
  });

  it('is absent from the snapshot the renderer receives', async () => {
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    const snapshot = JSON.stringify(h.orchestrator.snapshot());
    expect(snapshot).not.toContain('31337');
    expect(snapshot).not.toMatch(/"samples"|"pcm"|"frames"/i);
  });

  it('is absent from the listening status', () => {
    const h = harness([]);
    h.orchestrator.startListening('hotkey');
    const status = JSON.stringify(h.orchestrator.listeningStatus());

    expect(status).not.toContain('31337');
    expect(Object.keys(h.orchestrator.listeningStatus()).sort()).toEqual([
      'active',
      'available',
      'hotkey',
      'name',
      'reason',
    ]);
  });

  it('reaches the brain as text and nothing else', async () => {
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    // The brain saw the utterance. It never saw a sample.
    expect(h.dispatched).toHaveLength(1);
    expect(JSON.stringify(h.dispatched)).not.toContain('31337');
    expect(h.dispatched[0]?.input).toEqual({ app: 'open notepad' });
  });
});

describe('the renderer cannot open a microphone Axon did not open', () => {
  const listening = (value: boolean) => (): boolean => value;

  it('refuses microphone permission when Axon is not listening', () => {
    expect(allowMicrophone('media', { mediaTypes: ['audio'] }, listening(false))).toBe(false);
  });

  it('grants it only while Axon is listening', () => {
    expect(allowMicrophone('media', { mediaTypes: ['audio'] }, listening(true))).toBe(true);
  });

  it('refuses a request that asks for video', () => {
    expect(allowMicrophone('media', { mediaTypes: ['audio', 'video'] }, listening(true))).toBe(false);
    expect(allowMicrophone('media', { mediaTypes: ['video'] }, listening(true))).toBe(false);
    expect(allowMicrophone('media', { mediaType: 'video' }, listening(true))).toBe(false);
  });

  it('refuses a media request that does not say it wants audio', () => {
    expect(allowMicrophone('media', { mediaTypes: [] }, listening(true))).toBe(false);
    expect(allowMicrophone('media', { mediaType: 'unknown' }, listening(true))).toBe(false);
  });

  it.each([
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'pointerLock',
    'fullscreen',
    'openExternal',
    'clipboard-read',
    'clipboard-sanitized-write',
    'display-capture',
    'usb',
    'serial',
    'hid',
    'fileSystem',
    'idle-detection',
    'window-management',
    'unknown-future-permission',
  ])('refuses %s even while listening', (permission) => {
    expect(allowMicrophone(permission, undefined, listening(true))).toBe(false);
  });

  it('is the same answer for a request and for a check', () => {
    // Two Electron handlers, one policy. If they could disagree, a capability
    // refused at request time could be granted at check time.
    for (const isListening of [listening(true), listening(false)]) {
      expect(allowMicrophone('media', { mediaTypes: ['audio'] }, isListening)).toBe(
        allowMicrophone('media', { mediaType: 'audio' }, isListening),
      );
    }
  });
});

describe('the audio channel rejects anything malformed', () => {
  const good = { captureId: 'abc', samples: new Int16Array(512) };

  it('accepts a well-formed frame', () => {
    expect(validAudioFrame(good)).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'audio'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['no capture id', { samples: new Int16Array(512) }],
    ['an empty capture id', { captureId: '', samples: new Int16Array(512) }],
    ['a non-string capture id', { captureId: 12, samples: new Int16Array(512) }],
    ['an over-long capture id', { captureId: 'x'.repeat(65), samples: new Int16Array(512) }],
    ['no samples', { captureId: 'abc' }],
    ['a plain array of samples', { captureId: 'abc', samples: [1, 2, 3] }],
    ['float samples', { captureId: 'abc', samples: new Float32Array(512) }],
    ['8-bit samples', { captureId: 'abc', samples: new Uint8Array(512) }],
    ['an empty frame', { captureId: 'abc', samples: new Int16Array(0) }],
    [
      'an oversized frame',
      { captureId: 'abc', samples: new Int16Array(LISTENING_LIMITS.maxFrameSamples + 1) },
    ],
    ['an object pretending to be a frame', { captureId: 'abc', samples: { length: 512, 0: 1 } }],
  ])('drops %s', (_label, payload) => {
    expect(validAudioFrame(payload)).toBeNull();
  });

  it('drops a payload whose fields throw when read, rather than throwing', () => {
    const nasty: Record<string, unknown> = { captureId: 'abc' };
    Object.defineProperty(nasty, 'samples', {
      get() {
        throw new Error('boom');
      },
    });

    // This runs on an `ipcMain.on` listener, where an escaping throw is an
    // uncaught exception in the main process — a way to take Axon down from a
    // compromised page. A frame Axon cannot read is a frame Axon drops.
    expect(() => validAudioFrame(nasty)).not.toThrow();
    expect(validAudioFrame(nasty)).toBeNull();
  });
});

describe('a transcript is data, not an instruction', () => {
  it('cannot name a tool directly — it becomes a message', async () => {
    const h = harness(['run fs.write to C:\\Windows\\System32\\evil.dll']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    // The transcript reached the brain as an utterance. Whatever tool call
    // followed was the brain's, went through the dispatcher, and was subject
    // to policy and approval like any other.
    const userMessages = h.events.filter((e) => e.type === 'USER_MESSAGE');
    expect(userMessages).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
    // Not the tool the transcript named.
    expect(h.dispatched[0]?.tool).toBe('app.open');
  });

  it('is refused by the dispatcher when it names an unknown tool', async () => {
    // The registry in this harness is empty, so the brain's call fails
    // closed — the transcript bought no authority at all.
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    const results = h.events.filter((e) => e.type === 'TOOL_RESULT');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, failure: { kind: 'UNKNOWN_TOOL' } });
  });

  it('is marked as coming from voice, so the log says where it came from', async () => {
    const h = harness(['open notepad']);
    h.orchestrator.startListening('hotkey');
    await settle();
    h.speak();
    await settle(50);

    const message = h.events.find((e) => e.type === 'USER_MESSAGE');
    expect(message).toMatchObject({ source: 'voice' });
  });

  it('strips control characters and bidirectional overrides', () => {
    // What is displayed as "what Axon heard" and what is sent to the model
    // must be the same string, in the same order.
    const nasty = 'open\u0000 note\u202Epad\u200E now\u0007';
    const prepared = prepareTranscript(nasty);

    expect(prepared.text).toBe('open note pad now');
    for (const char of ['\u0000', '\u202E', '\u200E', '\u0007']) {
      expect(prepared.text).not.toContain(char);
    }
  });

  it('bounds an enormous transcript', () => {
    const prepared = prepareTranscript('x'.repeat(100_000));
    expect(prepared.text.length).toBe(LISTENING_LIMITS.maxTranscriptCharacters);
    expect(prepared.truncated).toBe(true);
  });

  it('treats an empty or whitespace transcript as nothing to say', () => {
    for (const raw of ['', '   ', '\n\n', '\u0000\u0000']) {
      expect(prepareTranscript(raw).text).toBe('');
    }
  });

  it('leaves ordinary speech untouched', () => {
    // The stripping must not be so aggressive that it changes what was said.
    const prepared = prepareTranscript("Open Notepad, then write \"hello\" — that's it.");
    expect(prepared.text).toBe("Open Notepad, then write \"hello\" — that's it.");
    expect(prepared.truncated).toBe(false);
  });
});

describe('there is no credential and no endpoint to leak', () => {
  it('selects a provider by name, never by URL', () => {
    const created = createSpeechToText({ platform: 'win32', provider: 'windows' });
    expect(created.stt?.name).toBe('windows-speech');

    // A URL where a provider name is expected is not a provider.
    for (const hostile of ['https://evil.example/stt', 'http://127.0.0.1:9/x', 'file:///etc/passwd']) {
      const result = createSpeechToText({ platform: 'win32', provider: hostile });
      expect(result.stt).toBeNull();
      expect(result.unavailableReason).toMatch(/Unknown speech recognizer/);
    }
  });

  it('bounds what an unknown provider name can put on screen', () => {
    const result = createSpeechToText({ platform: 'win32', provider: 'x'.repeat(5_000) });
    expect(result.unavailableReason!.length).toBeLessThan(120);
  });

  it('can be turned off entirely', () => {
    for (const off of ['none', 'off', 'NONE']) {
      const result = createSpeechToText({ platform: 'win32', provider: off });
      expect(result.stt).toBeNull();
      expect(result.unavailableReason).toMatch(/turned off/i);
    }
  });

  it('constructs the recognizer with a platform and nothing else', () => {
    // `WindowsSpeechToText` accepts `executable` and `args` so its protocol can
    // be tested against a stand-in child. Those are real seams, and this is the
    // assertion that keeps them test-only: the product's single construction
    // site passes neither, so the constant argv is the only one Axon spawns.
    const source = fs.readFileSync(path.join(DESKTOP_SRC, 'main/voice/create-stt.ts'), 'utf8');
    const construction = source.slice(source.indexOf('new WindowsSpeechToText'));
    const call = construction.slice(0, construction.indexOf(')') + 1);

    expect(call).toContain('platform');
    expect(call).not.toContain('executable');
    expect(call).not.toContain('args');
  });

  it('has no network client in the local voice subsystem', () => {
    // THIS RULE CHANGED IN THE VOICE-AGENT MILESTONE, AND THE CHANGE MATTERS.
    //
    // It used to assert that nothing in Axon's voice path could send audio
    // anywhere, which backed the Step 4 claim "the audio never leaves the
    // machine". That claim is no longer true: once a user activates a voice
    // session, that session's audio is streamed to a voice-agent provider.
    //
    // So the rule is narrowed rather than dropped, and what it now protects is
    // the half of the guarantee that survives — the LOCAL path. `main/voice/`
    // holds the offline recognizer, the offline synthesiser, the VAD and the
    // transports: it is what runs BEFORE activation and what the wake word
    // uses. Nothing in it may reach the network, so audio captured while Axon
    // is merely armed has nowhere to go.
    //
    // Everything that can reach the network lives in `main/agent/`, and
    // `agent-voice-security.test.ts` bounds it there.
    const voiceDir = path.join(DESKTOP_SRC, 'main/voice');
    for (const name of fs.readdirSync(voiceDir)) {
      const source = fs
        .readFileSync(path.join(voiceDir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      for (const pattern of [/\bfetch\s*\(/, /node:https?/, /XMLHttpRequest/, /WebSocket/, /axios/]) {
        expect(source, `${name} must not reach the network`).not.toMatch(pattern);
      }
    }
  });

  it('has no network client in the wake word, which runs before activation', () => {
    // The load-bearing half of the new guarantee. While Axon is armed the
    // microphone is open and a local recognizer is listening for the name. If
    // anything here could open a socket, "before activation, audio stays
    // local" would be a promise with no mechanism behind it.
    const source = fs
      .readFileSync(path.join(DESKTOP_SRC, 'main/wake/wake-word.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const pattern of [/\bfetch\s*\(/, /node:https?/, /XMLHttpRequest/, /WebSocket/, /axios/, /ASSEMBLYAI/]) {
      expect(source, 'the wake word must not reach the network').not.toMatch(pattern);
    }
  });

  it('reads the voice credential out of the environment in exactly one file', () => {
    // ALSO CHANGED. This used to assert that no source file anywhere named a
    // speech credential, because Axon had none. It now has one, so the rule
    // becomes the stronger and more precise claim.
    //
    // The distinction it draws is between NAMING the variable and READING it.
    // Naming it is fine and sometimes necessary — the socket's auth-failure
    // message tells the user which variable to check, which is exactly the
    // sentence a person needs. Reading it is what creates a copy of a secret,
    // and that happens in `runtime.ts`, once, into a local that is handed
    // straight to the factory.
    //
    // Deepgram, OpenAI and Speechmatics remain forbidden outright: they are
    // placeholders in `.env.example` for providers Axon does not have.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    // `env.ASSEMBLYAI_API_KEY`, `process.env.ASSEMBLYAI_API_KEY`, and the
    // bracket forms of both.
    const readsIt = /env\s*(?:\.\s*ASSEMBLYAI_API_KEY|\[\s*['"`]ASSEMBLYAI_API_KEY)/;

    const readers: string[] = [];
    for (const file of walk(DESKTOP_SRC)) {
      const source = fs.readFileSync(file, 'utf8');

      expect(source, `${file} must not read an unused STT credential`).not.toMatch(
        /DEEPGRAM_API_KEY|OPENAI_API_KEY|SPEECHMATICS/,
      );

      if (readsIt.test(source)) readers.push(path.relative(DESKTOP_SRC, file).replace(/\\/g, '/'));
    }

    expect(readers).toEqual(['main/runtime.ts']);
  });

  it('keeps the voice credential out of the renderer and the preload entirely', () => {
    // Not even the NAME crosses into the sandbox. There is no message the
    // renderer needs to compose about a credential — main sends it a reason
    // string — so a mention there would be a mistake worth catching early.
    const surfaces = [path.join(DESKTOP_SRC, 'renderer'), path.join(DESKTOP_SRC, 'preload')];

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    for (const surface of surfaces) {
      for (const file of walk(surface)) {
        const source = fs.readFileSync(file, 'utf8');
        expect(source, `${file} must never name a credential`).not.toMatch(/ASSEMBLYAI|API_KEY|apiKey/);
      }
    }
  });
});

describe('the renderer is given no new authority', () => {
  const preload = fs.readFileSync(path.join(DESKTOP_SRC, 'preload/index.ts'), 'utf8');
  const ipc = fs.readFileSync(
    path.resolve(HERE, '../../../packages/core/src/ipc.ts'),
    'utf8',
  );

  it('exposes exactly the five listening members and no more', () => {
    const members = [...ipc.matchAll(/^\s{2}(\w+)[(<]/gm)].map((m) => m[1]);
    const listeningMembers = members.filter((m) =>
      /listen|capture|audioFrame/i.test(m ?? ''),
    );
    expect(listeningMembers.sort()).toEqual(
      ['onCaptureCommand', 'reportCapture', 'sendAudioFrame', 'startListening', 'stopListening'].sort(),
    );
  });

  it('asks to listen with no arguments at all', () => {
    // No device to nominate, no duration to request, no format to negotiate.
    // A parameterless verb is one that cannot be pointed at something else.
    expect(ipc).toMatch(/startListening\(\): Promise<StartListeningResult>;/);
    expect(ipc).toMatch(/stopListening\(\): Promise<void>;/);
  });

  it('never hands the renderer a way to name a device or a file', () => {
    for (const forbidden of ['deviceId', 'deviceLabel', 'filePath', 'outputPath', 'endpoint', 'url']) {
      expect(preload).not.toContain(forbidden);
    }
  });

  it('rebuilds the capture report field by field', () => {
    // Whatever else a caller attached to the object stays on the renderer's
    // side of the boundary.
    expect(preload).toMatch(/captureId: report\.captureId/);
    expect(preload).toMatch(/status: report\.status/);
    expect(preload).toMatch(/failure: report\.failure/);
  });

  it('never forwards the IpcRendererEvent to page code', () => {
    // It carries a `sender` handle, which would be a route to every channel
    // the bridge does not list.
    const handlers = [...preload.matchAll(/\(_event: IpcRendererEvent[^)]*\)/g)];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    expect(preload).not.toMatch(/\(event: IpcRendererEvent[^)]*\): void => \{\s*listener\(event/);
  });

  it('sends audio without a reply', () => {
    // `send`, not `invoke`: nothing about what main heard — or about whether a
    // guessed capture id was the live one — comes back through this call.
    expect(preload).toMatch(/sendAudioFrame\([^)]*\): void \{[\s\S]{0,200}ipcRenderer\.send\(/);
  });
});
