/**
 * Every failure says what it is.
 *
 * FOUND IN A REAL CONVERSATION. Nearly every failure reached the user as
 * "that timed out". The event log disagreed: 13 of 19 were a spent budget,
 * three were a page that had changed, one was an approval nobody answered —
 * and the dispatcher had turned every executor error, whatever its cause,
 * into EXECUTION_ERROR. A model handed one undifferentiated kind guessed, and
 * guessed "timeout".
 *
 * These pin the taxonomy at every boundary it crosses:
 *
 *   core          one list of kinds; the event schema derives from it
 *   dispatcher    honours a kind an executor DECLARES, but only from the
 *                 permitted set — it can describe a failure, never forge an
 *                 approval outcome
 *   browser       its own failure kinds, mapped where they are defined
 *   desktop       accessibility outcomes, window listings, launches
 *   renderers     the typed brain and the voice agent read one table for
 *                 retryability and for what to say
 *
 * And the behaviours that must NOT change: a plain error is still
 * EXECUTION_ERROR, a cancelled turn is still CANCELLED whatever the error
 * claims, and retryability of every kind that existed before is untouched.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AxonEventSchema,
  EXECUTOR_FAILURE_KINDS,
  FAILURE_GUIDANCE,
  TOOL_FAILURE_KINDS,
  ToolError,
  declaredFailureKind,
  defineTool,
  type JsonValue,
  type RegisteredTool,
  type ToolFailureKind,
  type ToolResult,
} from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Orchestrator } from '../src/main/orchestrator/orchestrator.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { toAgentResult } from '../src/main/agent/tool-bridge.js';
import { toModelToolResult } from '../src/main/brain/tool-result-view.js';
import { BrowserError, type BrowserFailureKind } from '../src/main/browser/browser-error.js';
import { WindowsDesktop, parseReading, type DesktopWindow } from '../src/main/platform/windows-desktop.js';
import { controlFailureKind } from '../src/main/tools/executors/ui-input.js';
import { WindowRegistry, createAppFocusTool, createWindowFocusTool } from '../src/main/tools/executors/windows.js';
import { createAppOpenTool } from '../src/main/tools/executors/app-open.js';
import { toObservationOutput } from '../src/main/screen/visual-observation.js';

const NEW_KINDS = [
  'NOT_FOUND',
  'TIMEOUT',
  'VERIFICATION_FAILED',
  'AUTH_REQUIRED',
  'UNSUPPORTED',
  'WINDOW_NOT_FOUND',
  'UI_NOT_ACCESSIBLE',
] as const;

/** A SAFE tool that fails however the test says. */
function failing(error: () => unknown): RegisteredTool {
  return defineTool<Record<string, never>, JsonValue>({
    name: 'test.fail',
    title: 'Fail',
    description: 'A test tool that fails.',
    inputSchema: z.object({}).strict(),
    resolveRisk: () => ({ level: 'SAFE', reason: 'A test tool.' }),
    summarize: () => ({ title: 'Fail', parameters: [] }),
    sideEffect: () => 'NONE',
    execute: () => Promise.reject(error()),
  });
}

async function dispatch(tool: RegisteredTool, input: JsonValue = {}): Promise<ToolResult> {
  const registry = new ToolRegistry();
  registry.register(tool);
  const orchestrator = new Orchestrator({ bus: new EventBus(), registry, approvalTimeoutMs: 1_000, devConsoleEnabled: false });
  try {
    return await orchestrator.dispatcher.dispatch({ callId: 'c1', tool: tool.name, input });
  } finally {
    orchestrator.shutdown();
  }
}

const kindOf = (result: ToolResult): ToolFailureKind | null => (result.ok ? null : result.failure.kind);

describe('one list of kinds', () => {
  it('contains every new kind alongside every old one', () => {
    for (const kind of NEW_KINDS) expect(TOOL_FAILURE_KINDS).toContain(kind);
    for (const kind of ['EXECUTION_ERROR', 'FORBIDDEN', 'DENIED', 'CANCELLED', 'BUDGET_EXCEEDED', 'STALE_REFERENCE']) {
      expect(TOOL_FAILURE_KINDS).toContain(kind);
    }
  });

  it('the event schema accepts every kind — an event with one it did not know would vanish from the log', () => {
    for (const kind of TOOL_FAILURE_KINDS) {
      const parsed = AxonEventSchema.safeParse({
        id: 'e',
        sessionId: 's',
        seq: 0,
        at: new Date().toISOString(),
        type: 'TOOL_RESULT',
        callId: 'c',
        tool: 't',
        ok: false,
        durationMs: 1,
        output: null,
        failure: { kind, message: 'x', detail: null },
      });
      expect(parsed.success, kind).toBe(true);
    }
  });

  it('every kind has guidance on what to say', () => {
    for (const kind of TOOL_FAILURE_KINDS) expect(FAILURE_GUIDANCE[kind].say.length, kind).toBeGreaterThan(10);
  });
});

