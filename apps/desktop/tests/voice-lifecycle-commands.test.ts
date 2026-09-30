/**
 * "Go to sleep" and "stop listening" do what they say.
 *
 * FOUND IN A REAL CONVERSATION. Neither existed. Every one of these was
 * answered by the model while the session went on streaming the microphone:
 *
 *     13:09:55  "You can, you can go to sleep for now."   -> "Goodnight!"
 *     13:10:05  "Yeah, stop listening."                   -> "Understood. I will stop listening now."
 *     13:01:45  "I want you to stop listening to me."     -> "Stopped."
 *     13:01:51  "No, you are still listening."            -> "Stopped."
 *
 * The semantics now, and what each test proves about the MICROPHONE rather
 * than about the words:
 *
 *   sleep    the conversation ends and its microphone closes at once. The
 *            local wake word keeps listening — no audio leaves the machine —
 *            so "Hey Axon" wakes it. Chip: "On-device".
 *   mic-off  the same, and the wake word stops too. Nothing listens, even
 *            locally, until an explicit start (orb, hotkey, tray). Chip:
 *            "Mic off". A renderer reload cannot quietly re-arm it.
 *
 * Every capture command the window would receive is recorded, so "the
 * microphone closed" is asserted as a `stop` command and the absence of any
 * later `start`, not inferred from a state name.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { matchesLifecycleCommand, type CaptureCommand } from '@axon/core';
import { buildAgentSystemPrompt } from '../src/main/agent/agent-tool-surface.js';
import { createSystemTimeTool } from '../src/main/tools/executors/system-time.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

interface StandInWake {
  armed: boolean;
  arms: number;
  disarms: number;
}

const rigs: VoiceRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});

/**
 * A conversation with a wake word attached, behaving as the real detector
 * does: arming and disarming are reported back to the orchestrator.
 */
async function conversation(): Promise<{ r: VoiceRig; wake: StandInWake; commands: CaptureCommand[] }> {
  const commands: CaptureCommand[] = [];
  const r = await voiceRig({
    tools: [createSystemTimeTool()],
    orchestrator: { captureCommand: (command) => commands.push(command) },
  });
  rigs.push(r);

  const wake: StandInWake = { armed: false, arms: 0, disarms: 0 };
  r.orchestrator.attachWakeWord({
    pushFrame: () => {},
    getStatus: () => ({
      engine: 'keyword-spotter',
      detail: 'stand-in',
      available: true,
      unavailableReason: null,
      restarts: 0,
      starvedOfAudio: false,
    }),
    arm: () => {
      wake.arms += 1;
      wake.armed = true;
      r.orchestrator.setWakeArmed(true);
      return Promise.resolve(true);
    },
    disarm: () => {
      wake.disarms += 1;
      wake.armed = false;
      r.orchestrator.setWakeArmed(false);
    },
  });
  // Armed at boot, as index.ts does.
  wake.armed = true;
  r.orchestrator.setWakeArmed(true);

  await r.start();
  return { r, wake, commands };
}

const starts = (commands: CaptureCommand[]): CaptureCommand[] => commands.filter((command) => command.action === 'start');
/** The voice conversation's capture: the one opened at the agent's rate. */
const voiceCaptureOf = (commands: CaptureCommand[]): string | null =>
  starts(commands).find((command) => command.sampleRate === 24_000)?.captureId ?? null;

describe('"go to sleep"', () => {
  it('ends the conversation and closes its microphone at once — the real phrasing', async () => {
    const { r, commands } = await conversation();
    const voiceCapture = voiceCaptureOf(commands);
    expect(voiceCapture).not.toBeNull();

    await r.say('You can, you can go to sleep for now.');

    expect(r.orchestrator.voiceAgentStatus().active).toBe(false);
    expect(commands.some((command) => command.action === 'stop' && command.captureId === voiceCapture)).toBe(true);
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);
  });

  it('keeps the LOCAL wake word listening, so "Hey Axon" can wake it', async () => {
    const { r, wake, commands } = await conversation();
    const before = starts(commands).length;

    await r.say('Go to sleep.');

    expect(wake.disarms).toBe(0);
    expect(r.orchestrator.voiceAgentStatus().armed).toBe(true);
    // The wake word got its microphone back: a new 16 kHz capture, not the
    // conversation's.
    const reopened = starts(commands).slice(before);
    expect(reopened.some((command) => command.sampleRate !== 24_000)).toBe(true);

    // And the wake phrase can start a new conversation.
    expect(r.orchestrator.startVoiceSession('wake-word').accepted).toBe(true);
  });

  it('says what is true, in the event stream the panel reads', async () => {
    const { r } = await conversation();
    await r.say('Go to sleep.');
    const said = r.events.find((event) => event.type === 'OBSERVATION' && /went to sleep/.test(event.summary));
    expect(said).toBeDefined();
    expect(r.events.some((event) => event.type === 'VOICE_SESSION' && event.action === 'ended')).toBe(true);
  });
});

