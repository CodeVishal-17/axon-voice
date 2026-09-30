/**
 * The conversational harness: a real Axon, driven the way a voice agent drives
 * one.
 *
 * WHAT IS REAL HERE, WHICH IS ALMOST ALL OF IT.
 *
 * The real `Orchestrator`, holding the real `TaskLedger`, the real
 * `AxonStateMachine`, the real `Dispatcher` with the real `Policy`, the real
 * `ApprovalBroker` with its real binding and expiry, the real `TurnBudget`,
 * the real duplicate ledger, the real goal boundary, and the real tools from
 * the real factories. On top of it, the real `ToolBridge` — the same object
 * the voice session uses, with the same task lifecycle, the same inline
 * budget, the same in-progress answers and the same late-result rules.
 *
 * TWO THINGS ARE SUBSTITUTED, both at interfaces the product already depends
 * on:
 *
 *   BrowserController -> FakeSite, so the page is deterministic and offline.
 *   AssemblyAI        -> the test, which says sentences and proposes tools.
 *
 * The second substitution is the interesting one and it is worth being precise
 * about what it does and does not prove. The test plays the part of the model:
 * it decides which tool to propose next, as the model would. What it CANNOT do
 * is anything the model could not — it reaches the world through
 * `bridge.handleToolCall`, which is the same door a `tool.call` arrives at,
 * and everything past that door is shipping code.
 *
 * So a test here demonstrates that the PIPELINE holds for a given sequence of
 * proposals. It is not evidence that the model will produce that sequence;
 * that is what `smoke-assemblyai.cjs` is for, against the real provider. Those
 * two claims are kept apart on purpose, because collapsing them is how a demo
 * becomes a claim nobody verified.
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, AxonEvent, JsonValue } from '@axon/core';
import { EventBus } from '../../src/main/bus/event-bus.js';
import { Orchestrator } from '../../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../../src/main/tools/registry.js';
import { ToolBridge } from '../../src/main/agent/tool-bridge.js';
import { toToolSchemas } from '../../src/main/tools/schema-view.js';
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
import { createDefaultRegistry } from '../../src/main/tools/registry.js';
import { VisualObservationStore } from '../../src/main/screen/visual-observation.js';
import type { AppLauncher, CapturedScreen, ScreenCapturer } from '../../src/main/platform/ports.js';
import type {
  DesktopControl,
  DesktopControlOutcome,
  DesktopScreenReading,
  DesktopUi,
  DesktopWindow,
  DesktopWindows,
} from '../../src/main/platform/windows-desktop.js';
import type { BrowserController } from '../../src/main/browser/axon-browser.js';

/** A one-pixel PNG, so the capture path carries real bytes. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A desktop that does what it is told and can be looked at afterwards.
 *
 * The point of it being real state rather than a mock is that `app.open` now
 * VERIFIES: it polls the window list until a window the registry recognises
 * appears. A stand-in that returned a fixed list would make that verification
 * pass without ever having verified anything.
 */
export function fakeDesktop(options: { readonly appearsAfterMs?: number } = {}) {
  const launched: string[] = [];
  let windows: DesktopWindow[] = [];
  let controls: DesktopControl[] = [];
  let foreground = 'Desktop';

  const launcher: AppLauncher = {
    launchExecutable: (file) => {
      launched.push(file);
      // Real applications take a moment to put a window on screen, and the
      // verification exists precisely to wait for one.
      const title = file.includes('calc') ? 'Calculator' : file.includes('notepad') ? 'Untitled - Notepad' : file;
      setTimeout(() => {
        windows = [...windows, { handle: String(2000 + windows.length), title, foreground: true, minimized: false }];
        foreground = title;
      }, options.appearsAfterMs ?? 5);
      return Promise.resolve({ pid: 4242 });
    },
    openUri: (uri) => {
      launched.push(uri);
      return Promise.resolve();
    },
  };

  const desktop: DesktopWindows & DesktopUi = {
    available: true,
    uiAvailable: true,
    list: () => Promise.resolve([...windows]),
    act: () => Promise.resolve(true),
    observeControls: (handle): Promise<DesktopScreenReading> =>
      Promise.resolve({
        available: true,
        windowHandle: handle ?? '2000',
        windowTitle: foreground,
        controls: [...controls],
        truncated: false,
        note: controls.length === 0 ? 'That window publishes no controls Axon can act on.' : null,
      }),
    actOnControl: (): Promise<DesktopControlOutcome> => Promise.resolve({ kind: 'ok', value: null }),
  };

  const capturer: ScreenCapturer = {
    capturePrimaryDisplay: (): Promise<CapturedScreen> =>
      Promise.resolve({ png: PNG_1PX, width: 1920, height: 1080, displayLabel: 'Primary' }),
  };

  return {
    launcher,
    desktop,
    capturer,
    launched,
    windowTitles: () => windows.map((window) => window.title),
    setControls: (next: readonly DesktopControl[]) => {
      controls = [...next];
    },
  };
}

export interface DemoHarnessOptions {
  /**
   * The page model behind the browser tools.
   *
   * A `FakeSite` for a scenario about one site, or a `combinedSite` for one
   * that crosses origins — the canonical demo goes from YouTube to a careers
   * site without closing the browser, and a harness that could not do that
   * would be rehearsing a different demo from the one being given.
   */
  readonly site: BrowserController;
  /**
   * A desktop, when the scenario needs one.
   *
   * Absent means a browser-only Axon, which is what most of the web scenarios
   * want — and a tool the model can see but that can never work is worse than
   * no tool, so the desktop tools are then simply not registered.
   */
  readonly desktop?: ReturnType<typeof fakeDesktop>;
  /**
   * How a pending approval is answered.
   *
   * A function of the request, so a test can allow one act and deny another —
   * and can assert on what the user was SHOWN before deciding, which is the
   * only way to test that a dialog carries what a person needs.
   *
   * Returning null leaves it pending, which is how the timeout and
   * cancellation paths are reached.
   */
  readonly decide?: (request: ApprovalRequest) => ApprovalDecision | null;
  /** Pinned small so "slow" is deterministic rather than a race with a clock. */
  readonly inlineBudgetMs?: number;
}

