/**
 * Drawing: `draw.paint` and `draw.generate`.
 *
 * WHAT THE MODEL CAN SAY, AND ALL IT CAN SAY. Words. `draw.paint` takes what
 * to draw ("a house at sunset"); `draw.generate` takes a description of an
 * image. The schemas are STRICT: a coordinate, a window handle, a process id,
 * a path, a file name or an application is not an unknown field that gets
 * dropped — it is invalid input, and nothing runs.
 *
 * `draw.paint` — one semantic act, sequenced by Axon, not by the model:
 *
 *   resolve   the description against Axon's own scenes (`draw/drawing.ts`);
 *             anything else is refused before anyone is asked anything
 *   find      Paint in the discovered catalog — exact name first, never a
 *             guess between two; not installed is "Paint isn't installed"
 *   approve   the SAME approval every discovered application gets, through
 *             the one dispatcher. Nothing happens before it.
 *   plan      the scene's FIXED steps (sky, walls, roof, door, …), each
 *             rendered by Axon to a whole picture: step N shows steps 1..N
 *   open      a NEW Paint window, started the way the Start menu starts it,
 *             found by Paint's package identity — never a window the user
 *             already had, which could hold unsaved work
 *   draw      for each step: the picture onto the clipboard, then Paint's
 *             own Edit > Paste, pressed through UI Automation (expand,
 *             invoke) — so Paint's actual canvas builds up while you watch
 *   verify    Paint's own Edit > Copy visible layers, read back and compared
 *             with the plan at fixed sample points; and the window must still
 *             be Paint's. Anything less is VERIFICATION_FAILED, never "done".
 *   restore   the user's clipboard, as it was
 *
 * WHY NOT STROKES. Measured: Paint's canvas is exposed to UI Automation as a
 * Group with no patterns and no actions. Every tool, shape and colour is
 * selectable, but putting one on the canvas needs a pointer drag at screen
 * coordinates — synthetic input, which Axon has nowhere and does not add
 * here. Paste is the one canvas-changing operation Paint exposes as a
 * control. There is no mouse and no keyboard anywhere on this path.
 *
 * `draw.generate` — a real image model, when one is configured. None is (see
 * `draw/image-provider.ts`), and it says so before anything else happens.
 */

import { z } from 'zod';
import {
  ClarificationRequired,
  ToolError,
  defineTool,
  type JsonObject,
  type PrecheckVerdict,
  type RegisteredTool,
  type RiskAssessment,
  type SideEffectClass,
  type ToolSummary,
} from '@axon/core';
import type { DesktopControlOutcome, DesktopUi, DesktopWindow, DesktopWindows } from '../../platform/windows-desktop.js';
import type { AppLauncher, ClipboardImages } from '../../platform/ports.js';
import { resolveApp, type AppCatalog, type DiscoveredApp, type Resolution } from '../../apps/app-catalog.js';
import { ownerOf } from '../../apps/window-identity.js';
import { snapshotWindows } from './app-launching.js';
import { DRAWABLE_SUBJECTS, buildScene, canvasMatch, isPng, renderFrames, resolveSubject } from '../../draw/drawing.js';
import type { DrawingStore } from '../../draw/artifact-store.js';
import type { ImageProvider } from '../../draw/image-provider.js';

const PAINT = 'Paint';
const VERIFY_TIMEOUT_MS = 10_000;
const VERIFY_INTERVAL_MS = 400;
/** A generated image larger than this is not accepted from a provider. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const NOT_CONFIGURED = "Image generation isn't configured yet.";
export const NOT_INSTALLED = "Paint isn't installed on this PC.";
const WORDS_ONLY = 'Describe the drawing in words. Axon never takes a path, a file or a program for it.';
const CANNOT_DRAW = `Axon can draw ${DRAWABLE_SUBJECTS.slice(0, -1).join(', ')} or ${DRAWABLE_SUBJECTS.at(-1)} in Paint — not that yet.`;

/**
 * Text that reads as a location or a program rather than a description.
 * Words about a picture never need a drive letter, a backslash, a parent step
 * or an executable's extension.
 */
export function looksLikePath(text: string): boolean {
  return /[a-z]:[\\/]|\\|\.\.[\\/]|(^|\s)\/[\w.]|\.(exe|bat|cmd|com|ps1|psm1|vbs|lnk|dll|msi|scr|reg)\b/i.test(text);
}

// --- draw.paint ---------------------------------------------------------------

