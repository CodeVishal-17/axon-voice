/**
 * The agent loop.
 *
 * ARCHITECTURAL BOUNDARY — read `tool-surface.ts` before editing.
 *
 * This file holds Axon's reasoning loop and none of its authority. It receives
 * a code-free tool surface and a `dispatch` callback; it cannot execute a tool,
 * cannot resolve risk, cannot raise or settle an approval, and cannot emit a
 * TOOL_CALL or TOOL_RESULT event. Every effect it causes is one the dispatcher
 * chose to permit.
 *
 * The loop, once per iteration:
 *
 *     ask the model  ->  it either replies, or asks for tools
 *                        |
 *                        for each requested tool:
 *                          suppress it if it repeats a refused call
 *                          otherwise dispatch it (validate, gate, execute)
 *                          convert the ToolResult into a readable result
 *                        feed every result back in ONE user message
 *
 * until the model stops asking for tools, or a bound is hit.
 *
 * Three details are load-bearing:
 *
 * 1. Assistant content is appended verbatim (`response.content`), not
 *    reconstructed from its text. Thinking blocks must be echoed back
 *    unchanged within a turn, and rebuilding the message would drop them.
 * 2. All tool results for one assistant turn go back in a *single* user
 *    message. Splitting them teaches the model to stop making parallel calls.
 * 3. A refused call is remembered and suppressed if repeated identically.
 *    The system prompt asks for this; this code guarantees it. Suppression
 *    only ever prevents a dispatch, so it cannot weaken the safety layer.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  Brain,
  BrainTurnInput,
  BrainTurnResult,
  JsonValue,
  Memory,
  MemoryRecord,
  ToolCall,
  ToolResult,
  ToolSchema,
} from '@axon/core';
import { AGENT_LOOP_LIMITS, stableStringify } from '@axon/core';
import type { ModelClient } from './model-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { serializeToolResult, toModelToolResult } from './tool-result-view.js';
import { toModelToolDefinitions } from './tool-surface.js';

/**
 * Bounds on one turn, as this loop applies them.
 *
 * A model that loops forever is not a hypothetical: a tool that keeps failing
 * in a way the model reads as retryable will produce exactly that. These caps
 * turn an infinite loop into a finished turn with an honest explanation.
 *
 * THESE ARE COURTESY, NOT CONTAINMENT. Stopping here produces a better answer
 * — the model gets to say what it managed to do — but a brain that ignored
 * them would still be bounded, because `TurnBudget` spends the same limits at
 * the dispatch boundary, which is the one place every effect must cross. The
 * numbers are shared from `@axon/core` so the polite stop and the hard stop
 * cannot drift apart.
 */
const MAX_ITERATIONS = AGENT_LOOP_LIMITS.maxIterations;
const MAX_TOOL_CALLS = AGENT_LOOP_LIMITS.maxToolCalls;
/** How many past turns to replay as context. */
const HISTORY_TURNS = 12;

export interface ClaudeBrainOptions {
  readonly client: ModelClient;
  readonly memory: Memory;
  readonly workspaceRoot: string;
  readonly platform: string;
  /** Mints call ids. Injected so tests are deterministic. */
  readonly newCallId: () => string;
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
}

/**
 * A refused call, keyed so an identical repeat can be recognised.
 *
 * Uses the SAME normalization as the turn budget and the approval binding, so
 * the three cannot disagree about whether two calls are the same call.
 */
function signature(tool: string, input: unknown): string {
  return `${tool}:${stableStringify(input)}`;
}

