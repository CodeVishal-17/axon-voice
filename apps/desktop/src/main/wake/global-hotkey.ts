/**
 * Push-to-talk, as a global hotkey.
 *
 * WHY THE MAIN PROCESS OWNS THIS. A system-wide key hook is a privileged
 * capability: it sees keystrokes aimed at other applications. The renderer is
 * the untrusted side of Axon and has no business registering one, so the hook
 * lives here, behind Electron's own `globalShortcut`, and the renderer's only
 * route to the same behaviour is the `startListening` request on the bridge —
 * which main is free to refuse.
 *
 * Electron's `globalShortcut` reports key *presses*, not releases, so a true
 * hold-to-talk is not available through it. Axon uses press-to-start instead,
 * and ends the utterance from the audio itself: press once, speak, and the
 * voice activity detector closes the microphone when you stop. Pressing again
 * while listening stops early. That is a better fit for a desktop agent than
 * holding a chord down through a sentence, and it means the same code path
 * serves the hotkey and the on-screen button.
 *
 * A shortcut can legitimately fail to register — another application may
 * already own it. The candidates below are tried in order and the first that
 * takes is used, so Axon starts with a working hotkey or with none, never with
 * one it merely believes in.
 */

import { globalShortcut } from 'electron';
import type { WakeSource, WakeTrigger } from '@axon/core';

/**
 * Accelerators tried in order.
 *
 * Ctrl+Shift+Space is unclaimed by Windows itself and by the shell, and is
 * awkward enough to hit by accident that it will not open the microphone while
 * someone is typing. The fallbacks exist for machines where another
 * application got there first.
 */
export const DEFAULT_HOTKEY_CANDIDATES: readonly string[] = [
  'Control+Shift+Space',
  'Control+Alt+Space',
  'Control+Shift+F9',
];

/**
 * Accelerators Axon refuses to register, whatever the configuration says.
 *
 * A single unmodified key, or a bare modifier, would swallow that key for
 * every application on the machine. `AXON_VOICE_HOTKEY` is developer-facing
 * configuration rather than a user setting, but it is still input, and input
 * that can make a machine unusable gets refused.
 */
function isPlausibleAccelerator(accelerator: string): boolean {
  const trimmed = accelerator.trim();
  if (trimmed === '' || trimmed.length > 64) return false;
  // At least one modifier and at least one key.
  const parts = trimmed.split('+').filter((part) => part !== '');
  if (parts.length < 2) return false;
  return /^[A-Za-z0-9+]+$/.test(trimmed.replace(/\s/g, ''));
}

export interface HotkeyOptions {
  /** `AXON_VOICE_HOTKEY`. Falls back to the candidates above. */
  readonly preferred?: string | undefined;
  /** Injected in tests, so this class can be exercised without Electron. */
  readonly register?: (accelerator: string, callback: () => void) => boolean;
  readonly unregister?: (accelerator: string) => void;
}

export class GlobalHotkeyWakeSource implements WakeSource {
  readonly name = 'global-hotkey';
  readonly trigger: WakeTrigger = 'hotkey';

  private readonly candidates: readonly string[];
  private readonly register: (accelerator: string, callback: () => void) => boolean;
  private readonly unregister: (accelerator: string) => void;

  private registered: string | null = null;

  constructor(options: HotkeyOptions = {}) {
    const preferred = options.preferred?.trim();
    this.candidates =
      preferred && isPlausibleAccelerator(preferred)
        ? [preferred, ...DEFAULT_HOTKEY_CANDIDATES]
        : DEFAULT_HOTKEY_CANDIDATES;

    this.register = options.register ?? ((accelerator, callback) => globalShortcut.register(accelerator, callback));
    this.unregister = options.unregister ?? ((accelerator) => globalShortcut.unregister(accelerator));
  }

  /** The accelerator actually in force, or null when none could be taken. */
  get accelerator(): string | null {
    return this.registered;
  }

  start(onWake: () => void): void {
    if (this.registered) return;

    for (const candidate of this.candidates) {
      let taken = false;
      try {
        taken = this.register(candidate, onWake);
      } catch {
        // `register` throws on a malformed accelerator. Treat it as "not
        // available" and try the next one rather than failing startup: a
        // desktop agent that will not launch because of a keyboard shortcut
        // is a worse outcome than one with no shortcut.
        taken = false;
      }
      if (taken) {
        this.registered = candidate;
        return;
      }
    }

    console.warn('[wake] no push-to-talk shortcut could be registered; use the on-screen button');
  }

  stop(): void {
    const accelerator = this.registered;
    this.registered = null;
    if (!accelerator) return;
    try {
      this.unregister(accelerator);
    } catch {
      /* already gone */
    }
  }
}
