/**
 * The memory tools.
 *
 * Three narrow capabilities, and the shape matters as much as it did for the
 * browser: there is no `memory.query(sql)`, no `memory.execute`, and no way to
 * name a table, a column or a file. The model can save a fact, look for one,
 * and forget one — that is the entire vocabulary.
 *
 *   memory.save    a category, a name, a value
 *   memory.search  a query string
 *   memory.forget  a name
 *
 * THE BRAIN NEVER TOUCHES THE DATABASE. These executors receive a
 * `PersistenceService`, and they are reached only through the dispatcher, so
 * the path is:
 *
 *   brain -> tool-call JSON -> dispatcher -> policy -> approval -> executor
 *
 * `architecture.test.ts` fails the build if anything under `brain/` imports
 * the persistence layer, and `persistence-security.test.ts` asserts the same
 * property against the source.
 *
 * WRITING IS APPROVED; READING IS NOT. Saving something about the user is a
 * durable change to what Axon believes, so it asks. Searching what has already
 * been approved is not, so it does not — an assistant that interrupted to ask
 * permission to consult its own notes would be unusable, and would teach the
 * user to dismiss the dialog that matters.
 */

import { z } from 'zod';
import {
  PERSISTENCE_LIMITS,
  defineTool,
  type JsonObject,
  type RegisteredTool,
  type RiskAssessment,
  type ToolSummary,
} from '@axon/core';
import { MEMORY_CATEGORIES, evaluateMemory } from '../../persistence/memory-policy.js';
import type { PersistenceService } from '../../persistence/persistence-service.js';

const categorySchema = z
  .enum(MEMORY_CATEGORIES)
  .describe('What kind of thing this is. One of the fixed categories.');

// ---------------------------------------------------------------------------
// memory.save
// ---------------------------------------------------------------------------

export function createMemorySaveTool(persistence: PersistenceService): RegisteredTool {
  const inputSchema = z.object({
    category: categorySchema,
    key: z
      .string()
      .min(1)
      .max(PERSISTENCE_LIMITS.maxMemoryKeyCharacters)
      .describe('A short name for what is being remembered, e.g. "current project".'),
    value: z
      .string()
      .min(1)
      .max(PERSISTENCE_LIMITS.maxMemoryValueCharacters)
      .describe('The fact itself. Never a password, key, token or card number.'),
  });
  type Input = z.infer<typeof inputSchema>;

  return defineTool<Input, JsonObject>({
    name: 'memory.save',
    title: 'Remember something',
    description:
      'Save a short fact for future conversations — a project name, a preference, how the user likes ' +
      'something done. The user is asked before anything is saved. Credentials are refused outright. ' +
      'Use this only when the user asks you to remember something, or clearly wants you to.',
    inputSchema,

    /**
     * The policy runs here, in risk resolution, before the approval dialog.
     *
     * That ordering is deliberate: a memory containing something that looks
     * like a credential is refused OUTRIGHT rather than offered to the user as
     * a choice. Nobody should be asked "shall I write this API key to disk?" —
     * the right number of times to ask that is zero.
     */
    resolveRisk(input): RiskAssessment {
      const decision = evaluateMemory({ ...input, source: 'assistant' });

      if (!decision.ok) {
        if (decision.rejection === 'looks-like-a-secret') {
          return { level: 'FORBIDDEN', reason: decision.reason };
        }
        // Anything else is a malformed request rather than a dangerous one,
        // but a memory Axon could not evaluate is not one it may write.
        return { level: 'REQUIRES_APPROVAL', reason: `Risk could not be determined: ${decision.reason}` };
      }

      return {
        level: 'REQUIRES_APPROVAL',
        reason:
          decision.sensitivity === 'personal'
            ? 'This would be remembered permanently, and it looks personal.'
            : 'This would be remembered across conversations until you delete it.',
      };
    },

    /** The dialog shows exactly what would be written, in full. */
    summarize(input): ToolSummary {
      return {
        title: 'Axon wants to remember something',
        parameters: [
          { label: 'Category', value: input.category },
          { label: 'Name', value: input.key },
          { label: 'Remember', value: input.value },
        ],
      };
    },

    execute(input, ctx): Promise<JsonObject> {
      // Re-evaluated at execution time. The dispatcher already gated this
      // call, but a credential must be unreachable through *any* path into
      // this function, including a future caller that forgets.
      const decision = evaluateMemory({ ...input, source: 'assistant' });
      if (!decision.ok) throw new Error(decision.reason);

      const entry = persistence.saveMemory({
        category: decision.category,
        key: decision.key,
        value: decision.value,
        source: 'assistant',
        sensitivity: decision.sensitivity,
      });

      if (!entry) {
        throw new Error('Axon could not save that, because its database is unavailable.');
      }

      ctx.observe(`Remembered "${entry.key}"`, { category: entry.category });
      return Promise.resolve({ saved: true, category: entry.category, key: entry.key });
    },
  });
}

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

