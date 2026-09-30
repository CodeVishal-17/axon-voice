/**
 * Seeing the screen, and naming things on it.
 *
 * TWO DIFFERENT THINGS THAT WERE PREVIOUSLY ONE.
 *
 * `system.screenshot` used to capture a PNG, write it into a folder, and hand
 * the model a file path. In a live test the model then said it could not open
 * image files — which was true, and which showed the shape was wrong. A path
 * is not an observation. It is a promise of an observation that the recipient
 * may or may not be able to redeem, and Axon had no idea which.
 *
 * So the two are separated here:
 *
 *   A VISUAL OBSERVATION is ephemeral. It lives in the main process for a
 *   short, bounded time, it holds the pixels, and it holds AXON'S OWN reading
 *   of what is on screen. It is what reasoning and action are bound to. It is
 *   not a file, it has no path, and it expires.
 *
 *   A SAVED SCREENSHOT is a file the user asked for. It happens only when
 *   somebody explicitly wanted a picture kept, and it is a separate outcome of
 *   the same capture rather than an unavoidable side effect of looking.
 *
 * WHAT THE MODEL ACTUALLY RECEIVES, AND THE PROVIDER LIMITATION.
 *
 * Axon's voice provider speaks a text protocol: a tool result is a JSON
 * string, and there is no channel on it that carries an image. Axon therefore
 * does NOT hand the model pixels, and does not pretend to. What it hands over
 * is `VisualObservationView` — dimensions, the foreground window, and a
 * bounded list of the controls Axon itself enumerated through the operating
 * system's accessibility layer, each with a short reference.
 *
 * That is a real limitation and it is written down rather than papered over.
 * The abstraction is built so a vision-capable consumer can be added without
 * changing anything that acts: the pixels are already held, already bound to
 * an observation id, and already expire on the same clock as the references.
 * What is absent is a provider that can accept them.
 *
 * WHY A REFERENCE, AND NOT A COORDINATE.
 *
 * A model that can say `click(940, 512)` is a model that can invent a target.
 * Nothing about the number 940 is checkable: Axon cannot tell whether it is
 * the button the user meant, a different button, or the taskbar. So there is
 * no coordinate anywhere in this contract. An action names a `ref` that Axon
 * minted for an element Axon found and described, and the risk policy resolves
 * from Axon's record of that element rather than from anything the model said
 * about it. The set of things the model can act on is, by construction, a
 * subset of what Axon has just looked at.
 *
 * This is the same design as `browsing.ts`, applied to the desktop, and it is
 * deliberately the same so there is one idea to understand rather than two.
 *
 * Pure: no Node, no Electron.
 */

import type { ToolFailureKind } from './tool-contract.js';

/**
 * Hard ceilings, enforced in the main process.
 *
 * The desktop is unbounded in the same way a page is: a window can contain
 * thousands of accessibility nodes, and a screenshot is megabytes. Every limit
 * here exists so that looking at the screen cannot become unbounded context,
 * unbounded memory, or an unbounded wait.
 */
export const OBSERVATION_LIMITS = {
  /** Controls described in one observation. */
  maxTargets: 60,
  /** Characters of any single control name. Names are untrusted text. */
  maxNameCharacters: 120,
  /**
   * How long a target reference may be acted on.
   *
   * The screen changes constantly and nothing tells Axon when. A page at least
   * fires navigation events; a desktop fires nothing an outside process can
   * rely on. So time is the only honest staleness signal available, and it is
   * short: fifteen seconds is long enough to observe, decide and act, and far
   * too short for a reference to survive the user opening something else.
   *
   * An expired reference is REFUSED, not repaired. Recovery is a fresh
   * observation, which is one tool call away.
   */
  targetTtlMs: 15_000,
  /**
   * How long captured pixels are held in memory.
   *
   * Longer than the reference lifetime, so an observation can still be
   * described after its references have expired, and short enough that Axon is
   * never sitting on a picture of somebody's screen from ten minutes ago.
   */
  imageTtlMs: 60_000,
  /** Visual observations retained at once. Old ones are dropped, not queued. */
  maxRetainedObservations: 3,
  /**
   * How long the accessibility enumeration may take before it is abandoned.
   *
   * BOUNDED BY THE VOICE PROTOCOL, not by how long a tree walk can take. A
   * live test found this the hard way: enumerating a browser window's
   * accessibility tree took long enough that `system.screenshot` outlasted the
   * voice provider's tool timeout, the provider abandoned the call, and the
   * model told the user it could not take a screenshot — of a screenshot it
   * had taken. A tool that answers after nobody is listening has not answered.
   *
   * So the enumeration gets a deadline that leaves room for the capture and
   * the dispatch inside `VOICE_AGENT_LIMITS.toolTimeoutSeconds`, and a walk
   * that does not finish in time yields an observation with no controls and a
   * note saying so. Fewer controls, honestly reported, beats a result nobody
   * receives. `voice-agent-timing.test.ts` asserts the relationship.
   */
  enumerateTimeoutMs: 6_000,
  /**
   * How long one act on a control may take.
   *
   * Chosen so that ACT plus the VERIFICATION that follows it still fits inside
   * the voice provider's tool timeout. `ui.click` with `focus`, `expand` or
   * `select` runs inline — those commit to nothing, so they are not gated —
   * and an inline call that outlives the wire timeout produces the same
   * false-failure report that made this whole class of bug visible. Anything
   * that actually activates a control is answered as pending and its outcome
   * spoken later, so it is not bound by this at all.
   */
  actTimeoutMs: 5_000,
  /** Characters of text one keyboard action will enter. */
  maxTypeCharacters: 2_000,
} as const;

