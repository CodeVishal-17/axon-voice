/**
 * The agent brain.
 *
 * The interface fixes the most important boundary in the system: what a brain
 * is *allowed* to do.
 *
 * A brain receives a goal, a code-free view of the tool surface, a `dispatch`
 * callback and a narrow `emit` callback. It cannot execute anything itself —
 * `dispatch` is the dispatcher, which validates, classifies risk and gates on
 * approval before anything runs. Swapping Claude for another model, or for a
 * scripted brain in a test, changes nothing about the safety guarantees.
 *
 * Note what `emit` deliberately excludes. A brain may narrate its own work
 * (THINKING, PLANNING, ASSISTANT_MESSAGE, COMPLETED, ERROR) but it may not
 * emit TOOL_CALL, TOOL_RESULT, APPROVAL_REQUIRED, APPROVAL_RESOLVED or
 * STATE_CHANGED. Those describe what the machine actually did, and only the
 * dispatcher and the orchestrator are in a position to say so truthfully. A
 * brain that could emit them could show the user a tool call that never ran.
 */

import type { AxonEventInput } from '../events.js';
import type { JsonValue } from '../json.js';
import type { SessionContext } from '../persistence.js';
import type { ToolCall, ToolResult, ToolSchema } from '../tool-contract.js';

/**
 * The event types a brain may emit.
 *
 * Narrated progress only — never a claim about execution, approval or state.
 */
export type BrainEventInput = Extract<
  AxonEventInput,
  { type: 'THINKING' | 'PLANNING' | 'ASSISTANT_MESSAGE' | 'COMPLETED' | 'ERROR' }
>;

export interface BrainTurnInput {
  readonly sessionId: string;
  /** What the user asked, as text (from STT or typed). */
  readonly utterance: string;
  /** Code-free tool surface. The brain gets schemas, never executors. */
  readonly tools: readonly ToolSchema[];
  readonly signal: AbortSignal;
  /**
   * Bounded context from earlier work: a session summary and the memories the
   * user approved.
   *
   * Handed over as an ARGUMENT, already capped in the main process. This is
   * what lets Axon remember across restarts without the brain gaining database
   * access — it cannot query for more, cannot widen the limits, and cannot
   * reach a session other than this one. Absent when persistence is
   * unavailable or the user turned memory off.
   */
  readonly context?: SessionContext | null;
  /** Narrate progress into the one event stream the UI and the log share. */
  emit(event: BrainEventInput): void;
}

export interface BrainTurnResult {
  /** What Axon should say back, if anything. */
  readonly reply: string | null;
  /** Structured trace for logging; not rendered directly. */
  readonly detail: JsonValue | null;
}

export interface Brain {
  readonly name: string;
  /**
   * Run one turn to completion, calling `dispatch` as many times as needed.
   * Implementations must propagate `signal` so a turn can be interrupted
   * (barge-in during SPEAKING is exactly this).
   */
  run(input: BrainTurnInput, dispatch: (call: ToolCall) => Promise<ToolResult>): Promise<BrainTurnResult>;
}
