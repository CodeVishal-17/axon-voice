/**
 * The three real tools, executed for real.
 *
 * `fs.write` writes to an actual temporary directory and the assertions read
 * the file back off disk. `app.open` and `system.screenshot` run against fake
 * platform ports, because launching Notepad and grabbing the framebuffer in a
 * unit test would be a test of Windows rather than of Axon — those two are
 * exercised for real by `npm run verify:tools`, which runs inside Electron.
 *
 * Everything goes through the dispatcher. There is no direct-execution path in
 * these tests, because there is no direct-execution path in the product.
 */

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxonEvent } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { Dispatcher, newCallId, type StateController } from '../src/main/safety/dispatcher';
import { ApprovalBroker } from '../src/main/safety/approval-broker';
import { Policy } from '../src/main/safety/policy';
import { createDefaultRegistry, type ToolRegistry } from '../src/main/tools/registry';
import { toToolSchemas } from '../src/main/tools/schema-view';
import type { AppLauncher, CapturedScreen, LaunchedApp, ScreenCapturer } from '../src/main/platform/ports';
import { APP_KEYS, appForWindowTitle, isAppKey, listApps, resolveApp } from '../src/main/tools/executors/app-registry';

/** A one-pixel PNG, so the screenshot path writes real bytes. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

class FakeLauncher implements AppLauncher {
  readonly executables: string[] = [];
  readonly uris: string[] = [];

  launchExecutable(file: string): Promise<LaunchedApp> {
    this.executables.push(file);
    return Promise.resolve({ pid: 4242 });
  }

  openUri(uri: string): Promise<void> {
    this.uris.push(uri);
    return Promise.resolve();
  }
}

class FakeCapturer implements ScreenCapturer {
  calls = 0;

  capturePrimaryDisplay(): Promise<CapturedScreen> {
    this.calls += 1;
    return Promise.resolve({
      png: new Uint8Array(PNG_1PX),
      width: 1,
      height: 1,
      displayLabel: 'Fake Display',
    });
  }
}

interface Fixture {
  readonly dispatcher: Dispatcher;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly events: AxonEvent[];
  readonly launcher: FakeLauncher;
  readonly capturer: FakeCapturer;
  readonly workspaceRoot: string;
  readonly screenshotDir: string;
  readonly forbiddenRoot: string;
}

let tempRoot = '';
let fixture: Fixture;

const noopStates: StateController = {
  enterExecuting: () => {},
  enterAwaitingApproval: () => {},
  settle: () => {},
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-tools-'));

  const workspaceRoot = path.join(tempRoot, 'Axon', 'workspace');
  const screenshotDir = path.join(tempRoot, 'Axon', 'screenshots');
  const forbiddenRoot = path.join(tempRoot, 'Protected');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const bus = new EventBus();
  const events: AxonEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const launcher = new FakeLauncher();
  const capturer = new FakeCapturer();
  const registry = createDefaultRegistry({
    launcher,
    capturer,
    screenshotDir,
    pathPolicy: { workspaceRoot, forbiddenRoots: [forbiddenRoot] },
  });

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus,
    states: noopStates,
    approvalTimeoutMs: 30_000,
  });

  fixture = {
    dispatcher,
    registry,
    approvals,
    events,
    launcher,
    capturer,
    workspaceRoot,
    screenshotDir,
    forbiddenRoot,
  };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/**
 * Dispatch, answer the approval it raises, and return the result.
 *
 * The pattern the file already uses for `fs.write`, named once now that
 * several tools reach the gate. It waits for the request to be REAL — the
 * broker holding a pending entry — rather than assuming one appeared.
 */
async function runWithDecision(tool: string, input: unknown, decision: 'ALLOW' | 'DENY') {
  const dispatch = run(tool, input);
  await vi.waitFor(() => expect(fixture.approvals.list()).toHaveLength(1));
  fixture.approvals.settle(fixture.approvals.list()[0]!.callId, decision, 'user');
  return dispatch;
}

const run = (tool: string, input: unknown) =>
  fixture.dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });

// ---------------------------------------------------------------------------

