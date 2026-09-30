/**
 * Classifying what activating an on-screen control would actually do.
 *
 * The same load-bearing idea as `browser/action-risk.ts`, applied to the
 * desktop: risk is resolved from AXON'S OWN reading of the control — the name
 * the application published to the accessibility layer, which Axon enumerated
 * and stored — and never from anything the model said about it. The model's
 * entire input is a reference. It cannot describe the button, cannot rename
 * it, and cannot assert that it is harmless.
 *
 * WHY THE DEFAULT HERE IS "ASK", WHERE THE BROWSER'S IS "GO".
 *
 * A web page is a document Axon opened, in a window Axon owns, whose every
 * navigation is re-checked. Clicking an unrecognised link on one is a fetch.
 * A desktop control belongs to somebody else's application, doing something
 * Axon has no way to model — a menu item in an editor might insert a
 * character or empty a folder, and the accessibility tree says nothing about
 * which. So activating a control asks, and the dialog names the application
 * and the control so the question is answerable.
 *
 * The exceptions are narrow and each is defensible on its own: moving keyboard
 * focus, opening a menu, and choosing a tab change what the user is looking at
 * and commit to nothing. Those are the operations an agent needs in order to
 * LOOK, and gating them would mean asking a person for permission to see.
 *
 * That default may well be too cautious once there is evidence about which
 * controls people actually ask for. Too cautious is the correct direction to
 * be wrong in for a capability's first release: the failure mode is a dialog
 * nobody needed, not an application doing something nobody asked for.
 */

import {
  classifyActionLabel,
  escalate,
  type RiskAssessment,
  type RiskLevel,
  type ScreenTarget,
  type SensitivityClass,
  type TargetAction,
} from '@axon/core';

/**
 * Actions that only change what is visible.
 *
 * `focus` moves the caret. `expand` opens a menu or a disclosure. `select`
 * chooses a tab or a list row. None of them commits to anything, and all three
 * are how Axon finds out what is there.
 */
const OBSERVING_ACTIONS: readonly TargetAction[] = ['focus', 'expand', 'select'];

/** Where the action would happen, for the approval dialog. */
export interface TargetContext {
  /** The window Axon observed. UNTRUSTED text, shown so the user can judge. */
  readonly window: string;
}

/**
 * Risk of activating one control.
 *
 * A null target means the reference is unknown, expired or superseded, and
 * that is never SAFE: Axon does not know what it would be activating, which is
 * the definition of a call whose risk could not be determined. The precheck
 * refuses those first, so this branch should be unreachable — it is here
 * because "should be unreachable" is not a security property.
 */
export function activateRisk(
  target: ScreenTarget | null,
  action: TargetAction,
  context: TargetContext | null,
): RiskAssessment {
  if (!target) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason:
        'Risk could not be determined: Axon has no current record of that control. ' +
        'Take a fresh screenshot before acting on it.',
    };
  }

  const where = context?.window ? ` in "${context.window}"` : '';
  const label = target.name || 'an unlabelled control';

  // A protected-entry field is not a thing to activate through an agent, ever.
  // Reported by the application itself, so this is evidence rather than a
  // guess about the field's name.
  if (target.sensitive) {
    return {
      level: 'FORBIDDEN',
      reason: `"${label}" is a password or other protected field. Axon does not interact with those.`,
    };
  }

  const verdict = classifyActionLabel(target.name);
  const destructive = verdict.matched.some((entry) => entry.startsWith('destructive:'));

  if (destructive) {
    return {
      level: 'HIGH_RISK',
      reason: `"${label}"${where} looks destructive, expensive or hard to undo.`,
    };
  }

  if (verdict.sensitivity === 'CONSEQUENTIAL') {
    return {
      level: 'REQUIRES_APPROVAL',
      reason: `"${label}"${where} sends something or changes shared state.`,
    };
  }

  if (OBSERVING_ACTIONS.includes(action)) {
    return {
      level: 'SAFE',
      reason:
        action === 'focus'
          ? `Putting the cursor in "${label}"${where} changes what is focused and nothing else.`
          : action === 'expand'
            ? `Opening "${label}"${where} shows what is in it and commits to nothing.`
            : `Choosing "${label}"${where} changes what is shown without sending anything.`,
    };
  }

  // Anything that actually activates a control in somebody else's
  // application. Axon cannot know what it does, so a person decides.
  return {
    level: 'REQUIRES_APPROVAL',
    reason: `Activating "${label}"${where} makes that application do something Axon cannot predict.`,
  };
}

/**
 * Risk of putting text into one control.
 *
 * TWO INDEPENDENT REFUSALS, and both are hard.
 *
 * The FIELD may be a credential field, which the application says outright.
 * The TEXT may be a credential, whatever field it was headed for. Axon refuses
 * either, at any risk level, and no approval unlocks them — if a password is
 * needed, the person types it themselves. The caller passes the text's class
 * rather than the text, so the string never reaches the risk layer and cannot
 * end up in a reason, a dialog or an event.
 *
 * Everything else asks. Text going into somebody else's application is not the
 * same act as text going into a field on a page Axon opened: the accessibility
 * layer's `SetValue` REPLACES a control's contents, so typing into a field
 * that already has something in it destroys what was there. That case is
 * HIGH_RISK and the dialog says so.
 */
export function typeIntoRisk(
  target: ScreenTarget | null,
  textSensitivity: SensitivityClass,
  context: TargetContext | null,
): RiskAssessment {
  if (!target) {
    return {
      level: 'REQUIRES_APPROVAL',
      reason:
        'Risk could not be determined: Axon has no current record of that field. ' +
        'Take a fresh screenshot before typing into it.',
    };
  }

  const where = context?.window ? ` in "${context.window}"` : '';
  const label = target.name || 'an unlabelled field';

  if (target.sensitive) {
    return {
      level: 'FORBIDDEN',
      reason:
        `"${label}" is a password or other protected field. Axon never types credentials — ` +
        'if that field needs one, the user should type it themselves.',
    };
  }

  if (textSensitivity === 'SECRET') {
    return {
      level: 'FORBIDDEN',
      reason:
        'That text looks like a password, key, token or one-time code. Axon does not type credentials ' +
        'into applications, at any risk level.',
    };
  }

  if (!target.actions.includes('setText')) {
    return {
      level: 'FORBIDDEN',
      reason: `"${label}"${where} does not accept text.`,
    };
  }

  const replacing = (target.value ?? '') !== '';
  return {
    level: escalate('REQUIRES_APPROVAL', replacing ? ('HIGH_RISK' as RiskLevel) : ('SAFE' as RiskLevel)),
    reason: replacing
      ? `Typing into "${label}"${where} REPLACES what is already in it, which cannot be undone from Axon.`
      : `Typing into "${label}"${where} puts text into another application.`,
  };
}