describe('the dispatcher honours a declared kind — and only a permitted one', () => {
  it.each(EXECUTOR_FAILURE_KINDS.map((kind) => [kind]))('passes %s through', async (kind) => {
    expect(kindOf(await dispatch(failing(() => new ToolError(kind, 'described'))))).toBe(kind);
  });

  it('a plain error is still EXECUTION_ERROR — nothing is reclassified by guessing', async () => {
    expect(kindOf(await dispatch(failing(() => new Error('the request timed out'))))).toBe('EXECUTION_ERROR');
  });

  it.each([
    ['DENIED'],
    ['APPROVAL_TIMEOUT'],
    ['APPROVAL_MISMATCH'],
    ['DUPLICATE_SIDE_EFFECT'],
    ['UNKNOWN_TOOL'],
    ['INVALID_INPUT'],
    ['CANCELLED'],
    ['CLARIFICATION_NEEDED'],
  ])('refuses an executor that claims %s, which only the dispatcher may establish', async (kind) => {
    const forged = Object.assign(new Error('forged'), { toolFailureKind: kind });
    expect(declaredFailureKind(forged)).toBeNull();
    expect(kindOf(await dispatch(failing(() => forged)))).toBe('EXECUTION_ERROR');
  });

  it('ignores a kind on something that is not an Error', async () => {
    expect(declaredFailureKind({ toolFailureKind: 'TIMEOUT' })).toBeNull();
    expect(kindOf(await dispatch(failing(() => ({ toolFailureKind: 'TIMEOUT' }))))).toBe('EXECUTION_ERROR');
  });
});

describe('the browser states what its own failures mean', () => {
  const expected: Readonly<Record<BrowserFailureKind, ToolFailureKind>> = {
    NOT_OPEN: 'WINDOW_NOT_FOUND',
    REFUSED: 'FORBIDDEN',
    TIMEOUT: 'TIMEOUT',
    ELEMENT_NOT_FOUND: 'NOT_FOUND',
    ELEMENT_SENSITIVE: 'FORBIDDEN',
    ELEMENT_NOT_EDITABLE: 'UNSUPPORTED',
    BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
    // No better name, so the truth: it failed.
    NAVIGATION_FAILED: 'EXECUTION_ERROR',
    CRASHED: 'EXECUTION_ERROR',
    // The turn's abort signal is what reports CANCELLED. A browser that could
    // declare it on its own could tell the model the user stopped something.
    CANCELLED: 'EXECUTION_ERROR',
  };

  it.each(Object.entries(expected))('%s reaches the model as %s', async (browserKind, toolKind) => {
    const result = await dispatch(failing(() => new BrowserError(browserKind as BrowserFailureKind, 'the page said no')));
    expect(kindOf(result)).toBe(toolKind);
  });

  it('a security refusal stays a security refusal', async () => {
    const refused = await dispatch(failing(() => new BrowserError('REFUSED', 'file: addresses are not allowed')));
    expect(kindOf(refused)).toBe('FORBIDDEN');
    expect(toModelToolResult(refused)).toMatchObject({ retryable: false });
  });
});

