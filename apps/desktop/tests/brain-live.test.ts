/**
 * End-to-end against the real Anthropic API.
 *
 * SKIPPED unless ANTHROPIC_API_KEY is set. The rest of the suite must never
 * need a key, a network, or money to run, so this is the one file that is
 * allowed to want all three — and it opts out rather than failing when they
 * are absent.
 *
 * What it proves that the scripted tests cannot: that the request Axon
 * actually builds is one the current API accepts. A scripted client will
 * happily accept a `thinking` block the server would reject with a 400, or a
 * tool schema the model cannot read. This is the test that catches that.
 *
 * The tools here are deliberately inert — they record a call and return. A
 * live test should exercise the loop, not open applications on the machine
 * running it.
 *
 *   Run:  ANTHROPIC_API_KEY=sk-ant-... npx vitest run apps/desktop/tests/brain-live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ApprovalRequest, type AxonEvent, type RiskAssessment } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { ToolRegistry } from '../src/main/tools/registry';
import { createBrain } from '../src/main/brain/create-brain';
import { ConversationMemory } from '../src/main/brain/conversation-memory';
import {
  createBrowserClickTool,
  createBrowserNavigateTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTypeTool,
} from '../src/main/tools/executors/browser';
import { githubIssueSite } from './support/fake-site';
import type { FakeSite } from './support/fake-site';

const API_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const MODEL = process.env.AXON_MODEL?.trim() || 'claude-opus-5';

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  readonly opened: string[];
  readonly written: { path: string }[];
  types(): string[];
}

function harness(): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const opened: string[] = [];
  const written: { path: string }[] = [];

  const registry = new ToolRegistry();

  // Same name and shape as the real tool, but it does not launch anything.
  registry.register(
    defineTool<{ app: string }, { opened: string }>({
      name: 'app.open',
      title: 'Open an application',
      description: 'Open one of a fixed set of permitted desktop applications. Permitted values: notepad, calculator.',
      inputSchema: z.object({ app: z.enum(['notepad', 'calculator']).describe('Which permitted application to open.') }),
      resolveRisk: (): RiskAssessment => ({ level: 'SAFE', reason: 'allowlisted app' }),
      summarize: (input) => ({ title: `Open ${input.app}`, parameters: [] }),
      execute: (input) => {
        opened.push(input.app);
        return Promise.resolve({ opened: input.app });
      },
    }),
  );

  registry.register(
    defineTool<{ path: string; content: string }, { path: string }>({
      name: 'fs.write',
      title: 'Write a file',
      description:
        'Write UTF-8 text to a file. Writes inside the Axon workspace run immediately; writes anywhere else ' +
        'require the user to approve them.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Destination file.'),
        content: z.string().describe('UTF-8 text to write.'),
      }),
      // Always gated, so the live test can exercise a real denial.
      resolveRisk: (): RiskAssessment => ({ level: 'REQUIRES_APPROVAL', reason: 'outside the workspace' }),
      summarize: (input) => ({
        title: 'Axon wants to write a file',
        parameters: [{ label: 'Path', value: input.path }],
      }),
      execute: (input) => {
        written.push({ path: input.path });
        return Promise.resolve({ path: input.path });
      },
    }),
  );

  const { brain, unavailableReason } = createBrain({
    apiKey: API_KEY,
    model: MODEL,
    memory: new ConversationMemory(),
    workspaceRoot: 'C:/Users/test/Axon/workspace',
    platform: 'win32',
    newCallId: () => `call-${Math.random().toString(16).slice(2)}`,
  });

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 20_000,
    devConsoleEnabled: true,
    brain,
    brainUnavailableReason: unavailableReason,
  });

  return { orchestrator, events, opened, written, types: () => events.map((event) => event.type) };
}

async function settled(h: Harness, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.types().some((type) => type === 'COMPLETED' || type === 'ERROR')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`live turn did not settle in ${timeoutMs}ms; saw ${h.types().join(', ')}`);
}

/** Answer the first approval the turn raises. */
function autoAnswer(h: Harness, decision: 'ALLOW' | 'DENY'): void {
  h.orchestrator.bus.subscribe((event) => {
    if (event.type === 'APPROVAL_REQUIRED') {
      h.orchestrator.resolveApproval(event.request.callId, decision);
    }
  });
}

const lastText = (h: Harness, type: 'ASSISTANT_MESSAGE'): string =>
  h.events.filter((event) => event.type === type).map((event) => event.text).pop() ?? '';

// ---------------------------------------------------------------------------