export function createMemorySearchTool(persistence: PersistenceService): RegisteredTool {
  const inputSchema = z.object({
    query: z
      .string()
      .max(200)
      .default('')
      .describe('Words to look for. Leave empty to list everything currently remembered.'),
  });
  type Input = z.infer<typeof inputSchema>;

  return defineTool<Input, JsonObject>({
    name: 'memory.search',
    title: 'Look up what you remember',
    description:
      'Search the facts the user has already approved you to remember. Returns at most ' +
      `${PERSISTENCE_LIMITS.maxMemorySearchResults} entries. Reading memory needs no approval.`,
    inputSchema,

    resolveRisk: (): RiskAssessment => ({
      level: 'SAFE',
      reason: 'Reading memories the user already approved produces no outward effect.',
    }),

    summarize: (input): ToolSummary => ({
      title: 'Axon wants to look up what it remembers',
      parameters: [{ label: 'Search', value: input.query || '(everything)' }],
    }),

    execute(input, ctx): Promise<JsonObject> {
      const results = persistence.searchMemories(input.query);
      ctx.observe(results.length === 0 ? 'Found nothing remembered about that' : `Recalled ${results.length} item(s)`, null);

      return Promise.resolve({
        // Three fields each. No ids, no timestamps, no sensitivity flag — the
        // model does not need them, and every field withheld is one it cannot
        // repeat back or write somewhere else.
        memories: results.map((memory) => ({ category: memory.category, key: memory.key, value: memory.value })),
        count: results.length,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// memory.forget
// ---------------------------------------------------------------------------

export function createMemoryForgetTool(persistence: PersistenceService): RegisteredTool {
  const inputSchema = z.object({
    category: categorySchema,
    key: z.string().min(1).max(PERSISTENCE_LIMITS.maxMemoryKeyCharacters).describe('The name of the memory to remove.'),
  });
  type Input = z.infer<typeof inputSchema>;

  return defineTool<Input, JsonObject>({
    name: 'memory.forget',
    title: 'Forget something',
    description: 'Remove one remembered fact. The user is asked first, because forgetting cannot be undone.',
    inputSchema,

    resolveRisk: (): RiskAssessment => ({
      // Asked about, not because deleting a note is dangerous, but because it
      // is irreversible and the user is the one who approved it existing.
      level: 'REQUIRES_APPROVAL',
      reason: 'Forgetting is permanent — the memory cannot be recovered afterwards.',
    }),

    summarize: (input): ToolSummary => ({
      title: 'Axon wants to forget something',
      parameters: [
        { label: 'Category', value: input.category },
        { label: 'Name', value: input.key },
      ],
    }),

    execute(input, ctx): Promise<JsonObject> {
      const match = persistence
        .listMemories()
        .find((memory) => memory.category === input.category && memory.key === input.key);

      if (!match) {
        // Not an error: "there was nothing to forget" is a true and useful
        // answer, and throwing would make the model retry.
        ctx.observe(`Nothing remembered under "${input.key}"`, null);
        return Promise.resolve({ forgotten: false, reason: 'No memory with that name.' });
      }

      const deleted = persistence.deleteMemory(match.id);
      if (deleted) ctx.observe(`Forgot "${match.key}"`, { category: match.category });

      return Promise.resolve({ forgotten: deleted, category: match.category, key: match.key });
    },
  });
}
