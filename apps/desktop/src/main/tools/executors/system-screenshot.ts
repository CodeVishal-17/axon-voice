/**
 * `system.screenshot` — capture the primary display.
 *
 * SAFE, because it only reads what is already on screen and produces no
 * outward effect. It is still fully logged: a TOOL_CALL, an OBSERVATION naming
 * the file, and a TOOL_RESULT carrying the path. "Safe" means "runs without
 * asking", never "runs without a record".
 *
 * The image lands on disk rather than in the event, deliberately. A few
 * megabytes of base64 in an event would bloat the JSONL log past usefulness
 * and would have to cross the IPC boundary on every render.
 *
 * RETENTION. A screenshot is a picture of whatever the user had on screen —
 * their mail, their bank, a colleague's message. Keeping every one of them
 * forever, in a folder nobody remembers, is a privacy problem that grows
 * quietly. So the folder is pruned to the most recent few on every capture:
 * enough for a model to look back at what it just did, not an archive of
 * someone's week. Nothing here uploads a screenshot anywhere, and the event
 * stream carries the path and the dimensions, never the pixels.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, type RegisteredTool, type RiskAssessment, type ToolSummary } from '@axon/core';
import type { ScreenCapturer } from '../../platform/ports.js';

const inputSchema = z.object({
  /** Optional slug folded into the filename to make captures findable later. */
  label: z
    .string()
    .max(60)
    .regex(/^[a-zA-Z0-9 _-]*$/, 'Label may contain only letters, digits, spaces, hyphens and underscores.')
    .default(''),
});

type Input = z.infer<typeof inputSchema>;

export interface ScreenshotOutput {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly display: string;
  [key: string]: string | number;
}

export interface ScreenshotToolOptions {
  readonly capturer: ScreenCapturer;
  readonly screenshotDir: string;
  readonly now?: () => Date;
}

/**
 * How many captures the folder keeps.
 *
 * Enough to cover a multi-step task that looks at the screen more than once.
 * Small enough that the folder is never a record of a day's work.
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

export function createScreenshotTool({
  capturer,
  screenshotDir,
  now = (): Date => new Date(),
}: ScreenshotToolOptions): RegisteredTool {
  return defineTool<Input, ScreenshotOutput>({
    name: 'system.screenshot',
    title: 'Take a screenshot',
    description:
      'Capture the primary display and save it as a PNG in the Axon screenshots folder. ' +
      'Returns the file path and dimensions.',
    inputSchema,

    resolveRisk(): RiskAssessment {
      return {
        level: 'SAFE',
        reason: 'Reads what is already visible on screen and writes only into the Axon screenshots folder.',
      };
    },

    summarize(input): ToolSummary {
      return {
        title: 'Axon wants to take a screenshot',
        parameters: [{ label: 'Saved to', value: screenshotDir }, ...(input.label ? [{ label: 'Label', value: input.label }] : [])],
      };
    },

    async execute(input, ctx): Promise<ScreenshotOutput> {
      const captured = await capturer.capturePrimaryDisplay();

      const suffix = input.label ? `-${input.label.trim().replace(/\s+/g, '-')}` : '';
      const filePath = path.join(screenshotDir, `screen-${timestampSlug(now())}${suffix}.png`);

      await fs.mkdir(screenshotDir, { recursive: true });
      await fs.writeFile(filePath, captured.png);

      // After writing, so a failure to prune can never lose the capture that
      // was just requested. The timestamped names sort chronologically, which
      // is what makes "the most recent N" a lexical operation.
      await prune(screenshotDir, MAX_RETAINED);

      ctx.observe(`Captured ${captured.width}x${captured.height} screenshot`, { path: filePath });

      return {
        path: filePath,
        width: captured.width,
        height: captured.height,
        bytes: captured.png.byteLength,
        display: captured.displayLabel,
      };
    },
  });
}
