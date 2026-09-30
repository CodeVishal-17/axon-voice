/**
 * NEVER GET STUCK.
 *
 * The individual failure paths already have suites: `cancellation.test.ts`,
 * `browser-timeout.test.ts`, `agent-protocol.test.ts` for a dropped socket,
 * `agent-voice-security.test.ts` for denial, timeout and interruption. Those
 * ask "does the failure behave correctly?"
 *
 * This file asks the only question a live demo cares about, and asks it the
 * same way twelve times: AFTER THAT WENT WRONG, CAN THE SHOW GO ON? Each test
 * breaks something, checks that what the user is told is a sentence rather
 * than a diagnostic, and then does the next ordinary thing and requires it to
 * work. A product that recovers into a subtly wrong state passes every test in
 * the other files and still dies on stage.
 *
 * The second, quieter assertion is everywhere: NO STACK TRACES. A message with
 * a file path or a frame in it is a message that was written for a developer
 * and shown to a person, and on a stage it is shown to a room.
 */

import { describe, expect, it } from 'vitest';
import { createDemoHarness, fakeDesktop, type DemoHarness } from './support/demo-harness.js';
import { internshipSite, youtubeSite } from './support/fake-site.js';

function elementsOf(answer: { body: Record<string, unknown> } | undefined): { ref: string; label: string; role: string }[] {
  const output = (answer?.body.output ?? {}) as { elements?: { ref: string; label: string; role: string }[] };
  return output.elements ?? [];
}

function lastMessage(h: DemoHarness): string {
  const body = h.answers.at(-1)?.body ?? {};
  const message = body.message ?? body.error ?? '';
  return typeof message === 'string' ? message : '';
}

/**
 * Nothing a developer wrote for a developer.
 *
 * Checked on the text the MODEL receives, because whatever the model receives
 * is one sentence away from being said out loud.
 */
function expectHumanReadable(text: string): void {
  expect(text).not.toMatch(/\n\s+at\s/); // a stack frame
  expect(text).not.toMatch(/[A-Za-z]:\\|\/src\/|\.ts:\d+/); // a path
  expect(text).not.toMatch(/undefined|\[object Object\]|NaN/);
  expect(text.length).toBeLessThan(600);
}

/**
 * The show goes on: an ordinary request, after the failure, must work.
 *
 * The URL is a parameter because a fixture serves one origin, and asking a
 * careers-site harness for YouTube would fail for a reason that has nothing
 * to do with recovery.
 */
async function recovers(h: DemoHarness, url = 'https://www.youtube.com/'): Promise<void> {
  h.say('open the page');
  await h.propose('browser.open', { url });
  expect(h.answers.at(-1)?.body.ok, 'Axon could not do an ordinary thing afterwards').toBe(true);
}

// ---------------------------------------------------------------------------