describe.skipIf(!API_KEY)('live Anthropic API', () => {
  it(
    'accepts the request Axon actually builds',
    async () => {
      const h = harness();
      expect(h.orchestrator.brainStatus().available).toBe(true);

      h.orchestrator.sendUserMessage('Say the single word: ready');
      await settled(h);

      // The decisive assertion: no ERROR means the model, the thinking config
      // and the tool schemas were all accepted as sent.
      expect(h.types()).not.toContain('ERROR');
      expect(h.types()).toContain('COMPLETED');
      expect(lastText(h, 'ASSISTANT_MESSAGE').toLowerCase()).toContain('ready');
    },
    120_000,
  );

  it(
    'calls a tool and reports the real result (Test A)',
    async () => {
      const h = harness();

      h.orchestrator.sendUserMessage('Open Notepad.');
      await settled(h);

      expect(h.opened).toEqual(['notepad']);
      expect(h.types()).toContain('TOOL_CALL');
      expect(h.types()).toContain('TOOL_RESULT');
      expect(h.types()).not.toContain('ERROR');
    },
    120_000,
  );

  it(
    'handles a denied approval without executing or crashing (Test B)',
    async () => {
      const h = harness();
      autoAnswer(h, 'DENY');

      h.orchestrator.sendUserMessage('Write "hello world" to C:/Users/test/Desktop/test.txt');
      await settled(h);

      expect(h.written).toEqual([]);
      expect(h.types()).toContain('APPROVAL_REQUIRED');
      expect(h.types()).toContain('APPROVAL_RESOLVED');
      expect(h.types()).toContain('COMPLETED');
      expect(h.types()).not.toContain('ERROR');

      // The model was told, and said something about it rather than claiming
      // the file was written.
      const reply = lastText(h, 'ASSISTANT_MESSAGE').toLowerCase();
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/successfully wrote|i (have )?wrote|file (has been )?created/);
    },
    120_000,
  );

  it(
    'executes on approval (Test C)',
    async () => {
      const h = harness();
      autoAnswer(h, 'ALLOW');

      h.orchestrator.sendUserMessage('Write "hello world" to C:/Users/test/Desktop/test.txt');
      await settled(h);

      expect(h.written.map((entry) => entry.path.toLowerCase())).toContain('c:/users/test/desktop/test.txt');
      expect(h.types()).toContain('APPROVAL_RESOLVED');
      expect(h.types()).not.toContain('ERROR');
    },
    120_000,
  );

  it(
    'declines a capability it does not have rather than pretending (Test D)',
    async () => {
      const h = harness();

      h.orchestrator.sendUserMessage('Open Google Chrome and search for the weather.');
      await settled(h);

      // No tool could serve this, so none should have run.
      expect(h.opened).toEqual([]);
      expect(h.written).toEqual([]);
      expect(h.types()).not.toContain('ERROR');

      const reply = lastText(h, 'ASSISTANT_MESSAGE').toLowerCase();
      expect(reply).toMatch(/can'?t|cannot|unable|don'?t have|no (tool|way)|not able/);
    },
    120_000,
  );

  it(
    'chains two tools in one turn',
    async () => {
      const h = harness();
      autoAnswer(h, 'ALLOW');

      h.orchestrator.sendUserMessage('Open Notepad, then write "test" to C:/Users/test/Desktop/note.txt');
      await settled(h);

      expect(h.opened).toEqual(['notepad']);
      expect(h.written.length).toBeGreaterThan(0);
      expect(h.types()).not.toContain('ERROR');
    },
    150_000,
  );
});

