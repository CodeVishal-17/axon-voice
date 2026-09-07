/**
 * What the brain is allowed to know about tools.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * Modules under `src/main/brain/` may import `@axon/core` and nothing else
 * from the main process. In particular they may not import:
 *
 *   - `../tools/registry`   (holds live executors)
 *   - `../tools/executors/*`(the executors themselves)
 *   - `../safety/*`         (the gate is applied *to* the brain, not *by* it)
 *   - `node:child_process`, `node:fs`, `electron`
 *
 * `tests/architecture.test.ts` enforces this list. The brain receives its tool
 * surface and its `dispatch` callback as arguments, so the set of effects it
 * can cause is exactly the set the dispatcher permits.
 *
 * This file exists now, before the brain does, because the boundary has to be
 * in place and under test before there is anything on the far side of it that
 * might be tempted to cross.
 */

import type { ToolCall, ToolSchema } from '@axon/core';

/**
 * A tool as presented to a language model, in the Anthropic tool-use shape.
 *
 * Note what is absent: nothing here can be invoked. The model reads this and
 * can, at most, produce a `ToolCall`.
 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/**
 * Project the code-free tool surface into model-facing definitions.
 *
 * Takes the schemas as an argument rather than reaching for the registry —
 * that argument passing *is* the boundary.
 */
export function toModelToolDefinitions(tools: readonly ToolSchema[]): readonly ModelToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    // The model sees the human title alongside the description; it is often
    // the clearest signal of what a tool is for.
    description: `${tool.title}. ${tool.description}`,
    input_schema: tool.inputSchema,
  }));
}

/** Validate that a name the model produced corresponds to an offered tool. */
export function isOfferedTool(tools: readonly ToolSchema[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

/**
 * Shape a model's tool-use block into a `ToolCall`.
 *
 * Deliberately does not check whether the tool exists or whether the input is
 * valid — that is the dispatcher's job, and duplicating it here would create a
 * second, weaker copy of the rules.
 */
export function toToolCall(callId: string, name: string, input: ToolCall['input']): ToolCall {
  return { callId, tool: name, input };
}