export interface DemoHarness {
  readonly bus: EventBus;
  readonly orchestrator: Orchestrator;
  readonly events: AxonEvent[];
  readonly approvals: ApprovalRequest[];
  /** Everything Axon said out loud, in order. */
  readonly spoken: string[];
  /** Every result the agent was handed, decoded. */
  readonly answers: { readonly tool: string; readonly body: Record<string, unknown> }[];
  /** The user says something. Takes the real conversational entry point. */
  say(text: string): void;
  /** The model proposes a tool. Takes the real `tool.call` door. */
  propose(tool: string, input: JsonValue): Promise<void>;
  /** End the agent's reply turn, flushing whatever is queued. */
  endReply(status?: string): void;
  /** Wait for anything in flight to settle. */
  settle(ms?: number): Promise<void>;
}

let callOrdinal = 0;

export function createDemoHarness(options: DemoHarnessOptions): DemoHarness {
  const bus = new EventBus();
  const events: AxonEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const spoken: string[] = [];
  const answers: { tool: string; body: Record<string, unknown> }[] = [];

  // WITH a desktop, the registry is built by the SHIPPING factory, so the
  // scenario runs against exactly the tool set a real Axon has. Without one,
  // the nine browser tools are registered from the same factories the shipping
  // registry uses — the desktop and memory tools are absent because this
  // harness has no desktop and no database, not because they differ.
  const observations = new VisualObservationStore();
  const registry = options.desktop
    ? createDefaultRegistry({
        launcher: options.desktop.launcher,
        capturer: options.desktop.capturer,
        screenshotDir: '/nowhere/axon-demo-screenshots',
        pathPolicy: { workspaceRoot: '/nowhere/axon-demo-workspace', forbiddenRoots: [] },
        browser: options.site,
        desktop: options.desktop.desktop,
        ui: options.desktop.desktop,
        observations,
      })
    : new ToolRegistry();

  if (!options.desktop) {
    registry.register(createBrowserOpenTool(options.site));
    registry.register(createBrowserNavigateTool(options.site));
    registry.register(createBrowserReadTool(options.site));
    registry.register(createBrowserClickTool(options.site));
    registry.register(createBrowserTypeTool(options.site));
    registry.register(createBrowserScrollTool(options.site));
    registry.register(createBrowserBackTool(options.site));
    registry.register(createBrowserForwardTool(options.site));
    registry.register(createBrowserCloseTool(options.site));
  }

  const orchestrator = new Orchestrator({
    bus,
    registry,
    approvalTimeoutMs: 2_000,
    devConsoleEnabled: false,
    browser: options.site,
    observations,
  });

  // Stand in for the user at the dialog. Answers on a later tick, as a person
  // would: an approval resolved inside the emit would never exercise the
  // broker's pending state at all.
  bus.subscribe((event) => {
    events.push(event);
    if (event.type !== 'APPROVAL_REQUIRED') return;
    approvals.push(event.request);
    // `??` would be wrong: `decide` returning null MEANS "leave it pending",
    // and `null ?? 'ALLOW'` would silently turn the cancellation tests into
    // approval tests that pass for the wrong reason.
    const decision = options.decide === undefined ? 'ALLOW' : options.decide(event.request);
    if (decision === null) return;
    setTimeout(() => {
      orchestrator.resolveApproval(event.request.callId, decision, event.request.binding.fingerprint);
    }, 0);
  });

  const bridge = new ToolBridge({
    tools: toToolSchemas(registry.list()),
    newCallId: () => randomUUID(),
    tasks: orchestrator.tasks,
    dispatch: (call) => orchestrator.dispatcher.dispatch(call),
    willRequireApproval: (tool, input) => orchestrator.dispatcher.requiresApproval(tool, input),
    // The same wiring `startVoiceSession` supplies, so the approval moment the
    // tests see is the one the voice agent would say.
    describeApproval: (tool, input) => orchestrator.dispatcher.describeApproval(tool, input),
    onDeferredOutcome: (summary) => {
      // What the session turns into a spoken turn. Recorded as "what Axon
      // would say", which is the level a conversational test asserts at.
      spoken.push(summary);
    },
    onLateResult: () => {},
    onNotice: () => {},
    ...(options.inlineBudgetMs === undefined ? {} : { inlineBudgetMs: options.inlineBudgetMs }),
  });

  // A conversation, not a turn: the budget and the browser's per-turn action
  // count are opened once, exactly as `startVoiceSession` opens them.
  orchestrator.beginConversation();

  return {
    bus,
    orchestrator,
    events,
    approvals,
    spoken,
    answers,
    say: (text) => {
      orchestrator.onVoiceTranscript(text);
    },
    propose: async (tool, input) => {
      callOrdinal += 1;
      await bridge.handleToolCall(`provider-${callOrdinal}`, tool, input);
      for (const pending of bridge.flush('completed')) {
        answers.push({ tool, body: JSON.parse(pending.result) as Record<string, unknown> });
      }
    },
    endReply: (status = 'completed') => {
      bridge.flush(status);
    },
    settle: async (ms = 30) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
