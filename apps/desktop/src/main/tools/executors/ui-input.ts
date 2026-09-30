/**
 * Acting on things Axon can see: `ui.click` and `keyboard.type`.
 *
 * WHY THERE IS NO `mouse.click(x, y)`, WHICH IS THE WHOLE DESIGN.
 *
 * A coordinate is a target nobody can check. If a model says "click 940, 512",
 * there is no question Axon can ask that would establish whether 940, 512 is
 * the button the user meant, a different button, or the taskbar — and there is
 * no record afterwards of what was actually hit. Worse, coordinate injection
 * acts on whatever is under the pointer AT DELIVERY: between the decision and
 * the event, a window can move, a dialog can appear, and the user can alt-tab.
 * The thing that receives the click is then not the thing that was reasoned
 * about, and nothing in the system knows.
 *
 * So the pipeline is the one the browser tools use, applied to the desktop:
 *
 *     system.screenshot   Axon captures, and enumerates the controls in the
 *                         window in front through the accessibility layer.
 *          |              It mints a reference for each: t1, t2, t3.
 *          v
 *     the model names a REFERENCE. It has no other vocabulary — there is no
 *          |              coordinate, no window handle, no automation id and
 *          |              no selector anywhere in these schemas.
 *          v
 *     precheck            the reference is resolved against Axon's record.
 *          |              Unknown, expired or superseded is refused here,
 *          |              before risk, before anybody is asked anything.
 *          v
 *     risk                resolved from AXON'S reading of the control — the
 *          |              name the application published — never from what
 *          |              the model said about it.
 *          v
 *     approval            for anything that activates a control.
 *          v
 *     act                 UI Automation invokes THAT ELEMENT, re-found by
 *          |              identity at the moment of acting. Two matches is a
 *          |              refusal; none is a refusal. Axon does not choose.
 *          v
 *     observe again       the controls are read afresh and compared, and the
 *                         result says what actually changed. Every reference
 *                         minted before the act is invalidated.
 *
 * WHAT IS NOT HERE, AND WHY IT IS NOT AN OVERSIGHT.
 *
 * `keyboard.press` — sending Enter, Escape, Tab or a shortcut — is absent.
 * There is no way to press a key through the accessibility layer: keys go to
 * whatever holds focus, so the only implementation is synthetic input
 * (`keybd_event`, `SendInput`), and that reintroduces exactly the race this
 * design removes. Axon can verify focus a millisecond before injecting and
 * still deliver the keystroke to something else, and it would have no way to
 * know. `keyboard.type` avoids that entirely because `SetValue` addresses an
 * ELEMENT rather than the focus.
 *
 * Most of what `keyboard.press` would be used for is available honestly:
 * pressing a button is `ui.click` on that button, and choosing a menu item is
 * `ui.click` on the item. What is genuinely missing is submitting with Enter,
 * and that is stated as missing rather than approximated with a mechanism
 * whose safety Axon cannot establish.
 */

import { z } from 'zod';
import {
  ClarificationRequired,
  OBSERVATION_LIMITS,
  ToolError,
  classifyText,
  defineTool,
  type ExecutorFailureKind,
  type JsonObject,
  type PrecheckVerdict,
  type RegisteredTool,
  type RiskAssessment,
  type ScreenChangeVerification,
  type ScreenTarget,
  type SideEffectClass,
  type TargetAction,
  type ToolSummary,
} from '@axon/core';
import type { DesktopControlOutcome, DesktopScreenReading, DesktopUi } from '../../platform/windows-desktop.js';
import { activateRisk, typeIntoRisk, type TargetContext } from '../../screen/target-risk.js';
import type { VisualObservationStore } from '../../screen/visual-observation.js';

/**
 * A target reference.
 *
 * Constrained at the schema, so the value that reaches a lookup is known to be
 * a short token and nothing else — the first of three places this is enforced,
 * alongside the store's own resolution and the accessibility program's
 * identity re-match.
 */
export const refSchema = z
  .string()
  .regex(/^t\d{1,6}$/, 'Use a target reference from the most recent system.screenshot or ui.read, such as "t4".');

/**
 * What `ui.click` may ask for.
 *
 * A closed set, and deliberately smaller than what the accessibility layer
 * offers: `setText` is not here because typing has its own tool, its own risk
 * rules and its own refusals, and folding it in would mean one schema whose
 * risk could not be decided from its arguments.
 */
const CLICK_ACTIONS = ['invoke', 'toggle', 'select', 'expand', 'focus'] as const;

