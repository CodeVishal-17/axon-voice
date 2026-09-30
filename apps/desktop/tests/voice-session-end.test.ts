/**
 * What the orb says after a conversation ends by itself.
 *
 * A BUG FOUND BY USING THE APP. A voice conversation was started, nobody
 * spoke, and the provider closed the session sixteen seconds later. The event
 * log recorded it exactly:
 *
 *     12:07:05  VOICE_SESSION  connected
 *     12:07:06  STATE_CHANGED  THINKING -> LISTENING
 *     12:07:22  VOICE_SESSION  ended
 *     (nothing)
 *
 * No state change after the session ended. The machine stayed in LISTENING,
 * so the panel sat on "Listening..." for ever, the orb never moved again, and
 * clicking it offered "stop listening" for a session that no longer existed —
 * leaving no way to get out of the state from inside the app.
 *
 * The cause was `settle()` refusing, by design, to leave LISTENING: that rule
 * is right for push-to-talk, which owns its own microphone and reports its own
 * end through `onListeningEnded`, but the voice agent had no equivalent. It
 * closes its microphone and then settles, and the settle was being dropped.
 *
 * These drive the real orchestrator against a real VoiceAgentSession over a
 * real local socket, and close that socket the way the provider did.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { VoiceSocket } from '../src/main/agent/assemblyai-client.js';
import { VoiceAgentSession } from '../src/main/agent/voice-agent-session.js';
import type { AxonEvent } from '@axon/core';

const servers: WebSocketServer[] = [];
const orchestrators: Orchestrator[] = [];

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) orchestrator.shutdown();
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A provider that says it is ready, and can drop the session on command. */
async function provider(): Promise<{ endpoint: string; endSession: () => void }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_end_test' }));
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    // What the provider did after sixteen seconds of silence.
    endSession: () => {
      for (const client of server.clients) client.close();
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function rig(endpoint: string) {
  const events: AxonEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));

  const orchestrator = new Orchestrator({
    bus,
    registry: new ToolRegistry(),
    approvalTimeoutMs: 2_000,
    devConsoleEnabled: false,
    captureCommand: () => {},
    voiceAgent: {
      name: 'assemblyai',
      create: (wiring) =>
        new VoiceAgentSession({
          apiKey: 'voice-session-end-test-key',
          platform: 'Windows',
          workspaceRoot: '/nowhere',
          createSocket: (handlers) => new VoiceSocket({ apiKey: 'voice-session-end-test-key', endpoint }, handlers),
          ...wiring,
        }),
    },
  });
  orchestrators.push(orchestrator);
  return { orchestrator, events };
}

describe('a voice conversation that ends by itself', () => {
  it('does not leave the machine claiming to be listening', async () => {
    const p = await provider();
    const r = rig(p.endpoint);

    expect(r.orchestrator.startVoiceSession('manual').accepted).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);

    p.endSession();

    // The session is over, so the microphone is closed and LISTENING is no
    // longer true. Whatever the machine settles to, it must not be LISTENING.
    expect(await until(() => r.orchestrator.voiceAgentStatus().active === false)).toBe(true);
    expect(await until(() => r.orchestrator.state !== 'LISTENING')).toBe(true);
    expect(r.orchestrator.state).toBe('IDLE');
  });

  it('records the state change, so the window is told and not only the log', async () => {
    const p = await provider();
    const r = rig(p.endpoint);

    expect(r.orchestrator.startVoiceSession('manual').accepted).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);
    p.endSession();
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);

    // The renderer follows STATE_CHANGED. A machine that moved without saying
    // so would leave the panel exactly as stuck as the original bug did.
    const left = r.events.filter(
      (event): event is Extract<AxonEvent, { type: 'STATE_CHANGED' }> => event.type === 'STATE_CHANGED' && event.from === 'LISTENING',
    );
    expect(left.length).toBeGreaterThan(0);
    expect(left.at(-1)?.to).toBe('IDLE');
  });

  it('still refuses to leave LISTENING while the session is live', async () => {
    const p = await provider();
    const r = rig(p.endpoint);

    expect(r.orchestrator.startVoiceSession('manual').accepted).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);

    // The barge-in case the rule exists for: a turn that was waiting on speech
    // resolves and settles just after the machine has entered LISTENING. The
    // microphone is open, so the orb must stay in LISTENING.
    r.orchestrator.settle('Turn finished');
    expect(r.orchestrator.state).toBe('LISTENING');
  });
});
