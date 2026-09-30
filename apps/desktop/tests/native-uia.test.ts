/**
 * Phase 4B — the native IUIAutomation engine and its persistent host.
 *
 * Three layers, tested separately:
 *
 *   the host client   (`uia-host.ts`) against a FAKE process: ordering,
 *                     timeouts, crashes, crash loops, malformed answers,
 *                     idle shutdown
 *   the adapter       (`windows-desktop.ts`) against a fake engine: the exact
 *                     requests Axon builds, and how answers become readings
 *   the engine itself (`uia-program.ts`) LIVE, on Windows only: the real
 *                     program, compiled and run, against a throwaway window
 *                     this test creates — never against the user's apps
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { declaredFailureKind, type ToolResult } from '@axon/core';
import { MAX_ANSWER_CHARS, UiaHost, type HostProcess } from '../src/main/platform/uia-host.js';
import { WindowsDesktop, startUiaEngine, type DesktopControl, type DesktopScreenReading, type DesktopUi } from '../src/main/platform/windows-desktop.js';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry } from '../src/main/tools/registry.js';
import { VisualObservationStore } from '../src/main/screen/visual-observation.js';
import { createKeyboardTypeTool, createUiClickTool } from '../src/main/tools/executors/ui-input.js';
import { createUiReadTool } from '../src/main/tools/executors/ui-read.js';

// ---------------------------------------------------------------------------
// A fake engine process
// ---------------------------------------------------------------------------

function fakeProcess(reply: (request: Record<string, unknown>, process: FakeProcess) => string | null = (request) => JSON.stringify({ id: request.id, ok: true })) {
  const process: FakeProcess = {
    written: [],
    killed: false,
    lineListeners: [],
    exitListeners: [],
    write(line) {
      this.written.push(line);
      const answer = reply(JSON.parse(line) as Record<string, unknown>, this);
      if (answer !== null) queueMicrotask(() => this.emit(answer));
    },
    onLine(listener) {
      this.lineListeners.push(listener);
    },
    onExit(listener) {
      this.exitListeners.push(listener);
    },
    kill() {
      this.killed = true;
    },
    emit(line) {
      for (const listener of this.lineListeners) listener(line);
    },
    exit() {
      for (const listener of this.exitListeners) listener();
    },
  };
  return process;
}

interface FakeProcess extends HostProcess {
  written: string[];
  killed: boolean;
  lineListeners: ((line: string) => void)[];
  exitListeners: (() => void)[];
  emit(line: string): void;
  exit(): void;
}

describe('the engine host — one COM thread, contained failure', () => {
  it('sends a request as one JSON line and resolves with its answer', async () => {
    const process = fakeProcess();
    const host = new UiaHost({ start: () => process });
    await expect(host.request({ op: 'ping' }, 1_000)).resolves.toMatchObject({ ok: true });
    expect(process.written).toEqual(['{"id":"r1","op":"ping"}\n']);
  });

  it('never has two requests in flight: the second is written only after the first is answered', async () => {
    let answerFirst: (() => void) | null = null;
    const process = fakeProcess((request, self) => {
      if (request.id === 'r1') {
        answerFirst = () => self.emit(JSON.stringify({ id: 'r1', ok: true }));
        return null;
      }
      return JSON.stringify({ id: request.id, ok: true });
    });
    const host = new UiaHost({ start: () => process });
    const one = host.request({ op: 'ping' }, 1_000);
    const two = host.request({ op: 'ping' }, 1_000);
    await Promise.resolve();
    expect(process.written).toHaveLength(1);
    answerFirst!();
    await one;
    await two;
    expect(process.written).toHaveLength(2);
  });

  it('ends a stuck engine on timeout, reports TIMEOUT, and starts a fresh one next time', async () => {
    const processes: FakeProcess[] = [];
    const host = new UiaHost({
      startupAllowanceMs: 0,
      start: () => {
        const process = fakeProcess(processes.length === 0 ? () => null : undefined);
        processes.push(process);
        return process;
      },
    });
    const error = await host.request({ op: 'ping' }, 20).catch((caught: unknown) => caught);
    expect(declaredFailureKind(error)).toBe('TIMEOUT');
    expect(processes[0]?.killed).toBe(true);
    await expect(host.request({ op: 'ping' }, 1_000)).resolves.toMatchObject({ ok: true });
    expect(processes).toHaveLength(2);
  });

  it('gives only the first request after a start the startup allowance', async () => {
    vi.useFakeTimers();
    try {
      const pending: FakeProcess[] = [];
      const host = new UiaHost({ startupAllowanceMs: 5_000, start: () => {
        const process = fakeProcess(() => null);
        pending.push(process);
        return process;
      } });
      const first = host.request({ op: 'ping' }, 100).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pending[0]?.killed).toBe(false); // still inside 100 ms + 5 s
      await vi.advanceTimersByTimeAsync(5_000);
      expect(declaredFailureKind(await first)).toBe('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails what is in flight when the engine crashes, and restarts on the next request', async () => {
    const processes: FakeProcess[] = [];
    const host = new UiaHost({
      start: () => {
        const process = fakeProcess(processes.length === 0 ? (_request, self) => (queueMicrotask(() => self.exit()), null) : undefined);
        processes.push(process);
        return process;
      },
    });
    await expect(host.request({ op: 'ping' }, 1_000)).rejects.toThrow(/stopped unexpectedly/);
    await expect(host.request({ op: 'ping' }, 1_000)).resolves.toMatchObject({ ok: true });
    expect(processes).toHaveLength(2);
  });

  it('stops restarting an engine that keeps crashing, for a cooldown', async () => {
    let now = 0;
    let starts = 0;
    const host = new UiaHost({
      now: () => now,
      start: () => {
        starts += 1;
        return fakeProcess((_request, self) => (queueMicrotask(() => self.exit()), null));
      },
    });
    for (let i = 0; i < 3; i += 1) await host.request({ op: 'ping' }, 1_000).catch(() => undefined);
    const paused = await host.request({ op: 'ping' }, 1_000).catch((caught: unknown) => caught);
    expect(declaredFailureKind(paused)).toBe('UNSUPPORTED');
    expect(starts).toBe(3);
    now = 31_000;
    await host.request({ op: 'ping' }, 1_000).catch(() => undefined);
    expect(starts).toBe(4);
  });

  it('refuses an answer that is not JSON, is for another request, or is too large — and ends that engine', async () => {
    for (const bad of ['not json', '[1,2]', JSON.stringify({ id: 'r99', ok: true }), 'x'.repeat(MAX_ANSWER_CHARS + 1)]) {
      const process = fakeProcess(() => bad);
      const host = new UiaHost({ start: () => process });
      await expect(host.request({ op: 'ping' }, 1_000), bad.slice(0, 20)).rejects.toThrow();
      expect(process.killed, bad.slice(0, 20)).toBe(true);
    }
  });

  it('ignores an answer to nothing — it can never be matched to a later request', async () => {
    const process = fakeProcess();
    const host = new UiaHost({ start: () => process });
    await host.request({ op: 'ping' }, 1_000);
    process.emit(JSON.stringify({ id: 'r2', ok: true, stray: true }));
    const next = await host.request({ op: 'ping' }, 1_000);
    expect(next).not.toHaveProperty('stray');
  });

  it('ends an idle engine, and a disposed one fails whatever was waiting', async () => {
    const process = fakeProcess();
    const host = new UiaHost({ start: () => process, idleMs: 20 });
    await host.request({ op: 'ping' }, 1_000);
    expect(host.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(process.killed).toBe(true);
    expect(host.running).toBe(false);

    const stuck = new UiaHost({ start: () => fakeProcess(() => null) });
    const waiting = stuck.request({ op: 'ping' }, 5_000);
    stuck.dispose();
    await expect(waiting).rejects.toThrow(/shut down/);
  });
});

// ---------------------------------------------------------------------------
// The adapter: what Axon asks, and how answers become readings
// ---------------------------------------------------------------------------

describe('the desktop adapter speaking to the engine', () => {
  function adapter(reply: (request: Record<string, unknown>) => Record<string, unknown>) {
    const requests: Record<string, unknown>[] = [];
    const desktop = new WindowsDesktop({
      platform: 'win32',
      run: () => Promise.resolve('[]'),
      startEngine: () =>
        fakeProcess((request) => {
          requests.push(request);
          return JSON.stringify({ id: request.id, ...reply(request) });
        }),
    });
    return { desktop, requests };
  }

  it('builds an observe request from its own records: handle, page, and an internal scope', async () => {
    const { desktop, requests } = adapter(() => ({ window: 'W', handle: '5', offset: 60, hasMore: false, elements: [] }));
    await desktop.observeControls('5', { skip: 60, scope: { nativeRole: 'ControlType.List', name: 'Chats', automationId: '', runtimeId: '42.7.1' } });
    expect(requests[0]).toEqual({
      id: 'r1',
      op: 'observe',
      window: '5',
      skip: 60,
      max: 60,
      scope: { role: 'ControlType.List', name: 'Chats', automationId: '', runtimeId: '42.7.1' },
    });
  });

  it('drops a runtime id that is not the engine\'s shape rather than forwarding it', async () => {
    const { desktop, requests } = adapter(() => ({ ok: true, value: null }));
    await desktop.actOnControl({ windowHandle: '5', nativeRole: 'ControlType.Button', name: 'Go', automationId: '', runtimeId: '1; calc', action: 'invoke' });
    expect((requests[0]?.target as Record<string, string>).runtimeId).toBeUndefined();
    await desktop.actOnControl({ windowHandle: '5', nativeRole: 'ControlType.Button', name: 'Go', automationId: '', runtimeId: '42.1.9', action: 'invoke' });
    expect((requests[1]?.target as Record<string, string>).runtimeId).toBe('42.1.9');
  });

  it('reads containers as scope-only targets, and keeps runtime and class ids internal', async () => {
    const { desktop } = adapter(() => ({
      window: 'W',
      handle: '5',
      offset: 0,
      hasMore: false,
      elements: [
        { nativeRole: 'ControlType.List', role: 'container', name: 'Chats', automationId: '', runtimeId: '42.1', className: 'ListView', actions: ['invoke'], value: 'x' },
        { nativeRole: 'ControlType.Button', role: 'button', name: 'New chat', automationId: 'new', runtimeId: 'bad id', actions: ['invoke'] },
      ],
    }));
    const reading = await desktop.observeControls('5');
    expect(reading.controls[0]).toMatchObject({ role: 'container', actions: [], value: null, runtimeId: '42.1', className: 'ListView' });
    expect(reading.controls[1]?.runtimeId).toBeUndefined();
  });

  it('says a read stopped at its bound instead of pretending it was complete', async () => {
    const { desktop } = adapter(() => ({ window: 'W', handle: '5', offset: 0, hasMore: true, incomplete: true, elements: [{ nativeRole: 'ControlType.Button', role: 'button', name: 'A', actions: ['invoke'] }] }));
    const reading = await desktop.observeControls('5');
    expect(reading.hasMore).toBe(true);
    expect(reading.note).toMatch(/stopped reading at its limit/);
  });

  it('maps the engine\'s refusals, and reports an engine that cannot start as UNSUPPORTED', async () => {
    expect((await adapter(() => ({ error: 'gone' })).desktop.observeControls('5')).problem).toBe('WINDOW_NOT_FOUND');
    expect((await adapter(() => ({ error: 'scope-ambiguous' })).desktop.observeControls('5')).problem).toBe('STALE_REFERENCE');
    expect((await adapter(() => ({ error: 'com' })).desktop.observeControls('5')).problem).toBe('UNSUPPORTED');
    expect((await adapter(() => ({ error: 'invalid' })).desktop.observeControls('5')).problem).toBe('EXECUTION_ERROR');
    const act = adapter(() => ({ error: 'sensitive' }));
    expect(await act.desktop.actOnControl({ windowHandle: '5', nativeRole: 'ControlType.Edit', name: 'Password', automationId: '', action: 'setText', text: 'x' })).toEqual({ kind: 'sensitive' });
  });
});

// ---------------------------------------------------------------------------
// Containers through the tools
// ---------------------------------------------------------------------------

describe('containers are for reading inside, never for acting on', () => {
  const list: DesktopControl = { nativeRole: 'ControlType.List', role: 'container', name: 'Chats', automationId: '', sensitive: false, actions: [], value: null, runtimeId: '42.1' };
  const row: DesktopControl = { nativeRole: 'ControlType.ListItem', role: 'listitem', name: 'Row one', automationId: '', sensitive: false, actions: ['select'], value: null, runtimeId: '42.2' };

  function harness() {
    const scopes: unknown[] = [];
    const acts: unknown[] = [];
    const ui: DesktopUi = {
      uiAvailable: true,
      observeControls: (_handle, options = {}) => {
        scopes.push(options.scope ?? null);
        const reading: DesktopScreenReading = { available: true, windowHandle: '5', windowTitle: 'W', controls: options.scope ? [row] : [list], truncated: false, hasMore: false, offset: 0, note: null };
        return Promise.resolve(reading);
      },
      actOnControl: (request) => {
        acts.push(request);
        return Promise.resolve({ kind: 'ok', value: null });
      },
    };
    const store = new VisualObservationStore();
    const registry = new ToolRegistry();
    registry.register(createUiReadTool({ ui, store }));
    registry.register(createUiClickTool({ ui, store }));
    registry.register(createKeyboardTypeTool({ ui, store }));
    const approvals = new ApprovalBroker();
    const dispatcher = new Dispatcher({ registry, policy: new Policy(), approvals, bus: new EventBus(), states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} }, approvalTimeoutMs: 1_000 });
    dispatcher.beginTurn(new TurnBudget());
    const run = (tool: string, input: unknown): Promise<ToolResult> => dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });
    return { run, scopes, acts, approvals };
  }

  it('reads inside a container, passing its internal identity — runtime id included — to the engine', async () => {
    const h = harness();
    const first = await h.run('ui.read', {});
    const ref = (first.ok ? (first.output as { targets: { ref: string; role: string; actions: string[] }[] }).targets : [])[0]!;
    expect(ref).toMatchObject({ role: 'container', actions: [] });
    const inside = await h.run('ui.read', { within: ref.ref });
    expect(inside.ok).toBe(true);
    expect(h.scopes.at(-1)).toEqual({ nativeRole: 'ControlType.List', name: 'Chats', automationId: '', runtimeId: '42.1' });
    // The runtime id reached the engine; it reaches no model.
    expect(JSON.stringify([first, inside])).not.toMatch(/42\.1|42\.2|runtimeId|className/);
  });

  it('refuses to press a container before anyone is asked to approve it', async () => {
    const h = harness();
    const first = await h.run('ui.read', {});
    const ref = (first.ok ? (first.output as { targets: { ref: string }[] }).targets : [])[0]!.ref;
    const result = await h.run('ui.click', { ref });
    expect(result.ok ? null : result.failure.kind).toBe('UNSUPPORTED');
    expect(h.approvals.list()).toHaveLength(0);
    expect(h.acts).toEqual([]);
    // Typing is refused by keyboard.type's own precheck — not a text field — also before any dialog.
    const typed = await h.run('keyboard.type', { ref, text: 'hello' });
    expect(typed.ok).toBe(false);
    expect(h.approvals.list()).toHaveLength(0);
    expect(h.acts).toEqual([]);
  });

  it('acts on a control through its internal runtime id, which the model never supplied', async () => {
    const h = harness();
    const first = await h.run('ui.read', {});
    const container = (first.ok ? (first.output as { targets: { ref: string }[] }).targets : [])[0]!.ref;
    const inside = await h.run('ui.read', { within: container });
    const rowRef = (inside.ok ? (inside.output as { targets: { ref: string }[] }).targets : [])[0]!.ref;
    const result = await h.run('ui.click', { ref: rowRef, action: 'select' });
    expect(result.ok).toBe(true);
    expect(h.acts[0]).toMatchObject({ nativeRole: 'ControlType.ListItem', runtimeId: '42.2', action: 'select' });
  });

  it('never accepts a native identifier from the model', async () => {
    const h = harness();
    await h.run('ui.read', {});
    for (const input of [{ runtimeId: [42, 17, 8] }, { runtimeId: '42.17.8' }, { hwnd: 65962 }, { pid: 1234 }, { comPointer: '0x1234' }]) {
      const result = await h.run('ui.read', input);
      // Unknown keys are stripped: the read is of the window in front, as if they were never sent.
      expect(h.scopes.at(-1), JSON.stringify(input)).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(/42\.17\.8|65962|1234|0x1234/);
    }
    expect((await h.run('ui.click', { ref: '42.17.8' })).ok).toBe(false);
    expect((await h.run('ui.read', { within: '42.17.8' })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real engine, on Windows, against a window this test owns
// ---------------------------------------------------------------------------

/**
 * A throwaway WinForms window: a button that writes into a field when
 * pressed, that field, a PASSWORD field, a checkbox, and a group holding a
 * second button with the SAME name as the first. Test fixture only — it is
 * started by this test, read by the real engine, and killed at the end.
 */