export interface DrawPaintToolOptions {
  readonly catalog: AppCatalog;
  readonly launcher: AppLauncher;
  readonly desktop: DesktopWindows;
  readonly ui: DesktopUi;
  readonly clipboard: ClipboardImages;
  readonly verifyTimeoutMs?: number;
  readonly verifyIntervalMs?: number;
  /** The pause after each step, so the audience sees it land. */
  readonly stepPauseMs?: number;
  /** How long Paint's menu may take to become readable after its window appears. */
  readonly readyTimeoutMs?: number;
  readonly wait?: (ms: number) => Promise<void>;
}

const paintSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('What to draw, in the user\'s words: "a house", "a sunset", "a cat at night".'),
    style: z.string().trim().max(40).optional().describe('Optional, e.g. "simple". Axon\'s drawings have one style.'),
  })
  .strict();
type PaintInput = z.infer<typeof paintSchema>;

/** Paint, as the catalog resolves it: exact name first; two is a question, never a guess. */
function findPaint(apps: readonly DiscoveredApp[]): Resolution {
  const exact = apps.filter((app) => app.name.trim().toLowerCase() === 'paint');
  if (exact.length === 1) return { kind: 'match', app: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
  return resolveApp(apps, PAINT);
}

function paintProblem(resolution: Resolution | null): PrecheckVerdict | null {
  if (!resolution) return null;
  if (resolution.kind === 'none') return { ok: false, retryable: false, kind: 'NOT_FOUND', reason: NOT_INSTALLED };
  if (resolution.kind === 'ambiguous') {
    return {
      ok: false,
      retryable: false,
      kind: 'UNSUPPORTED',
      reason: `More than one application here is called Paint (${resolution.candidates.map((app) => app.name).join(', ')}), and Axon will not guess which one.`,
    };
  }
  if (resolution.app.blocked) return { ok: false, retryable: false, kind: 'FORBIDDEN', reason: resolution.app.blocked };
  if (resolution.app.kind !== 'packaged') {
    return { ok: false, retryable: false, kind: 'UNSUPPORTED', reason: 'Axon can draw only in the Microsoft Store version of Paint.' };
  }
  return null;
}

/**
 * Paint's own menu labels. The ONLY controls this tool ever touches, and
 * only inside the Paint window it opened itself: open the Edit menu, press
 * Paste, and — once, to check — press Copy visible layers.
 */
const PAINT_MENU = { role: 'ControlType.MenuItem', edit: 'Edit', paste: 'Paste', copyVisible: 'Copy visible layers' } as const;
/** Of the sampled points, how many must match for the drawing to count as there. */
const MATCH_THRESHOLD = 0.9;
const STEP_PAUSE_MS = 180;
const READY_TIMEOUT_MS = 12_000;
export const DRAW_UNVERIFIED = "I started drawing, but I couldn't verify that Paint finished it.";

export function createDrawPaintTool(options: DrawPaintToolOptions): RegisteredTool {
  const { catalog, launcher, desktop, ui, clipboard } = options;
  const timeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  const intervalMs = options.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
  const pauseMs = options.stepPauseMs ?? STEP_PAUSE_MS;
  const readyMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const paintNow = (): Resolution | null => {
    const listed = catalog.snapshot();
    return listed ? findPaint(listed) : null;
  };

  return defineTool<PaintInput, JsonObject>({
    name: 'draw.paint',
    title: 'Draw a picture in Paint',
    description:
      `Open a new Paint window and draw in it, step by step, while the user watches. Axon can draw ` +
      `${DRAWABLE_SUBJECTS.join(', ')} — optionally at sunset or at night. Call this ONCE for "draw a house in ` +
      'Paint" or "open Paint and draw a sunset": it opens Paint itself, so do not call app.launch first. Give only ' +
      'what to draw, in words. It asks the user before opening Paint. The result carries a "verified" section; ' +
      'only say the drawing is finished when that says so. For any other subject, say what Axon can draw instead.',
    inputSchema: paintSchema,

    precheck(input): PrecheckVerdict {
      if (looksLikePath(input.subject) || (input.style && looksLikePath(input.style))) {
        return { ok: false, retryable: false, kind: 'FORBIDDEN', reason: WORDS_ONLY };
      }
      if (!resolveSubject(input.subject)) return { ok: false, retryable: false, kind: 'UNSUPPORTED', reason: CANNOT_DRAW };
      return paintProblem(paintNow()) ?? { ok: true };
    },

    resolveRisk(input): RiskAssessment {
      if (looksLikePath(input.subject)) return { level: 'FORBIDDEN', reason: WORDS_ONLY };
      const resolution = paintNow();
      if (resolution?.kind === 'match' && resolution.app.blocked) return { level: 'FORBIDDEN', reason: resolution.app.blocked };
      // The same rule as every discovered application: a person says yes first.
      return {
        level: 'REQUIRES_APPROVAL',
        reason:
          'Drawing opens Paint, which is installed on this computer but is not one of Axon\'s built-in applications, ' +
          'and pastes each step of the drawing into that new window through the clipboard.',
      };
    },

    summarize(input): ToolSummary {
      const subject = resolveSubject(input.subject);
      const scene = subject ? buildScene(subject.key, subject.sky) : null;
      return {
        title: `Axon wants to open Paint and draw ${scene?.label ?? input.subject}`,
        parameters: [
          { label: 'Application', value: `${PAINT} — a new window` },
          { label: 'Drawing', value: scene ? `${scene.label}, in ${scene.steps.length} steps` : input.subject },
          { label: 'How', value: 'Each step is pasted into Paint from the clipboard, which is put back afterwards' },
        ],
      };
    },

    sideEffect: (): SideEffectClass => 'LOCAL',

    async execute(input, ctx): Promise<JsonObject> {
      if (looksLikePath(input.subject)) throw new ToolError('FORBIDDEN', WORDS_ONLY);
      const subject = resolveSubject(input.subject);
      if (!subject) throw new ToolError('UNSUPPORTED', CANNOT_DRAW);
      if (!launcher.launchStartMenuApp) throw new ToolError('UNSUPPORTED', 'Opening Paint is not available on this computer.');

      const listed = await catalog.current();
      const resolution = findPaint(listed);
      const problem = paintProblem(resolution);
      if (problem && !problem.ok) {
        if (resolution.kind === 'ambiguous') throw new ClarificationRequired(problem.reason);
        throw new ToolError(problem.kind ?? 'UNSUPPORTED', problem.reason);
      }
      if (resolution.kind !== 'match') throw new ToolError('NOT_FOUND', NOT_INSTALLED);
      const paint = resolution.app;

      // The whole plan, rendered before Paint is touched: nothing is computed
      // while the audience is watching, and a plan that cannot render never
      // opens anything.
      const scene = buildScene(subject.key, subject.sky);
      const frames = renderFrames(scene);

      // A NEW Paint window, by identity, that did not exist a moment ago. Axon
      // never draws into a Paint window the user already had — that could be
      // somebody's unsaved work.
      const before = await snapshotWindows(desktop);
      if (before === null) throw new ToolError('UNSUPPORTED', 'Axon could not list the windows, so it did not open Paint.');
      const known = new Set(before.map((window) => window.handle));
      ctx.observe('Opening Paint', { app: paint.id });
      await launcher.launchStartMenuApp(paint.appId);
      const isNewPaint = (window: DesktopWindow): boolean => !known.has(window.handle) && ownerOf(window, listed)?.app.id === paint.id;
      const opened = await findWindow(desktop, isNewPaint, timeoutMs, intervalMs, wait);
      if (!opened) throw new ToolError('VERIFICATION_FAILED', 'Paint did not open a new window, so Axon did not draw anything.');
      const handle = opened.handle;
      await desktop.act(handle, 'focus').catch(() => false);

      // Ready: Paint's Edit menu is readable in that window.
      const ready = await waitForMenu(ui, handle, readyMs, intervalMs, wait);
      if (!ready) throw new ToolError('UI_NOT_ACCESSIBLE', 'Paint opened, but its menu never became readable, so Axon did not draw anything.');

      const act = (name: string, action: 'expand' | 'invoke', runtimeId?: string): Promise<DesktopControlOutcome> =>
        ui.actOnControl({ windowHandle: handle, nativeRole: PAINT_MENU.role, name, automationId: '', action, ...(runtimeId ? { runtimeId } : {}) });
      // A Paste that does not answer means Paint is stuck in it; pressing again
      // only queues more work behind it. 'hung' ends the drawing at once.
      type Press = 'ok' | 'failed' | 'hung';
      const hung = (outcome: DesktopControlOutcome): boolean => outcome.kind === 'failed' && outcome.reason === 'timeout';
      const attempt = async (name: string): Promise<Press> => {
        const menu = await act(PAINT_MENU.edit, 'expand', ready.editRuntimeId);
        if (hung(menu)) return 'hung';
        if (menu.kind !== 'ok') return 'failed';
        let item = await act(name, 'invoke');
        // 'gone': the menu was still opening. Anything else is not retried here.
        if (item.kind === 'gone') {
          await wait(150);
          item = await act(name, 'invoke');
        }
        if (hung(item)) return 'hung';
        return item.kind === 'ok' ? 'ok' : 'failed';
      };
      // MEASURED LIVE, TWICE OVER. A packaged app like Paint can read the
      // clipboard only while it is the foreground window: behind another window
      // its Paste is disabled ("unsupported") or blocks. And a WinUI menu closes
      // itself the moment its window is not the active one. So Paint must be IN
      // FRONT — checked from a fresh listing, not assumed from a focus request
      // Windows may refuse. Axon never forces the foreground.
      const inFront = async (): Promise<boolean> =>
        (await desktop.list().catch(() => [] as readonly DesktopWindow[])).some((window) => window.handle === handle && window.foreground);
      const bringForward = async (): Promise<boolean> => {
        for (let tries = 0; tries < 3; tries += 1) {
          if (await inFront()) return true;
          await desktop.act(handle, 'focus').catch(() => false);
          await wait(250);
        }
        return inFront();
      };
      // Checked before the first press (below) and after any press that fails —
      // a listing costs over a second, so not before every step.
      const press = async (name: string): Promise<Press> => {
        const first = await attempt(name);
        if (first !== 'failed') return first;
        if (!(await bringForward())) return 'failed';
        return attempt(name);
      };

      // Paint must be able to come to the front before anything is put on the
      // user's clipboard: if Windows keeps another window there, stop now.
      if (!(await bringForward())) {
        throw new ToolError('VERIFICATION_FAILED', 'Paint opened, but Windows kept another window in front of it, so Axon did not draw. Click on Paint and ask again.');
      }

      const saved = await clipboard.save();
      let drawn = 0;
      let restored = false;
      let result: JsonObject;
      try {
        ctx.observe(`Drawing ${scene.label}`, { steps: frames.length });
        for (const frame of frames) {
          await clipboard.writePng(frame.png);
          if ((await press(PAINT_MENU.paste)) !== 'ok') break;
          drawn += 1;
          ctx.observe(`Drew ${frame.label}`, { step: drawn, of: frames.length });
          await wait(pauseMs);
        }
        if (drawn < frames.length) {
          throw new ToolError('VERIFICATION_FAILED', `${DRAW_UNVERIFIED} It stopped after ${drawn} of ${frames.length} steps.`);
        }

        // VERIFIED FROM PAINT, not from Axon's own record: Paint copies what it
        // has, and that picture is compared with the plan.
        await clipboard.clear();
        const copied = (await press(PAINT_MENU.copyVisible)) === 'ok';
        const image = copied ? await clipboard.readImage() : null;
        const match = image ? canvasMatch(scene, image) : { matched: 0, sampled: 0 };
        const stillThere = (await desktop.list().catch(() => [] as readonly DesktopWindow[])).find((window) => window.handle === handle);
        const owned = stillThere ? ownerOf(stillThere, listed)?.app.id === paint.id : false;
        if (!owned || match.sampled === 0 || match.matched / match.sampled < MATCH_THRESHOLD) {
          throw new ToolError('VERIFICATION_FAILED', DRAW_UNVERIFIED);
        }
        ctx.observe(`Paint shows ${scene.label}`, { steps: drawn, matched: match.matched, sampled: match.sampled });

        result = {
          drawing: scene.label,
          application: PAINT,
          steps: frames.map((frame) => frame.label),
          verified: {
            drawn: true,
            evidence: 'canvas',
            matched: `${match.matched} of ${match.sampled} sampled points`,
            foreground: stillThere?.foreground === true,
            // UNTRUSTED text: Paint named its own window.
            window: stillThere?.title ?? null,
            summary: `${scene.label.charAt(0).toUpperCase()}${scene.label.slice(1)} is drawn in Paint — Axon read Paint's canvas back and it matches.`,
          },
        };
      } finally {
        // The user's clipboard, as it was — or, if it cannot be put back, empty.
        // Never Axon's drawing. A failure here must not turn a finished drawing
        // into an error, but it is reported rather than swallowed.
        restored = await clipboard.restore(saved).catch(async () => {
          await clipboard.clear().catch(() => undefined);
          return false;
        });
      }
      return { ...result, clipboard: restored ? 'restored' : 'emptied: the earlier contents could not be put back' };
    },
  });
}

async function findWindow(
  desktop: DesktopWindows,
  wanted: (window: DesktopWindow) => boolean,
  timeoutMs: number,
  intervalMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<DesktopWindow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = await desktop.list().catch(() => [] as readonly DesktopWindow[]);
    const found = windows.find(wanted);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await wait(intervalMs);
  }
}

