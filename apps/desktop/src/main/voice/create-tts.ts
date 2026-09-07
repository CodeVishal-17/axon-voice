/**
 * Choosing a speech synthesiser.
 *
 * The single place a provider is named. Everything above depends on the
 * `TextToSpeech` interface, so swapping SAPI for a cloud voice later is a
 * change to this file and a new adapter beside `sapi-tts.ts` — the
 * orchestrator, the renderer and the brain are untouched by it.
 *
 * Today the choice is easy: Windows SAPI is present on the target platform,
 * needs no API key, no network and no credential to protect, and synthesises
 * to a buffer rather than to the speakers, which is exactly what a pipeline
 * that must also drive the orb requires. A cloud voice would sound better and
 * would add a second secret to defend for no capability Step 3 needs.
 *
 * Absence is a normal state, not a failure: on a non-Windows machine Axon runs
 * and simply does not speak.
 */

import type { TextToSpeech } from '@axon/core';
import { SapiTextToSpeech } from './sapi-tts.js';

export interface TtsFactoryOptions {
  readonly platform: NodeJS.Platform;
  /** `AXON_TTS_PROVIDER`: 'sapi' (default) or 'none' to disable speech. */
  readonly provider: string | undefined;
}

export interface TtsCreation {
  readonly tts: TextToSpeech | null;
  /** Why Axon will not speak. Null when it will. Never carries a path or key. */
  readonly unavailableReason: string | null;
}

export function createTextToSpeech(options: TtsFactoryOptions): TtsCreation {
  const provider = (options.provider ?? 'sapi').trim().toLowerCase();

  if (provider === 'none' || provider === 'off') {
    return { tts: null, unavailableReason: 'Speech is turned off (AXON_TTS_PROVIDER=none).' };
  }

  if (provider !== 'sapi') {
    return {
      tts: null,
      // Echoes a configured value, which is the user's own input and never a
      // secret — but it is bounded so a pathological value cannot flood the UI.
      unavailableReason: `Unknown speech provider "${provider.slice(0, 32)}". Axon will not speak.`,
    };
  }

  const tts = new SapiTextToSpeech({ platform: options.platform });

  if (!tts.isAvailable()) {
    return {
      tts: null,
      unavailableReason: 'Windows speech synthesis is unavailable on this system, so Axon will not speak.',
    };
  }

  return { tts, unavailableReason: null };
}