const FIXTURE = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = 'Axon UIA Fixture'; $f.StartPosition = 'Manual'; $f.Location = New-Object Drawing.Point(40, 40); $f.Size = New-Object Drawing.Size(460, 340); $f.TopMost = $true
$field = New-Object Windows.Forms.TextBox; $field.AccessibleName = 'Axon Test Field'; $field.Location = New-Object Drawing.Point(10, 10); $field.Width = 200
$secret = New-Object Windows.Forms.TextBox; $secret.AccessibleName = 'Axon Secret Field'; $secret.UseSystemPasswordChar = $true; $secret.Location = New-Object Drawing.Point(10, 40); $secret.Width = 200
$button = New-Object Windows.Forms.Button; $button.Text = 'Axon Press'; $button.Location = New-Object Drawing.Point(10, 70)
$button.Add_Click({ $field.Text = 'pressed' })
$check = New-Object Windows.Forms.CheckBox; $check.Text = 'Axon Option'; $check.Location = New-Object Drawing.Point(10, 100)
$group = New-Object Windows.Forms.GroupBox; $group.Text = 'Axon Group'; $group.Location = New-Object Drawing.Point(10, 130); $group.Size = New-Object Drawing.Size(300, 100)
$inner = New-Object Windows.Forms.Button; $inner.Text = 'Axon Press'; $inner.Location = New-Object Drawing.Point(10, 30)
$inner.Add_Click({ $field.Text = 'inner' })
$group.Controls.Add($inner)
$f.Controls.AddRange(@($field, $secret, $button, $check, $group))
$f.Show()
[Console]::Out.WriteLine($f.Handle.ToInt64()); [Console]::Out.Flush()
while ($f.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
`;

describe.skipIf(process.platform !== 'win32')('the native engine, live, against a window this test owns', () => {
  let fixture: ChildProcess | null = null;
  let handle = '';
  const desktop = new WindowsDesktop({ platform: 'win32', run: () => Promise.resolve('[]') });

  beforeAll(async () => {
    fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', FIXTURE], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false });
    handle = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: fixture!.stdout! });
      lines.once('line', (line) => resolve(line.trim()));
      fixture!.once('exit', () => reject(new Error('fixture exited')));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 60_000);

  afterAll(() => {
    desktop.dispose();
    fixture?.kill();
  });

  const control = (reading: DesktopScreenReading, name: string) => reading.controls.filter((entry) => entry.name === name);

  it('compiles, starts, and answers — and refuses every malformed request', async () => {
    const engine = startUiaEngine();
    const answers: string[] = [];
    engine.onLine((line) => answers.push(line));
    for (const line of ['{"id":"p1","op":"ping"}', '{not json', '{"id":"x1","op":"shell","window":"1"}', '{"id":"x2","op":"observe","window":"1","command":"calc"}', '{"id":"x3","op":"act","window":"1","target":{"role":"ControlType.Button","name":"x","action":"delete"}}', '{"id":"x4","op":"observe","window":"abc"}', `{"id":"x5","op":"ping","pad":"${'x'.repeat(70_000)}"}`]) {
      engine.write(`${line}\n`);
    }
    await vi.waitFor(() => expect(answers).toHaveLength(7), { timeout: 30_000 });
    engine.kill();
    expect(answers.map((answer) => JSON.parse(answer) as Record<string, unknown>).map((answer) => answer.ok ?? answer.error)).toEqual([
      true,
      'malformed',
      'unknown-op',
      'invalid',
      'invalid',
      'invalid',
      'too-large',
    ]);
  }, 60_000);

  it('reads the window natively: controls, a container, and a password field it will not read', async () => {
    const reading = await desktop.observeControls(handle);
    expect(reading.available).toBe(true);
    expect(control(reading, 'Axon Test Field')[0]).toMatchObject({ role: 'textbox', sensitive: false });
    expect(control(reading, 'Axon Test Field')[0]?.actions).toContain('setText');
    const secret = control(reading, 'Axon Secret Field')[0];
    expect(secret).toMatchObject({ sensitive: true, value: null });
    expect(control(reading, 'Axon Option')[0]?.actions).toContain('toggle');
    expect(control(reading, 'Axon Group')[0]).toMatchObject({ role: 'container', actions: [] });
    expect(control(reading, 'Axon Press')).toHaveLength(2);
    for (const entry of reading.controls) expect(entry.runtimeId).toMatch(/^-?\d+(\.-?\d+)*$/);
  }, 60_000);

  it('never reads outside the window it was asked about', async () => {
    // Regression: a filtered walk that starts at a window root once treated the
    // DESKTOP as the parent of the window's controls, and walked into other
    // windows. Everything read here must be this fixture's own.
    const reading = await desktop.observeControls(handle);
    const ours = new Set(['Axon Test Field', 'Axon Secret Field', 'Axon Press', 'Axon Option', 'Axon Group', 'Minimize', 'Maximize', 'Close', 'Restore', 'System', 'Application', 'Axon UIA Fixture']);
    const foreign = reading.controls.map((entry) => entry.name).filter((name) => !ours.has(name));
    expect(foreign).toEqual([]);
    expect(reading.hasMore).toBe(false);
  }, 60_000);

  it('pages exactly, and reads inside a container only', async () => {
    const all = await desktop.observeControls(handle);
    const second = await desktop.observeControls(handle, { skip: 2 });
    expect(second.controls.map((entry) => entry.name)).toEqual(all.controls.slice(2).map((entry) => entry.name));
    expect(second.hasMore).toBe(false);
    const group = control(all, 'Axon Group')[0]!;
    const inside = await desktop.observeControls(handle, { scope: { nativeRole: group.nativeRole, name: group.name, automationId: group.automationId, runtimeId: group.runtimeId } });
    expect(inside.controls.map((entry) => entry.name)).toEqual(['Axon Press']);
  }, 60_000);

  it('acts on exactly the control it was given, even where two share a name', async () => {
    const reading = await desktop.observeControls(handle);
    const [outer, inner] = control(reading, 'Axon Press');
    const pressInner = await desktop.actOnControl({ windowHandle: handle, nativeRole: inner!.nativeRole, name: inner!.name, automationId: inner!.automationId, runtimeId: inner!.runtimeId, action: 'invoke' });
    expect(pressInner.kind).toBe('ok');
    await vi.waitFor(async () => expect(control(await desktop.observeControls(handle), 'Axon Test Field')[0]?.value).toBe('inner'), { timeout: 5_000 });
    const pressOuter = await desktop.actOnControl({ windowHandle: handle, nativeRole: outer!.nativeRole, name: outer!.name, automationId: outer!.automationId, runtimeId: outer!.runtimeId, action: 'invoke' });
    expect(pressOuter.kind).toBe('ok');
    await vi.waitFor(async () => expect(control(await desktop.observeControls(handle), 'Axon Test Field')[0]?.value).toBe('pressed'), { timeout: 5_000 });
    // WinForms gives the two buttons different automation ids, so a runtime id
    // that no longer matches anything falls back to that unique identity —
    // and still presses the right one.
    expect(outer!.automationId).not.toBe(inner!.automationId);
    const stale = await desktop.actOnControl({ windowHandle: handle, nativeRole: inner!.nativeRole, name: inner!.name, automationId: inner!.automationId, runtimeId: '1.2.3', action: 'invoke' });
    expect(stale.kind).toBe('ok');
    await vi.waitFor(async () => expect(control(await desktop.observeControls(handle), 'Axon Test Field')[0]?.value).toBe('inner'), { timeout: 5_000 });
  }, 60_000);

  it('sets a value and reads it back as evidence', async () => {
    const reading = await desktop.observeControls(handle);
    const field = control(reading, 'Axon Test Field')[0]!;
    const result = await desktop.actOnControl({ windowHandle: handle, nativeRole: field.nativeRole, name: field.name, automationId: field.automationId, runtimeId: field.runtimeId, action: 'setText', text: 'typed by the engine' });
    expect(result).toEqual({ kind: 'ok', value: 'typed by the engine' });
  }, 60_000);

  it('refuses to type into a password field, whatever the caller asks', async () => {
    const reading = await desktop.observeControls(handle);
    const secret = control(reading, 'Axon Secret Field')[0]!;
    const result = await desktop.actOnControl({ windowHandle: handle, nativeRole: secret.nativeRole, name: secret.name, automationId: secret.automationId, runtimeId: secret.runtimeId, action: 'setText', text: 'hunter2' });
    expect(result).toEqual({ kind: 'sensitive' });
  }, 60_000);

  it('answers concurrent reads one after another on its one COM thread, each correctly', async () => {
    const readings = await Promise.all([desktop.observeControls(handle), desktop.observeControls(handle, { skip: 1 }), desktop.observeControls(handle)]);
    expect(readings.map((reading) => reading.available)).toEqual([true, true, true]);
    expect(readings[1]?.controls.map((entry) => entry.name)).toEqual(readings[0]?.controls.slice(1).map((entry) => entry.name));
    expect(readings[2]?.controls.length).toBe(readings[0]?.controls.length);
  }, 60_000);

  it('says gone for a control that is not there, and for a window that has closed', async () => {
    const missing = await desktop.actOnControl({ windowHandle: handle, nativeRole: 'ControlType.Button', name: 'No Such Button', automationId: '', action: 'invoke' });
    expect(missing.kind).toBe('gone');
    fixture?.kill();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const closed = await desktop.observeControls(handle);
    expect(closed.problem).toBe('WINDOW_NOT_FOUND');
    // Acting on an application that has exited is refused, never retargeted.
    const afterExit = await desktop.actOnControl({ windowHandle: handle, nativeRole: 'ControlType.Button', name: 'Axon Press', automationId: '', action: 'invoke' });
    expect(afterExit.kind).toBe('gone');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Play a song: search → result → play → verified (shaped on Spotify, measured live)
// ---------------------------------------------------------------------------

describe('playing a song is verified by what the application shows, not by the press', () => {
  const search: DesktopControl = { nativeRole: 'ControlType.ComboBox', role: 'combobox', name: 'What do you want to play?', automationId: '', sensitive: false, actions: ['expand', 'setText', 'focus'], value: null, runtimeId: '42.10' };
  const play: DesktopControl = { nativeRole: 'ControlType.Button', role: 'button', name: 'Play Blinding Lights', automationId: '', sensitive: false, actions: ['invoke', 'focus'], value: null, runtimeId: '42.11' };

  function harness(options: { playWorks: boolean }) {
    let typed = false;
    let playing = false;
    const ui: DesktopUi = {
      uiAvailable: true,
      observeControls: () =>
        Promise.resolve({
          available: true,
          windowHandle: '9',
          // Spotify retitles its window to the song while it plays.
          windowTitle: playing ? 'The Weeknd - Blinding Lights' : 'Spotify Free',
          controls: typed ? [search, play] : [search],
          truncated: false,
          hasMore: false,
          offset: 0,
          note: null,
        } satisfies DesktopScreenReading),
      actOnControl: (request) => {
        if (request.action === 'setText') typed = true;
        if (request.name === play.name && options.playWorks) playing = true;
        // The search box reads back EMPTY after its text is set — measured.
        return Promise.resolve({ kind: 'ok', value: request.action === 'setText' ? '' : null });
      },
    };
    const store = new VisualObservationStore();
    const registry = new ToolRegistry();
    registry.register(createUiReadTool({ ui, store }));
    registry.register(createUiClickTool({ ui, store }));
    registry.register(createKeyboardTypeTool({ ui, store }));
    const approvals = new ApprovalBroker();
    const dispatcher = new Dispatcher({ registry, policy: new Policy(), approvals, bus: new EventBus(), states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} }, approvalTimeoutMs: 2_000 });
    dispatcher.beginTurn(new TurnBudget(), 'play blinding lights on spotify');
    const run = async (tool: string, input: unknown): Promise<ToolResult> => {
      const pending = dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });
      // Whatever asks is allowed here: the approval itself is tested elsewhere.
      const settle = setInterval(() => {
        for (const request of approvals.list()) approvals.settle(request.callId, 'ALLOW', 'user');
      }, 5);
      try {
        return await pending;
      } finally {
        clearInterval(settle);
      }
    };
    const refOf = async (name: string): Promise<string> => {
      const read = await run('ui.read', {});
      return (read.ok ? (read.output as { targets: { ref: string; name: string }[] }).targets : []).find((target) => target.name === name)!.ref;
    };
    return { run, refOf };
  }

  type Verified = { verified: { changed: boolean; textApplied: boolean | null; summary: string; newlyOnScreen: string[] } };
  const verified = (result: ToolResult): Verified['verified'] => (result.ok ? (result.output as Verified).verified : ({} as Verified['verified']));

  it('takes new results as evidence the search was typed, while still saying the box did not read it back', async () => {
    const h = harness({ playWorks: true });
    const typed = verified(await h.run('keyboard.type', { ref: await h.refOf(search.name), text: 'Blinding Lights' }));
    expect(typed.textApplied).toBe(false);
    expect(typed.changed).toBe(true);
    expect(typed.newlyOnScreen).toContain('Play Blinding Lights');
    expect(typed.summary).toMatch(/new items appeared/);
  });

  it('reports playback only from what changed on screen — the song in the window title', async () => {
    const h = harness({ playWorks: true });
    await h.run('keyboard.type', { ref: await h.refOf(search.name), text: 'Blinding Lights' });
    const pressed = verified(await h.run('ui.click', { ref: await h.refOf(play.name) }));
    expect(pressed.changed).toBe(true);
    expect(pressed.summary).toContain('The Weeknd - Blinding Lights');
  });

  it('does not claim anything played when the press changed nothing', async () => {
    const h = harness({ playWorks: false });
    await h.run('keyboard.type', { ref: await h.refOf(search.name), text: 'Blinding Lights' });
    const pressed = verified(await h.run('ui.click', { ref: await h.refOf(play.name) }));
    expect(pressed.changed).toBe(false);
    expect(pressed.newlyOnScreen).toEqual([]);
    expect(pressed.summary).toMatch(/nothing it can see on screen changed/);
  });
});