/**
 * The ways Axon can observe a screen, and which of them a model can receive.
 *
 * THE TWO QUESTIONS THAT ARE NOT THE SAME ONE.
 *
 *   Can Axon PRODUCE this?      Can a consumer RECEIVE it?
 *
 * Collapsing them is how a system ends up claiming to see. Axon captures
 * pixels — really, on every look — and there is no channel on the voice
 * provider's protocol that carries an image, so the model never gets them.
 * A design that tracked only "we have a screenshot" would let a model
 * reasonably conclude it could be shown one.
 *
 * So both are recorded, separately, per modality, and the tool surface reports
 * them. `vision` appears here with `captured: false` deliberately: naming the
 * thing Axon cannot do is what stops it being quietly assumed.
 */
export const OBSERVATION_MODALITIES = ['accessibility', 'pixels', 'vision'] as const;

export type ObservationModality = (typeof OBSERVATION_MODALITIES)[number];

export interface ObservationModalityStatus {
  readonly modality: ObservationModality;
  /** Whether Axon can produce an observation of this kind at all. */
  readonly captured: boolean;
  /**
   * Whether a model can actually be handed one today.
   *
   * False for `pixels`: Axon holds them, and the protocol has nowhere to put
   * them. That is a provider limitation, stated rather than worked around.
   */
  readonly deliverableToModel: boolean;
  /** One sentence a person — or a model — can act on. */
  readonly reason: string;
}

/**
 * Roles Axon reports for an on-screen control.
 *
 * A closed set, not the operating system's. UI Automation has upwards of forty
 * control types; the model needs to know whether a thing is pressable, whether
 * it takes text, and little else. A closed set also means an unrecognised
 * control type degrades to `other` rather than becoming a new value the risk
 * policy has never seen.
 */
export const TARGET_ROLES = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'menuitem',
  'listitem',
  'tab',
  'combobox',
  // Phase 4B: a named list, group, document or pane. Never acted on — it has
  // no actions — but it can be the scope of a read ("within").
  'container',
  'other',
] as const;

export type TargetRole = (typeof TARGET_ROLES)[number];

/**
 * What Axon can do with a control, as the accessibility layer reports it.
 *
 * Derived from the patterns the control actually supports, not from its role:
 * a "button" that supports nothing cannot be invoked, and saying otherwise
 * would produce a confident plan built on a capability that is not there.
 */
export const TARGET_ACTIONS = ['invoke', 'toggle', 'select', 'setText', 'focus', 'expand'] as const;

export type TargetAction = (typeof TARGET_ACTIONS)[number];

/**
 * One control, as Axon describes it.
 *
 * `ref` is the ONLY way an action can name it. There is no coordinate, no
 * window handle, no automation id and no accessibility pointer in this type —
 * everything the operating system uses to find the control again stays in the
 * main process, in `ScreenTargetIdentity`, which the model never receives.
 */