describe('the desktop: accessibility outcomes', () => {
  it('maps each outcome at the boundary that knows what it means', () => {
    expect(controlFailureKind({ kind: 'gone' })).toBe('STALE_REFERENCE');
    expect(controlFailureKind({ kind: 'sensitive' })).toBe('FORBIDDEN');
    expect(controlFailureKind({ kind: 'unsupported' })).toBe('UNSUPPORTED');
    expect(controlFailureKind({ kind: 'failed', reason: 'timeout' })).toBe('TIMEOUT');
    expect(controlFailureKind({ kind: 'failed', reason: 'bad-window' })).toBe('WINDOW_NOT_FOUND');
    expect(controlFailureKind({ kind: 'failed', reason: 'not-available' })).toBe('UNSUPPORTED');
    // No better name: stays EXECUTION_ERROR rather than a guess.
    expect(controlFailureKind({ kind: 'failed', reason: 'unreadable' })).toBeNull();
    expect(controlFailureKind({ kind: 'failed', reason: 'unknown' })).toBeNull();
  });

  it('an application that publishes no controls is UI_NOT_ACCESSIBLE — on a SUCCESSFUL look', () => {
    const reading = parseReading(JSON.stringify({ handle: '123', window: 'Custom App', elements: [] }), '123');
    expect(reading.problem).toBe('UI_NOT_ACCESSIBLE');

    const output = toObservationOutput(
      ({
        id: 'o1',
        epoch: 1,
        capturedAt: 0,
        width: 100,
        height: 100,
        display: 'primary',
        foregroundWindow: reading.windowTitle,
        targets: [],
        targetsTruncated: false,
        note: reading.note,
        accessibility: reading.problem ?? null,
      }),
    );
    expect(output.accessibility).toBe('UI_NOT_ACCESSIBLE');
    // Still a success: the note leads with it.
    expect(String(output.note)).toMatch(/This call SUCCEEDED/);
  });

  it('a window that closed is WINDOW_NOT_FOUND; a window that answered is null', () => {
    expect(parseReading(JSON.stringify({ error: 'gone' }), '123').problem).toBe('WINDOW_NOT_FOUND');
    const read = parseReading(
      JSON.stringify({ handle: '123', window: 'Calc', elements: [{ role: 'button', name: 'Equals', actions: ['invoke'] }] }),
      '123',
    );
    expect(read.problem).toBeNull();
  });

  it('a slow accessibility read says TIMEOUT, and only then says "in time"', async () => {
    const slow = new WindowsDesktop({ runUi: () => Promise.reject(new ToolError('TIMEOUT', 'The screen query did not finish in time.')) });
    const reading = await slow.observeControls(null);
    expect(reading.problem).toBe('TIMEOUT');
    expect(reading.note).toMatch(/in time/);

    const broken = new WindowsDesktop({ runUi: () => Promise.reject(new Error('exit code 1')) });
    const other = await broken.observeControls(null);
    expect(other.problem).toBe('EXECUTION_ERROR');
    expect(other.note).not.toMatch(/in time/);
  });
});

describe('the desktop: a failed listing is not an empty desktop', () => {
  const calc: DesktopWindow = { handle: '101', title: 'Calculator', foreground: false, minimized: false };

  it('a listing that times out THROWS TIMEOUT instead of returning nothing', async () => {
    const desktop = new WindowsDesktop({ run: () => Promise.reject(new ToolError('TIMEOUT', 'The desktop query did not finish in time.')) });
    await expect(desktop.list()).rejects.toMatchObject({ toolFailureKind: 'TIMEOUT' });
  });

  it('so app.focus reports TIMEOUT, not "Calculator does not appear to be running"', async () => {
    // The false statement this replaces: a slow PowerShell start, reported to
    // the user as a fact about their desktop.
    const desktop = new WindowsDesktop({ run: () => Promise.reject(new ToolError('TIMEOUT', 'The desktop query did not finish in time.')) });
    const result = await dispatch(createAppFocusTool(desktop, new WindowRegistry(), ['calculator']), { app: 'calculator' });
    expect(kindOf(result)).toBe('TIMEOUT');
    expect(result.ok ? '' : result.failure.message).not.toMatch(/not appear to be running/);
  });

  it('an application that genuinely is not open is WINDOW_NOT_FOUND', async () => {
    const desktop = { available: true, list: () => Promise.resolve([{ ...calc, title: 'Untitled - Notepad' }]), act: () => Promise.resolve(true) };
    const result = await dispatch(createAppFocusTool(desktop, new WindowRegistry(), ['calculator']), { app: 'calculator' });
    expect(kindOf(result)).toBe('WINDOW_NOT_FOUND');
  });

  it('a window that closed before the act is WINDOW_NOT_FOUND; one that refused is a plain failure', async () => {
    const registry = new WindowRegistry();
    const [listed] = registry.record([calc]);

    const closed = { available: true, list: () => Promise.resolve([] as DesktopWindow[]), act: () => Promise.resolve(false) };
    expect(kindOf(await dispatch(createWindowFocusTool(closed, registry), { ref: listed!.ref }))).toBe('WINDOW_NOT_FOUND');

    const registry2 = new WindowRegistry();
    const [again] = registry2.record([calc]);
    const refused = { available: true, list: () => Promise.resolve([calc]), act: () => Promise.resolve(false) };
    expect(kindOf(await dispatch(createWindowFocusTool(refused, registry2), { ref: again!.ref }))).toBe('EXECUTION_ERROR');
  });

  it('an act whose re-check cannot be taken is reported as done-but-unconfirmed, not as a failure', async () => {
    const registry = new WindowRegistry();
    const [listed] = registry.record([calc]);
    const desktop = {
      available: true,
      list: () => Promise.reject(new ToolError('TIMEOUT', 'slow')),
      act: () => Promise.resolve(true),
    };
    const result = await dispatch(createWindowFocusTool(desktop, registry), { ref: listed!.ref });
    expect(result.ok).toBe(true);
    expect(result.ok && (result.output as { verified: { changed: boolean } }).verified.changed).toBe(false);
  });
});

