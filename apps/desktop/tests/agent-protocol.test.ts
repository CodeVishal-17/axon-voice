/**
 * The Voice Agent protocol, against a real WebSocket server.
 *
 * NOT a mock of `ws`. A real `WebSocketServer` on an ephemeral loopback port,
 * a real client socket, real JSON frames, real base64 audio. What is
 * substituted is the PROVIDER — this server replays the documented event
 * sequence rather than reaching AssemblyAI — which is the only part that costs
 * money and needs a network.
 *
 * That distinction is the point. Mocking the socket would test that the code
 * calls the functions it calls; this tests that the bytes on the wire are the
 * ones the protocol specifies, that the handshake completes, that the auth
 * header is set, and that a dropped connection is handled the way a dropped
 * connection actually behaves.
 *
 * NOTHING HERE TOUCHES THE REAL PROVIDER, and no API key is needed: the server
 * accepts any Authorization header and asserts on its shape.
 */

import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE_AGENT_ENCODING, VOICE_AGENT_LIMITS, type SpeechChunk, type ToolResult } from '@axon/core';
import { VoiceSocket } from '../src/main/agent/assemblyai-client.js';
import { VoiceAgentSession } from '../src/main/agent/voice-agent-session.js';

/** A stand-in provider: a real server that replays documented events. */
interface FakeProvider {
  readonly url: string;
  /** Every message the client sent, parsed. */
  readonly received: Record<string, unknown>[];
  /** The Authorization header the client presented on the upgrade. */
  authorization: string | null;
  /** Push one server event to the connected client. */
  send(message: Record<string, unknown>): void;
  /** Drop the connection, as a network failure would. */
  drop(): void;
  close(): Promise<void>;
  /** Resolves once a client has connected. */
  connected(): Promise<void>;
}

async function startProvider(options: { autoReady?: boolean } = {}): Promise<FakeProvider> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received: Record<string, unknown>[] = [];
  let socket: WebSocket | null = null;
  let authorization: string | null = null;

  let onConnected: (() => void) | null = null;
  const connectedPromise = new Promise<void>((resolve) => {
    onConnected = resolve;
  });

  server.on('connection', (client, request) => {
    socket = client;
    authorization = request.headers.authorization ?? null;

    client.on('message', (data: RawData) => {
      try {
        received.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      } catch {
        /* a frame that is not JSON is not part of this protocol */
      }
    });

    if (options.autoReady !== false) {
      client.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_test_1' }));
    }
    onConnected?.();
  });

  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    get authorization() {
      return authorization;
    },
    send(message) {
      socket?.send(JSON.stringify(message));
    },
    drop() {
      socket?.terminate();
    },
    connected: () => connectedPromise,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

/** Wait until `predicate` holds, or fail with what was actually seen. */
async function until(predicate: () => boolean, describe_: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe_}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const providers: FakeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
});

async function provider(options: { autoReady?: boolean } = {}): Promise<FakeProvider> {
  const started = await startProvider(options);
  providers.push(started);
  return started;
}

// ---------------------------------------------------------------------------
// The socket.
// ---------------------------------------------------------------------------

