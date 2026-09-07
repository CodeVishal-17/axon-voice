/**
 * Activation.
 *
 * A WakeSource is anything that can say "the user wants Axon now": a global
 * hotkey (Step 1/4), a click on the orb, or a wake-word engine later. They are
 * interchangeable because activation carries no other meaning.
 */

export type WakeTrigger = 'hotkey' | 'wake-word' | 'manual';

export interface WakeSource {
  readonly name: string;
  readonly trigger: WakeTrigger;
  start(onWake: () => void): void;
  stop(): void;
}