describe('the default registry', () => {
  it('registers exactly the tools this fixture supplies dependencies for', () => {
    // No browser, no persistence, no desktop and no accessibility layer are
    // wired in here, so their tools must be absent rather than present and
    // broken. `system.time` needs nothing but a clock, so it is always here.
    // `web.open` needs only the launcher's `openUri` — the same port `app.open`
    // uses — so it is here too; `app.launch` needs the Start-menu catalog, which
    // this fixture does not supply, so it is absent.
    expect(fixture.registry.names()).toEqual(['app.open', 'fs.write', 'system.screenshot', 'system.time', 'web.open']);
  });

  it('projects every tool into a code-free schema for the brain', () => {
    const schemas = toToolSchemas(fixture.registry.list());

    expect(schemas).toHaveLength(5);
    for (const schema of schemas) {
      expect(schema.inputSchema).toBeTypeOf('object');
      expect(schema.description.length).toBeGreaterThan(10);
      // The projection must carry no callable — that is its entire purpose.
      expect(JSON.stringify(schema)).not.toContain('function');
    }
  });
});

describe('app.open', () => {
  it('launches a permitted executable without approval', async () => {
    const result = await run('app.open', { app: 'notepad' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toMatchObject({ app: 'notepad', method: 'exe', pid: 4242 });
    expect(fixture.launcher.executables).toEqual(['notepad.exe']);
  });

  it('opens a URI target through the OS handler, once approved', async () => {
    // Settings is a URI target AND an approval-gated one — it is the front
    // door to system configuration, so Axon asks before opening it. Both
    // facts are exercised here: the human is asked, and the launch then goes
    // through the OS handler rather than as an executable.
    const result = await runWithDecision('app.open', { app: 'settings' }, 'ALLOW');

    expect(result.ok).toBe(true);
    expect(fixture.launcher.uris).toEqual(['ms-settings:']);
  });

  it('does not open Settings when the user declines', async () => {
    const result = await runWithDecision('app.open', { app: 'settings' }, 'DENY');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('DENIED');
    expect(fixture.launcher.uris).toHaveLength(0);
  });

  it('rejects an application that is not on the allowlist', async () => {
    // The allowlist is an enum, so "run anything" is not expressible: the
    // request dies at schema validation, before risk is even considered.
    const result = await run('app.open', { app: 'cmd.exe' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('INVALID_INPUT');
    expect(fixture.launcher.executables).toHaveLength(0);
  });

  it('classifies each application from the registry, not uniformly', async () => {
    // "It is an application" is not a risk assessment. A text editor and Task
    // Manager are both applications and only one of them can end a running
    // program, so the level comes from the registry entry.
    for (const app of ['notepad', 'calculator', 'file-explorer']) {
      const result = await run('app.open', { app });
      expect(result.ok, app).toBe(true);
    }

    const calls = fixture.events.filter((event) => event.type === 'TOOL_CALL');
    expect(calls.every((event) => event.risk === 'SAFE')).toBe(true);
  });

  it('asks before opening an application that can change or end things', async () => {
    for (const app of ['settings', 'task-manager']) {
      const result = await runWithDecision('app.open', { app }, 'DENY');
      expect(result.ok, app).toBe(false);
      if (!result.ok) expect(result.failure.kind, app).toBe('DENIED');
    }

    const calls = fixture.events.filter((event) => event.type === 'TOOL_CALL');
    expect(calls.every((event) => event.risk === 'REQUIRES_APPROVAL')).toBe(true);
    // Nothing launched.
    expect(fixture.launcher.executables).toHaveLength(0);
    expect(fixture.launcher.uris).toHaveLength(0);
  });
});

describe('system.screenshot', () => {
  it('writes no file unless asked, and hands back a visual observation instead', async () => {
    // The Phase 2 change. Looking at the screen used to leave a photograph of
    // whatever the user had open in a folder they had forgotten about, on
    // every call, whether or not anybody wanted a picture kept.
    const result = await run('system.screenshot', {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as { observation: string; saved: unknown; width: number };
    expect(fixture.capturer.calls).toBe(1);
    expect(output.observation).toMatch(/^v\d+$/);
    expect(output.saved).toBeNull();
    await expect(fs.readdir(fixture.screenshotDir)).rejects.toThrow();
  });

  it('captures and writes a real PNG when a file was explicitly asked for', async () => {
    const result = await run('system.screenshot', { save: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.output as { saved: { file: string } };
    // The model is handed a FILE NAME, never a path. The path is the user's
    // business and travels in the timeline; a model that never receives one
    // cannot name one.
    expect(output.saved.file).toMatch(/^screen-.*\.png$/);
    expect(JSON.stringify(output)).not.toContain(fixture.screenshotDir);

    const written = await fs.readFile(path.join(fixture.screenshotDir, output.saved.file));
    expect(written.byteLength).toBe(PNG_1PX.byteLength);
    expect(written.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('runs without approval and still records an observation', async () => {
    await run('system.screenshot', { label: 'test run' });

    expect(fixture.events.some((e) => e.type === 'APPROVAL_REQUIRED')).toBe(false);
    expect(fixture.events.find((e) => e.type === 'OBSERVATION')).toMatchObject({
      summary: expect.stringContaining('screen'),
    });
  });

  it('rejects a label that could shape the filename', async () => {
    const result = await run('system.screenshot', { label: '../../escape' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('INVALID_INPUT');
  });
});

describe('fs.write — dynamic risk', () => {
  it('writes inside the workspace with no approval', async () => {
    const result = await run('fs.write', { path: 'notes.txt', content: 'hello', overwrite: false });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, 'notes.txt'), 'utf8')).toBe('hello');
    expect(fixture.events.some((e) => e.type === 'APPROVAL_REQUIRED')).toBe(false);
    expect(fixture.events.find((e) => e.type === 'TOOL_CALL')).toMatchObject({ risk: 'SAFE' });
  });

  it('creates intermediate directories', async () => {
    const result = await run('fs.write', { path: 'a/b/c/deep.txt', content: 'x', overwrite: false });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('x');
  });

  it('requires approval outside the workspace, and writes once allowed', async () => {
    const target = path.join(tempRoot, 'Axon', 'outside.txt');
    const dispatch = run('fs.write', { path: target, content: 'approved', overwrite: true });

    await vi.waitFor(() => expect(fixture.approvals.list()).toHaveLength(1));
    const request = fixture.approvals.list()[0]!;
    expect(request.title).toBe('Axon wants to write a file');
    expect(request.parameters.find((p) => p.label === 'Path')?.value).toBe(target);

    fixture.approvals.settle(request.callId, 'ALLOW', 'user');

    expect((await dispatch).ok).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('approved');
  });

  it('leaves the file untouched when the user denies', async () => {
    const target = path.join(tempRoot, 'Axon', 'denied.txt');
    const dispatch = run('fs.write', { path: target, content: 'should not exist', overwrite: true });

    await vi.waitFor(() => expect(fixture.approvals.list()).toHaveLength(1));
    fixture.approvals.settle(fixture.approvals.list()[0]!.callId, 'DENY', 'user');

    expect((await dispatch).ok).toBe(false);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('refuses a protected location outright, with no approval offered', async () => {
    const target = path.join(fixture.forbiddenRoot, 'x.txt');
    const result = await run('fs.write', { path: target, content: 'no', overwrite: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('FORBIDDEN');
    expect(fixture.events.some((e) => e.type === 'APPROVAL_REQUIRED')).toBe(false);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('refuses traversal out of the workspace into a protected root', async () => {
    const escape = path.relative(fixture.workspaceRoot, path.join(fixture.forbiddenRoot, 'x.txt'));
    const result = await run('fs.write', { path: escape, content: 'no', overwrite: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('FORBIDDEN');
  });

  it('will not clobber an existing file unless asked', async () => {
    await run('fs.write', { path: 'once.txt', content: 'first', overwrite: false });
    const second = await run('fs.write', { path: 'once.txt', content: 'second', overwrite: false });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.kind).toBe('EXECUTION_ERROR');
    expect(await fs.readFile(path.join(fixture.workspaceRoot, 'once.txt'), 'utf8')).toBe('first');
  });

  it('overwrites when explicitly asked, and says that it did', async () => {
    await run('fs.write', { path: 'twice.txt', content: 'first', overwrite: true });
    const second = await run('fs.write', { path: 'twice.txt', content: 'second', overwrite: true });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toMatchObject({ overwritten: true });
    expect(await fs.readFile(path.join(fixture.workspaceRoot, 'twice.txt'), 'utf8')).toBe('second');
  });

  it('escalates an unclassifiable path to approval rather than allowing it', async () => {
    const dispatch = run('fs.write', { path: '\\\\server\\share\\x.txt', content: 'x', overwrite: true });

    await vi.waitFor(() => expect(fixture.approvals.list()).toHaveLength(1));
    const request = fixture.approvals.list()[0]!;
    expect(request.detail).toContain('Risk could not be determined');

    // And even an approved write is refused at execution time, because the
    // executor re-checks rather than trusting that it was gated.
    fixture.approvals.settle(request.callId, 'ALLOW', 'user');
    const result = await dispatch;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('EXECUTION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// The application registry.
// ---------------------------------------------------------------------------

describe('the application registry is the whole of what Axon can launch', () => {
  it('resolves only keys that have an entry behind them', () => {
    for (const entry of listApps()) {
      expect(resolveApp(entry.key)).toBeTruthy();
      expect(isAppKey(entry.key)).toBe(true);
    }
    expect(APP_KEYS.length).toBe(listApps().length);
  });

  it('refuses a shell command, a PowerShell command, and a path', () => {
    // None of these are "rejected by a filter". They are UNREPRESENTABLE:
    // there is no field in the schema that carries a program, so the only
    // question is whether the string happens to be an enum member — and a
    // table has none of the quoting corners a command validator would.
    for (const hostile of [
      'powershell -Command "Get-Process"',
      'powershell.exe',
      'cmd /c del *',
      'cmd.exe',
      'C:/Windows/System32/cmd.exe',
      '../../../Windows/System32/cmd.exe',
      'notepad.exe',
      'notepad; calc',
      'notepad && calc',
      'notepad | calc',
      '$(calc)',
      'file:///C:/Windows/System32/cmd.exe',
    ]) {
      expect(resolveApp(hostile), hostile).toBeNull();
      expect(isAppKey(hostile), hostile).toBe(false);
    }
  });

  it('names no argument, working directory or environment anywhere', () => {
    // A launcher that takes no arguments cannot be turned into a shell by a
    // cleverly chosen file name.
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/tools/executors/app-registry.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/\bargs\b|\bargv\b|\bcwd\b|\bshell\b|spawn|exec\(/);
  });

  it('holds only well-known executables and registered URI schemes', () => {
    for (const entry of listApps()) {
      if (entry.target.kind === 'exe') {
        // A bare file name resolved by the OS search path, never a path this
        // table assembled — an absolute path here is a place a typo could
        // point somewhere unintended.
        expect(entry.target.file, entry.key).toMatch(/^[a-z0-9_-]+\.exe$/i);
        expect(entry.target.file, entry.key).not.toContain('/');
        expect(entry.target.file, entry.key).not.toContain('\\');
      } else {
        expect(entry.target.uri, entry.key).toMatch(/^ms-[a-z-]+:$/);
      }
    }
  });

  it('classifies each application deliberately, not uniformly', () => {
    // The registry exists partly so this judgement is visible in one place.
    const byKey = new Map(listApps().map((entry) => [entry.key, entry]));
    expect(byKey.get('notepad')?.risk).toBe('SAFE');
    expect(byKey.get('calculator')?.risk).toBe('SAFE');
    // Things that can change or end other things are asked about.
    expect(byKey.get('settings')?.risk).toBe('REQUIRES_APPROVAL');
    expect(byKey.get('task-manager')?.risk).toBe('REQUIRES_APPROVAL');
  });

  it('gives every entry a reason a person could act on', () => {
    for (const entry of listApps()) {
      expect(entry.reason.length, entry.key).toBeGreaterThan(20);
      expect(entry.label.length, entry.key).toBeGreaterThan(0);
    }
  });

  it('recognises a window only when it matches a permitted application', () => {
    expect(appForWindowTitle('Untitled - Notepad')?.key).toBe('notepad');
    expect(appForWindowTitle('Calculator')?.key).toBe('calculator');
    // A window Axon cannot name is a window Axon has no business touching.
    expect(appForWindowTitle('Online Banking — Chrome')).toBeNull();
    expect(appForWindowTitle('')).toBeNull();
  });
});
