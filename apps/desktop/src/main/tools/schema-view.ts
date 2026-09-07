/**
 * The code-free projection of the tool surface.
 *
 * A `RegisteredTool` carries an `execute` function. A `ToolSchema` carries a
 * name, a description and a JSON Schema — data only. This module is the
 * one-way door between them, and it is what the brain will be given in Step 2.
 *
 * Handing the model a list of callables and trusting it not to call them would
 * make the dispatcher advisory. Handing it JSON makes calling impossible: the
 * only thing it can produce is a `ToolCall`, which is an intention, not an
 * effect.
 */

import { z } from 'zod';
import type { JsonObject, RegisteredTool, ToolSchema } from '@axon/core';

/**
 * Convert one tool to its schema view.
 *
 * `io: 'input'` matters: it renders fields that have defaults as optional,
 * which is what a caller deciding *what to send* needs to see. The output view
 * would mark them required, because after parsing they always exist.
 */
export function toToolSchema(tool: RegisteredTool): ToolSchema {
  const jsonSchema = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    // Tool schemas are consumed by a model, not resolved by a $ref-aware
    // validator, so inline everything rather than emitting $defs.
    target: 'draft-2020-12',
  }) as JsonObject;

  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: jsonSchema,
  };
}

export function toToolSchemas(tools: readonly RegisteredTool[]): readonly ToolSchema[] {
  return tools.map(toToolSchema);
}
