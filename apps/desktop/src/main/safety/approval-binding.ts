/**
 * Binding an approval to the act it describes.
 *
 * THE PROBLEM THIS SOLVES.
 *
 * "The user approved call 7f3a" and "the thing about to run is what the user
 * was shown" are different claims, and only the second one matters. They come
 * apart wherever something can change between the dialog and the executor: a
 * renderer holding a dialog from a moment ago, a refactor that re-reads
 * arguments after the await, a future retry path that reuses a call id.
 *
 * So an approval carries a fingerprint of (tool, normalized arguments). It is
 * computed when the request is raised, travels on the request, and is
 * recomputed from the arguments actually about to execute. Equal means the
 * user authorised this. Unequal means they authorised something else, and the
 * call is refused — not re-asked, not adapted, refused.
 *
 * WHAT AN APPROVAL DELIBERATELY IS NOT.
 *
 * It is not a permission for the tool, the site, or the category of action.
 * There is no "always allow GitHub" here and Step 7 does not add one. Scoped
 * standing permissions are a real feature with a real design problem
 * (revocation, drift, what counts as "the same site"), and inventing one as a
 * side effect of shipping a demo is how approval fatigue becomes approval
 * theatre. Every consequential act is its own question.
 *
 * Pure: hashing and string handling only.
 */

import { createHash } from 'node:crypto';
import { stableStringify, type ApprovalBinding, type SideEffectClass } from '@axon/core';

/**
 * Which tools send something outward.
 *
 * Keyed by tool name, because the *tool* determines the category and only the
 * arguments determine whether a given call is in it. `browser.type` with
 * `submit: false` fills a visible field and sends nothing; the same tool with
 * `submit: true` posts. That is why this takes the input too.
 */
export function classifySideEffect(tool: string, input: unknown): SideEffectClass {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'browser.read':
    case 'browser.scroll':
    case 'browser.back':
    case 'browser.forward':
    case 'browser.close':
      return 'NONE';

    // A navigation is a request to somebody else's server, so it is not
    // NONE — but it creates no record and can be repeated without
    // consequence, which is what the duplicate guard cares about.
    case 'browser.open':
    case 'browser.navigate':
      return 'LOCAL';

    case 'browser.type':
      return args.submit === true ? 'EXTERNAL' : 'LOCAL';

    // A click may be anything. The dispatcher escalates to EXTERNAL for any
    // click that required approval, so the unknown case here is safe: a click
    // the policy called SAFE is one Axon's own record says only navigates.
    case 'browser.click':
      return 'LOCAL';

    case 'fs.write':
    case 'app.open':
    case 'system.screenshot':
    case 'memory.save':
    case 'memory.forget':
      return 'LOCAL';

    case 'memory.search':
      return 'NONE';

    default:
      // Deny-by-default for repeatability too: an unrecognised tool is
      // assumed to do something that should not be done twice by accident.
      return 'EXTERNAL';
  }
}

/** A short verb phrase for the dialog and the audit log. */
export function describeAction(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'browser.type':
      return args.submit === true ? 'submit text on a web page' : 'fill in a field on a web page';
    case 'browser.click':
      return 'click something on a web page';
    case 'browser.open':
    case 'browser.navigate':
      return 'open a web page';
    case 'fs.write':
      return 'write a file';
    case 'app.open':
      return 'open an application';
    case 'memory.save':
      return 'remember something';
    case 'memory.forget':
      return 'forget something';
    default:
      return `run ${tool}`;
  }
}

/**
 * The fingerprint.
 *
 * SHA-256 over the tool name and the normalized arguments, truncated to 32
 * hex characters. Truncation is fine here: this is an equality check between
 * two values computed by the same process seconds apart, not a signature
 * against a motivated forger — and nothing downstream grants authority on the
 * strength of a fingerprint alone. It exists to catch *change*, and it is
 * short so it can be shown to a person and read in a log line.
 */
export function fingerprintCall(tool: string, input: unknown): string {
  return createHash('sha256').update(`${tool} ${stableStringify(input)}`).digest('hex').slice(0, 32);
}

/** Where the act lands, when that is knowable from the arguments. */
function targetOf(tool: string, input: unknown, page: string | null): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === 'browser.open' || tool === 'browser.navigate') {
    return typeof args.url === 'string' ? args.url : page;
  }
  if (tool.startsWith('browser.')) return page;
  if (tool === 'fs.write') return typeof args.path === 'string' ? args.path : null;
  return null;
}

export interface BindingInputs {
  readonly tool: string;
  readonly input: unknown;
  /** The page Axon last observed, for browser actions. Never a credential. */
  readonly page: string | null;
  /**
   * Whether the risk policy decided this needed a human.
   *
   * A click the policy escalated is treated as EXTERNAL whatever
   * `classifySideEffect` guessed, because "a human had to be asked" is the
   * strongest available signal that something leaves the machine.
   */
  readonly escalated: boolean;
}

export function bindApproval(inputs: BindingInputs): ApprovalBinding {
  const guessed = classifySideEffect(inputs.tool, inputs.input);
  const effect: SideEffectClass = inputs.escalated && guessed !== 'EXTERNAL' ? 'EXTERNAL' : guessed;

  return {
    tool: inputs.tool,
    action: describeAction(inputs.tool, inputs.input),
    target: targetOf(inputs.tool, inputs.input, inputs.page),
    effect,
    fingerprint: fingerprintCall(inputs.tool, inputs.input),
  };
}