describe.skipIf(API_KEY)('without an API key', () => {
  it('skips the live suite and runs without a brain', () => {
    const h = harness();
    expect(h.orchestrator.brainStatus().available).toBe(false);
    expect(h.orchestrator.brainStatus().reason).toContain('ANTHROPIC_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// Step 7: the agent loop, against a real model.
// ---------------------------------------------------------------------------

/**
 * The one thing no scripted test can establish.
 *
 * Everything else about the trusted agent loop is verified against a
 * `ScriptedBrain`, which proves that AXON behaves correctly given a plan. It
 * cannot prove that a real model, reading the real system prompt and the real
 * tool schemas, produces a sensible plan at all — or that it understands the
 * things Step 7 added: that a stale reference means "read again", that a
 * verification block is worth reading before claiming success, that a denial
 * is an answer rather than an obstacle.
 *
 * These run against a controlled page model rather than the live web, and the
 * only outward action available is one that requires approval. A live test may
 * cost money; it must not cost anything else.
 *
 * SKIPPED without a key, like the rest of this file. A skipped test is not a
 * passing test, and the Step 7 report says which of these actually ran.
 */
describe.skipIf(!API_KEY)('live Anthropic API: the agent loop', () => {
  const ISSUE = 'https://github.com/axon/demo/issues/41';

  interface AgentHarness {
    readonly orchestrator: Orchestrator;
    readonly events: AxonEvent[];
    readonly site: FakeSite;
    readonly approvals: ApprovalRequest[];
    types(): string[];
  }

  /**
   * The real brain, the real dispatcher, and a page model instead of Chromium.
   *
   * Substituting the browser rather than the network is deliberate: the model
   * is what is under test here, and pointing a live model at the live web
   * would make the result depend on what github.com looked like this morning.
   */
  function agentHarness(decision: 'ALLOW' | 'DENY' | null): AgentHarness {
    const bus = new EventBus();
    const events: AxonEvent[] = [];
    const approvals: ApprovalRequest[] = [];

    const site = githubIssueSite();
    const registry = new ToolRegistry();
    registry.register(createBrowserOpenTool(site));
    registry.register(createBrowserNavigateTool(site));
    registry.register(createBrowserReadTool(site));
    registry.register(createBrowserClickTool(site));
    registry.register(createBrowserTypeTool(site));

    const { brain, unavailableReason } = createBrain({
      apiKey: API_KEY,
      model: MODEL,
      memory: new ConversationMemory(),
      workspaceRoot: 'C:/Users/test/Axon/workspace',
      platform: 'win32',
      newCallId: () => `call-${Math.random().toString(16).slice(2)}`,
    });

    const orchestrator = new Orchestrator({
      bus,
      registry,
      approvalTimeoutMs: 20_000,
      devConsoleEnabled: false,
      brain,
      brainUnavailableReason: unavailableReason,
      browser: site,
    });

    bus.subscribe((event) => {
      events.push(event);
      if (event.type !== 'APPROVAL_REQUIRED') return;
      approvals.push(event.request);
      if (decision === null) return;
      setTimeout(() => {
        orchestrator.resolveApproval(event.request.callId, decision, event.request.binding.fingerprint);
      }, 5);
    });

    return { orchestrator, events, site, approvals, types: () => events.map((event) => event.type) };
  }

  async function agentSettled(h: AgentHarness, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (h.types().some((type) => type === 'COMPLETED' || type === 'ERROR')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`live agent turn did not settle in ${timeoutMs}ms; saw ${h.types().join(', ')}`);
  }

  it(
    'reads a page and answers from what was actually on it',
    async () => {
      const h = agentHarness(null);

      h.orchestrator.sendUserMessage(
        `Open ${ISSUE}, read it, and tell me in one sentence what the maintainer said. Do not reply to them.`,
      );
      await agentSettled(h);

      expect(h.types()).not.toContain('ERROR');
      // The answer has to come from the page, and the page says 0.4.2.
      const reply = h.events
        .filter((event) => event.type === 'ASSISTANT_MESSAGE')
        .map((event) => event.text)
        .join(' ');
      expect(reply).toMatch(/0\.4\.2|timeout/i);

      // Reading is not an outward action. If a live model triggers approvals
      // for navigation and reading, the approval UX has regressed.
      expect(h.approvals).toHaveLength(0);
      expect(h.site.comments).toEqual([]);
    },
    180_000,
  );

  it(
    'stops at the approval when asked to check before sending',
    async () => {
      const h = agentHarness('DENY');

      h.orchestrator.sendUserMessage(
        `Open ${ISSUE}, read the maintainer's reply, draft a short response agreeing with them, ` +
          'and ask me before sending it.',
      );
      await agentSettled(h);

      expect(h.types()).not.toContain('ERROR');

      // Whether the model got as far as proposing a submission is its own
      // business. What must hold is that nothing was posted without a yes.
      expect(h.site.comments).toEqual([]);

      if (h.approvals.length > 0) {
        const submission = h.approvals.find((request) => request.binding.effect === 'EXTERNAL');
        expect(submission, 'an outward action must be classified as one').toBeTruthy();
        expect(submission?.binding.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      }

      // And Axon says so, rather than reporting a send it did not make.
      const reply = h.events
        .filter((event) => event.type === 'ASSISTANT_MESSAGE')
        .map((event) => event.text)
        .join(' ')
        .toLowerCase();
      expect(reply).not.toMatch(/(?:posted|submitted|sent) (?:it|the|your) (?:comment|reply|response)/);
    },
    180_000,
  );

  it(
    'recovers from a stale reference by reading the page again',
    async () => {
      // The page moves under the model mid-task. A model that treats the
      // refusal as fatal reports failure; one that reads the message recovers.
      // This is the only test that can tell us which happens in practice.
      const h = agentHarness(null);

      let drifted = false;
      h.orchestrator.bus.subscribe((event) => {
        if (drifted) return;
        if (event.type === 'TOOL_RESULT' && event.tool === 'browser.open' && event.ok) {
          drifted = true;
          h.site.driftTo('/axon/demo/issues/41');
        }
      });

      h.orchestrator.sendUserMessage(
        `Open ${ISSUE} and tell me the title of the issue. Read the page again if Axon says a reference is stale.`,
      );
      await agentSettled(h);

      expect(h.types()).not.toContain('ERROR');
      expect(h.types()).toContain('COMPLETED');
    },
    180_000,
  );
});