async function waitForMenu(
  ui: DesktopUi,
  handle: string,
  timeoutMs: number,
  intervalMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<{ readonly editRuntimeId?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reading = await ui.observeControls(handle).catch(() => null);
    const edit = reading?.controls.find((control) => control.nativeRole === PAINT_MENU.role && control.name === PAINT_MENU.edit);
    if (edit) return edit.runtimeId ? { editRuntimeId: edit.runtimeId } : {};
    if (Date.now() >= deadline) return null;
    await wait(intervalMs);
  }
}

// --- draw.generate --------------------------------------------------------------

export interface DrawGenerateToolOptions {
  readonly store: DrawingStore;
  /** Null: no image service is configured, and the tool says so. */
  readonly provider: ImageProvider | null;
}

const generateSchema = z
  .object({
    prompt: z.string().trim().min(3).max(500).describe('What the image should show, in the user\'s words.'),
    style: z.string().trim().max(40).optional(),
    width: z.number().int().min(256).max(2048).optional(),
    height: z.number().int().min(256).max(2048).optional(),
  })
  .strict();
type GenerateInput = z.infer<typeof generateSchema>;

export function createDrawGenerateTool(options: DrawGenerateToolOptions): RegisteredTool {
  const { store, provider } = options;

  return defineTool<GenerateInput, JsonObject>({
    name: 'draw.generate',
    title: 'Create an image from a description',
    description:
      'Create a picture of anything — "a cyberpunk city", "a cat astronaut" — with an image-generation service, ' +
      'saved in Axon\'s own folder. If no service is configured the result says so: tell the user plainly that ' +
      'image generation isn\'t configured yet, and never describe an image as made when it was not. For a house, ' +
      'a sunset, a cat or a tree in Paint, use draw.paint instead.',
    inputSchema: generateSchema,

    precheck(input): PrecheckVerdict {
      if (looksLikePath(input.prompt) || (input.style && looksLikePath(input.style))) {
        return { ok: false, retryable: false, kind: 'FORBIDDEN', reason: 'Describe the image in words. Axon never takes a path or a file for it.' };
      }
      if (!provider) return { ok: false, retryable: false, kind: 'UNSUPPORTED', reason: NOT_CONFIGURED };
      return { ok: true };
    },

    resolveRisk(input): RiskAssessment {
      if (looksLikePath(input.prompt)) return { level: 'FORBIDDEN', reason: 'Axon never takes a path for an image.' };
      if (!provider) return { level: 'SAFE', reason: NOT_CONFIGURED };
      // The description LEAVES this machine for the provider. That is the
      // same fact that makes a form submission ask.
      return { level: 'REQUIRES_APPROVAL', reason: `Creating an image sends its description to ${provider.name}.` };
    },

    summarize(input): ToolSummary {
      return {
        title: provider ? `Axon wants to create an image with ${provider.name}` : 'Axon wants to create an image',
        parameters: [
          { label: 'Description', value: input.prompt },
          { label: 'Saved in', value: 'Axon\'s drawings folder' },
        ],
      };
    },

    sideEffect: (): SideEffectClass => (provider ? 'EXTERNAL' : 'LOCAL'),

    async execute(input, ctx): Promise<JsonObject> {
      if (!provider) throw new ToolError('UNSUPPORTED', NOT_CONFIGURED);
      if (looksLikePath(input.prompt)) throw new ToolError('FORBIDDEN', 'Axon never takes a path for an image.');

      ctx.observe('Creating an image', { provider: provider.name });
      let bytes: Uint8Array;
      try {
        bytes = await provider.generate({
          prompt: input.prompt,
          style: input.style ?? null,
          width: input.width ?? 1024,
          height: input.height ?? 1024,
        });
      } catch {
        // The provider's own message is NOT passed on: it can quote a request,
        // a URL or a key back, and none of that belongs in a model's context.
        throw new ToolError('VERIFICATION_FAILED', 'No image was created: the image service did not return one.');
      }
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMAGE_BYTES || !isPng(bytes)) {
        throw new ToolError('VERIFICATION_FAILED', 'No image was created: what came back was not a picture Axon could save.');
      }
      const saved = await store.save('image', bytes);
      return {
        created: true,
        file: saved.fileName,
        location: 'Axon\'s drawings folder',
        verified: { created: true, summary: 'The image was created and saved in Axon\'s drawings folder.' },
      };
    },
  });
}
