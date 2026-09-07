/**
 * The voice-agent security boundary.
 *
 * THE GUARANTEE THIS FILE ENFORCES, IN FULL:
 *
 *   Before activation, microphone audio remains local.
 *   After the user activates a voice session, that session's audio may be
 *   streamed to the voice-agent provider.
 *   Axon never persists or logs raw microphone audio.
 *
 * The first line is the one that needs mechanism rather than intention, and
 * most of this file is about it. "No audio before activation" is only true if
 * there is nothing that COULD send audio before activation — not a socket that
 * is politely idle, but no socket at all, and no code path to one.
 *
 * The rest asserts the properties that did not change and must not: the
 * credential stays in main, the renderer gains nothing, and a proposal from
 * the provider reaches the world only through the dispatcher.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFERRED_TOOL_RESULT, VOICE_AGENT_LIMITS, type ToolResult, type ToolSchema } from '@axon/core';
import { buildAgentSystemPrompt, buildAgentTools } from '../src/main/agent/agent-tool-surface.js';
import { ToolBridge, toAgentResult } from '../src/main/agent/tool-bridge.js';
import { describeSocketError } from '../src/main/agent/assemblyai-client.js';
import { matchesWakePhrase, normalizePhrase, WAKE_PHRASES } from '../src/main/wake/wake-word.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = path.resolve(HERE, '../src');
const AGENT_DIR = path.join(DESKTOP_SRC, 'main/agent');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed, so a rule matches code and not prose.
 *
 * The line-comment pattern requires the `//` not to be preceded by a colon.
 * Without that, `wss://agents.assemblyai.com` is read as a comment and
 * stripped — which would silently blind every rule below that looks for a URL,
 * and a blinded security rule passes for the wrong reason.
 */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// Where the network is allowed to be.
// ---------------------------------------------------------------------------