/** Where the action would happen, for the approval dialog and the risk policy. */
function contextOf(store: VisualObservationStore): TargetContext | null {
  const observation = store.latest();
  return observation ? { window: observation.foregroundWindow } : null;
}

/**
 * Refuse a reference Axon cannot currently vouch for.
 *
 * Runs before risk resolution and before any approval, which is the whole
 * point of the precheck hook. A reference to a control Axon has not just
 * looked at is not a dangerous request to be weighed by a human — it is one
 * that cannot be evaluated, and asking "may Axon click t4?" when Axon does not
 * know what t4 is now would be a question with no correct answer.
 *
 * `retryable` is true for every rejection here, because the remedy is the same
 * single call in each case: look again.
 */
export function requireLiveTarget(store: VisualObservationStore, ref: string): PrecheckVerdict {
  const resolved = store.resolve(ref);
  return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason, retryable: true };
}

/**
 * Turn what the accessibility layer reported into something a model can read.
 *
 * `gone` and `ambiguous` are the two that carry real information: the screen
 * changed under Axon between the observation and the act, and Axon refused to
 * guess. Both name the remedy.
 */
function throwOutcome(outcome: Exclude<DesktopControlOutcome, { kind: 'ok' }>, label: string): never {
  // ASK, DO NOT GUESS. Two controls matching the identity Axon recorded is not
  // a fault to report — it is a question only the user can answer, and acting
  // on either would be Axon choosing for them. Everything else is a genuine
  // refusal and is reported as one.
  if (outcome.kind === 'ambiguous') {
    throw new ClarificationRequired(
      `There is more than one control matching "${label}" on screen now. Which one do you mean?`,
    );
  }
  const kind = controlFailureKind(outcome);
  const message = describeOutcome(outcome, label);
  throw kind ? new ToolError(kind, message) : new Error(message);
}

/**
 * What each accessibility outcome means, stated at the boundary that knows.
 *
 *   gone         STALE_REFERENCE   the screen changed; look again, which is
 *                                  exactly what the message tells the model
 *   sensitive    FORBIDDEN         a protected field — a security refusal
 *                                  stays one
 *   unsupported  UNSUPPORTED       the control does not accept that action
 *   failed:
 *     timeout        TIMEOUT
 *     not-available  UNSUPPORTED     no accessibility layer on this machine
 *     bad-window     WINDOW_NOT_FOUND
 *     bad-action     UNSUPPORTED
 *     anything else  (none)        stays EXECUTION_ERROR: "unreadable" and
 *                                  "unknown" name no better kind, and
 *                                  guessing one is the mistake this avoids
 */
export function controlFailureKind(outcome: Exclude<DesktopControlOutcome, { kind: 'ok' }>): ExecutorFailureKind | null {
  switch (outcome.kind) {
    case 'gone':
      return 'STALE_REFERENCE';
    case 'sensitive':
      return 'FORBIDDEN';
    case 'unsupported':
      return 'UNSUPPORTED';
    case 'failed':
      switch (outcome.reason) {
        case 'timeout':
          return 'TIMEOUT';
        case 'not-available':
        case 'bad-action':
          return 'UNSUPPORTED';
        case 'bad-window':
          return 'WINDOW_NOT_FOUND';
        default:
          return null;
      }
    default:
      return null;
  }
}

function describeOutcome(outcome: Exclude<DesktopControlOutcome, { kind: 'ok' }>, label: string): string {
  switch (outcome.kind) {
    case 'gone':
      return `"${label}" is no longer on screen. The screen changed — take a fresh screenshot and decide again from what is actually there.`;
    case 'ambiguous':
      // Unreachable as a plain string now — see `throwOutcome` — but kept so
      // the description of every outcome stays in one place.
      return `There are now several controls matching "${label}". Which one do you mean?`;
    case 'sensitive':
      return `"${label}" is a password or other protected field. Axon does not interact with those.`;
    case 'unsupported':
      return `"${label}" did not accept that action.`;
    default:
      return `Axon could not act on "${label}".`;
  }
}

/**
 * Did anything actually change?
 *
 * ACT -> OBSERVE -> VERIFY. The act returning without an exception means the
 * control accepted the call, which is not the same as anything having
 * happened: a menu item that did nothing, a dialog that opened behind another
 * window, and a successful activation all return the same way.
 *
 * Reports EVIDENCE, never a verdict on the user's goal. Axon can say "the
 * window in front changed and there are different controls on it"; it cannot
 * say "the file was saved", and pretending otherwise is the invented success
 * this whole layer exists to prevent.
 */
