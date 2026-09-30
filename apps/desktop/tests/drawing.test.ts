/**
 * Drawing: Axon draws in a new Paint window step by step, and image
 * generation says plainly when it is not configured.
 *
 * Everything here runs through the REAL dispatcher, policy and approval broker
 * — the model's proposal goes in the one door every tool call uses. The
 * operating system is faked: windows are a list; "Paint" is a fake
 * accessibility engine whose Edit ▸ Paste puts the clipboard's picture on a
 * canvas and whose Copy visible layers copies that canvas back; the
 * clipboard is a variable.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus.js';
import { Dispatcher, newCallId } from '../src/main/safety/dispatcher.js';
import { ApprovalBroker } from '../src/main/safety/approval-broker.js';
import { Policy } from '../src/main/safety/policy.js';
import { TurnBudget } from '../src/main/safety/turn-budget.js';
import { ToolRegistry, createDefaultRegistry } from '../src/main/tools/registry.js';
import { AppCatalog } from '../src/main/apps/app-catalog.js';
import type {
  DesktopApps,
  DesktopControlOutcome,
  DesktopControlRequest,
  DesktopScreenReading,
  DesktopUi,
  DesktopWindow,
  DesktopWindows,
  RawStartMenuApp,
} from '../src/main/platform/windows-desktop.js';
import type { AppLauncher, ClipboardImages, ClipboardSnapshot, ScreenCapturer } from '../src/main/platform/ports.js';
import { createAppLaunchTool } from '../src/main/tools/executors/app-launch.js';
import {
  DRAW_UNVERIFIED,
  NOT_CONFIGURED,
  NOT_INSTALLED,
  createDrawGenerateTool,
  createDrawPaintTool,
  looksLikePath,
} from '../src/main/tools/executors/draw.js';
import { DRAWING_FILE, DrawingStore } from '../src/main/draw/artifact-store.js';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_DRAW_STEPS,
  buildScene,
  canvasMatch,
  isPng,
  rasterize,
  renderFrames,
  renderPng,
  renderSvg,
  resolveSubject,
  type SceneKey,
  type SkyVariant,
} from '../src/main/draw/drawing.js';
import type { ImageProvider } from '../src/main/draw/image-provider.js';
import { resolveRuntimeConfig } from '../src/main/config.js';
import { toToolSchema } from '../src/main/tools/schema-view.js';

const PAINT_ID = 'Microsoft.Paint_8wekyb3d8bbwe!App';
const RAW: readonly RawStartMenuApp[] = [
  { name: 'Paint', appId: PAINT_ID },
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'Command Prompt', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe' },
];
const SCENES: readonly [SceneKey, SkyVariant][] = [
  ['house', 'day'], ['house', 'sunset'], ['house', 'night'],
  ['sunset', 'sunset'],
  ['cat', 'day'], ['cat', 'night'],
  ['tree', 'day'], ['tree', 'sunset'], ['tree', 'night'],
];

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-draw-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Decode one of Axon's own PNGs (8-bit RGB, one IDAT, filter 0) to RGBA. */
function decode(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const bytes = Buffer.from(png);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const at = bytes.indexOf('IDAT');
  const raw = inflateSync(bytes.subarray(at + 4, at + 4 + bytes.readUInt32BE(at - 4)));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = y * (width * 3 + 1) + 1 + x * 3;
      const to = (y * width + x) * 4;
      rgba[to] = raw[from]!;
      rgba[to + 1] = raw[from + 1]!;
      rgba[to + 2] = raw[from + 2]!;
      rgba[to + 3] = 255;
    }
  }
  return { width, height, rgba };
}

let nextHandle = 7000;
const paintWindow = (title = 'Untitled - Paint'): DesktopWindow => ({
  handle: String(nextHandle++),
  title,
  foreground: true,
  minimized: false,
  appUserModelId: PAINT_ID,
});

interface HarnessOptions {
  raw?: readonly RawStartMenuApp[];
  /** Whether starting Paint makes a new Paint window appear. */
  paintOpens?: boolean;
  /** Paste fails on this step (1-based), every time. */
  pasteFailsAt?: number;
  /** Another window takes the foreground before this step, until Axon brings Paint forward. */
  pasteFailsUntilFocusAt?: number;
  /** Windows refuses every focus request and keeps another window in front. */
  focusRefused?: boolean;
  /** Paint's Paste stops answering on this step (1-based). */
  pasteHangsAt?: number;
  /** What Copy visible layers hands back: the canvas, a wrong picture, or nothing. */
  readBack?: 'canvas' | 'wrong' | 'nothing';
  /** Paint closes before Axon checks. */
  paintCloses?: boolean;
  /** Windows already on screen, e.g. the user's own Paint. */
  existing?: DesktopWindow[];
  provider?: ImageProvider | null;
  /** The platform cannot put the user's clipboard back ('refuses'), or fails outright ('throws'). */
  restoreFails?: 'refuses' | 'throws';
}

