/**
 * `system.screenshot` — look at the screen.
 *
 * WHAT CHANGED IN PHASE 2, AND WHY.
 *
 * This tool used to capture a PNG, write it into a folder, and hand the model
 * a file path. In a live test the model then said, correctly, that it could
 * not open image files. That answer showed the shape was wrong: a path is not
 * an observation, it is a promise of one that the recipient may or may not be
 * able to redeem, and Axon had no idea which.
 *
 * So one call now produces two separable things:
 *
 *   A VISUAL OBSERVATION, always. Ephemeral, held in memory on a short clock,
 *   carrying the pixels AND Axon's own reading of the controls on screen. It
 *   is what reasoning and action bind to. It has no path and it expires.
 *
 *   A SAVED FILE, only when asked. `save: true` means somebody wanted a
 *   picture kept. The default is false, so looking at the screen no longer
 *   leaves a photograph of the user's screen in a folder they have forgotten
 *   about — which, for a tool an agent may call whenever it feels uncertain,
 *   was a privacy problem that grew quietly.
 *
 * THE PROVIDER LIMITATION, STATED PLAINLY RATHER THAN WORKED AROUND.
 *
 * Axon's voice provider speaks a text protocol. A tool result is a JSON
 * string; there is no channel on it that carries an image. So the model does
 * not receive the pixels, and this tool does not pretend it does. What it
 * receives is the structured reading — dimensions, the foreground window, and
 * the controls Axon enumerated through the operating system's accessibility
 * layer — and the note in the result says exactly that. Inventing an image
 * channel the provider does not have would be the dishonest fix; describing
 * what Axon can actually see is the real one.
 *
 * LOOKING IS A SET OF PROVIDERS, not two inline port calls. See
 * `observation-providers.ts`: each modality knows whether Axon can produce it
 * AND whether anything can receive it, which are different questions and are
 * the two that get conflated when a system starts claiming to see. The result
 * reports both, per modality, including the one Axon does not have.
 *
 * SAFE. It reads what is already on screen. It is still fully logged, and the
 * event stream carries the dimensions and the control count — never the
 * pixels, which would bloat the JSONL past usefulness and cross IPC on every
 * render.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  defineTool,
  type JsonObject,
  type RegisteredTool,
  type RiskAssessment,
  type SideEffectClass,
  type ToolSummary,
} from '@axon/core';
import type { ScreenCapturer } from '../../platform/ports.js';
import type { DesktopUi } from '../../platform/windows-desktop.js';
import { toObservationOutput } from '../../screen/visual-observation.js';
import type { VisualObservationStore } from '../../screen/visual-observation.js';
import {
  createAccessibilityProvider,
  createScreenshotProvider,
  describeModalities,
} from '../../screen/observation-providers.js';

const inputSchema = z.object({
  /** Optional slug folded into the filename to make saved captures findable. */
  label: z
    .string()
    .max(60)
    .regex(/^[a-zA-Z0-9 _-]*$/, 'Label may contain only letters, digits, spaces, hyphens and underscores.')
    .default(''),
  /**
   * Keep the picture as a file.
   *
   * Defaults to false, and that default is the privacy decision. Set it only
   * when the user asked for a screenshot they can open later; looking at the
   * screen in order to answer a question is not that.
   */
  save: z
    .boolean()
    .default(false)
    .describe('Save the capture as a PNG file. Only do this when the user asked for a file they can keep.'),
});

type Input = z.infer<typeof inputSchema>;

export interface ScreenshotToolOptions {
  readonly capturer: ScreenCapturer;
  readonly screenshotDir: string;
  readonly store: VisualObservationStore;
  /** Absent where the accessibility layer is unavailable; the reading is empty. */
  readonly ui?: DesktopUi | null;
  readonly now?: () => Date;
  /** How long a capture may take before it is abandoned. Tests shorten it. */
  readonly captureTimeoutMs?: number;
}

/**
 * What Axon can and cannot observe, computed once.
 *
 * Reported in every result so the answer to "can you see my screen?" comes
 * from the system rather than from the model's impression of itself.
 */
function modalityReport(pixels: ReturnType<typeof createScreenshotProvider>, accessibility: ReturnType<typeof createAccessibilityProvider>): JsonObject {
  return {
    canObserve: describeModalities([accessibility, pixels]).map((status) => ({
      modality: status.modality,
      captured: status.captured,
      youCanReceiveThis: status.deliverableToModel,
      reason: status.reason,
    })),
  };
}

/**
 * How many SAVED captures the folder keeps.
 *
 * A screenshot is a picture of whatever the user had on screen — their mail,
 * their bank, a colleague's message. Keeping every one forever, in a folder
 * nobody remembers, is a privacy problem that grows quietly. Saving is now
 * deliberate, and the folder is still pruned on top of that.
 */
const MAX_RETAINED = 12;

/**
 * Delete all but the most recent captures.
 *
 * Best-effort by design: a screenshot that cannot be deleted (open in a viewer,
 * locked by the OS) must not fail the capture the user actually asked for.
 * Only files this tool's own naming produces are ever considered, so a folder
 * someone repurposed is not quietly emptied.
 */