describe('after something goes wrong, the next thing still works', () => {
  it('an address Axon will not go to', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open the admin page');
    await h.propose('browser.open', { url: 'http://127.0.0.1:8080/admin' });

    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a navigation that errors but lands on the page anyway', async () => {
    // Not a failure at all, and Axon only knows that because it looked. A
    // browser reports errors for things that loaded; an agent that trusted
    // the error would announce a failure about a page on the user's screen,
    // which is the live bug this behaviour was built to fix.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    site.failNext(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    const answer = h.answers.at(-1);
    expect(answer?.body.ok).toBe(true);
    const output = answer?.body.output as { note?: string; url?: string };
    expect(output.url).toBe('https://www.youtube.com/');
    expect(output.note ?? '').toMatch(/read the page afterwards|treat the page as loaded/i);
    await recovers(h);
  });

  it('an internal error with a stack behind it', async () => {
    // The failure mode this is really about: an exception nobody planned for.
    // What the user gets must still be a sentence.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    const nasty = new Error('Cannot read properties of undefined (reading \'frame\')');
    nasty.stack = 'Error: boom\n    at Object.<anonymous> (C:\\dev\\axon-voice\\src\\main\\thing.ts:42:11)';

    h.say('read the page');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    site.failNext(nasty);
    await h.propose('browser.read', {});

    const whole = JSON.stringify(h.answers.at(-1));
    expect(whole).not.toContain('thing.ts');
    expect(whole).not.toContain('at Object');
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a stale observation — the page moved before the click', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and click the first link');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    const link = elementsOf(h.answers.at(-1))[0];

    site.driftTo('/results');
    site.driftTo('/');
    await h.propose('browser.click', { ref: link!.ref });

    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a target that has become ambiguous', async () => {
    const site = youtubeSite({ ambiguousResults: true });
    const h = createDemoHarness({ site });

    h.say('open the AssemblyAI one');
    await h.propose('browser.open', { url: 'https://www.youtube.com/results' });
    const candidate = elementsOf(h.answers.at(-1)).find((element) => element.label.startsWith('AssemblyAI'));
    site.driftTo('/results');
    await h.propose('browser.click', { ref: candidate!.ref });

    expect(h.answers.at(-1)?.body.errorKind).toBe('CLARIFICATION_NEEDED');
    expectHumanReadable(lastMessage(h));

    // A question is not a dead end: answering it continues, and something else
    // entirely also works.
    h.say('never mind, open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    expect(h.answers.at(-1)?.body.ok).toBe(true);
  });

  it('an approval the user denies', async () => {
    const h = createDemoHarness({ site: internshipSite(), decide: () => 'DENY' });

    h.say('submit the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    expectHumanReadable(h.spoken.join(' '));
    expect(h.spoken.join(' ')).toMatch(/denied|did not|declined|not to/i);
  });

  it('an approval nobody answers', async () => {
    // The dialog expires into a DENIAL, and the conversation carries on. The
    // harness pins the timeout at two seconds, so this is a real wait.
    const h = createDemoHarness({ site: internshipSite(), decide: () => null });

    h.say('submit the application');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(2_400);

    expectHumanReadable(h.spoken.join(' '));
    await recovers(h, 'https://careers.example.com/internship/apply');
  }, 10_000);

  it('a request the user stops halfway', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube and search for something');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    h.say('stop');
    await h.propose('browser.read', {});

    expect(h.answers.at(-1)?.body.errorKind).toBe('CANCELLED');
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a result that arrives after the user stopped', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    const spokenBefore = h.spoken.length;
    h.say('stop');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.settle(80);

    // The cancelled work does not get to speak.
    expect(h.spoken.slice(spokenBefore).join(' ')).not.toMatch(/YouTube is open/i);
    await recovers(h);
  });

  it('the same call arriving twice', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });

    // Whatever the second one is told, it is told something, and the
    // conversation is not left waiting on a result that will never come.
    expect(h.answers).toHaveLength(2);
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a tool the model invented', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('do the thing');
    await h.propose('system.exec', { command: 'whoami' });

    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('arguments that do not match the schema', async () => {
    const h = createDemoHarness({ site: youtubeSite() });

    h.say('open something');
    await h.propose('browser.open', { url: 42 as unknown as string });

    expect(h.answers.at(-1)?.body.ok).toBe(false);
    expectHumanReadable(lastMessage(h));
    await recovers(h);
  });

  it('a desktop application that never appears', async () => {
    // `app.open` verifies by looking. When the window never arrives it must
    // say so rather than claiming success — and Axon must stay usable.
    const h = createDemoHarness({ site: youtubeSite(), desktop: fakeDesktop({ appearsAfterMs: 60_000 }) });

    h.say('open Calculator');
    await h.propose('app.open', { app: 'calculator' });

    const output = h.answers.at(-1)?.body.output as { verified?: { opened?: boolean; summary?: string } } | undefined;
    expect(output?.verified?.opened).toBe(false);
    expect(output?.verified?.summary ?? '').toMatch(/no window appeared|cannot check/i);
    expectHumanReadable(output?.verified?.summary ?? '');
    await recovers(h);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// What a person is told
// ---------------------------------------------------------------------------

describe('a failure is explained, not dumped', () => {
  it('names what went wrong in a sentence, without the mechanism', async () => {
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    const h2 = h;
    h2.say('open the admin page');
    await h2.propose('browser.open', { url: 'http://127.0.0.1:8080/admin' });

    const message = lastMessage(h2);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('net::');
    expect(message).not.toMatch(/policy|URL_POLICY|scheme_denied/i);
    expectHumanReadable(message);
  });

  it('tells the model not to retry what cannot be retried', async () => {
    const h = createDemoHarness({ site: internshipSite(), decide: () => 'DENY' });

    h.say('submit it');
    await h.propose('browser.open', { url: 'https://careers.example.com/internship/apply' });
    const submit = elementsOf(h.answers.at(-1)).find((element) => element.label === 'Submit application');
    await h.propose('browser.click', { ref: submit!.ref });
    await h.settle(60);

    // A denial is the user's decision, and the agent is told so in words that
    // do not invite another attempt.
    expect(h.spoken.join(' ')).toMatch(/do not ask again|their decision|denied/i);
  });

  it('never leaves the machine in ERROR after an ordinary failure', async () => {
    // ERROR is for Axon being broken, not for a page that would not load.
    // Living in ERROR would need an explicit reset before anything else could
    // happen, which on stage is indistinguishable from a crash.
    const site = youtubeSite();
    const h = createDemoHarness({ site });

    h.say('open YouTube');
    site.failNext(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await h.propose('browser.open', { url: 'https://www.youtube.com/' });
    await h.settle(40);

    expect(h.orchestrator.state).not.toBe('ERROR');
  });
});

// ---------------------------------------------------------------------------
// The voice connection itself
// ---------------------------------------------------------------------------

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { VoiceSocket } from '../src/main/agent/assemblyai-client.js';
import { VoiceAgentSession } from '../src/main/agent/voice-agent-session.js';
import type { VoiceAgentProvider } from '../src/main/agent/create-voice-agent.js';

/**
 * A local provider: a real WebSocketServer on loopback, as in
 * `agent-protocol.test.ts`. Real frames over real TCP, reached through the
 * `createSocket` seam the session already has for exactly this purpose — the
 * endpoint constant is not redirected, and no configuration can redirect it.
 */
async function localProvider(): Promise<{ url: string; drop(): void; close(): Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'session.ready', session_id: 'sess_recovery' }));
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    drop: () => {
      for (const client of server.clients) client.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe('when the voice connection drops', () => {
  it('ends the session with a sentence, and a new activation starts cleanly', async () => {
    let endpoint = (await localProvider());
    const providers = [endpoint];

    const voiceAgent: VoiceAgentProvider = {
      name: 'assemblyai',
      create: (wiring) =>
        new VoiceAgentSession({
          apiKey: 'recovery-test-key-0000',
          platform: 'Windows',
          workspaceRoot: '/nowhere',
          createSocket: (handlers) => new VoiceSocket({ apiKey: 'recovery-test-key-0000', endpoint: endpoint.url }, handlers),
          ...wiring,
        }),
    };

    const bus = new EventBus();
    const events: { type: string; action?: string; detail?: unknown }[] = [];
    bus.subscribe((event) => events.push(event as never));
    const orchestrator = new Orchestrator({
      bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 2_000,
      devConsoleEnabled: false,
      voiceAgent,
    });

    try {
      expect(orchestrator.startVoiceSession('manual').accepted).toBe(true);
      expect(await until(() => orchestrator.state === 'LISTENING')).toBe(true);

      // The provider goes away for good: every reconnect attempt fails.
      await endpoint.close();
      expect(await until(() => orchestrator.voiceAgentStatus().active === false, 15_000)).toBe(true);

      // It TRIED to come back — a dropped connection is not a hang-up — and
      // then said so plainly when it could not.
      expect(JSON.stringify(events)).toContain('The voice connection dropped. Reconnecting.');
      const failure = events.find((event) => event.type === 'VOICE_SESSION' && event.action === 'failed');
      expect(failure).toBeDefined();
      expect(String(failure?.detail ?? '')).not.toContain('recovery-test-key');
      expect(JSON.stringify(events)).not.toContain('recovery-test-key-0000');

      // The show goes on: activating again is accepted and reaches LISTENING,
      // whatever state the drop left behind.
      endpoint = await localProvider();
      providers.push(endpoint);
      const again = orchestrator.startVoiceSession('manual');
      expect(again.accepted, again.error ?? '').toBe(true);
      expect(await until(() => orchestrator.state === 'LISTENING')).toBe(true);
      orchestrator.stopVoiceSession();
    } finally {
      orchestrator.shutdown();
      for (const provider of providers) await provider.close().catch(() => undefined);
    }
  }, 30_000);
});

describe('when the voice connection blips', () => {
  it('reconnects on its own, resumes the session, and keeps listening', async () => {
    const endpoint = await localProvider();
    const resumes: string[] = [];

    const voiceAgent: VoiceAgentProvider = {
      name: 'assemblyai',
      create: (wiring) =>
        new VoiceAgentSession({
          apiKey: 'blip-test-key-0000',
          platform: 'Windows',
          workspaceRoot: '/nowhere',
          createSocket: (handlers) =>
            new VoiceSocket({ apiKey: 'blip-test-key-0000', endpoint: endpoint.url }, {
              onMessage: handlers.onMessage,
              onClosed: handlers.onClosed,
            }),
          ...wiring,
        }),
    };

    const bus = new EventBus();
    const events: { type: string; summary?: string }[] = [];
    bus.subscribe((event) => {
      events.push(event as never);
      if (event.type === 'OBSERVATION' && /Reconnecting/.test(event.summary)) resumes.push(event.summary);
    });
    const orchestrator = new Orchestrator({
      bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 2_000,
      devConsoleEnabled: false,
      voiceAgent,
    });

    try {
      expect(orchestrator.startVoiceSession('manual').accepted).toBe(true);
      expect(await until(() => orchestrator.state === 'LISTENING')).toBe(true);

      // The wifi hiccups: the connection is cut, the server is still there.
      endpoint.drop();

      expect(await until(() => resumes.length > 0)).toBe(true);
      // And it is back, listening, in the same session.
      expect(await until(() => orchestrator.state === 'LISTENING' && orchestrator.voiceAgentStatus().active === true)).toBe(true);
      expect(events.some((event) => event.type === 'VOICE_SESSION' && (event as { action?: string }).action === 'failed')).toBe(false);
      orchestrator.stopVoiceSession();
    } finally {
      orchestrator.shutdown();
      await endpoint.close();
    }
  }, 30_000);
});

describe('how a closed connection is read', () => {
  it('treats a dropped connection as resumable, and a hang-up as a hang-up', async () => {
    const { describeClose } = await import('../src/main/agent/assemblyai-client.js');
    expect(describeClose(1006)?.retryable).toBe(true);
    expect(describeClose(1012)?.kind).toBe('NETWORK');
    // A deliberate close is not something to reconnect after.
    expect(describeClose(1000)).toBeNull();
    expect(describeClose(1001)).toBeNull();
    expect(describeClose(1008)).toBeNull();
    expect(describeClose(4001)).toBeNull();
  });
});

describe('a screen capture that never returns', () => {
  it('is abandoned at its deadline with a plain sentence, instead of running forever', async () => {
    const { createScreenshotTool } = await import('../src/main/tools/executors/system-screenshot.js');
    const { VisualObservationStore } = await import('../src/main/screen/visual-observation.js');

    const tool = createScreenshotTool({
      // The operating system's capture hanging, which it can.
      capturer: { capturePrimaryDisplay: () => new Promise(() => undefined) },
      screenshotDir: '/nowhere/axon-screens',
      store: new VisualObservationStore(),
      captureTimeoutMs: 50,
    });

    const startedAt = Date.now();
    const outcome = await tool
      .execute({ save: false } as never, { callId: 'c1', signal: new AbortController().signal, observe: () => undefined })
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    expect(outcome).toBe('The screen could not be captured in time.');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expectHumanReadable(outcome);
  });
});