describe('the network lives in exactly one subsystem', () => {
  it('has an agent directory, so these rules are not vacuous', () => {
    expect(fs.existsSync(AGENT_DIR)).toBe(true);
    expect(walk(AGENT_DIR).length).toBeGreaterThan(3);
  });

  it('opens a socket from exactly one module', () => {
    const openers = walk(DESKTOP_SRC)
      .filter((file) => /new WebSocket\(|from 'ws'|require\('ws'\)/.test(code(file)))
      .map((file) => path.relative(DESKTOP_SRC, file).replace(/\\/g, '/'));

    expect(openers).toEqual(['main/agent/assemblyai-client.ts']);
  });

  it('names the endpoint in exactly one module, as a constant', () => {
    const namers = walk(DESKTOP_SRC)
      .filter((file) => /agents\.assemblyai\.com/.test(code(file)))
      .map((file) => path.relative(DESKTOP_SRC, file).replace(/\\/g, '/'));

    expect(namers).toEqual(['main/agent/assemblyai-client.ts']);

    // A constant, never assembled from configuration. There is no environment
    // variable that points Axon's microphone at a different host.
    const source = code(path.join(AGENT_DIR, 'assemblyai-client.ts'));
    expect(source).toMatch(/const VOICE_AGENT_ENDPOINT = 'wss:\/\/agents\.assemblyai\.com\/v1\/ws'/);
    expect(source).not.toMatch(/env\s*[.[]/);
  });

  it('reaches the network from nowhere outside main/agent', () => {
    for (const file of walk(DESKTOP_SRC)) {
      const rel = path.relative(DESKTOP_SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('main/agent/')) continue;

      for (const pattern of [/new WebSocket\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /axios/]) {
        expect(code(file), `${rel} must not reach the network`).not.toMatch(pattern);
      }
    }
  });

  it('keeps the socket out of the renderer and the preload', () => {
    // The renderer displays text that came from web pages. A socket there
    // would put the credential one XSS away from a page.
    for (const surface of ['renderer', 'preload']) {
      for (const file of walk(path.join(DESKTOP_SRC, surface))) {
        const source = code(file);
        expect(source, `${file} must have no socket`).not.toMatch(/WebSocket|assemblyai/i);
      }
    }
  });

  it('never uses the browser token flow, which exists so browsers can connect', () => {
    // The provider offers short-lived tokens precisely so a browser can hold a
    // socket. Axon's answer is that the renderer has no socket at all, so a
    // token would be solving a problem Axon does not have — and introducing
    // the very thing it avoided.
    for (const file of walk(DESKTOP_SRC)) {
      expect(code(file), `${file} must not fetch a browser token`).not.toMatch(/v1\/token|temporary_token/);
    }
  });
});

// ---------------------------------------------------------------------------
// Before activation.
// ---------------------------------------------------------------------------

describe('before activation, audio stays on this machine', () => {
  it('has no socket until a session is created', () => {
    // Structural: the session OWNS the socket, and the orchestrator creates a
    // session only inside `startVoiceSession`. With no session there is no
    // socket object in existence, so "not sending" is not a runtime state that
    // could be got wrong — there is nothing to send with.
    const orchestrator = code(path.join(DESKTOP_SRC, 'main/orchestrator/orchestrator.ts'));
    const creations = orchestrator.match(/\.create\(/g) ?? [];
    expect(creations).toHaveLength(1);

    const start = orchestrator.indexOf('startVoiceSession(');
    const create = orchestrator.indexOf('.create(');
    expect(start).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(start);
  });

  it('routes wake-word audio to a local recognizer and nothing else', () => {
    const wake = code(path.join(DESKTOP_SRC, 'main/wake/wake-word.ts'));
    // The only thing it does with a frame is hand it to the STT session.
    expect(wake).toMatch(/this\.session\?\.push\(frame\)/);
    // And it imports nothing that could send one anywhere.
    expect(wake).not.toMatch(/WebSocket|fetch|http|agent\//);
  });

  it('emits no transcript from the wake word, only a bare signal', () => {
    // A detector that emitted what it rejected would be a continuous local
    // transcription service quietly filling a log with everything said near
    // the machine. `onWake` takes no arguments, and that is load-bearing.
    const wake = fs.readFileSync(path.join(DESKTOP_SRC, 'main/wake/wake-word.ts'), 'utf8');
    expect(wake).toMatch(/onWake\(\): void/);
    expect(wake).not.toMatch(/onWake\([a-zA-Z]/);
  });

  it('records who asked, every time a session opens', () => {
    // The audit trail for the guarantee. A log that cannot say "the user
    // activated this at 14:02 by saying the wake phrase" cannot support the
    // claim that audio only leaves on purpose.
    const orchestrator = code(path.join(DESKTOP_SRC, 'main/orchestrator/orchestrator.ts'));
    expect(orchestrator).toMatch(/type: 'VOICE_SESSION'/);
    expect(orchestrator).toMatch(/action: 'activated'/);
    expect(orchestrator).toMatch(/activation,/);
  });
});

// ---------------------------------------------------------------------------
// Raw audio is never persisted or logged.
// ---------------------------------------------------------------------------

describe('raw microphone audio is never persisted or logged', () => {
  it('is not written to disk by anything in the agent or wake subsystems', () => {
    for (const file of [...walk(AGENT_DIR), path.join(DESKTOP_SRC, 'main/wake/wake-word.ts')]) {
      const source = code(file);
      expect(source, `${file} must not touch the filesystem`).not.toMatch(/node:fs|writeFile|createWriteStream/);
    }
  });

  it('never puts audio into an event', () => {
    // Every event is validated as a JsonValue and written to the JSONL log, so
    // audio in an event is audio on disk. The agent subsystem emits nothing
    // itself; it calls back with text, and the one audio callback goes to the
    // speech transport rather than the bus.
    for (const file of walk(AGENT_DIR)) {
      const source = code(file);
      expect(source, `${file} must not emit events`).not.toMatch(/bus\.emit|type: 'OBSERVATION'/);
    }
  });

  it('carries no audio on the VOICE_SESSION event', () => {
    const core = fs.readFileSync(path.resolve(HERE, '../../../packages/core/src/events.ts'), 'utf8');
    const block = core.slice(core.indexOf("type: z.literal('VOICE_SESSION')"));
    const declaration = block.slice(0, block.indexOf('}),'));

    for (const forbidden of ['audio', 'pcm', 'samples', 'bytes', 'transcript']) {
      expect(declaration, `VOICE_SESSION must not carry ${forbidden}`).not.toMatch(new RegExp(forbidden, 'i'));
    }
  });

  it('does not retain outbound audio past the flush', () => {
    const session = code(path.join(AGENT_DIR, 'voice-agent-session.ts'));
    // The buffer is emptied every time it is sent. A buffer that grew would be
    // a recording, whatever it was called.
    expect(session).toMatch(/this\.outbound = \[\];/);
    expect(session).toMatch(/this\.outboundBytes = 0;/);
  });
});

// ---------------------------------------------------------------------------
// The provider proposes; Axon decides.
// ---------------------------------------------------------------------------

describe('a tool call from the provider cannot bypass the dispatcher', () => {
  const schema = (name: string): ToolSchema => ({
    name,
    title: name,
    description: 'a tool',
    inputSchema: { type: 'object', properties: {} },
  });

  function bridge(options: {
    dispatch?: (call: { tool: string; input: unknown }) => Promise<ToolResult>;
    requiresApproval?: boolean;
    tools?: readonly ToolSchema[];
  }) {
    const dispatched: { tool: string; input: unknown }[] = [];
    const outcomes: string[] = [];

    const instance = new ToolBridge({
      tools: options.tools ?? [schema('browser.read')],
      newCallId: () => 'call-1',
      willRequireApproval: () => options.requiresApproval ?? false,
      onDeferredOutcome: (summary) => outcomes.push(summary),
      onNotice: () => {},
      dispatch: async (call) => {
        dispatched.push({ tool: call.tool, input: call.input });
        if (options.dispatch) return options.dispatch(call);
        return {
          callId: call.callId,
          tool: call.tool,
          ok: true,
          output: { fine: true },
          durationMs: 1,
        } satisfies ToolResult;
      },
    });

    return { instance, dispatched, outcomes };
  }

  it('reaches the world only through the dispatch callback it was given', () => {
    // Structural: the bridge imports nothing that could execute anything. It
    // holds a callback, and that callback is the dispatcher.
    const source = code(path.join(AGENT_DIR, 'tool-bridge.ts'));
    expect(source).not.toMatch(/executors\/|registry|electron|node:child_process|node:fs/);
  });

  it('dispatches an ordinary call and returns its real result', async () => {
    const rig = bridge({});
    await rig.instance.handleToolCall('c1', 'browser.read', { a: 1 });

    expect(rig.dispatched).toEqual([{ tool: 'browser.read', input: { a: 1 } }]);
    const flushed = rig.instance.flush('completed');
    expect(flushed).toHaveLength(1);
    expect(JSON.parse(flushed[0]!.result)).toMatchObject({ ok: true });
  });

  it('refuses a tool that is not registered, without dispatching it', async () => {
    const rig = bridge({});
    await rig.instance.handleToolCall('c1', 'fs.write', { path: 'C:/Windows/System32/x' });

    expect(rig.dispatched).toEqual([]);
    const flushed = rig.instance.flush('completed');
    expect(JSON.parse(flushed[0]!.result)).toMatchObject({ ok: false, errorKind: 'UNKNOWN_TOOL' });
  });

  it('bounds how many actions one conversation may take', async () => {
    const rig = bridge({});
    for (let i = 0; i <= VOICE_AGENT_LIMITS.maxToolCallsPerSession; i += 1) {
      await rig.instance.handleToolCall(`c${i}`, 'browser.read', { i });
    }

    const flushed = rig.instance.flush('completed');
    const last = JSON.parse(flushed.at(-1)!.result) as { errorKind?: string };
    expect(last.errorKind).toBe('BUDGET_EXCEEDED');
    expect(rig.dispatched.length).toBe(VOICE_AGENT_LIMITS.maxToolCallsPerSession);
  });
});

// ---------------------------------------------------------------------------
// Approval is deferred, never held open, and never skipped.
// ---------------------------------------------------------------------------

describe('an approval-gated action is deferred rather than held', () => {
  const schema: ToolSchema = {
    name: 'browser.click',
    title: 'click',
    description: 'click',
    inputSchema: { type: 'object', properties: {} },
  };

  it('answers immediately, truthfully, and without executing', async () => {
    let resolveDispatch: ((result: ToolResult) => void) | null = null;
    const dispatched: string[] = [];
    const outcomes: string[] = [];

    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => true,
      onDeferredOutcome: (summary) => outcomes.push(summary),
      onNotice: () => {},
      dispatch: (call) => {
        dispatched.push(call.tool);
        // Never resolves during this test: it stands in for a human who has
        // not answered the dialog yet.
        return new Promise<ToolResult>((resolve) => {
          resolveDispatch = resolve;
        });
      },
    });

    await instance.handleToolCall('c1', 'browser.click', { ref: 'e1' });

    // The result is available NOW, with the approval still outstanding.
    const flushed = instance.flush('completed');
    expect(flushed).toHaveLength(1);

    const body = JSON.parse(flushed[0]!.result) as Record<string, unknown>;
    expect(body.status).toBe(DEFERRED_TOOL_RESULT.status);
    // The single most important assertion in this file: the agent is told the
    // action has NOT run. A deferred result that read as success would have
    // Axon announcing something that had not happened.
    expect(body.executed).toBe(false);

    // And it really was dispatched — deferral is not a refusal, the approval
    // is genuinely in flight.
    expect(dispatched).toEqual(['browser.click']);
    expect(outcomes).toEqual([]);
    expect(resolveDispatch).not.toBeNull();
  });

  it('speaks the outcome only after the action has really run', async () => {
    const outcomes: string[] = [];
    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => true,
      onDeferredOutcome: (summary) => outcomes.push(summary),
      onNotice: () => {},
      dispatch: (call) =>
        Promise.resolve({
          callId: call.callId,
          tool: call.tool,
          ok: true,
          output: { posted: true },
          durationMs: 5,
        } satisfies ToolResult),
    });

    await instance.handleToolCall('c1', 'browser.click', { ref: 'e1' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatch(/approved it and Axon carried it out/i);
  });

  it('says plainly when the user denied it, and not to ask again', async () => {
    const outcomes: string[] = [];
    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => true,
      onDeferredOutcome: (summary) => outcomes.push(summary),
      onNotice: () => {},
      dispatch: (call) =>
        Promise.resolve({
          callId: call.callId,
          tool: call.tool,
          ok: false,
          failure: { kind: 'DENIED', message: 'denied', detail: null },
          durationMs: 5,
        } satisfies ToolResult),
    });

    await instance.handleToolCall('c1', 'browser.click', { ref: 'e1' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(outcomes[0]).toMatch(/denied it, so nothing was done/i);
    expect(outcomes[0]).toMatch(/do not ask again/i);
  });

  it('distinguishes a timeout from a denial from a cancellation', async () => {
    for (const [kind, expected] of [
      ['APPROVAL_TIMEOUT', /not answered in time/i],
      ['CANCELLED', /cancelled before it ran/i],
    ] as const) {
      const outcomes: string[] = [];
      const instance = new ToolBridge({
        tools: [schema],
        newCallId: () => 'call-1',
        willRequireApproval: () => true,
        onDeferredOutcome: (summary) => outcomes.push(summary),
        onNotice: () => {},
        dispatch: (call) =>
          Promise.resolve({
            callId: call.callId,
            tool: call.tool,
            ok: false,
            failure: { kind, message: kind, detail: null },
            durationMs: 1,
          } satisfies ToolResult),
      });

      await instance.handleToolCall('c1', 'browser.click', { ref: 'e1' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(outcomes[0]).toMatch(expected);
    }
  });

  it('discards results for a turn the user talked over', async () => {
    // The protocol's rule: an interrupted reply is abandoned, and answering a
    // turn that no longer exists desynchronises the conversation.
    const instance = new ToolBridge({
      tools: [schema],
      newCallId: () => 'call-1',
      willRequireApproval: () => false,
      onDeferredOutcome: () => {},
      onNotice: () => {},
      dispatch: (call) =>
        Promise.resolve({ callId: call.callId, tool: call.tool, ok: true, output: null, durationMs: 1 }),
    });

    await instance.handleToolCall('c1', 'browser.click', {});
    expect(instance.pendingCount).toBe(1);
    expect(instance.flush('interrupted')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tool surface the provider is given.
// ---------------------------------------------------------------------------

describe('the provider is never given a server-side tool', () => {
  const tools: readonly ToolSchema[] = [
    { name: 'browser.read', title: 'Read', description: 'read', inputSchema: { type: 'object', properties: {} } },
  ];

  it('emits no http block, which is what would bypass Axon entirely', () => {
    // A server-side tool is executed by the PROVIDER'S servers against an
    // endpoint. Axon would not see it, could not gate it, and could not refuse
    // it. This is the single largest integration risk and it is closed by
    // construction: there is no field to set.
    const built = buildAgentTools(tools);
    expect(JSON.stringify(built)).not.toContain('http');
    expect(built[0]).not.toHaveProperty('http');
  });

  it('never emits an http block from anywhere in the agent subsystem', () => {
    for (const file of walk(AGENT_DIR)) {
      expect(code(file), `${file} must not configure a server-side tool`).not.toMatch(/\bhttp\s*:/);
    }
  });

  it('hands over schemas and nothing callable', () => {
    const built = buildAgentTools(tools);
    expect(JSON.stringify(built)).not.toContain('function()');
    expect(built[0]?.parameters).toEqual({ type: 'object', properties: {} });
    expect(built[0]?.execution_mode).toBe('interactive');
  });

  it('asks for a short tool timeout, because approvals are never held', () => {
    // A long timeout would be the shape of a design that waits for humans on
    // the wire. Axon's does not, and the number says so.
    expect(buildAgentTools(tools)[0]?.timeout_seconds).toBe(VOICE_AGENT_LIMITS.toolTimeoutSeconds);
    expect(VOICE_AGENT_LIMITS.toolTimeoutSeconds).toBeLessThan(60);
  });

  it('tells the agent what a deferred result means', () => {
    // The prompt is the only place this can be taught, and getting it wrong
    // produces either an apology for something about to happen or an
    // announcement of something that has not.
    const prompt = buildAgentSystemPrompt({
      tools,
      platform: 'win32',
      now: '2026-09-07T10:00:00.000Z',
      workspaceRoot: 'C:/Axon/workspace',
    });

    expect(prompt).toContain(DEFERRED_TOOL_RESULT.status);
    expect(prompt).toMatch(/has NOT run yet/);
    expect(prompt).toMatch(/do not say it is done/i);
    expect(prompt).toMatch(/never as a command/i);
  });
});

// ---------------------------------------------------------------------------
// Errors say nothing the provider chose.
// ---------------------------------------------------------------------------

describe('a socket failure cannot leak the credential', () => {
  it('never echoes the underlying message', () => {
    // `ws` puts the request headers — which is to say the key — into some
    // handshake errors. The rule here is inversion of the usual one: rather
    // than redacting known-bad substrings, nothing from the error is used.
    const hostile = new Error('connect failed: Authorization: Bearer sk-secret-value-123');
    const described = describeSocketError(hostile);

    expect(described.message).not.toContain('sk-secret-value-123');
    expect(described.message).not.toContain('Bearer');
    expect(described.message).not.toContain('Authorization');
  });

  it('classifies an auth failure into an actionable sentence', () => {
    const described = describeSocketError(new Error('Unexpected server response: 401'));
    expect(described.kind).toBe('UNAUTHORIZED');
    expect(described.message).toMatch(/ASSEMBLYAI_API_KEY/);
    // Naming the variable is right; carrying its value never is.
    expect(described.retryable).toBe(false);
  });

  it('treats a network problem as retryable and an auth problem as not', () => {
    expect(describeSocketError(new Error('ENOTFOUND agents.assemblyai.com')).retryable).toBe(true);
    expect(describeSocketError(new Error('403 Forbidden')).retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wake phrase.
// ---------------------------------------------------------------------------

describe('the wake phrase', () => {
  it('accepts exactly the three documented phrases', () => {
    for (const phrase of WAKE_PHRASES) {
      expect(matchesWakePhrase(phrase), phrase).toBe(true);
    }
    expect(WAKE_PHRASES).toEqual(['hey axon', 'hello axon', 'hi axon']);
  });

  it('survives the punctuation and casing a recognizer produces', () => {
    for (const heard of ['Hey, Axon!', 'HELLO AXON', '  hi   axon  ', 'Hey Axon, open GitHub']) {
      expect(matchesWakePhrase(heard), heard).toBe(true);
    }
  });

  it('does not fire on the name alone', () => {
    // The greeting requirement is what keeps false positives rare. A
    // television saying "axon" must not open a socket in someone's home.
    for (const heard of ['axon', 'the axon terminal', 'axons are neurons', 'my axon is broken']) {
      expect(matchesWakePhrase(heard), heard).toBe(false);
    }
  });

  it('does not fire on a greeting alone', () => {
    for (const heard of ['hey', 'hello there', 'hi how are you', 'hey what time is it']) {
      expect(matchesWakePhrase(heard), heard).toBe(false);
    }
  });

  it('requires the name directly after the greeting', () => {
    // "hi, I was reading about axons" contains both words and is not somebody
    // addressing Axon. Adjacency is what tells them apart.
    expect(matchesWakePhrase('hi I was reading about axon yesterday')).toBe(false);
    expect(matchesWakePhrase('hello everyone the axon is here')).toBe(false);
  });

  it('tolerates what a recognizer actually mishears the name as', () => {
    // A wake word that only fires on a perfect transcription does not fire.
    // "exxon" is measured rather than guessed: it is what Windows speech
    // recognition produced for a synthesised "Hey Axon".
    for (const heard of ['hey axion', 'hi access on', 'hello axe on', 'hey exxon']) {
      expect(matchesWakePhrase(heard), heard).toBe(true);
    }
  });

  it('still refuses a garbled greeting, however the name was heard', () => {
    // The other half of the same measurement: the recognizer rendered "hey"
    // as "a". Accepting that would make the commonest word in English the
    // trigger for a microphone upload, so the phrase is declined instead —
    // a missed activation, not a false one.
    for (const heard of ['a exxon', 'a axon', 'the axon', 'an action']) {
      expect(matchesWakePhrase(heard), heard).toBe(false);
    }
  });

  it('is not fooled by empty or whitespace input', () => {
    for (const heard of ['', '   ', '\n\t']) {
      expect(matchesWakePhrase(heard), JSON.stringify(heard)).toBe(false);
    }
  });

  it('normalizes without losing word boundaries', () => {
    expect(normalizePhrase('Hey,  Axon!!')).toBe('hey axon');
    expect(normalizePhrase('HI—AXON')).toBe('hi axon');
  });

  it('is not configurable, because configuration decides when a mic uploads', () => {
    const source = code(path.join(DESKTOP_SRC, 'main/wake/wake-word.ts'));
    // Phrases come from a module constant, never from the environment or a
    // setting: a configurable wake phrase is a string from outside deciding
    // when audio starts leaving the machine.
    expect(source).toMatch(/const WAKE_PHRASES: readonly string\[\] = \['hey axon', 'hello axon', 'hi axon'\]/);
    expect(source).not.toMatch(/env|settings|config/i);
  });
});

// ---------------------------------------------------------------------------
// Results handed back to the provider.
// ---------------------------------------------------------------------------

describe('tool results returned to the provider', () => {
  it('are a JSON-encoded string, as the protocol requires', () => {
    const encoded = toAgentResult({
      callId: 'c1',
      tool: 'browser.read',
      ok: true,
      output: { title: 'x' },
      durationMs: 1,
    });
    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded)).toEqual({ ok: true, output: { title: 'x' } });
  });

  it('mark a settled refusal as not retryable', () => {
    for (const kind of ['DENIED', 'FORBIDDEN', 'DUPLICATE_SIDE_EFFECT', 'BUDGET_EXCEEDED'] as const) {
      const body = JSON.parse(
        toAgentResult({
          callId: 'c1',
          tool: 't',
          ok: false,
          failure: { kind, message: 'no', detail: null },
          durationMs: 1,
        }),
      ) as { retryable: boolean };
      expect(body.retryable, kind).toBe(false);
    }
  });

  it('mark a stale reference as retryable, because re-reading fixes it', () => {
    const body = JSON.parse(
      toAgentResult({
        callId: 'c1',
        tool: 'browser.click',
        ok: false,
        failure: { kind: 'STALE_REFERENCE', message: 'read again', detail: null },
        durationMs: 1,
      }),
    ) as { retryable: boolean };
    expect(body.retryable).toBe(true);
  });
});