async function prune(directory: string, keep: number): Promise<void> {
  try {
    const entries = await fs.readdir(directory);
    const ours = entries.filter((name) => /^screen-.*\.png$/.test(name)).sort();
    for (const stale of ours.slice(0, Math.max(0, ours.length - keep))) {
      await fs.rm(path.join(directory, stale), { force: true });
    }
  } catch {
    // The folder may not exist yet, or may be busy. Neither is a reason to
    // fail a capture.
  }
}

/** Filesystem-safe timestamp: 2026-09-01T14-32-05-123Z. */
function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Long enough for a real capture (measured at 2-3s), well inside the voice provider's tool timeout. */
const CAPTURE_TIMEOUT_MS = 10_000;

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createScreenshotTool({
  capturer,
  screenshotDir,
  store,
  ui = null,
  now = (): Date => new Date(),
  captureTimeoutMs = CAPTURE_TIMEOUT_MS,
}: ScreenshotToolOptions): RegisteredTool {
  // Two ways of looking, each of which knows what it can produce and what
  // anything can receive. There is no third, and the absent one is named in
  // the report rather than omitted from it.
  const pixels = createScreenshotProvider(capturer);
  const accessibility = createAccessibilityProvider(ui);

  return defineTool<Input, JsonObject>({
    name: 'system.screenshot',
    title: 'Look at the screen',
    description:
      'Capture the screen and read the controls on the window in front. Returns the size of the screen, ' +
      'which window is in front, and a numbered list of the buttons, links and fields Axon can act on, ' +
      'each with a reference you can use with ui.click or keyboard.type. A result means the capture worked. ' +
      'Axon cannot send you the picture itself, so the list is what it can tell you about what is on screen. ' +
      'References expire quickly, so look again before acting if time has passed. ' +
      'Pass save: true when the user wants a picture kept as a file they can open later.',
    inputSchema,

    resolveRisk: (): RiskAssessment => ({
      level: 'SAFE',
      reason: 'Reads what is already visible on screen and produces no outward effect.',
    }),

    summarize(input): ToolSummary {
      return {
        title: 'Axon wants to look at the screen',
        parameters: [
          ...(input.save ? [{ label: 'Saved to', value: screenshotDir }] : []),
          ...(input.label ? [{ label: 'Label', value: input.label }] : []),
        ],
      };
    },

    // Looking sends nothing anywhere. Saving writes into Axon's own folder.
    sideEffect: (input): SideEffectClass => (input.save ? 'LOCAL' : 'NONE'),

    /**
     * Two looks are "the same look" only if the screen has not changed.
     *
     * `system.screenshot` takes almost no arguments, so the ordinary repeat
     * bound treats every capture as identical and refuses the fourth — which
     * would break the one recovery path this whole design depends on, since
     * re-observing is exactly how the agent recovers from an expired target.
     * Keying on what was last OBSERVED does what the bound is actually for:
     * it stops a model looking at an unchanged screen over and over, and
     * leaves a look after a real change free.
     */
    repeatKey: (input): string => {
      const latest = store.latest();
      if (!latest) return `screen:none:${input.save}`;
      const identity = latest.targets.map((target) => `${target.role}|${target.name}`).join('');
      return `screen:${latest.foregroundWindow}:${identity.length}:${identity.slice(0, 200)}:${input.save}`;
    },

    async execute(input, ctx): Promise<JsonObject> {
      // BOUNDED. The operating system's screen capture has no deadline of its
      // own, and a capture that never returns would leave the step running
      // forever: the agent is told "in progress" and then never told anything
      // else. Every other slow tool already has a deadline; this was the one
      // that did not.
      const captured = await withDeadline(pixels.capture(), captureTimeoutMs, 'The screen could not be captured in time.');

      // AXON'S OWN READING of what is on screen. Failure here is not a failure
      // of the capture: the observation is still minted, with a note saying
      // why it has no controls, and the model can still report the size of the
      // screen and which window is in front.
      const reading = await accessibility.read(null);

      const observation = store.record(captured, reading);

      let savedFile: string | null = null;
      if (input.save) {
        const suffix = input.label ? `-${input.label.trim().replace(/\s+/g, '-')}` : '';
        const fileName = `screen-${timestampSlug(now())}${suffix}.png`;

        await fs.mkdir(screenshotDir, { recursive: true });
        await fs.writeFile(path.join(screenshotDir, fileName), captured.png);
        // After writing, so a failure to prune can never lose the capture that
        // was just requested. The timestamped names sort chronologically,
        // which is what makes "the most recent N" a lexical operation.
        await prune(screenshotDir, MAX_RETAINED);
        savedFile = fileName;
      }

      // The FULL PATH goes to the user, in the timeline, because it is their
      // file and they need to find it. The model gets the file NAME only —
      // see `toObservationOutput`, which carries no path at all. A model that
      // never receives a filesystem path cannot name one.
      ctx.observe(
        `Looked at the screen: ${captured.width}x${captured.height}, ` +
          `${observation.targets.length} control${observation.targets.length === 1 ? '' : 's'} on "${observation.foregroundWindow}"` +
          (savedFile ? ` — saved to ${path.join(screenshotDir, savedFile)}` : ''),
        {
          observation: observation.id,
          targets: observation.targets.length,
          saved: savedFile ? path.join(screenshotDir, savedFile) : null,
        },
      );

      return {
        ...toObservationOutput(observation),
        ...modalityReport(pixels, accessibility),
        saved: savedFile
          ? { file: savedFile, folder: 'the Axon screenshots folder' }
          : null,
      };
    },
  });
}