describe('VoiceSocket', () => {
  it('authenticates with a Bearer header on the upgrade', async () => {
    const fake = await provider();
    const messages: Record<string, unknown>[] = [];

    const socket = new VoiceSocket(
      { apiKey: 'test-key-value', endpoint: fake.url },
      { onMessage: (message) => messages.push(message), onClosed: () => {} },
    );
    await socket.open_();
    await fake.connected();

    // The documented auth: Bearer on the HTTP upgrade, not a query parameter,
    // which would put the credential somewhere proxies and logs can see it.
    expect(fake.authorization).toBe('Bearer test-key-value');
    expect(fake.url).not.toContain('test-key-value');

    await until(() => messages.length > 0, 'session.ready');
    expect(messages[0]).toMatchObject({ type: 'session.ready' });
    socket.close();
  });

  it('sends audio as base64 in an input.audio envelope', async () => {
    const fake = await provider();
    const socket = new VoiceSocket({ apiKey: 'k', endpoint: fake.url }, { onMessage: () => {}, onClosed: () => {} });
    await socket.open_();

    // Two samples of 16-bit PCM: 0x0100 and 0x0302 little-endian.
    socket.sendAudio(new Uint8Array([0, 1, 2, 3]));
    await until(() => fake.received.some((m) => m.type === 'input.audio'), 'input.audio');

    const audio = fake.received.find((m) => m.type === 'input.audio')!;
    expect(typeof audio.audio).toBe('string');
    expect(Buffer.from(String(audio.audio), 'base64')).toEqual(Buffer.from([0, 1, 2, 3]));
    socket.close();
  });

  it('refuses to send more audio than one session may', async () => {
    const fake = await provider();
    let closedWith: string | null = null;
    const socket = new VoiceSocket(
      { apiKey: 'k', endpoint: fake.url },
      { onMessage: () => {}, onClosed: (error) => (closedWith = error?.kind ?? null) },
    );
    await socket.open_();

    // One frame past the ceiling. The bound exists so a session Axon forgot to
    // close becomes an ended session rather than an unbounded bill.
    const huge = new Uint8Array(VOICE_AGENT_LIMITS.maxSessionAudioBytes + 2);
    expect(socket.sendAudio(huge)).toBe(false);
    await until(() => closedWith !== null, 'the socket to close');
    expect(closedWith).toBe('PROTOCOL');
  });

  it('says session.end on a polite close', async () => {
    const fake = await provider();
    const socket = new VoiceSocket({ apiKey: 'k', endpoint: fake.url }, { onMessage: () => {}, onClosed: () => {} });
    await socket.open_();
    socket.close();

    await until(() => fake.received.some((m) => m.type === 'session.end'), 'session.end');
  });

  it('reports an unreachable provider without leaking the key', async () => {
    const socket = new VoiceSocket(
      // A port nothing is listening on.
      { apiKey: 'secret-key-abc', endpoint: 'ws://127.0.0.1:1', handshakeTimeoutMs: 1_500 },
      { onMessage: () => {}, onClosed: () => {} },
    );

    await expect(socket.open_()).rejects.toMatchObject({ name: 'VoiceSocketError' });
    await socket.open_().catch((error: Error) => {
      expect(error.message).not.toContain('secret-key-abc');
    });
  });

  it('discards a frame that is not a JSON object', async () => {
    const fake = await provider();
    const messages: Record<string, unknown>[] = [];
    const socket = new VoiceSocket(
      { apiKey: 'k', endpoint: fake.url },
      { onMessage: (message) => messages.push(message), onClosed: () => {} },
    );
    await socket.open_();
    await until(() => messages.length === 1, 'session.ready');

    // A peer's message is input. Anything that is not a typed JSON object is
    // dropped rather than coerced into one.
    fake.send([1, 2, 3] as unknown as Record<string, unknown>);
    fake.send({ notype: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(messages).toHaveLength(1);
    socket.close();
  });
});

// ---------------------------------------------------------------------------
// The session.
// ---------------------------------------------------------------------------

describe('VoiceAgentSession', () => {
  interface Rig {
    readonly session: VoiceAgentSession;
    readonly fake: FakeProvider;
    readonly transcripts: { user: string[]; agent: string[] };
    readonly chunks: SpeechChunk[];
    readonly phases: string[];
    readonly notices: string[];
    readonly dispatched: { tool: string; input: unknown }[];
    closed: boolean;
  }

  async function rig(
    options: {
      requiresApproval?: boolean;
      dispatch?: (tool: string) => ToolResult;
    } = {},
  ): Promise<Rig> {
    const fake = await provider();

    const state: Rig = {
      session: null as unknown as VoiceAgentSession,
      fake,
      transcripts: { user: [], agent: [] },
      chunks: [],
      phases: [],
      notices: [],
      dispatched: [],
      closed: false,
    };

    const session = new VoiceAgentSession({
      apiKey: 'k',
      platform: 'win32',
      workspaceRoot: 'C:/Axon/workspace',
      tools: [
        { name: 'browser.read', title: 'Read', description: 'read a page', inputSchema: { type: 'object', properties: {} } },
      ],
      createSocket: (handlers) => new VoiceSocket({ apiKey: 'k', endpoint: fake.url }, handlers),
      newCallId: () => 'call-1',
      dispatch: (call) => {
        state.dispatched.push({ tool: call.tool, input: call.input });
        return Promise.resolve(
          options.dispatch?.(call.tool) ?? {
            callId: call.callId,
            tool: call.tool,
            ok: true,
            output: { read: true },
            durationMs: 1,
          },
        );
      },
      willRequireApproval: () => options.requiresApproval ?? false,
      onUserTranscript: (text) => state.transcripts.user.push(text),
      onAgentTranscript: (text) => state.transcripts.agent.push(text),
      onAudioChunk: (chunk) => state.chunks.push(chunk),
      onPhase: (phase) => state.phases.push(phase),
      onNotice: (summary) => state.notices.push(summary),
      onClosed: () => {
        state.closed = true;
      },
    });

    (state as { session: VoiceAgentSession }).session = session;
    await session.start();
    await fake.connected();
    return state;
  }

  it('configures the session with the documented shape', async () => {
    const r = await rig();
    await until(() => r.fake.received.some((m) => m.type === 'session.update'), 'session.update');

    const update = r.fake.received.find((m) => m.type === 'session.update')!;
    const config = update.session as Record<string, unknown>;

    expect(typeof config.system_prompt).toBe('string');
    expect(config.input).toEqual({ format: { encoding: VOICE_AGENT_ENCODING, sample_rate: VOICE_AGENT_LIMITS.sampleRate } });
    expect(config.output).toEqual({ format: { encoding: VOICE_AGENT_ENCODING, sample_rate: VOICE_AGENT_LIMITS.sampleRate } });
    expect(Array.isArray(config.tools)).toBe(true);

    // The rule that matters most: no server-side tool, ever.
    expect(JSON.stringify(config.tools)).not.toContain('http');
    r.session.stop();
  });

  it('turns a final user transcript into one message, ignoring deltas', async () => {
    const r = await rig();

    r.fake.send({ type: 'transcript.user.delta', text: 'open my' });
    r.fake.send({ type: 'transcript.user.delta', text: 'open my git' });
    r.fake.send({ type: 'transcript.user', text: 'open my GitHub issues', item_id: 'i1' });

    await until(() => r.transcripts.user.length > 0, 'a final transcript');
    // A transcript still being revised has no business in an append-only
    // event stream, and the final one arrives a moment later regardless.
    expect(r.transcripts.user).toEqual(['open my GitHub issues']);
    r.session.stop();
  });

  it('streams reply audio to the speakers as it arrives', async () => {
    const r = await rig();

    r.fake.send({ type: 'reply.started' });
    r.fake.send({ type: 'reply.audio', data: Buffer.from([1, 0, 2, 0]).toString('base64') });
    r.fake.send({ type: 'reply.audio', data: Buffer.from([3, 0, 4, 0]).toString('base64') });

    await until(() => r.chunks.filter((c) => !c.final).length === 2, 'two audio chunks');

    // Streaming, not buffering: the chunks arrive individually and in order,
    // which is what lets Axon start speaking before the reply is finished.
    expect(r.chunks[0]?.sequence).toBe(1);
    expect(r.chunks[1]?.sequence).toBe(2);
    expect(r.chunks[0]?.speechId).toBe(r.chunks[1]?.speechId);
    expect(r.chunks[0]?.sampleRate).toBe(VOICE_AGENT_LIMITS.sampleRate);
    expect([...r.chunks[0]!.pcm]).toEqual([1, 0, 2, 0]);

    r.fake.send({ type: 'reply.done', status: 'completed' });
    await until(() => r.chunks.some((c) => c.final), 'the final marker');
    r.session.stop();
  });

  it('drops an oversized audio payload rather than forwarding it', async () => {
    const r = await rig();
    r.fake.send({ type: 'reply.started' });
    r.fake.send({
      type: 'reply.audio',
      data: Buffer.alloc(VOICE_AGENT_LIMITS.maxInboundAudioBytes + 16).toString('base64'),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(r.chunks.filter((c) => !c.final)).toHaveLength(0);
    r.session.stop();
  });

  it('holds tool results until reply.done, as the protocol requires', async () => {
    const r = await rig();

    r.fake.send({ type: 'tool.call', call_id: 'call_abc', name: 'browser.read', arguments: {} });
    await until(() => r.dispatched.length === 1, 'the dispatch');

    // Dispatched, but NOT answered: sending mid-turn confuses turn-taking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.fake.received.some((m) => m.type === 'tool.result')).toBe(false);

    r.fake.send({ type: 'reply.done', status: 'completed' });
    await until(() => r.fake.received.some((m) => m.type === 'tool.result'), 'the tool result');

    const result = r.fake.received.find((m) => m.type === 'tool.result')!;
    expect(result.call_id).toBe('call_abc');
    // The protocol requires a JSON-ENCODED STRING, not a nested object.
    expect(typeof result.result).toBe('string');
    expect(JSON.parse(String(result.result))).toMatchObject({ ok: true });
    r.session.stop();
  });

  it('discards results when the user talked over the turn', async () => {
    const r = await rig();
    r.fake.send({ type: 'tool.call', call_id: 'call_abc', name: 'browser.read', arguments: {} });
    await until(() => r.dispatched.length === 1, 'the dispatch');

    r.fake.send({ type: 'reply.done', status: 'interrupted' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(r.fake.received.some((m) => m.type === 'tool.result')).toBe(false);
    r.session.stop();
  });

  it('answers an approval-gated call immediately, then speaks the outcome', async () => {
    const r = await rig({ requiresApproval: true });

    r.fake.send({ type: 'tool.call', call_id: 'call_abc', name: 'browser.read', arguments: {} });
    r.fake.send({ type: 'reply.done', status: 'completed' });

    await until(() => r.fake.received.some((m) => m.type === 'tool.result'), 'the deferred result');
    const result = r.fake.received.find((m) => m.type === 'tool.result')!;
    expect(JSON.parse(String(result.result))).toMatchObject({ status: 'pending_user_approval', executed: false });

    // And afterwards, a NEW turn carrying what actually happened — never a
    // second answer to a tool call that was already answered.
    await until(() => r.fake.received.some((m) => m.type === 'reply.create'), 'the spoken outcome');
    const spoken = r.fake.received.find((m) => m.type === 'reply.create')!;
    expect(String(spoken.instructions)).toMatch(/approved it and Axon carried it out/i);
    r.session.stop();
  });

  it('stops the current utterance when the user barges in', async () => {
    const r = await rig();
    r.fake.send({ type: 'reply.started' });
    r.fake.send({ type: 'reply.audio', data: Buffer.from([1, 0]).toString('base64') });
    await until(() => r.chunks.length > 0, 'audio');

    r.fake.send({ type: 'input.speech.started' });
    await until(() => r.chunks.some((c) => c.final), 'the utterance to be closed');

    // Talking over Axon stops Axon, through the same path the stop button uses.
    expect(r.phases).toContain('LISTENING');
    r.session.stop();
  });

  it('never shows the provider a message it wrote', async () => {
    const r = await rig();
    r.fake.send({
      type: 'session.error',
      code: 'invalid_format',
      message: 'Bearer sk-leaked-key-value and other internals',
    });
    await until(() => r.notices.length > 0, 'the notice');

    // The code is a value we choose the wording for; the message is text from
    // a remote party that could reach the screen or the log.
    expect(r.notices.join(' ')).toContain('invalid_format');
    expect(r.notices.join(' ')).not.toContain('sk-leaked-key-value');
    r.session.stop();
  });

  it('buffers microphone audio to the provider chunk size', async () => {
    const r = await rig();

    // One small frame is under the target and must not be sent on its own.
    r.session.pushAudio(new Uint8Array(64));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.fake.received.some((m) => m.type === 'input.audio')).toBe(false);

    // Enough to cross 50 ms at 24 kHz 16-bit = 2400 bytes.
    r.session.pushAudio(new Uint8Array(2_400));
    await until(() => r.fake.received.some((m) => m.type === 'input.audio'), 'input.audio');
    r.session.stop();
  });

  it('sends nothing after it is stopped', async () => {
    const r = await rig();
    r.session.stop();

    // Let the polite close (`session.end`) land before sampling, so the count
    // below measures what the stopped session sent rather than what was still
    // in flight when it stopped.
    await until(() => r.fake.received.some((m) => m.type === 'session.end'), 'session.end');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const before = r.fake.received.length;
    r.session.pushAudio(new Uint8Array(8_000));
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A stopped session is a closed microphone. Anything else would mean audio
    // continuing to leave after the user said stop.
    expect(r.fake.received.length).toBe(before);
    expect(r.closed).toBe(true);
  });

  it('ends when the provider ends the session', async () => {
    const r = await rig();
    r.fake.send({ type: 'session.ended' });
    await until(() => r.closed, 'the session to close');
    expect(r.phases).toContain('CLOSED');
  });

  it('ignores an event it does not recognise', async () => {
    const r = await rig();
    const phases = r.phases.length;
    r.fake.send({ type: 'some.future.event', payload: { anything: true } });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Guessing at an unknown event is how a client acts on something it does
    // not understand.
    expect(r.phases.length).toBe(phases);
    r.session.stop();
  });
});
