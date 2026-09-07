/**
 * `app.open` — launch one of a fixed set of desktop applications.
 *
 * The security design is the allowlist, and specifically its *shape*. The
 * input is not a program name that we then validate; it is an enum whose
 * members index a constant table. A caller cannot express "run this arbitrary
 * thing" at all — a value outside the enum fails schema validation in the
 * dispatcher and never reaches this file.
 *
 * The risk level comes from the registry rather than from this file, because
 * launching an application is not uniformly harmless: a text editor and Task
 * Manager are both "an application", and only one of them can end a running
 * program. `app-registry.ts` holds that judgement so every tool that can reach
 * an application reads the same answer.
 */

import { z } from 'zod';
import { defineTool, type RegisteredTool, type RiskAssessment, type ToolSummary } from '@axon/core';
import type { AppLauncher } from '../../platform/ports.js';
import { APP_KEYS, listApps, resolveApp } from './app-registry.js';

const inputSchema = z.object({
  app: z.enum(APP_KEYS).describe('Which permitted application to open.'),
});

type Input = z.infer<typeof inputSchema>;

export interface AppOpenOutput {
  readonly app: string;
  readonly label: string;
  readonly method: 'exe' | 'uri';
  readonly pid: number | null;
  [key: string]: string | number | null;
}

export function createAppOpenTool(launcher: AppLauncher): RegisteredTool {
  return defineTool<Input, AppOpenOutput>({
    name: 'app.open',
    title: 'Open an application',
    description:
      'Open one of a fixed set of permitted desktop applications. ' +
      `Permitted values: ${listApps().map((entry) => `${entry.key} (${entry.label})`).join(', ')}. ` +
      'This is the complete list; there is no way to name any other program, path or command.',
    inputSchema,

    resolveRisk(input): RiskAssessment {
      const entry = resolveApp(input.app);
      // Unreachable through the dispatcher (the enum guarantees membership),
      // but the tool must not assume its only caller is the one we wrote.
      if (!entry) {
        return { level: 'FORBIDDEN', reason: `"${String(input.app)}" is not a permitted application.` };
      }
      // The level comes from the REGISTRY, not from this tool. Not every
      // application is a Notepad: Settings and Task Manager can change or end
      // things, and the table is where that judgement lives so one edit
      // governs every tool that can launch or focus them.
      return { level: entry.risk, reason: entry.reason };
    },

    summarize(input): ToolSummary {
      const entry = resolveApp(input.app);
      return {
        title: `Axon wants to open ${entry?.label ?? input.app}`,
        parameters: [{ label: 'Application', value: entry?.label ?? input.app }],
      };
    },

    async execute(input, ctx): Promise<AppOpenOutput> {
      const entry = resolveApp(input.app);
      if (!entry) {
        throw new Error(`"${String(input.app)}" is not a permitted application.`);
      }

      ctx.observe(`Opening ${entry.label}`);

      if (entry.target.kind === 'uri') {
        await launcher.openUri(entry.target.uri);
        return { app: input.app, label: entry.label, method: 'uri', pid: null };
      }

      const launched = await launcher.launchExecutable(entry.target.file);
      return {
        app: input.app,
        label: entry.label,
        method: 'exe',
        pid: launched.pid,
      };
    },
  });
}