function verifyScreenChange(
  before: readonly ScreenTarget[],
  beforeWindow: string,
  after: DesktopScreenReading,
  expectedText: string | null,
  appliedValue: string | null,
): ScreenChangeVerification {
  const foregroundChanged = after.available && after.windowTitle !== beforeWindow;
  const identity = (names: readonly string[]): string => [...names].sort().join('\0');
  const targetsChanged =
    after.available &&
    identity(before.map((target) => `${target.role}|${target.name}`)) !==
      identity(after.controls.map((control) => `${control.role}|${control.name}`));

  const textApplied = expectedText === null ? null : appliedValue === expectedText;
  const changed = foregroundChanged || targetsChanged || textApplied === true;

  if (!after.available) {
    return {
      changed: false,
      foregroundChanged: false,
      targetsChanged: false,
      textApplied,
      summary:
        'Axon could not read the screen afterwards, so it cannot say whether anything changed. ' +
        'Do not report this as done — say that you could not confirm it.',
    };
  }

  if (textApplied === false) {
    return {
      changed,
      foregroundChanged,
      targetsChanged,
      textApplied,
      summary:
        'Axon put the text in, but reading the field back does not show it. ' +
        'Do not report it as typed — say what you saw.',
    };
  }

  if (textApplied === true) {
    return {
      changed: true,
      foregroundChanged,
      targetsChanged,
      textApplied,
      summary: 'The field now contains the text Axon entered, read back from the field itself.',
    };
  }

  return {
    changed,
    foregroundChanged,
    targetsChanged,
    textApplied,
    summary: changed
      ? foregroundChanged
        ? `The window in front is now "${after.windowTitle}".`
        : 'The controls on screen changed.'
      : 'Axon acted on the control, but nothing it can see on screen changed. ' +
        'Do not report it as done — say what you observed.',
  };
}

/**
 * What both tools return.
 *
 * Deliberately NOT a fresh observation with fresh references. Axon has just
 * changed the screen, and handing back new references in the same breath would
 * invite a chain of actions on a screen nobody has looked at as a whole. The
 * model is told to look again, which is one call and is how it gets a picture
 * of what its own action did.
 */
function actionOutput(verification: ScreenChangeVerification, windowNow: string): JsonObject {
  return {
    verified: {
      changed: verification.changed,
      foregroundChanged: verification.foregroundChanged,
      targetsChanged: verification.targetsChanged,
      textApplied: verification.textApplied,
      summary: verification.summary,
    },
    windowInFront: windowNow,
    note:
      'Every target reference from before this action has expired, because the screen has changed. ' +
      'Take a fresh screenshot before acting again. Read "verified" before you say anything: if it says ' +
      'nothing changed, then as far as Axon can tell nothing did.',
  };
}

export interface UiToolOptions {
  readonly ui: DesktopUi;
  readonly store: VisualObservationStore;
}

// ---------------------------------------------------------------------------
// ui.click
// ---------------------------------------------------------------------------

