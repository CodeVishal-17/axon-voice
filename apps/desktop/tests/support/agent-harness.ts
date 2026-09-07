/**
 * The signature-workflow harness.
 *
 * Builds the real thing: a real `Orchestrator`, holding the real
 * `AxonStateMachine`, driving the real `Dispatcher` with the real `Policy`,
 * the real `ApprovalBroker`, the real `TurnBudget`, the real duplicate ledger
 * and the real browser tools from the real registry.
 *
 * Exactly two things are substituted, and both are substituted at an interface
 * the product already depends on:
 *
 *   Brain            -> ScriptedBrain, so the plan is deterministic.
 *   BrowserController-> FakeSite, so the page is deterministic and offline.
 *
 * Everything between those two — which is to say, the whole of Step 7's
 * security architecture — is the shipping code. That is the point of building
 * the harness this way rather than assembling a convenient approximation: a
 * harness that constructs its own version of the dispatcher verifies its own
 * version of the dispatcher.
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, AxonEvent, EventOf } from '@axon/core';
import { EventBus } from '../../src/main/bus/event-bus.js';
import { Orchestrator } from '../../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../../src/main/tools/registry.js';
import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserForwardTool,
  createBrowserNavigateTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserTypeTool,
} from '../../src/main/tools/executors/browser.js';
import type { FakeSite } from './fake-site.js';
import type { ScriptedBrain } from './scripted-brain.js';

export interface HarnessOptions {
  readonly site: FakeSite;
  readonly brain: ScriptedBrain;
  readonly approvalTimeoutMs?: number;
  /**
   * How a pending approval is answered.
   *
   * A function of the request, so a test can approve one action and deny
   * another — and can assert on what it was shown before deciding, which is
   * the only way to test that the dialog carries what the user needs.
   *
   * Returning null leaves it pending, which is how the timeout path is tested.
   */
  readonly decide?: (request: ApprovalRequest) => ApprovalDecision | null;
}

export interface Harness {
  readonly bus: EventBus;
  readonly orchestrator: Orchestrator;
  readonly registry: ToolRegistry;
  readonly site: FakeSite;
  readonly brain: ScriptedBrain;
  /** Every event, in order. The same stream the UI and the JSONL log see. */
  readonly events: AxonEvent[];
  /** Approval requests the dispatcher actually raised. */
  readonly approvals: ApprovalRequest[];
  /** Send a message and wait for the turn to finish. */
  send(text: string, source?: 'text' | 'voice'): Promise<void>;
  /** Wait for the turn in flight to reach a resting state. */
  settled(): Promise<void>;
  eventsOfType<T extends AxonEvent['type']>(type: T): EventOf<T>[];
}

/** Poll until the orchestrator is no longer busy. */
async function waitForIdle(orchestrator: Orchestrator, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (orchestrator.snapshot().busy) {
    if (Date.now() > deadline) throw new Error('The turn did not finish in time.');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // One more tick so the COMPLETED event and the final settle have landed.
  await new Promise((resolve) => setTimeout(resolve, 2));
}

export function createHarness(options: HarnessOptions): Harness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  const approvals: ApprovalRequest[] = [];

  const registry = new ToolRegistry();
  // The same nine tools `createDefaultRegistry` registers for a browser, built
  // by the same factories. The filesystem and memory tools are left out
  // because this harness has no workspace and no database, not because they
  // would behave differently.
  registry.register(createBrowserOpenTool(options.site));
  registry.register(createBrowserNavigateTool(options.site));
  registry.register(createBrowserReadTool(options.site));
  registry.register(createBrowserClickTool(options.site));
  registry.register(createBrowserTypeTool(options.site));
  registry.register(createBrowserScrollTool(options.site));
  registry.register(createBrowserBackTool(options.site));
  registry.register(createBrowserForwardTool(options.site));
  registry.register(createBrowserCloseTool(options.site));

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 2_000,
    devConsoleEnabled: false,
    brain: options.brain,
    browser: options.site,
  });

  // Stand in for the user at the dialog. Answers on a later tick, as a person
  // would: an approval resolved synchronously inside the emit would not
  // exercise the broker's pending state at all.
  bus.subscribe((event) => {
    events.push(event);
    if (event.type !== 'APPROVAL_REQUIRED') return;

    approvals.push(event.request);
    // `??` would be wrong here: `decide` returning null MEANS "leave it
    // pending", and `null ?? 'ALLOW'` would silently turn the timeout and
    // cancellation tests into approval tests that pass for the wrong reason.
    const decision = options.decide === undefined ? 'ALLOW' : options.decide(event.request);
    if (decision === null) return;

    setTimeout(() => {
      // The fingerprint the dialog was shown, echoed back — exactly what the
      // real renderer does, so the binding check is exercised rather than
      // bypassed by a harness that omits it.
      orchestrator.resolveApproval(event.request.callId, decision, event.request.binding.fingerprint);
    }, 1);
  });

  return {
    bus,
    orchestrator,
    registry,
    site: options.site,
    brain: options.brain,
    events,
    approvals,
    async send(text, source = 'text'): Promise<void> {
      const accepted = orchestrator.sendUserMessage(text, source);
      if (!accepted.accepted) throw new Error(`The turn was refused: ${accepted.error ?? 'no reason given'}`);
      await waitForIdle(orchestrator);
    },
    settled: () => waitForIdle(orchestrator),
    eventsOfType<T extends AxonEvent['type']>(type: T): EventOf<T>[] {
      return events.filter((event): event is EventOf<T> => event.type === type);
    },
  };
}

/** A call id generator whose output is readable in a failure message. */
export function sequentialCallIds(prefix = 'call'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}-${randomUUID().slice(0, 8)}`;
  };
}
