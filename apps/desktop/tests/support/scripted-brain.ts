/**
 * A deterministic brain, for testing everything that is not the model.
 *
 * WHY A SECOND BRAIN EXISTS.
 *
 * `ClaudeBrain` is tested against a scripted `ModelClient`, which proves the
 * loop handles what a model sends back. That is a different question from
 * "does the whole agent workflow hold together", and answering the second one
 * against a live model would make the test suite depend on a paid, non-
 * deterministic, network-bound service — which means it would be skipped, and
 * a skipped test of the flagship workflow is no test of the flagship workflow.
 *
 * So this implements the same `Brain` interface with a fixed plan. Everything
 * below it in the flagship tests is the shipping code.
 *
 * WHAT IT IS NOT.
 *
 * It is not evidence that Claude behaves this way. A test using this brain
 * proves that AXON does the right thing when a brain proposes these actions —
 * that the approval fires, that the binding holds, that a denial stops the
 * submission, that cancellation lands. Whether a real model proposes sensible
 * actions is a question only a real model can answer, and the report says so.
 *
 * NOTE WHAT IT STILL CANNOT DO, despite being written by us and living in the
 * test tree: it gets a code-free tool surface and a `dispatch` callback, so it
 * has exactly the authority `ClaudeBrain` has, which is none. A scripted brain
 * that asks to click "Delete repository" reaches the same policy.
 */

import type {
  Brain,
  BrainTurnInput,
  BrainTurnResult,
  JsonValue,
  ToolCall,
  ToolResult,
} from '@axon/core';

/** What the brain does at one step of its plan. */
export type Step =
  | { readonly kind: 'call'; readonly tool: string; readonly input: JsonValue }
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'plan'; readonly summary: string; readonly steps: readonly string[] }
  /**
   * Decide the next step from what has happened so far.
   *
   * This is what makes the scripted brain an agent rather than a macro: the
   * flagship test needs a brain that reads the page, finds the comment box by
   * its label, and submits into THAT reference — because a test that hardcodes
   * "e3" would pass even if references stopped meaning anything.
   */
  | { readonly kind: 'decide'; readonly next: (results: readonly ToolResult[]) => Step | null };

export interface ScriptedBrainOptions {
  readonly name?: string;
  readonly steps: readonly Step[];
  /** Mints call ids. Fixed sequence keeps failures readable. */
  readonly newCallId?: () => string;
}

export class ScriptedBrain implements Brain {
  readonly name: string;
  /** Every result this brain saw, in order. Asserted on by the tests. */
  readonly results: ToolResult[] = [];
  /** The context the main process handed it, for the memory assertions. */
  lastContext: BrainTurnInput['context'] = null;

  private readonly steps: readonly Step[];
  private readonly newCallId: () => string;
  private counter = 0;

  constructor(options: ScriptedBrainOptions) {
    this.name = options.name ?? 'scripted';
    this.steps = options.steps;
    this.newCallId =
      options.newCallId ??
      ((): string => {
        this.counter += 1;
        return `call-${this.counter}`;
      });
  }

  async run(input: BrainTurnInput, dispatch: (call: ToolCall) => Promise<ToolResult>): Promise<BrainTurnResult> {
    this.lastContext = input.context ?? null;
    input.emit({ type: 'THINKING', note: 'Working out what to do' });

    let reply = '';

    for (const step of this.steps) {
      // Checked before every step, not only between model calls: a cancelled
      // turn must stop proposing actions immediately, and the dispatcher's
      // refusal is a backstop rather than the mechanism.
      if (input.signal.aborted) break;

      let current: Step | null = step;
      while (current) {
        if (input.signal.aborted) break;

        if (current.kind === 'say') {
          reply = current.text;
          current = null;
          continue;
        }

        if (current.kind === 'plan') {
          input.emit({ type: 'PLANNING', summary: current.summary, steps: [...current.steps] });
          current = null;
          continue;
        }

        if (current.kind === 'decide') {
          current = current.next(this.results);
          continue;
        }

        const result = await dispatch({
          callId: this.newCallId(),
          tool: current.tool,
          input: current.input,
        });
        this.results.push(result);
        current = null;
      }
    }

    const text = reply.trim();
    if (text !== '') input.emit({ type: 'ASSISTANT_MESSAGE', text });
    return { reply: text === '' ? null : text, detail: { steps: this.results.length } };
  }
}

// ---------------------------------------------------------------------------
// Helpers the flagship plan is written in terms of.
// ---------------------------------------------------------------------------

/** The parsed output of a browser tool result, or null if it failed. */
export function outputOf(result: ToolResult | undefined): Record<string, JsonValue> | null {
  if (!result?.ok) return null;
  const output = result.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  return output as Record<string, JsonValue>;
}

/**
 * Find an element reference by label, and optionally by role, in a read.
 *
 * The role filter is not decoration. On a GitHub issue page the textbox is
 * labelled "Add a comment" and the button is labelled "Comment", so a
 * label-only search for "comment" finds the box — and clicking a box is a
 * plausible-looking no-op that would let a broken plan pass. Naming the role
 * is how a plan says which of the two it means, exactly as a person would.
 */
export function refFor(
  result: ToolResult | undefined,
  label: string,
  role?: string,
): string | null {
  const output = outputOf(result);
  const elements = output?.elements;
  if (!Array.isArray(elements)) return null;

  const wanted = label.toLowerCase();
  let fallback: string | null = null;

  for (const entry of elements) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const element = entry as Record<string, JsonValue>;
    if (typeof element.label !== 'string' || typeof element.ref !== 'string') continue;
    if (role !== undefined && element.role !== role) continue;

    const found = element.label.toLowerCase();
    // An exact label wins over a substring, so "Comment" does not resolve to
    // "Add a comment" merely because that element came first.
    if (found === wanted) return element.ref;
    if (fallback === null && found.includes(wanted)) fallback = element.ref;
  }

  return fallback;
}

/** The `verified` block a browser action result carries. */
export function verificationOf(result: ToolResult | undefined): Record<string, JsonValue> | null {
  const output = outputOf(result);
  const verified = output?.verified;
  if (verified === null || verified === undefined || typeof verified !== 'object' || Array.isArray(verified)) {
    return null;
  }
  return verified as Record<string, JsonValue>;
}

/** The untrusted page text from a read, unwrapped from its envelope. */
export function pageTextOf(result: ToolResult | undefined): string {
  const output = outputOf(result);
  return typeof output?.untrustedPageText === 'string' ? output.untrustedPageText : '';
}