export function createUiClickTool({ ui, store }: UiToolOptions): RegisteredTool {
  const inputSchema = z.object({
    ref: refSchema,
    action: z
      .enum(CLICK_ACTIONS)
      .default('invoke')
      .describe(
        'What to do with the control. "invoke" presses it, "toggle" switches it, "select" chooses it, ' +
          '"expand" opens it, "focus" puts the cursor in it. Use one the target actually lists.',
      ),
  });
  type Input = z.infer<typeof inputSchema>;

  return defineTool<Input, JsonObject>({
    name: 'ui.click',
    title: 'Activate something on screen',
    description:
      'Press, toggle, select, open or focus a control by its reference from the most recent ' +
      'system.screenshot or ui.read. A "container" cannot be pressed — read inside it instead. ' +
      'Axon activates the control through the accessibility layer, not by moving the ' +
      'pointer, so it acts on that control and nothing else. Anything that presses a control asks the user ' +
      'first. References expire quickly and are void after any action, so take a fresh screenshot before ' +
      'each one. The result says what actually changed — read it rather than assuming.',
    inputSchema,

    precheck: (input): PrecheckVerdict => {
      const live = requireLiveTarget(store, input.ref);
      if (!live.ok) return live;
      // A CONTAINER is described so a read can be scoped beneath it, and for
      // nothing else: refused here, before anyone is asked to approve pressing it.
      if (store.describe(input.ref)?.role === 'container') {
        return {
          ok: false,
          retryable: false,
          kind: 'UNSUPPORTED',
          reason: 'That is a container, not a control. Read inside it with ui.read "within", then act on a control it holds.',
        };
      }
      return { ok: true };
    },

    // Resolved from AXON'S record of the control. Nothing the model said about
    // this reference is consulted, because nothing it said is here.
    resolveRisk: (input): RiskAssessment => activateRisk(store.describe(input.ref), input.action, contextOf(store)),

    summarize(input): ToolSummary {
      const target = store.describe(input.ref);
      const context = contextOf(store);
      return {
        title: target ? `Axon wants to ${verbFor(input.action)} "${target.name}"` : 'Axon wants to activate a control',
        parameters: [
          ...(context ? [{ label: 'Window', value: context.window }] : []),
          { label: 'Control', value: target ? `${target.role}: ${target.name}` : input.ref },
          { label: 'Action', value: input.action },
        ],
      };
    },

    // Activating a control in a local application is a local effect. The
    // dispatcher escalates anything the policy gated to EXTERNAL on its own,
    // so a control that needed asking about is treated as unrepeatable
    // regardless of what is claimed here.
    sideEffect: (): SideEffectClass => 'LOCAL',

    async execute(input, ctx): Promise<JsonObject> {
      // Resolved AGAIN, at execution time. The dispatcher already gated this
      // call, but a reference Axon cannot vouch for must be unusable through
      // any path into this function, including a future caller that forgets.
      const resolved = store.resolve(input.ref);
      if (!resolved.ok) throw new ToolError('STALE_REFERENCE', resolved.reason);

      const { target, identity } = resolved;
      if (target.sensitive) {
        throw new ToolError('FORBIDDEN', 'Refusing to activate a password or other protected field.');
      }
      if (!target.actions.includes(input.action)) {
        throw new ToolError(
          'UNSUPPORTED',
          `"${target.name}" does not support "${input.action}". It supports: ${target.actions.join(', ')}.`,
        );
      }

      const before = store.latest();
      const beforeTargets = before?.targets ?? [];
      const beforeWindow = before?.foregroundWindow ?? '';

      const outcome = await ui.actOnControl({
        windowHandle: identity.windowHandle,
        nativeRole: identity.nativeRole,
        name: identity.name,
        automationId: identity.automationId,
        ...(identity.runtimeId ? { runtimeId: identity.runtimeId } : {}),
        action: input.action,
      });

      // Whatever happened, the screen is no longer one Axon can vouch for.
      // Invalidated before the outcome is inspected, so an early return cannot
      // leave live references behind.
      store.invalidate();

      if (outcome.kind !== 'ok') throwOutcome(outcome, target.name);

      const after = await ui.observeControls(identity.windowHandle);
      const verification = verifyScreenChange(beforeTargets, beforeWindow, after, null, null);

      ctx.observe(`${verbFor(input.action)} "${target.name}" — ${verification.summary}`, {
        changed: verification.changed,
      });

      return actionOutput(verification, after.available ? after.windowTitle : beforeWindow);
    },
  });
}

function verbFor(action: TargetAction): string {
  switch (action) {
    case 'toggle':
      return 'toggle';
    case 'select':
      return 'select';
    case 'expand':
      return 'open';
    case 'focus':
      return 'focus';
    default:
      return 'press';
  }
}

// ---------------------------------------------------------------------------
// keyboard.type
// ---------------------------------------------------------------------------