async function harness(options: HarnessOptions = {}) {
  let windows: DesktopWindow[] = [...(options.existing ?? [])];
  const launched: string[] = [];
  const acts: DesktopControlRequest[] = [];
  const clipboardWrites: number[] = [];
  const waits: number[] = [];
  let pastes = 0;
  let canvas: Uint8Array | null = null;
  let newPaint: DesktopWindow | null = null;
  const focused: string[] = [];
  // Whether Axon's new Paint window is the foreground window right now.
  let front = options.focusRefused !== true;
  let stolen = false;

  const desktop: DesktopWindows = {
    available: true,
    list: () => Promise.resolve(windows.map((window) => (window === newPaint ? { ...window, foreground: front } : window))),
    act: (handle, action) => {
      if (action === 'focus') {
        focused.push(handle);
        if (!options.focusRefused && newPaint && handle === newPaint.handle) front = true;
      }
      return Promise.resolve(true);
    },
  };
  const launcher: AppLauncher = {
    launchExecutable: () => Promise.resolve({ pid: 1 }),
    openUri: () => Promise.resolve(),
    launchStartMenuApp: (appId) => {
      launched.push(appId);
      if (options.paintOpens !== false && appId === PAINT_ID) {
        newPaint = paintWindow();
        windows = [...windows, newPaint];
      }
      return Promise.resolve();
    },
  };

  // The clipboard: what the user had, then whatever Axon or "Paint" put there.
  const USER_CLIPBOARD = { __clipboardSnapshot: true, text: 'the user\'s own clipboard' } as unknown as ClipboardSnapshot;
  let clip: { kind: 'user' } | { kind: 'png'; png: Uint8Array } | { kind: 'empty' } = { kind: 'user' };
  const restored: ClipboardSnapshot[] = [];
  const clipboard: ClipboardImages = {
    save: () => Promise.resolve(USER_CLIPBOARD),
    restore: (snapshot) => {
      restored.push(snapshot);
      if (options.restoreFails === 'throws') return Promise.reject(new Error('clipboard busy'));
      // A port that cannot restore leaves the clipboard empty, never Axon's content.
      clip = options.restoreFails === 'refuses' ? { kind: 'empty' } : { kind: 'user' };
      return Promise.resolve(options.restoreFails !== 'refuses');
    },
    clear: () => {
      clip = { kind: 'empty' };
      return Promise.resolve();
    },
    writePng: (png) => {
      clipboardWrites.push(png.length);
      clip = { kind: 'png', png };
      return Promise.resolve();
    },
    readImage: () => Promise.resolve(clip.kind === 'png' ? decode(clip.png) : null),
  };

  const reading = (handle: string): DesktopScreenReading => ({
    available: true,
    windowHandle: handle,
    windowTitle: 'Untitled - Paint',
    controls: [
      { nativeRole: 'ControlType.MenuItem', role: 'menuitem', name: 'Edit', automationId: '', sensitive: false, actions: ['invoke', 'expand', 'focus'], value: null, runtimeId: '42.7.1' },
      { nativeRole: 'ControlType.MenuItem', role: 'menuitem', name: 'File', automationId: '', sensitive: false, actions: ['invoke', 'expand', 'focus'], value: null },
    ],
    truncated: false,
    note: null,
  });
  const ui: DesktopUi = {
    uiAvailable: true,
    observeControls: (handle) => Promise.resolve(reading(handle ?? '')),
    actOnControl: (request): Promise<DesktopControlOutcome> => {
      acts.push(request);
      if (!windows.some((window) => window.handle === request.windowHandle)) return Promise.resolve({ kind: 'gone' });
      if (request.name === 'Paste') {
        if (clip.kind !== 'png') return Promise.resolve({ kind: 'failed', reason: 'nothing to paste' });
        if (options.pasteFailsAt === pastes + 1) return Promise.resolve({ kind: 'failed', reason: 'paint said no' });
        // Focus taken away before this step: the flyout closed, until Axon refocuses.
        if (options.pasteFailsUntilFocusAt === pastes + 1 && !stolen) {
          stolen = true;
          front = false;
          return Promise.resolve({ kind: 'gone' });
        }
        // Behind another window, a packaged app cannot read the clipboard.
        if (!front) return Promise.resolve({ kind: 'unsupported' });
        if (options.pasteHangsAt === pastes + 1) return Promise.resolve({ kind: 'failed', reason: 'timeout' });
        pastes += 1;
        canvas = clip.png;
        if (options.paintCloses && newPaint) windows = windows.filter((window) => window !== newPaint);
      }
      if (request.name === 'Copy visible layers') {
        if (options.readBack === 'nothing') clip = { kind: 'empty' };
        else if (options.readBack === 'wrong') clip = { kind: 'png', png: renderPng(buildScene('cat', 'night')) };
        else if (canvas) clip = { kind: 'png', png: canvas };
      }
      return Promise.resolve({ kind: 'ok', value: null });
    },
  };

  const apps: DesktopApps = {
    appsAvailable: true,
    listStartMenuApps: () => Promise.resolve(options.raw ?? RAW),
    defaultBrowser: () => Promise.resolve(null),
  };
  const catalog = new AppCatalog(() => apps.listStartMenuApps());
  await catalog.refresh();
  const dir = tempDir();
  const store = new DrawingStore(dir);

  const registry = new ToolRegistry();
  registry.register(
    createDrawPaintTool({
      catalog,
      launcher,
      desktop,
      ui,
      clipboard,
      verifyTimeoutMs: 100,
      verifyIntervalMs: 5,
      readyTimeoutMs: 100,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }),
  );
  registry.register(createDrawGenerateTool({ store, provider: options.provider ?? null }));
  registry.register(createAppLaunchTool(launcher, { catalog, desktop, verifyTimeoutMs: 50, verifyIntervalMs: 10 }));

  const approvals = new ApprovalBroker();
  const dispatcher = new Dispatcher({
    registry,
    policy: new Policy(),
    approvals,
    bus: new EventBus(),
    states: { enterExecuting: () => {}, enterAwaitingApproval: () => {}, settle: () => {} },
    approvalTimeoutMs: 2_000,
  });
  dispatcher.beginTurn(new TurnBudget(), 'open paint and draw a house');
  const run = (tool: string, input: unknown): Promise<ToolResult> => dispatcher.dispatch({ callId: newCallId(), tool, input: input as never });
  const decide = async (tool: string, input: unknown, decision: 'ALLOW' | 'DENY'): Promise<ToolResult> => {
    const pending = run(tool, input);
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    approvals.settle(approvals.list()[0]!.callId, decision, 'user');
    return pending;
  };
  const files = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  return {
    run,
    decide,
    approvals,
    launched,
    acts,
    clipboardWrites,
    waits,
    restored,
    focused,
    USER_CLIPBOARD,
    clip: () => clip.kind,
    pastes: () => pastes,
    newPaint: () => newPaint,
    files,
  };
}

