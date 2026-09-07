/**
 * `fs.write` — write a text file, with risk resolved from the destination.
 *
 * This is the tool that makes dynamic risk resolution concrete. The same tool,
 * the same schema, three different outcomes depending only on where the file
 * would land:
 *
 *   <home>/Axon/workspace/notes.txt   -> SAFE, runs immediately
 *   <home>/Desktop/notes.txt          -> REQUIRES_APPROVAL, waits for a human
 *   C:\Windows\System32\notes.txt     -> FORBIDDEN, refused outright
 *
 * A static `risk: 'REQUIRES_APPROVAL'` on the tool would make the first case
 * nag; a static `'SAFE'` would make the third case a catastrophe. Neither
 * label is true of the tool, because riskiness is not a property of the tool.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  defineTool,
  unknownRisk,
  type RegisteredTool,
  type RiskAssessment,
  type ToolSummary,
} from '@axon/core';
import { classifyPath, type PathPolicy } from './paths.js';

const MAX_BYTES = 1_000_000;

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Destination file. Relative paths resolve inside the Axon workspace.'),
  content: z.string().max(MAX_BYTES).describe('UTF-8 text to write.'),
  /** Guard against clobbering. Overwriting is a distinct, opt-in intent. */
  overwrite: z.boolean().default(false).describe('Allow replacing an existing file.'),
});

type Input = z.infer<typeof inputSchema>;

export interface FsWriteOutput {
  readonly path: string;
  readonly bytesWritten: number;
  readonly overwritten: boolean;
  [key: string]: string | number | boolean;
}

export function createFsWriteTool(policy: PathPolicy): RegisteredTool {
  return defineTool<Input, FsWriteOutput>({
    name: 'fs.write',
    title: 'Write a file',
    description:
      'Write UTF-8 text to a file. Writes inside the Axon workspace run immediately; ' +
      'writes anywhere else require the user to approve them; writes into protected ' +
      'system locations are refused.',
    inputSchema,

    resolveRisk(input): RiskAssessment {
      const verdict = classifyPath(input.path, policy);

      switch (verdict.class) {
        case 'INSIDE_WORKSPACE':
          return { level: 'SAFE', reason: verdict.reason };

        case 'FORBIDDEN':
          return { level: 'FORBIDDEN', reason: verdict.reason };

        case 'OUTSIDE_WORKSPACE':
          return { level: 'REQUIRES_APPROVAL', reason: verdict.reason };

        case 'INVALID':
          // Cannot be classified, so cannot be called safe. Escalate rather
          // than guess — this is deny-by-default doing its job.
          return unknownRisk(verdict.reason);

        default: {
          const exhaustive: never = verdict.class;
          return unknownRisk(`Unhandled path classification: ${String(exhaustive)}`);
        }
      }
    },

    summarize(input): ToolSummary {
      const verdict = classifyPath(input.path, policy);
      const bytes = Buffer.byteLength(input.content, 'utf8');
      return {
        title: 'Axon wants to write a file',
        parameters: [
          { label: 'Path', value: verdict.resolved ?? input.path },
          { label: 'Size', value: `${bytes} bytes` },
          { label: 'Overwrite existing', value: input.overwrite ? 'yes' : 'no' },
        ],
      };
    },

    async execute(input, ctx): Promise<FsWriteOutput> {
      // Re-classify at execution time. The dispatcher already gated this call,
      // but a FORBIDDEN destination must be impossible to reach through *any*
      // path into this function — including a future caller that forgets.
      const verdict = classifyPath(input.path, policy);
      if (verdict.class === 'FORBIDDEN' || verdict.class === 'INVALID' || !verdict.resolved) {
        throw new Error(`Refusing to write: ${verdict.reason}`);
      }

      const target = verdict.resolved;
      const existed = await fileExists(target);
      if (existed && !input.overwrite) {
        throw new Error(`${target} already exists and overwrite was not requested.`);
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, 'utf8');

      const bytesWritten = Buffer.byteLength(input.content, 'utf8');
      ctx.observe(`Wrote ${bytesWritten} bytes to ${target}`, { path: target });

      return { path: target, bytesWritten, overwritten: existed };
    },
  });
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
