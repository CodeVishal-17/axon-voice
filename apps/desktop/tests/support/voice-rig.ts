/**
 * A real voice conversation, with a scripted provider.
 *
 * Every test that is ABOUT the voice path uses this rather than calling
 * orchestrator methods directly, because the bugs it exists to catch were all
 * of one shape: the brain path did something the voice path did not, and the
 * only way to see that is to drive the voice path the way AssemblyAI does.
 *
 *   the provider   a real WebSocket server on 127.0.0.1, speaking the
 *                  provider's protocol: `session.ready`, `transcript.user`,
 *                  `tool.call`, `reply.started`, `reply.audio`, `reply.done`
 *   the session    the shipping `VoiceAgentSession` and `VoiceSocket`
 *   the rest       the shipping orchestrator, dispatcher, tool bridge, task
 *                  ledger and state machine
 *
 * The provider is scripted from the test: `rig.provider.send(...)` is the
 * provider saying something, and `rig.provider.received` is everything Axon
 * said back. Nothing here reaches the network.
 */

import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AxonEvent, AxonState, JsonValue, RegisteredTool } from '@axon/core';
import { EventBus } from '../../src/main/bus/event-bus.js';
import { Orchestrator, type OrchestratorOptions } from '../../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../../src/main/tools/registry.js';
import { VoiceSocket } from '../../src/main/agent/assemblyai-client.js';
import { VoiceAgentSession } from '../../src/main/agent/voice-agent-session.js';

type ProviderMessage = Record<string, unknown> & { readonly type: string };

export interface ScriptedProvider {
  readonly endpoint: string;
  /** Everything Axon sent, decoded, oldest first. Audio frames are not kept. */
  readonly received: ProviderMessage[];
  /** The provider says something. Waits for a connection if there is none yet. */
  send(message: ProviderMessage): Promise<void>;
  /** The provider drops the session. */
  endSession(): void;
  close(): Promise<void>;
}

export async function scriptedProvider(): Promise<ScriptedProvider> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received: ProviderMessage[] = [];
  let client: WebSocket | null = null;
  const waiting: (() => void)[] = [];

  server.on('connection', (socket) => {
    client = socket;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(raw.toString()) as ProviderMessage;
        // Microphone audio is not evidence of anything these tests check, and
        // keeping it would make `received` enormous.
        if (message.type !== 'input.audio') received.push(message);
      } catch {
        /* not ours */
      }
    });
    socket.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_voice_rig' }));
    for (const resolve of waiting.splice(0)) resolve();
  });

  await new Promise<void>((resolve) => server.once('listening', resolve));

  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    async send(message) {
      if (!client) await new Promise<void>((resolve) => waiting.push(resolve));
      client?.send(JSON.stringify(message));
    },
    endSession() {
      for (const socket of server.clients) socket.close();
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface VoiceRigOptions {
  readonly tools: readonly RegisteredTool[];
  /** Anything else the orchestrator should be built with. */
  readonly orchestrator?: Partial<OrchestratorOptions>;
}

export interface VoiceRig {
  readonly provider: ScriptedProvider;
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  /** Every state the machine entered, in order, starting from where it was. */
  readonly states: AxonState[];
  /** Start the conversation and wait until Axon is listening. */
  start(): Promise<void>;
  /** The user says something, as the provider transcribes it. */
  say(text: string): Promise<void>;
  /** The provider's agent proposes a tool. Resolves once Axon has answered it. */
  call(name: string, args: JsonValue): Promise<Record<string, unknown>>;
  /** The provider finishes a reply, which is when queued results are flushed. */
  endReply(status?: string): Promise<void>;
  /** The system prompt Axon sent in `session.update`. */
  systemPrompt(): string;
  dispose(): Promise<void>;
}

let ordinal = 0;

export async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

export async function voiceRig(options: VoiceRigOptions): Promise<VoiceRig> {
  const provider = await scriptedProvider();
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  const states: AxonState[] = [];

  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 2_000,
    devConsoleEnabled: false,
    captureCommand: () => {},
    voiceAgent: {
      name: 'assemblyai',
      create: (wiring) =>
        new VoiceAgentSession({
          apiKey: 'voice-rig-test-key',
          platform: 'Windows',
          workspaceRoot: '/nowhere',
          createSocket: (handlers) => new VoiceSocket({ apiKey: 'voice-rig-test-key', endpoint: provider.endpoint }, handlers),
          ...wiring,
        }),
    },
    ...options.orchestrator,
  });

  states.push(orchestrator.state);
  bus.subscribe((event) => {
    events.push(event);
    if (event.type === 'STATE_CHANGED') states.push(event.to);
  });

  const answered = (callId: string): Record<string, unknown> | null => {
    const hit = provider.received.find((message) => message.type === 'tool.result' && message.call_id === callId);
    if (!hit || typeof hit.result !== 'string') return null;
    return JSON.parse(hit.result) as Record<string, unknown>;
  };

  return {
    provider,
    orchestrator,
    events,
    states,
    async start() {
      const result = orchestrator.startVoiceSession('manual');
      if (!result.accepted) throw new Error(`voice session refused: ${result.error ?? 'no reason'}`);
      if (!(await until(() => orchestrator.state === 'LISTENING'))) throw new Error('never reached LISTENING');
    },
    async say(text) {
      const before = events.filter((event) => event.type === 'USER_MESSAGE').length;
      await provider.send({ type: 'transcript.user', text });
      await until(() => events.filter((event) => event.type === 'USER_MESSAGE').length > before);
    },
    async call(name, args) {
      ordinal += 1;
      const callId = `call_rig_${ordinal}`;
      await provider.send({ type: 'tool.call', call_id: callId, name, arguments: args });
      // Results are flushed at `reply.done`, as the real protocol requires, so
      // the rig ends the reply once the bridge has had a chance to answer.
      let result: Record<string, unknown> | null = null;
      const deadline = Date.now() + 5_000;
      while (result === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await provider.send({ type: 'reply.done', status: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        result = answered(callId);
      }
      if (result === null) throw new Error(`${name} was never answered`);
      return result;
    },
    async endReply(status = 'completed') {
      await provider.send({ type: 'reply.done', status });
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    systemPrompt() {
      const update = provider.received.find((message) => message.type === 'session.update');
      const session = update?.session as { system_prompt?: unknown } | undefined;
      return typeof session?.system_prompt === 'string' ? session.system_prompt : '';
    },
    async dispose() {
      orchestrator.shutdown();
      await provider.close();
    },
  };
}