export function createKeyboardTypeTool({ ui, store }: UiToolOptions): RegisteredTool {
  const inputSchema = z.object({
    ref: refSchema,
    text: z
      .string()
      .max(OBSERVATION_LIMITS.maxTypeCharacters)
      .describe(
        'The text to put in the field. Never a password, key, token, card number or one-time code — ' +
          'Axon refuses those, and the user should type them themselves.',
      ),
  });
  type Input = z.infer<typeof inputSchema>;

  return defineTool<Input, JsonObject>({
    name: 'keyboard.type',
    title: 'Type into a field on screen',
    description:
      'Put text into a text field by its reference from the most recent system.screenshot. Axon writes to ' +
      'that field through the accessibility layer rather than sending keystrokes, so the text cannot land ' +
      'in whatever happens to be focused. This REPLACES what is already in the field. The user is asked ' +
      'first. Axon never types passwords, keys, card numbers or one-time codes and will refuse them.',
    inputSchema,

    precheck(input): PrecheckVerdict {
      const live = requireLiveTarget(store, input.ref);
      if (!live.ok) return live;

      // A field that does not take text is not a dangerous request to weigh —
      // it is one that cannot be carried out, and saying so before an approval
      // dialog is the difference between a useful refusal and a wasted
      // question.
      const target = store.describe(input.ref);
      if (target && !target.actions.includes('setText')) {
        return {
          ok: false,
          reason: `"${target.name}" is not a text field. Choose a field that lists "setText" among its actions.`,
          retryable: true,
        };
      }
      return { ok: true };
    },

    /**
     * The text is classified, and the CLASS is what reaches the risk layer.
     *
     * Not the string. A reason, a dialog parameter and an event are all places
     * a credential must never appear, and the surest way to keep it out of
     * them is for the layer that writes them never to hold it.
     */
    resolveRisk: (input): RiskAssessment =>
      typeIntoRisk(store.describe(input.ref), classifyText(input.text).sensitivity, contextOf(store)),

    summarize(input): ToolSummary {
      const target = store.describe(input.ref);
      const context = contextOf(store);
      return {
        // The summary names the content, because "allow a keyboard action?" is
        // not a question anybody can answer responsibly.
        title: 'Axon wants to type this into a field',
        parameters: [
          ...(context ? [{ label: 'Window', value: context.window }] : []),
          { label: 'Field', value: target ? target.name : input.ref },
          ...(target && (target.value ?? '') !== ''
            ? [{ label: 'Replaces', value: preview(target.value ?? '') }]
            : []),
          { label: 'Text', value: preview(input.text) },
        ],
      };
    },

    sideEffect: (): SideEffectClass => 'LOCAL',

    async execute(input, ctx): Promise<JsonObject> {
      const resolved = store.resolve(input.ref);
      if (!resolved.ok) throw new ToolError('STALE_REFERENCE', resolved.reason);

      const { target, identity } = resolved;

      // THE THREE REFUSALS, all of them repeated here.
      //
      // The risk policy already refuses each of these, and the accessibility
      // program refuses the first again on its own side. This is the layer
      // that must hold whatever route reached it: typing a credential into
      // another application is the one thing in this file that must never
      // happen.
      if (target.sensitive) {
        throw new ToolError('FORBIDDEN', 'Refusing to type into a password or other protected field.');
      }
      if (classifyText(input.text).sensitivity === 'SECRET') {
        throw new ToolError(
          'FORBIDDEN',
          'Refusing to type that: it looks like a password, key, token or one-time code. ' +
            'Ask the user to type it themselves.',
        );
      }
      if (!target.actions.includes('setText')) {
        throw new ToolError('UNSUPPORTED', `"${target.name}" does not accept text.`);
      }

      const before = store.latest();
      const beforeTargets = before?.targets ?? [];
      const beforeWindow = before?.foregroundWindow ?? '';
      const text = sanitize(input.text);

      const outcome = await ui.actOnControl({
        windowHandle: identity.windowHandle,
        nativeRole: identity.nativeRole,
        name: identity.name,
        automationId: identity.automationId,
        ...(identity.runtimeId ? { runtimeId: identity.runtimeId } : {}),
        action: 'setText',
        text,
      });

      store.invalidate();

      if (outcome.kind !== 'ok') throwOutcome(outcome, target.name);

      const after = await ui.observeControls(identity.windowHandle);
      const verification = verifyScreenChange(beforeTargets, beforeWindow, after, text, outcome.value);

      // THE TEXT IS NOT IN THIS LINE, and that is the point. An OBSERVATION
      // goes to the timeline, to the renderer and to the JSONL log on disk. A
      // typed value has no business in any of them, so the observation carries
      // the field, the length and whether it worked.
      ctx.observe(`Typed ${text.length} characters into "${target.name}" — ${verification.summary}`, {
        characters: text.length,
        changed: verification.changed,
      });

      return actionOutput(verification, after.available ? after.windowTitle : beforeWindow);
    },
  });
}

/**
 * Strip control characters from text about to be typed.
 *
 * The same hygiene the transcript, the speech path and `browser.type` apply,
 * for the same reason: what the user approved in the dialog and what lands in
 * the field should be the same string, in the same order. An embedded
 * right-to-left override makes those two things differ while looking
 * identical.
 */
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ');
}

// The point of this pattern is to STRIP control characters out of text before
// it is typed into another application. Matching them is the job.
/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);
/* eslint-enable no-control-regex */

/**
 * The text, for the approval dialog.
 *
 * Shown in full up to the tool's own ceiling: a user asked to approve text
 * they can only see the first sentence of is being asked to consent to
 * something they have not read. Control characters are stripped by the same
 * `sanitize` the executor applies, so what is displayed and what is typed are
 * the same string — which is the property that makes showing it worth
 * anything.
 */
function preview(text: string): string {
  const cleaned = sanitize(text)
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  return cleaned.length <= OBSERVATION_LIMITS.maxTypeCharacters
    ? cleaned
    : `${cleaned.slice(0, OBSERVATION_LIMITS.maxTypeCharacters)}… (${cleaned.length} characters)`;
}
