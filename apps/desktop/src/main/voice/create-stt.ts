/**
 * Choosing a speech recognizer.
 *
 * The single place a provider is named. Everything above depends on the
 * `SpeechToText` interface, so adding Whisper or a cloud recognizer later is a
 * new adapter beside `windows-stt.ts` and an arm in this switch — the
 * listening service, the orchestrator, the renderer and the brain are
 * untouched by it.
 *
 * WHY WINDOWS SPEECH, AND NOT THE ALTERNATIVES.
 *
 * Local, Windows built-in (`System.Speech.Recognition`) — CHOSEN.
 *   Ships with the OS. No API key, no account, no model download, no native
 *   compilation, no network. The audio never leaves the machine, which
 *   collapses an entire security surface: there is no endpoint to pin, no
 *   transport to secure, no key to keep out of the renderer and no third party
 *   to trust with a recording of someone's home. Measured on this machine at
 *   roughly a quarter-second from end-of-speech to transcript, because the
 *   engine is loaded while the user is still speaking. Accuracy on
 *   command-shaped utterances is good; on long free-form dictation it is
 *   noticeably worse than Whisper. That trade is the right one here — Axon's
 *   input is short instructions, and the model is what interprets them.
 *
 * Local Whisper (whisper.cpp bindings) — REJECTED for this milestone.
 *   Better accuracy, and the node bindings require a native build toolchain
 *   plus a model download of a few hundred megabytes. The environment note for
 *   this step is explicit that native audio dependencies are not to be fought
 *   with, and a recognizer that fails to compile on the demo machine is worth
 *   less than a slightly worse one that always works. It remains the obvious
 *   upgrade, and this file is where it would land.
 *
 * Cloud (Deepgram, OpenAI) — REJECTED for this milestone.
 *   Best accuracy, and it would send microphone audio off the machine, add a
 *   second credential to defend, add a network failure mode to a path that is
 *   currently deterministic, and make Axon's privacy story conditional on
 *   someone else's data policy. For a voice assistant that listens in a
 *   person's home, "the audio never leaves the device" is a feature, not a
 *   compromise.
 *
 * Browser Web Speech API — NOT AVAILABLE. Electron's Chromium has no working
 * `webkitSpeechRecognition`; it is bound to a Google endpoint keyed to Chrome
 * itself.
 *
 * Absence is a normal state, not a failure: with no recognizer Axon runs, does
 * not offer to listen, and says why.
 */

import type { SpeechToText } from '@axon/core';
import { WindowsSpeechToText } from './windows-stt.js';

export interface SttFactoryOptions {
  readonly platform: NodeJS.Platform;
  /** `AXON_STT_PROVIDER`: 'windows' (default) or 'none' to disable listening. */
  readonly provider: string | undefined;
}

export interface SttCreation {
  readonly stt: SpeechToText | null;
  /** Why Axon will not listen. Null when it will. Never a path or a key. */
  readonly unavailableReason: string | null;
}

export function createSpeechToText(options: SttFactoryOptions): SttCreation {
  const provider = (options.provider ?? 'windows').trim().toLowerCase();

  if (provider === 'none' || provider === 'off') {
    return { stt: null, unavailableReason: 'Voice input is turned off (AXON_STT_PROVIDER=none).' };
  }

  if (provider !== 'windows') {
    return {
      stt: null,
      // Echoes a configured value, which is the user's own input and never a
      // secret — but it is bounded so a pathological value cannot flood the UI.
      unavailableReason: `Unknown speech recognizer "${provider.slice(0, 32)}". Axon will not listen.`,
    };
  }

  const stt = new WindowsSpeechToText({ platform: options.platform });

  if (!stt.isAvailable()) {
    return {
      stt: null,
      unavailableReason:
        stt.unavailableReason() ?? 'Windows speech recognition is unavailable on this system, so Axon cannot listen.',
    };
  }

  return { stt, unavailableReason: null };
}