/** The visible text of an assistant message. Thinking blocks are not text. */
function visibleText(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function toolUseBlocks(content: readonly Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
}

/** Replay stored turns as plain user/assistant text. */
function historyToMessages(records: readonly MemoryRecord[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const record of records) {
    if (record.kind === 'utterance') messages.push({ role: 'user', content: record.text });
    else if (record.kind === 'reply' && record.text.trim() !== '') {
      messages.push({ role: 'assistant', content: record.text });
    }
  }
  // The API requires the first message to be a user turn. A history that
  // starts with a reply (possible after trimming) would be rejected.
  while (messages.length > 0 && messages[0]?.role !== 'user') messages.shift();
  return messages;
}

export class ClaudeBrain implements Brain {
  readonly name: string;

  private readonly client: ModelClient;
  private readonly memory: Memory;
  private readonly workspaceRoot: string;
  private readonly platform: string;
  private readonly newCallId: () => string;
  private readonly maxIterations: number;
  private readonly maxToolCalls: number;

  constructor(options: ClaudeBrainOptions) {
    this.client = options.client;
    this.memory = options.memory;
    this.workspaceRoot = options.workspaceRoot;
    this.platform = options.platform;
    this.newCallId = options.newCallId;
    this.maxIterations = options.maxIterations ?? MAX_ITERATIONS;
    this.maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS;
    this.name = `claude(${options.client.model})`;
  }

  async run(input: BrainTurnInput, dispatch: (call: ToolCall) => Promise<ToolResult>): Promise<BrainTurnResult> {
    const system = buildSystemPrompt({
      tools: input.tools,
      workspaceRoot: this.workspaceRoot,
      platform: this.platform,
      // Bounded by the main process before it arrives. The loop neither widens
      // it nor asks for more.
      context: input.context ?? null,
    });
    const tools = toAnthropicTools(input.tools);

    const history = await this.memory.recent({ sessionId: input.sessionId, limit: HISTORY_TURNS * 2 });
    const messages: Anthropic.MessageParam[] = [
      ...historyToMessages(history),
      { role: 'user', content: input.utterance },
    ];

    await this.memory.append({
      sessionId: input.sessionId,
      at: new Date().toISOString(),
      kind: 'utterance',
      text: input.utterance,
      detail: null,
    });

    input.emit({ type: 'THINKING', note: 'Working out what to do' });

    const refused = new Set<string>();
    let toolCallCount = 0;
    let lastText = '';

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (input.signal.aborted) return this.finish(input, lastText, { reason: 'aborted', iteration });

      const response = await this.client.createTurn({ system, messages, tools, signal: input.signal });

      const text = visibleText(response.content);
      const calls = toolUseBlocks(response.content);

      // Text alongside tool calls is the model narrating what it is about to
      // do. That is visible output, not hidden reasoning, so it is safe and
      // useful to surface as the plan.
      if (text !== '') {
        if (calls.length > 0) {
          input.emit({ type: 'PLANNING', summary: text, steps: calls.map((call) => call.name) });
        } else {
          lastText = text;
        }
      }

      if (calls.length === 0) {
        // `max_tokens` means the reply was cut off mid-sentence; say so rather
        // than presenting a truncated answer as complete.
        if (response.stop_reason === 'max_tokens' && lastText !== '') {
          lastText = `${lastText}\n\n(My reply was cut short.)`;
        }
        if (response.stop_reason === 'refusal') {
          lastText = lastText || 'I am not able to help with that.';
        }
        return this.finish(input, lastText, { stopReason: response.stop_reason, iterations: iteration + 1 });
      }

      // Verbatim: thinking and tool_use blocks must survive the round trip.
      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (toolCallCount >= this.maxToolCalls) {
          results.push(errorResult(call.id, 'Too many tool calls in one turn. Stop and report what you have done.'));
          continue;
        }
        toolCallCount += 1;
        results.push(await this.runOne(call, input, dispatch, refused));
      }

      // One user message carrying every result. See the file header.
      messages.push({ role: 'user', content: results });
    }

    const note = 'I stopped after too many steps without finishing.';
    return this.finish(input, lastText || note, { reason: 'iteration-limit' });
  }

  /**
   * Dispatch one tool call, or suppress it if it repeats a refused one.
   *
   * The suppressed branch never reaches the dispatcher, so a model stuck in a
   * loop cannot re-raise an approval the user already declined.
   */
  private async runOne(
    call: Anthropic.ToolUseBlock,
    input: BrainTurnInput,
    dispatch: (call: ToolCall) => Promise<ToolResult>,
    refused: Set<string>,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const key = signature(call.name, call.input);

    if (refused.has(key)) {
      return errorResult(
        call.id,
        JSON.stringify({
          success: false,
          error: 'You already made this exact request in this turn and it was refused. Do not repeat it. Either try a materially different approach or tell the user what you could not do.',
          errorKind: 'DENIED',
          retryable: false,
        }),
      );
    }

    // `call.input` is `unknown` from the SDK's perspective and arbitrary in
    // practice. It is passed through as-is: the dispatcher validates it
    // against the tool's Zod schema, and a second, weaker copy of that check
    // here would be a liability rather than a safeguard.
    const result = await dispatch({
      callId: this.newCallId(),
      tool: call.name,
      input: (call.input ?? {}) as JsonValue,
    });

    if (!result.ok && !toModelToolResult(result).retryable) {
      refused.add(key);
    }

    return {
      type: 'tool_result',
      tool_use_id: call.id,
      content: serializeToolResult(result),
      is_error: !result.ok,
    };
  }

  /** Record the reply, announce it, and hand it back to the orchestrator. */
  private async finish(input: BrainTurnInput, reply: string, detail: JsonValue): Promise<BrainTurnResult> {
    const text = reply.trim();

    if (text !== '') {
      input.emit({ type: 'ASSISTANT_MESSAGE', text });
      await this.memory.append({
        sessionId: input.sessionId,
        at: new Date().toISOString(),
        kind: 'reply',
        text,
        detail: null,
      });
    }

    return { reply: text === '' ? null : text, detail };
  }
}

function errorResult(toolUseId: string, content: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: true };
}

export { describeModelError } from './brain-errors.js';

/**
 * Project the code-free tool surface into the SDK's tool shape.
 *
 * Goes through `toModelToolDefinitions` so there is one description of what a
 * model is told about a tool, then adapts the result to the SDK's type. The
 * cast on `input_schema` is the one unavoidable widening: `ToolSchema`
 * carries a JSON Schema as a plain object, and the SDK types it as an object
 * with a literal `type: 'object'` that a `JsonObject` cannot prove.
 */
export function toAnthropicTools(tools: readonly ToolSchema[]): Anthropic.Tool[] {
  return toModelToolDefinitions(tools).map((definition) => ({
    name: definition.name,
    description: definition.description,
    input_schema: definition.input_schema as Anthropic.Tool.InputSchema,
  }));
}