describe('launching an application', () => {
  it('a missing executable is NOT_FOUND, said as such', async () => {
    const launcher = {
      launchExecutable: () => Promise.reject(Object.assign(new Error('spawn calc.exe ENOENT'), { code: 'ENOENT' })),
      openUri: () => Promise.resolve(),
    };
    const result = await dispatch(createAppOpenTool(launcher), { app: 'calculator' });
    expect(kindOf(result)).toBe('NOT_FOUND');
    expect(result.ok ? '' : result.failure.message).toMatch(/Calculator could not be found on this computer/);
  });

  it('any other launch failure is left as EXECUTION_ERROR', async () => {
    const launcher = { launchExecutable: () => Promise.reject(new Error('Access is denied.')), openUri: () => Promise.resolve() };
    expect(kindOf(await dispatch(createAppOpenTool(launcher), { app: 'calculator' }))).toBe('EXECUTION_ERROR');
  });
});

describe('both paths explain a failure the same way', () => {
  const failure = (kind: ToolFailureKind): ToolResult => ({
    callId: 'c',
    tool: 't',
    ok: false,
    failure: { kind, message: 'Spotify could not be found on this computer.', detail: null },
    durationMs: 1,
  });

  it('retryability comes from one table, for every kind, on both paths', () => {
    for (const kind of TOOL_FAILURE_KINDS) {
      const brain = toModelToolResult(failure(kind));
      const voice = JSON.parse(toAgentResult(failure(kind))) as { retryable: boolean; guidance: string };
      expect(brain.retryable, kind).toBe(FAILURE_GUIDANCE[kind].retryable);
      expect(voice.retryable, kind).toBe(FAILURE_GUIDANCE[kind].retryable);
      expect(voice.guidance, kind).toBe(FAILURE_GUIDANCE[kind].say);
    }
  });

  it('retryability of every kind that existed before is unchanged', () => {
    // What `toAgentResult` computed before the table existed.
    const before = (kind: ToolFailureKind): boolean => kind === 'EXECUTION_ERROR' || kind === 'STALE_REFERENCE';
    for (const kind of TOOL_FAILURE_KINDS.filter((k) => !(NEW_KINDS as readonly string[]).includes(k))) {
      expect(FAILURE_GUIDANCE[kind].retryable, kind).toBe(before(kind));
    }
  });

  it('only TIMEOUT is ever described as a timeout', () => {
    expect(FAILURE_GUIDANCE.TIMEOUT.say).toMatch(/took too long/);
    expect(FAILURE_GUIDANCE.BUDGET_EXCEEDED.say).toMatch(/not a timeout/);
    expect(FAILURE_GUIDANCE.EXECUTION_ERROR.say).toMatch(/Do not call it a timeout/);
    expect(FAILURE_GUIDANCE.NOT_FOUND.say).toMatch(/Do not call it a timeout/);
  });

  it('the typed brain tells the model the fact AND what to say about it', () => {
    const body = toModelToolResult(failure('NOT_FOUND'));
    expect(body.error).toContain('Spotify could not be found on this computer.');
    expect(body.error).toContain(FAILURE_GUIDANCE.NOT_FOUND.say);
  });

  it('carries no stack trace to the model', async () => {
    const result = await dispatch(
      failing(() => {
        const error = new ToolError('TIMEOUT', 'The page took too long to respond.');
        error.stack = 'Error: x\n    at secretInternalFunction (C:/axon/src/main/whatever.ts:1:1)';
        return error;
      }),
    );
    expect(JSON.stringify(toModelToolResult(result))).not.toMatch(/secretInternalFunction|\.ts:\d/);
    expect(toAgentResult(result)).not.toMatch(/secretInternalFunction|\.ts:\d/);
  });
});

describe('the voice prompt points the model at the guidance', () => {
  it('tells it that only TIMEOUT is a timeout', async () => {
    const { buildAgentSystemPrompt } = await import('../src/main/agent/agent-tool-surface.js');
    const prompt = buildAgentSystemPrompt({ tools: [], platform: 'Windows', workspaceRoot: '/w' });
    expect(prompt).toMatch(/"errorKind" and a "guidance" line/);
    expect(prompt).toMatch(/Only an errorKind of TIMEOUT is a\s+timeout/);
  });
});