const output = (result: ToolResult): Record<string, unknown> => (result.ok ? (result.output as Record<string, unknown>) : {});
const kind = (result: ToolResult): string | null => (result.ok ? null : result.failure.kind);
const message = (result: ToolResult): string => (result.ok ? '' : result.failure.message);

// ---------------------------------------------------------------------------
// The plans and the renderer
// ---------------------------------------------------------------------------

describe('what Axon can draw', () => {
  it('reads the subject and the sky from the words, and nothing else', () => {
    expect(resolveSubject('draw a house')).toEqual({ key: 'house', sky: 'day' });
    expect(resolveSubject('a simple house at sunset')).toEqual({ key: 'house', sky: 'sunset' });
    expect(resolveSubject('Open Paint and draw a simple sunset.')).toEqual({ key: 'sunset', sky: 'sunset' });
    expect(resolveSubject('a cat')).toEqual({ key: 'cat', sky: 'day' });
    expect(resolveSubject('two kittens')).toEqual({ key: 'cat', sky: 'day' });
    expect(resolveSubject('a tree under the stars')).toEqual({ key: 'tree', sky: 'night' });
    expect(resolveSubject('a cat next to a tree')?.key).toBe('cat');
  });

  it('refuses a subject it has no plan for, rather than inventing one', () => {
    expect(resolveSubject('a dragon')).toBeNull();
    expect(resolveSubject('a cyberpunk city')).toBeNull();
    expect(resolveSubject('')).toBeNull();
  });

  it('draws the house in the order the demo shows it', () => {
    expect(buildScene('house', 'day').steps.map((step) => step.label)).toEqual([
      'the sky and the ground',
      'the walls',
      'the roof',
      'the door',
      'the windows',
      'the sun',
      'the chimney',
      'the smoke',
      'a cloud',
      'a tree',
    ]);
  });

  it('has a fixed, deterministic plan: the same steps, shapes and frames every time', () => {
    for (const [key, sky] of SCENES) expect(buildScene(key, sky)).toEqual(buildScene(key, sky));
    // Every plan is structurally identical above. Rendering is one pure function
    // of the plan, so one plan rendered twice shows it is byte-stable; rendering
    // more only slows the suite (it timed out under full-suite load).
    const digest = (frames: ReturnType<typeof renderFrames>): string[] => frames.map((frame) => createHash('sha256').update(frame.png).digest('hex'));
    const frames = renderFrames(buildScene('house', 'day'));
    expect(digest(frames)).toEqual(digest(renderFrames(buildScene('house', 'day'))));
    // Frames are painted incrementally; the last one is exactly the whole scene.
    expect(digest([frames.at(-1)!])).toEqual(digest([{ label: '', png: renderPng(buildScene('house', 'day')) }]));
  });

  it('bounds every plan: a few steps, a few dozen shapes, every coordinate on the canvas', () => {
    for (const [key, sky] of SCENES) {
      const scene = buildScene(key, sky);
      expect(scene.steps.length, `${key}/${sky}`).toBeGreaterThanOrEqual(4);
      expect(scene.steps.length, `${key}/${sky}`).toBeLessThanOrEqual(MAX_DRAW_STEPS);
      expect(scene.shapes.length).toBeLessThanOrEqual(80);
      for (const shape of scene.shapes) {
        const xs = shape.kind === 'rect' ? [shape.x, shape.x + shape.w] : shape.kind === 'ellipse' ? [shape.cx] : shape.kind === 'polygon' ? shape.points.map(([x]) => x) : [shape.x1, shape.x2];
        const ys = shape.kind === 'rect' ? [shape.y, shape.y + shape.h] : shape.kind === 'ellipse' ? [shape.cy] : shape.kind === 'polygon' ? shape.points.map(([, y]) => y) : [shape.y1, shape.y2];
        for (const x of xs) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(CANVAS_WIDTH);
        }
        for (const y of ys) {
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(CANVAS_HEIGHT);
        }
      }
    }
  });

  it('builds up: each frame adds one step, and the last frame is the finished picture', () => {
    const scene = buildScene('house', 'day');
    const frames = renderFrames(scene);
    expect(frames).toHaveLength(scene.steps.length);
    expect(Buffer.from(frames.at(-1)!.png).equals(Buffer.from(renderPng(scene)))).toBe(true);
    // The walls are not in the first frame and are in the second.
    const wall = (png: Uint8Array) => {
      const image = decode(png);
      const at = (300 * CANVAS_WIDTH + 300) * 4;
      return [image.rgba[at], image.rgba[at + 1], image.rgba[at + 2]];
    };
    expect(wall(frames[0]!.png)).not.toEqual([0xe8, 0xd5, 0xb0]);
    expect(wall(frames[1]!.png)).toEqual([0xe8, 0xd5, 0xb0]);
  });

  it('writes a well-formed 800x600 PNG whose pixels are the scene', () => {
    const scene = buildScene('house', 'day');
    const png = renderPng(scene);
    expect(isPng(png)).toBe(true);
    const image = decode(png);
    expect([image.width, image.height]).toEqual([CANVAS_WIDTH, CANVAS_HEIGHT]);
    const pixel = (x: number, y: number) => Array.from(image.rgba.subarray((y * CANVAS_WIDTH + x) * 4, (y * CANVAS_WIDTH + x) * 4 + 3));
    expect(pixel(400, 230)).toEqual([0xb5, 0x47, 0x3a]); // the roof
    expect(pixel(10, 590)).toEqual([0x5c, 0xb8, 0x5c]); // the grass
    expect(rasterize(scene).length).toBe(CANVAS_WIDTH * CANVAS_HEIGHT * 3);
  });

  it('matches a read-back canvas only when it is the drawing', () => {
    const scene = buildScene('house', 'day');
    const same = canvasMatch(scene, decode(renderPng(scene)));
    expect(same.matched).toBe(same.sampled);
    const other = canvasMatch(scene, decode(renderPng(buildScene('cat', 'night'))));
    expect(other.matched / other.sampled).toBeLessThan(0.5);
    const tiny = canvasMatch(scene, { width: 10, height: 10, rgba: new Uint8Array(400) });
    expect(tiny.matched).toBe(0);
  });

  it('writes SVG that is only shapes: no script, no link, no external reference', () => {
    for (const key of ['house', 'sunset', 'cat', 'tree'] as const) {
      const svg = renderSvg(buildScene(key, 'day'));
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/<script|href|<image|<foreignObject|on[a-z]+=/i);
    }
  });
});

