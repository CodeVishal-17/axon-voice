/**
 * The wake word gets its microphone back.
 *
 * A RELEASE-BLOCKING BUG. A voice conversation and a push-to-talk session both
 * take the microphone from the wake word, and nothing gave it back: the
 * detector stayed ARMED while no audio reached it, so "Hey Axon" worked once
 * per launch. Every wake-word test drove the detector directly and none saw
 * it, because the bug was in who owns the microphone, not in how the phrase
 * is heard.
 *
 * These drive the real orchestrator — and, for the conversation, a real
 * VoiceAgentSession over a real local socket — and assert on the capture
 * commands the window would receive.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { CaptureCommand } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { VoiceSocket } from '../src/main/agent/assemblyai-client.js';
import { VoiceAgentSession } from '../src/main/agent/voice-agent-session.js';
import type { VoiceAgentProvider } from '../src/main/agent/create-voice-agent.js';

const servers: WebSocketServer[] = [];
const orchestrators: Orchestrator[] = [];

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) orchestrator.shutdown();
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function localProvider(): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_wake_resume' }));
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function rig(endpoint: string | null) {
  const commands: CaptureCommand[] = [];
  const heardByWake: number[] = [];

  const voiceAgent: VoiceAgentProvider | null = endpoint
    ? {
        name: 'assemblyai',
        create: (wiring) =>
          new VoiceAgentSession({
            apiKey: 'wake-resume-test-key',
            platform: 'Windows',
            workspaceRoot: '/nowhere',
            createSocket: (handlers) => new VoiceSocket({ apiKey: 'wake-resume-test-key', endpoint }, handlers),
            ...wiring,
          }),
      }
    : null;

  const orchestrator = new Orchestrator({
    bus: new EventBus(),
    registry: new ToolRegistry(),
    approvalTimeoutMs: 2_000,
    devConsoleEnabled: false,
    captureCommand: (command) => commands.push(command),
    voiceAgent,
  });
  orchestrators.push(orchestrator);
  orchestrator.attachWakeWord({
    pushFrame: (frame) => heardByWake.push(frame.length),
    // These tests are about the MICROPHONE following the wake word, not about
    // which engine is hearing. A stand-in status keeps them independent of
    // that choice.
    getStatus: () => ({
      engine: 'keyword-spotter',
      detail: 'stand-in',
      available: true,
      unavailableReason: null,
      restarts: 0,
      starvedOfAudio: false,
    }),
  });

  const starts = (): CaptureCommand[] => commands.filter((command) => command.action === 'start');
  return { orchestrator, commands, heardByWake, starts };
}

describe('the wake word keeps its microphone', () => {
  it('opens the microphone when armed', () => {
    const r = rig(null);
    r.orchestrator.setWakeArmed(true);
    expect(r.starts()).toHaveLength(1);
  });

  it('gets the microphone back after a voice conversation ends', async () => {
    const r = rig(await localProvider());
    r.orchestrator.setWakeArmed(true);
    const wakeCapture = r.starts()[0]!.captureId;

    // "Hey Axon" -> a conversation. The wake word's capture is stopped and the
    // conversation's is started.
    expect(r.orchestrator.startVoiceSession('wake-word').accepted).toBe(true);
    expect(r.commands.some((command) => command.action === 'stop' && command.captureId === wakeCapture)).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);

    // The conversation ends.
    r.orchestrator.stopVoiceSession();
    expect(await until(() => r.orchestrator.voiceAgentStatus().active === false)).toBe(true);

    // THE FIX: a fresh capture for the wake word, and its audio reaches the detector.
    const last = r.commands.at(-1)!;
    expect(last.action).toBe('start');
    expect(last.captureId).not.toBe(wakeCapture);
    r.orchestrator.pushAudioFrame(last.captureId, new Int16Array(1024));
    expect(r.heardByWake).toEqual([1024]);
  });

  it('gets the microphone back after push-to-talk listening ends', () => {
    const r = rig(null);
    r.orchestrator.setWakeArmed(true);
    // Push-to-talk borrows it...
    r.orchestrator.endWakeCapture();
    expect(r.commands.at(-1)?.action).toBe('stop');
    // ...and when listening ends, it comes back.
    r.orchestrator.onListeningEnded('no-speech' as Parameters<Orchestrator['onListeningEnded']>[0]);
    expect(r.commands.at(-1)?.action).toBe('start');
  });

  it('does not reopen the microphone for a wake word that is not armed', async () => {
    const r = rig(await localProvider());
    expect(r.orchestrator.startVoiceSession('manual').accepted).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);
    r.orchestrator.stopVoiceSession();
    expect(await until(() => r.orchestrator.voiceAgentStatus().active === false)).toBe(true);

    // Only the conversation's own start and stop: nothing opened afterwards.
    expect(r.starts()).toHaveLength(1);
    expect(r.commands.at(-1)?.action).toBe('stop');
  });

  it('never gives the wake word a microphone the conversation is still using', async () => {
    const r = rig(await localProvider());
    r.orchestrator.setWakeArmed(true);
    expect(r.orchestrator.startVoiceSession('wake-word').accepted).toBe(true);
    expect(await until(() => r.orchestrator.state === 'LISTENING')).toBe(true);

    // Listening ending while a conversation owns the microphone must not
    // hand it to the wake word.
    const before = r.starts().length;
    r.orchestrator.onListeningEnded('no-speech' as Parameters<Orchestrator['onListeningEnded']>[0]);
    expect(r.starts().length).toBe(before);
    r.orchestrator.stopVoiceSession();
  });
});
