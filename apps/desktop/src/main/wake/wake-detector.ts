/**
 * What a wake detector IS, whatever is doing the hearing.
 *
 * Axon has two. One is the Windows speech recognizer with a fixed grammar
 * (`wake-word.ts`), which is what shipped first. The other is a dedicated
 * local keyword spotter (`keyword-wake-detector.ts`), which is what ships now.
 * They exist side by side because a human microphone test — not a unit test —
 * is the only thing that can say which one works, and keeping the old one
 * runnable is what makes that comparison possible.
 *
 * THE SHAPE OF THE SEAM, AND WHY IT IS THESE FIVE MEMBERS.
 *
 * `arm` / `disarm` / `isArmed` / `available` / `pushFrame` are not new names.
 * They are the vocabulary the orchestrator, the runtime, the tray, and five
 * verification harnesses already speak, and renaming them to `start`/`stop`
 * would have meant two lifecycles in flight at once during the change — the
 * one thing a wake word must never have, because "is the microphone armed?"
 * would briefly have had two answers. `getStatus` is the one addition: a
 * bounded, printable description of what is listening, for the tray and the
 * settings panel, and for a live test to report which engine produced a
 * number.
 *
 * WHAT A DETECTOR MAY EMIT.
 *
 * One bit. `onWake()` takes no argument in either implementation and this
 * interface has no channel for a transcript, a score, or audio. Everything a
 * developer might want to know goes to `getStatus()`, which returns only the
 * engine's identity and health, or to the debug callback, which exists only in
 * a development build.
 *
 * This file declares types and nothing else, so that both implementations can
 * be checked against it without either of them importing the other.
 */

/** Which engine is doing the hearing, or that none is. */
export type WakeEngineKind = 'keyword-spotter' | 'windows-speech' | 'disabled';

/**
 * A detector's health, for the tray and the settings panel.
 *
 * Deliberately printable and deliberately boring: an engine name, whether it
 * is armed, whether it could be, and how many times it has had to be
 * restarted. Nothing here is derived from what anybody said.
 */
export interface WakeDetectorStatus {
  readonly engine: WakeEngineKind;
  /** The runtime doing the hearing, in a few words. Never a full path, never audio. */
  readonly detail: string;
  readonly armed: boolean;
  readonly available: boolean;
  /** Why it cannot listen, when it cannot. Phrased for a person; never a credential or a path. */
  readonly unavailableReason: string | null;
  /** How many times the engine has been restarted under it since arming. */
  readonly restarts: number;
  /** True while armed and no microphone audio has arrived recently. */
  readonly starvedOfAudio: boolean;
}

/**
 * A local wake detector.
 *
 * Implementations own their recognizer and nothing else. They do not open the
 * microphone — main does that, through the same capture command every other
 * consumer uses — and they do not decide what happens when the phrase is
 * heard. They say "now", once.
 */
export interface WakeDetector {
  /** Armed means: microphone open, audio to a LOCAL recognizer only. */
  readonly isArmed: boolean;
  /** False when this machine cannot run the engine at all. */
  readonly available: boolean;
  /** Begin listening locally. Idempotent. Resolves false if it could not. */
  arm(): Promise<boolean>;
  /** Stop listening locally. Idempotent, and reached from every exit. */
  disarm(): void;
  /** One frame of 16 kHz, 16-bit, mono microphone audio. Returns nothing. */
  pushFrame(frame: Int16Array): void;
  /** A bounded description of what is listening and whether it is well. */
  getStatus(): WakeDetectorStatus;
}