// ---------------------------------------------------------------------------
// draw.paint
// ---------------------------------------------------------------------------

describe('draw.paint — drawing in Paint, step by step', () => {
  it('asks first, opens a NEW Paint window, pastes every step into it, reads it back, and says so', async () => {
    const h = await harness();
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(result.ok).toBe(true);
    const steps = buildScene('house', 'day').steps.length;
    expect(h.launched).toEqual([PAINT_ID]);
    expect(h.pastes()).toBe(steps);
    expect(h.clipboardWrites).toHaveLength(steps);
    // Every act was in the window Axon opened.
    expect(new Set(h.acts.map((act) => act.windowHandle))).toEqual(new Set([h.newPaint()!.handle]));

    const out = output(result);
    expect(out.drawing).toBe('a house');
    expect(out.steps).toEqual(buildScene('house', 'day').steps.map((step) => step.label));
    expect(out.verified).toMatchObject({ drawn: true, evidence: 'canvas' });
    // What the model is told: never a handle, a runtime id or an AppID.
    const text = JSON.stringify(out);
    expect(text).not.toContain(PAINT_ID);
    expect(text).not.toContain(h.newPaint()!.handle);
    expect(text).not.toMatch(/runtimeId|hwnd|"pid"/i);
  });

  it('touches only Paint\'s Edit menu, Paste and Copy visible layers — nothing else, no coordinates', async () => {
    const h = await harness();
    await h.decide('draw.paint', { subject: 'a sunset' }, 'ALLOW');
    expect(new Set(h.acts.map((act) => act.name))).toEqual(new Set(['Edit', 'Paste', 'Copy visible layers']));
    expect(new Set(h.acts.map((act) => act.action))).toEqual(new Set(['expand', 'invoke']));
    expect(new Set(h.acts.map((act) => act.nativeRole))).toEqual(new Set(['ControlType.MenuItem']));
    for (const act of h.acts) expect(Object.keys(act).sort()).not.toContain('text');
  });

  it('puts the user\'s clipboard back afterwards — on success and on failure', async () => {
    const ok = await harness();
    await ok.decide('draw.paint', { subject: 'a tree' }, 'ALLOW');
    expect(ok.restored).toEqual([ok.USER_CLIPBOARD]);
    const failed = await harness({ pasteFailsAt: 3 });
    await failed.decide('draw.paint', { subject: 'a tree' }, 'ALLOW');
    expect(failed.restored).toEqual([failed.USER_CLIPBOARD]);
    expect(failed.clip()).toBe('user');
  });

  it('says so when the clipboard could not be put back — and never leaves the drawing on it', async () => {
    // FOUND LIVE: Electron 44 refused to write back what it had read, the
    // failure was swallowed, and Paint's copy of the drawing stayed behind.
    const ok = await harness();
    expect(output(await ok.decide('draw.paint', { subject: 'a house' }, 'ALLOW')).clipboard).toBe('restored');
    expect(ok.clip()).toBe('user');
    for (const restoreFails of ['refuses', 'throws'] as const) {
      const h = await harness({ restoreFails });
      const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
      expect(result.ok).toBe(true);
      expect(String(output(result).clipboard)).toMatch(/^emptied/);
      expect(h.clip()).toBe('empty');
    }
  });

  it('paces the steps so they can be watched, and the pauses are bounded', async () => {
    const h = await harness();
    await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    const steps = buildScene('house', 'day').steps.length;
    const pauses = h.waits.filter((ms) => ms >= 150 && ms <= 300);
    expect(pauses).toHaveLength(steps);
    // The whole deliberate pause across a plan stays within a few seconds.
    expect(pauses.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAX_DRAW_STEPS * 300);
  });

  it('does nothing at all when the user denies: no Paint, no clipboard, no paste', async () => {
    const h = await harness();
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'DENY');
    expect(kind(result)).toBe('DENIED');
    expect(h.launched).toEqual([]);
    expect(h.acts).toEqual([]);
    expect(h.clipboardWrites).toEqual([]);
    expect(h.restored).toEqual([]);
  });

  it('never draws into a Paint window the user already had', async () => {
    const mine = paintWindow('My unsaved work - Paint');
    const h = await harness({ existing: [mine] });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(result.ok).toBe(true);
    expect(h.acts.some((act) => act.windowHandle === mine.handle)).toBe(false);
  });

  it('draws nothing when no new Paint window appears', async () => {
    const h = await harness({ paintOpens: false, existing: [paintWindow('My unsaved work - Paint')] });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(kind(result)).toBe('VERIFICATION_FAILED');
    expect(h.acts).toEqual([]);
    expect(h.clipboardWrites).toEqual([]);
  });

  it('brings Paint forward again when something else took the foreground mid-drawing', async () => {
    const h = await harness({ pasteFailsUntilFocusAt: 5 });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(result.ok).toBe(true);
    expect(h.pastes()).toBe(buildScene('house', 'day').steps.length);
    // Once when it opened, once to recover — and only ever Axon's own new window.
    expect(h.focused).toEqual([h.newPaint()!.handle, h.newPaint()!.handle]);
  });

  it('does not draw — and never touches the clipboard — when Paint cannot come to the front', async () => {
    const h = await harness({ focusRefused: true });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(kind(result)).toBe('VERIFICATION_FAILED');
    expect(message(result)).toMatch(/kept another window in front/);
    expect(h.clipboardWrites).toEqual([]);
    expect(h.pastes()).toBe(0);
    expect(h.acts.filter((act) => act.name === 'Paste')).toEqual([]);
  });

  it('stops at once when Paint stops answering a Paste, and still restores the clipboard', async () => {
    const h = await harness({ pasteHangsAt: 2 });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(kind(result)).toBe('VERIFICATION_FAILED');
    expect(message(result)).toMatch(/after 1 of \d+ steps/);
    // One Paste for step 1, ONE for the hung step 2 — nothing queued behind it.
    expect(h.acts.filter((act) => act.name === 'Paste')).toHaveLength(2);
    expect(h.restored).toEqual([h.USER_CLIPBOARD]);
    expect(h.clip()).toBe('user');
  });

  it('does not claim success when a step fails part-way', async () => {
    const h = await harness({ pasteFailsAt: 4 });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(kind(result)).toBe('VERIFICATION_FAILED');
    expect(message(result)).toContain(DRAW_UNVERIFIED);
    expect(message(result)).toMatch(/after 3 of \d+ steps/);
  });

  it('requires Paint\'s own read-back to match the plan', async () => {
    for (const readBack of ['wrong', 'nothing'] as const) {
      const h = await harness({ readBack });
      const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
      expect(kind(result), readBack).toBe('VERIFICATION_FAILED');
      expect(message(result)).toBe(DRAW_UNVERIFIED);
    }
  });

  it('does not claim success when Paint disappears', async () => {
    const h = await harness({ paintCloses: true });
    const result = await h.decide('draw.paint', { subject: 'a house' }, 'ALLOW');
    expect(result.ok).toBe(false);
  });

  it('says Paint is not installed, before asking anybody anything', async () => {
    const h = await harness({ raw: RAW.filter((entry) => entry.name !== 'Paint') });
    const result = await h.run('draw.paint', { subject: 'a house' });
    expect(kind(result)).toBe('NOT_FOUND');
    expect(message(result)).toBe(NOT_INSTALLED);
    expect(h.approvals.list()).toEqual([]);
  });

  it('never guesses between two applications called Paint', async () => {
    const h = await harness({ raw: [...RAW, { name: 'Paint', appId: 'Contoso.PaintClone_abc123!App' }] });
    const result = await h.run('draw.paint', { subject: 'a house' });
    expect(result.ok).toBe(false);
    expect(message(result)).toMatch(/will not guess/);
    expect(h.approvals.list()).toEqual([]);
    expect(h.launched).toEqual([]);
  });

  it('takes the exact name first: "Paint" wins over "Paint 3D"', async () => {
    const h = await harness({ raw: [...RAW, { name: 'Paint 3D', appId: 'Microsoft.MSPaint_8wekyb3d8bbwe!Microsoft.MSPaint' }] });
    const result = await h.decide('draw.paint', { subject: 'a tree' }, 'ALLOW');
    expect(result.ok).toBe(true);
    expect(h.launched).toEqual([PAINT_ID]);
  });

  it('refuses a subject it has no plan for — "a dragon" — without a dialog', async () => {
    const h = await harness();
    const result = await h.run('draw.paint', { subject: 'a dragon' });
    expect(kind(result)).toBe('UNSUPPORTED');
    expect(message(result)).toMatch(/a house, a sunset, a cat or a tree/);
    expect(h.approvals.list()).toEqual([]);
    expect(h.launched).toEqual([]);
  });

  it('names the act and the method in the approval, through the existing broker', async () => {
    const h = await harness();
    const pending = h.run('draw.paint', { subject: 'a simple house at sunset' });
    await vi.waitFor(() => expect(h.approvals.list()).toHaveLength(1));
    const request = h.approvals.list()[0]!;
    expect(request.title).toBe('Axon wants to open Paint and draw a house at sunset');
    expect(JSON.stringify(request.parameters)).toMatch(/clipboard/);
    h.approvals.settle(request.callId, 'DENY', 'user');
    await pending;
  });
});