export interface ScreenTarget {
  readonly ref: string;
  readonly role: TargetRole;
  /**
   * The accessible name — what a person would say they were clicking.
   *
   * UNTRUSTED. Any application on the machine names its own controls, and a
   * hostile one can name a control anything, including a sentence addressed to
   * the model. Treated as data everywhere downstream.
   */
  readonly name: string;
  /** The title of the window it belongs to. Also untrusted text. */
  readonly window: string;
  readonly actions: readonly TargetAction[];
  /**
   * True for password and other protected-entry fields.
   *
   * Axon never types into one and never activates one, at any risk level. The
   * accessibility layer reports this directly, which makes it evidence rather
   * than a guess about the field's name.
   */
  readonly sensitive: boolean;
  /** Current text of an editable control, bounded. Null for anything else. */
  readonly value: string | null;
}

/**
 * How the main process finds a control again.
 *
 * NEVER SENT ANYWHERE. It is held beside the observation, used to re-locate
 * the control at the moment of acting, and it is the reason an action can be
 * verified rather than assumed. A model that received this could name a
 * control Axon had not looked at, which is exactly what the reference model
 * exists to prevent.
 */
export interface ScreenTargetIdentity {
  readonly ref: string;
  /** The owning window's OS handle, as a string. Opaque; stays in main. */
  readonly windowHandle: string;
  /** The operating system's own control-type name, for re-matching. */
  readonly nativeRole: string;
  readonly name: string;
  /** The application's own id for the control, when it has one. */
  readonly automationId: string;
  /**
   * The accessibility engine's id for the live element (Phase 4B), so a
   * re-find is exact where two controls share a name. Stays in main, like
   * the handle; never projected, never accepted from a model.
   */
  readonly runtimeId?: string;
}

/**
 * One look at the screen.
 *
 * `epoch` is monotonic per store and never reused: a reference belongs to an
 * epoch, and a reference from a superseded epoch names a position in a screen
 * that no longer exists.
 */
export interface VisualObservation {
  readonly id: string;
  readonly epoch: number;
  /** Milliseconds since the epoch, from the store's clock. */
  readonly capturedAt: number;
  readonly width: number;
  readonly height: number;
  readonly display: string;
  /** Title of the window that was in front. Untrusted text. */
  readonly foregroundWindow: string;
  readonly targets: readonly ScreenTarget[];
  readonly targetsTruncated: boolean;
  /**
   * Why the control list is empty or partial, when it is.
   *
   * Stated rather than silently returning nothing: a model told "no controls"
   * will confidently conclude the screen is empty, and a model told "the
   * accessibility layer is not available here" will say so to the user.
   */
  readonly note: string | null;
  /**
   * The same reason as a failure kind — UI_NOT_ACCESSIBLE, TIMEOUT,
   * WINDOW_NOT_FOUND — or null when the controls were read. A status on a
   * SUCCESSFUL look, never a failure: the capture worked either way.
   * Optional so a reading that does not state one is simply "nothing to
   * report".
   */
  readonly accessibility?: ToolFailureKind | null;
}

/**
 * The projection handed to a model.
 *
 * Note the absent fields: no image, no path, no handle, no coordinate, no
 * identity. Adding one would be a visible edit to this interface, in a file
 * whose header says why not to.
 */
export interface VisualObservationView {
  readonly observation: string;
  readonly width: number;
  readonly height: number;
  readonly display: string;
  readonly foregroundWindow: string;
  readonly targets: readonly ScreenTarget[];
  readonly targetsTruncated: boolean;
  /** Seconds the references remain valid. After that, observe again. */
  readonly referencesValidForSeconds: number;
  /** What Axon can and cannot do with this observation, in plain words. */
  readonly note: string;
  /** Why the control list is empty, as a failure kind; null when it was read. */
  readonly accessibility: ToolFailureKind | null;
}

/**
 * Whether an act on a control did anything, established by looking again.
 *
 * ACT -> OBSERVE -> VERIFY, the same rule the browser and the window tools
 * follow. A control being invoked without error is not evidence that anything
 * happened: a disabled menu item, a dialog that opened behind, and a
 * successful click all return normally.
 *
 * Reports EVIDENCE, never a verdict on the user's goal.
 */
export interface ScreenChangeVerification {
  readonly changed: boolean;
  readonly foregroundChanged: boolean;
  readonly targetsChanged: boolean;
  /** For a text entry: whether the control now holds the text Axon entered. */
  readonly textApplied: boolean | null;
  /** One sentence stating evidence, for the model and the timeline. */
  readonly summary: string;
}