describe('"stop listening"', () => {
  it('closes the conversation AND stops the wake word — the real phrasing', async () => {
    const { r, wake, commands } = await conversation();
    const voiceCapture = voiceCaptureOf(commands);

    await r.say('I want you to stop listening to me.');

    expect(r.orchestrator.voiceAgentStatus().active).toBe(false);
    expect(commands.some((command) => command.action === 'stop' && command.captureId === voiceCapture)).toBe(true);
    expect(wake.disarms).toBe(1);
    expect(r.orchestrator.voiceAgentStatus().armed).toBe(false);
    expect(r.orchestrator.microphoneOff).toBe(true);
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);
  });

  it('opens no microphone afterwards — not even the local one', async () => {
    const { r, commands } = await conversation();
    await r.say('Yeah, stop listening.');
    const after = commands.length;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(starts(commands.slice(after))).toEqual([]);
  });

  it('holds against anything that re-arms the detector behind the user’s back', async () => {
    // A renderer reload re-arms the wake word on `did-finish-load`. That must
    // not reopen a microphone the user asked to close.
    const { r, wake, commands } = await conversation();
    await r.say('Stop listening.');
    const after = commands.length;

    r.orchestrator.setWakeArmed(true);

    expect(wake.armed).toBe(false);
    expect(r.orchestrator.voiceAgentStatus().armed).toBe(false);
    expect(starts(commands.slice(after))).toEqual([]);
  });

  it('ends only with an explicit start, after which normal listening comes back', async () => {
    const { r, wake } = await conversation();
    await r.say('Turn off the microphone.');
    expect(r.orchestrator.microphoneOff).toBe(true);

    // The orb, the hotkey or the tray: an explicit start.
    await r.start();
    expect(r.orchestrator.microphoneOff).toBe(false);

    // When that conversation ends, the wake word is back on.
    r.provider.endSession();
    expect(await until(() => wake.armed)).toBe(true);
    expect(r.orchestrator.voiceAgentStatus().armed).toBe(true);
  });

  it('says what is true: the microphone is off', async () => {
    const { r } = await conversation();
    await r.say('Stop listening.');
    expect(r.events.some((event) => event.type === 'OBSERVATION' && /Microphone off/.test(event.summary))).toBe(true);
    expect(r.events.some((event) => event.type === 'VOICE_SESSION' && event.action === 'disarmed')).toBe(true);
  });
});

describe('what is NOT a command to stop', () => {
  it('"stop" still stops the work and keeps the conversation', async () => {
    const { r } = await conversation();
    await r.say('Stop.');
    expect(r.orchestrator.voiceAgentStatus().active).toBe(true);
    expect(r.orchestrator.state).toBe('LISTENING');
  });

  it.each([
    ['Can you stop listening to music on Spotify?'],
    ['Did you go to sleep?'],
    ["Don't stop listening."],
    ['Play Stop Listening.'],
    ['Remind me to go to sleep at eleven.'],
    ['No, you are still listening.'],
  ])('"%s" leaves the conversation running', async (text) => {
    const { r, wake } = await conversation();
    await r.say(text);
    expect(r.orchestrator.voiceAgentStatus().active).toBe(true);
    expect(wake.disarms).toBe(0);
  });
});

describe('the matcher', () => {
  it.each([
    ['You can, you can go to sleep for now.', 'sleep'],
    ['You may now go to sleep.', 'sleep'],
    ['Go back to sleep.', 'sleep'],
    ['End the conversation.', 'sleep'],
    ['Okay, bye.', 'sleep'],
    ["Thanks, that's all.", 'sleep'],
    ['Yeah, stop listening.', 'mic-off'],
    ['I want you to stop listening to me.', 'mic-off'],
    ['Turn off the microphone.', 'mic-off'],
    ['Mute yourself.', 'mic-off'],
    ['Stop listening and go to sleep.', 'mic-off'],
    ['No need to go to sleep.', null],
    ['Open Notepad.', null],
    ['What time is it?', null],
    ['Stop.', null],
  ] as const)('%s -> %s', (text, expected) => {
    expect(matchesLifecycleCommand(text)).toBe(expected);
  });
});

describe('the model is told it cannot do this itself', () => {
  it('forbids claiming to have stopped listening, and says what to tell the user', () => {
    const prompt = buildAgentSystemPrompt({ tools: [], platform: 'Windows', workspaceRoot: '/w' });
    expect(prompt).toMatch(/"Stop" means stop the work\. It never means stop listening/);
    expect(prompt).toMatch(/never say "Stopped",\s+"goodnight" or that you have stopped listening/);
    expect(prompt).toMatch(/Say 'stop\s+listening' or tap the orb/);
  });
});