describe('draw.paint — what the model cannot say', () => {
  it('rejects coordinates, handles, process ids, paths and programs as INVALID input', async () => {
    const h = await harness();
    for (const extra of [
      { x: 500, y: 300 },
      { from: [400, 300], to: [700, 500] },
      { points: [[1, 2]] },
      { steps: [{ action: 'rectangle', x: 1 }] },
      { hwnd: '12345' },
      { windowHandle: '12345' },
      { pid: 4242 },
      { path: 'C:\\Users\\me\\secret.png' },
      { app: 'cmd.exe' },
    ]) {
      const result = await h.run('draw.paint', { subject: 'a house', ...extra });
      expect(kind(result), JSON.stringify(extra)).toBe('INVALID_INPUT');
    }
    expect(h.launched).toEqual([]);
    expect(h.acts).toEqual([]);
    expect(h.approvals.list()).toEqual([]);
  });

  it('refuses a path or a program dressed up as a subject', async () => {
    const h = await harness();
    for (const subject of ['C:\\Windows\\System32\\cmd.exe', '..\\..\\house', 'house.exe', '/etc/passwd house']) {
      expect(kind(await h.run('draw.paint', { subject })), subject).toBe('FORBIDDEN');
    }
    expect(h.launched).toEqual([]);
  });

  it('has only "subject" and "style" in its schema, and no other field is allowed', () => {
    const noop = () => Promise.resolve();
    const tool = createDrawPaintTool({
      catalog: new AppCatalog(() => Promise.resolve(RAW)),
      launcher: { launchExecutable: () => Promise.resolve({ pid: 1 }), openUri: noop, launchStartMenuApp: noop },
      desktop: { available: true, list: () => Promise.resolve([]), act: () => Promise.resolve(true) },
      ui: { uiAvailable: true, observeControls: () => Promise.reject(new Error('unused')), actOnControl: () => Promise.reject(new Error('unused')) },
      clipboard: { save: () => Promise.reject(new Error('unused')), restore: () => Promise.resolve(true), clear: noop, writePng: noop, readImage: () => Promise.resolve(null) },
    });
    const view = toToolSchema(tool).inputSchema as { properties: object };
    expect(Object.keys(view.properties).sort()).toEqual(['style', 'subject']);
    expect(JSON.stringify(view)).toMatch(/"additionalProperties":false/);
  });

  it('leaves blocked applications blocked', async () => {
    const h = await harness();
    expect(kind(await h.run('app.launch', { app: 'Command Prompt' }))).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// The artifact store (used by draw.generate)
// ---------------------------------------------------------------------------

describe("Axon's drawings folder", () => {
  it('names every file itself, uniquely, inside its own folder', async () => {
    const dir = tempDir();
    const store = new DrawingStore(dir, { now: () => new Date(2026, 8, 30, 12, 0, 0) });
    const png = renderPng(buildScene('tree', 'day'));
    const a = await store.save('tree', png);
    const b = await store.save('tree', png);
    expect(a.fileName).not.toBe(b.fileName);
    for (const saved of [a, b]) {
      expect(saved.fileName).toMatch(DRAWING_FILE);
      expect(path.dirname(saved.path)).toBe(path.resolve(dir));
      expect(store.contains(saved.path)).toBe(true);
    }
  });

  it('never overwrites: a name that already exists is a failure, not a replacement', async () => {
    const dir = tempDir();
    const store = new DrawingStore(dir, { now: () => new Date(2026, 8, 30, 12, 0, 0), random: () => 'abcdef01' });
    const first = await store.save('house', renderPng(buildScene('house', 'day')));
    const before = fs.readFileSync(first.path);
    await expect(store.save('house', new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(fs.readFileSync(first.path).equals(before)).toBe(true);
  });

  it('cannot be steered outside its folder by a name', async () => {
    const dir = tempDir();
    const store = new DrawingStore(dir);
    for (const slug of ['../evil', '..\\evil', 'C:\\Windows\\evil', 'a/b', '', 'HOUSE', 'x'.repeat(21)]) {
      await expect(store.save(slug, new Uint8Array([1])), slug).rejects.toThrow();
    }
    await expect(new DrawingStore(dir, { random: () => '../../x' }).save('house', new Uint8Array([1]))).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('recognises only its own files, in its own folder', () => {
    const dir = tempDir();
    const store = new DrawingStore(dir);
    expect(store.contains(path.join(dir, 'house-20260930-120000-abcdef01.png'))).toBe(true);
    expect(store.contains(path.join(dir, '..', 'house-20260930-120000-abcdef01.png'))).toBe(false);
    expect(store.contains(path.join(dir, 'sub', 'house-20260930-120000-abcdef01.png'))).toBe(false);
    expect(store.contains(path.join(dir, 'notes.png'))).toBe(false);
    expect(store.contains('C:\\Windows\\System32\\calc.exe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// draw.generate
// ---------------------------------------------------------------------------

const TINY_PNG = renderPng(buildScene('tree', 'day'));

describe('draw.generate — image generation', () => {
  it('says it is not configured, before any dialog, and creates nothing', async () => {
    const h = await harness();
    const result = await h.run('draw.generate', { prompt: 'a cyberpunk city' });
    expect(kind(result)).toBe('UNSUPPORTED');
    expect(message(result)).toBe(NOT_CONFIGURED);
    expect(h.approvals.list()).toEqual([]);
    expect(h.files()).toEqual([]);
  });

  it('with a provider: asks first, because the description leaves the machine, then saves only a real PNG', async () => {
    const provider: ImageProvider = { name: 'Test Images', generate: () => Promise.resolve(TINY_PNG) };
    const h = await harness({ provider });
    const result = await h.decide('draw.generate', { prompt: 'a cat astronaut' }, 'ALLOW');
    expect(result.ok).toBe(true);
    expect(String(output(result).file)).toMatch(DRAWING_FILE);
    expect(h.files()).toHaveLength(1);
  });

  it('does not claim an image when the provider fails, and never repeats its message', async () => {
    const provider: ImageProvider & { key: string } = {
      name: 'Test Images',
      key: 'sk-test-SECRET0123456789abcdef0123456789',
      generate() {
        return Promise.reject(new Error(`401 for key ${this.key}`));
      },
    };
    const h = await harness({ provider });
    const result = await h.decide('draw.generate', { prompt: 'a futuristic car' }, 'ALLOW');
    expect(kind(result)).toBe('VERIFICATION_FAILED');
    expect(JSON.stringify(result)).not.toContain('SECRET0123456789');
    expect(h.files()).toEqual([]);
  });

  it('does not save something that is not a picture', async () => {
    const provider: ImageProvider = { name: 'Test Images', generate: () => Promise.resolve(new TextEncoder().encode('MZ not an image')) };
    const h = await harness({ provider });
    expect(kind(await h.decide('draw.generate', { prompt: 'a futuristic car' }, 'ALLOW'))).toBe('VERIFICATION_FAILED');
    expect(h.files()).toEqual([]);
  });

  it('bounds the prompt and the size, and takes no path', async () => {
    const h = await harness({ provider: { name: 'Test Images', generate: () => Promise.resolve(TINY_PNG) } });
    expect(kind(await h.run('draw.generate', { prompt: 'x'.repeat(501) }))).toBe('INVALID_INPUT');
    expect(kind(await h.run('draw.generate', { prompt: 'a city', width: 99_999 }))).toBe('INVALID_INPUT');
    expect(kind(await h.run('draw.generate', { prompt: 'a city', output: 'C:\\x.png' }))).toBe('INVALID_INPUT');
    expect(kind(await h.run('draw.generate', { prompt: 'save to C:\\Users\\me\\x.png' }))).toBe('FORBIDDEN');
  });
});

describe('path-shaped text', () => {
  it('is recognised in the forms a location or a program takes, and prose is not', () => {
    for (const text of ['C:\\x', 'c:/x', '..\\up', '../up', '\\\\server\\share', 'run.exe', 'x.ps1', '/etc/passwd']) {
      expect(looksLikePath(text), text).toBe(true);
    }
    for (const text of ['a house at sunset', 'a cat astronaut', 'a 16 by 9 picture of a car', 'a cyberpunk city, neon']) {
      expect(looksLikePath(text), text).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration and the flag
// ---------------------------------------------------------------------------

describe('registration', () => {
  const noop = () => Promise.resolve();
  const base = () => ({
    launcher: { launchExecutable: () => Promise.resolve({ pid: 1 }), openUri: noop, launchStartMenuApp: noop } as AppLauncher,
    capturer: { capturePrimaryDisplay: () => Promise.reject(new Error('no')) } as ScreenCapturer,
    screenshotDir: tempDir(),
    pathPolicy: { workspaceRoot: tempDir(), forbiddenRoots: [] },
  });
  const clipboard: ClipboardImages = { save: () => Promise.reject(new Error('unused')), restore: () => Promise.resolve(true), clear: noop, writePng: noop, readImage: () => Promise.resolve(null) };
  const desktop: DesktopWindows = { available: true, list: () => Promise.resolve([]), act: () => Promise.resolve(true) };
  const ui: DesktopUi = { uiAvailable: true, observeControls: () => Promise.reject(new Error('unused')), actOnControl: () => Promise.reject(new Error('unused')) };
  const apps: DesktopApps = { appsAvailable: true, listStartMenuApps: () => Promise.resolve(RAW), defaultBrowser: () => Promise.resolve(null) };

  it('registers no drawing tool when drawing is off', () => {
    const registry = createDefaultRegistry({ ...base(), drawing: null });
    expect(registry.names().filter((name) => name.startsWith('draw.'))).toEqual([]);
  });

  it('registers draw.paint only where Axon can find Paint, see it, and hand it a picture', () => {
    const catalog = new AppCatalog(() => Promise.resolve(RAW));
    const drawing = { store: new DrawingStore(tempDir()), imageProvider: null, clipboard };
    const full = createDefaultRegistry({ ...base(), apps, catalog, desktop, ui, drawing });
    expect(full.names().filter((name) => name.startsWith('draw.'))).toEqual(['draw.generate', 'draw.paint']);
    for (const missing of [{ ui: null }, { desktop: null }, { catalog: null }, { drawing: { ...drawing, clipboard: null } }]) {
      const partial = createDefaultRegistry({ ...base(), apps, catalog, desktop, ui, drawing, ...missing });
      expect(partial.names().filter((name) => name.startsWith('draw.')), JSON.stringify(Object.keys(missing))).toEqual(['draw.generate']);
    }
  });

  it('is on by default, off with AXON_DRAW_ENABLED=false, and keeps drawings under AXON_HOME', () => {
    const home = tempDir();
    const config = (env: NodeJS.ProcessEnv) => resolveRuntimeConfig({ home, env, isDev: false, sessionData: home });
    const on = config({ AXON_HOME: home });
    expect(on.drawEnabled).toBe(true);
    expect(on.drawingsDir).toBe(path.join(home, 'drawings'));
    for (const value of ['false', '0', 'FALSE', 'off']) {
      expect(config({ AXON_HOME: home, AXON_DRAW_ENABLED: value }).drawEnabled, value).toBe(false);
    }
  });
});
