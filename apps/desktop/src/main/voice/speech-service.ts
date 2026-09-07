/**
 * The speech service — one utterance at a time, and main stays in charge.
 *
 * Sits between the orchestrator and a `TextToSpeech` implementation:
 *
 *     Orchestrator -> SpeechService -> TextToSpeech -> audio bytes
 *                          |
 *                          +-> deliver(bytes) -> renderer plays + analyses
 *
 * WHY MAIN RUNS A WATCHDOG.
 *
 * The renderer tells us when playback ends, which is what makes the UI feel
 * immediate. But the renderer is the untrusted side of this application, and
 * "Axon is speaking" is a state it must not be able to pin. So every utterance
 * also gets a deadline computed from the *audio main itself synthesised* —
 * its real duration, parsed out of the WAV, plus a grace margin. Whichever
 * comes first, the report or the deadline, ends the utterance.
 *
 * The consequence is the property Step 3 asked for: Axon cannot get stuck in
 * SPEAKING. Not because the renderer is well behaved, but because nothing it
 * does or fails to do can extend the deadline.
 */

import { randomUUID } from 'node:crypto';
import {
  SPEECH_LIMITS,
  type SpeechDelivery,
  type SpeechEndReason,
  type SpeechMimeType,
  type SpeechStatus,
  type TextToSpeech,
} from '@axon/core';
import { prepareSpeech } from './speech-text.js';
import { parseWav } from './wav.js';

/** What the service needs from the world around it. */
export interface SpeechServiceOptions {
  readonly tts: TextToSpeech | null;
  /** Hands one utterance to every open window. */
  deliver(delivery: SpeechDelivery): void;
  /** Asks the renderer to stop an utterance it is playing. */
  stopPlayback(speechId: string): void;
  /** Called when an utterance begins. The orchestrator enters SPEAKING here. */
  onStarted(info: SpeechStartedInfo): void;
  /** Called exactly once per utterance, whatever the outcome. */
  onEnded(speechId: string, reason: SpeechEndReason): void;
  /** Non-fatal problems, for the timeline. Never carries provider internals. */
  onFailure(message: string): void;
  readonly unavailableReason?: string | null;
  readonly graceMs?: number;
  readonly newSpeechId?: () => string;
}

export interface SpeechStartedInfo {
  readonly speechId: string;
  readonly characters: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

interface ActiveUtterance {
  readonly speechId: string;
  readonly synthesis: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** True once the outcome has been reported; guards double-settlement. */
  settled: boolean;
  /** False until the audio has actually been handed to the renderer. */
  delivered: boolean;
}

export class SpeechService {
  private readonly tts: TextToSpeech | null;
  private readonly options: SpeechServiceOptions;
  private readonly graceMs: number;
  private readonly newSpeechId: () => string;

  private active: ActiveUtterance | null = null;

  /**
   * Whether the user wants Axon to speak.
   *
   * Separate from whether a synthesiser exists: "turned off" and "unavailable"
   * are different states, and the UI says which. Changing it takes effect on
   * the next utterance rather than at the next launch.
   */
  private enabled = true;

  constructor(options: SpeechServiceOptions) {
    this.options = options;
    this.tts = options.tts;
    this.graceMs = options.graceMs ?? SPEECH_LIMITS.playbackGraceMs;
    this.newSpeechId = options.newSpeechId ?? ((): string => randomUUID());
  }

  /** Turn speaking on or off. Stops anything in flight when turning off. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel('cancelled');
  }

  /** Whether Axon can speak. Carries a provider name, never a credential. */
  status(): SpeechStatus {
    const available = this.enabled && this.tts !== null && this.tts.isAvailable();
    return {
      available,
      name: this.tts?.name ?? 'none',
      reason: available
        ? null
        : (!this.enabled
            ? 'Speaking is turned off in settings.'
            : this.options.unavailableReason ??
          (this.tts === null
            ? 'No speech synthesiser is configured, so Axon will not speak.'
            : `${this.tts.name} is not available on this system, so Axon will not speak.`)),
    };
  }

  get speaking(): boolean {
    return this.active !== null;
  }

  /**
   * Speak one reply.
   *
   * Resolves when the utterance has *begun* — not when it finishes. Playback
   * completion arrives later through `onEnded`, because a turn should not hold
   * an await open for the length of a sentence, and because the renderer, the
   * watchdog and a cancellation all have to be able to end it.
   *
   * Returns false when nothing was spoken: no synthesiser, nothing to say, or
   * synthesis failed. A false here is never an error the user must see — Axon
   * simply stays silent, and the reply is still on screen.
   */
  async speak(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (!this.tts || !this.tts.isAvailable()) return false;

    const prepared = prepareSpeech(text);
    if (prepared.text === '') return false;

    // One voice at a time. A second utterance replaces the first rather than
    // overlapping it, which is what a person would expect and what keeps the
    // amplitude signal meaningful.
    this.cancel('cancelled');

    const utterance: ActiveUtterance = {
      speechId: this.newSpeechId(),
      synthesis: new AbortController(),
      timer: null,
      settled: false,
      delivered: false,
    };
    this.active = utterance;

    let audio;
    try {
      audio = await this.tts.synthesize(prepared.text, utterance.synthesis.signal);
    } catch (error) {
      // Cancellation during synthesis is not a failure to report; `cancel`
      // has already settled this utterance.
      if (utterance.settled) return false;
      this.settle(utterance, 'failed');
      this.options.onFailure(describeSynthesisFailure(error));
      return false;
    }

    // Cancelled while synthesis was in flight: throw the audio away rather
    // than starting playback the user already asked to stop.
    if (utterance.settled || this.active !== utterance) return false;

    let durationMs: number;
    try {
      durationMs = parseWav(audio.bytes).durationMs;
    } catch (error) {
      this.settle(utterance, 'failed');
      this.options.onFailure(
        error instanceof Error ? error.message : 'Axon produced audio it could not verify, so it stayed silent.',
      );
      return false;
    }

    const delivery: SpeechDelivery = {
      speechId: utterance.speechId,
      mimeType: audio.mimeType as SpeechMimeType,
      sampleRate: audio.sampleRate,
      bytes: audio.bytes,
      durationMs,
    };

    utterance.delivered = true;

    // The deadline is set BEFORE delivery. If the renderer never answers —
    // because it crashed, or because it chose not to — the utterance still
    // ends on its own.
    utterance.timer = setTimeout(() => {
      this.settle(utterance, 'timeout');
    }, durationMs + this.graceMs);
    if (typeof utterance.timer.unref === 'function') utterance.timer.unref();

    this.options.onStarted({
      speechId: utterance.speechId,
      characters: prepared.characters,
      durationMs,
      truncated: prepared.truncated,
    });

    this.options.deliver(delivery);
    return true;
  }

  /**
   * The renderer's advisory report.
   *
   * Ignored unless it names the utterance actually in flight, so a stale or
   * fabricated id cannot end the current one.
   */
  report(speechId: string, status: 'started' | 'ended' | 'failed'): void {
    const utterance = this.active;
    if (!utterance || utterance.speechId !== speechId || utterance.settled) return;

    if (status === 'ended') this.settle(utterance, 'completed');
    else if (status === 'failed') {
      this.settle(utterance, 'failed');
      this.options.onFailure('Axon could not play its voice audio.');
    }
    // 'started' is informational; the deadline is already running.
  }

  /**
   * Stop speaking.
   *
   * Aborts synthesis if it is still running, tells the renderer to stop if
   * audio was already delivered, and settles the utterance. Returns false when
   * there was nothing to stop.
   */
  cancel(reason: SpeechEndReason = 'cancelled'): boolean {
    const utterance = this.active;
    if (!utterance || utterance.settled) return false;

    utterance.synthesis.abort();
    if (utterance.delivered) this.options.stopPlayback(utterance.speechId);
    this.settle(utterance, reason);
    return true;
  }

  /** Release everything. Safe to call more than once. */
  shutdown(): void {
    this.cancel('cancelled');
  }

  /**
   * End an utterance exactly once.
   *
   * Every path out — completion, timeout, cancellation, failure — comes
   * through here, so the timer is always cleared and `onEnded` always fires
   * once. That single-settlement property is what stops a stuck SPEAKING
   * state and an orphaned timer.
   */
  private settle(utterance: ActiveUtterance, reason: SpeechEndReason): void {
    if (utterance.settled) return;
    utterance.settled = true;

    if (utterance.timer) {
      clearTimeout(utterance.timer);
      utterance.timer = null;
    }
    if (this.active === utterance) this.active = null;

    this.options.onEnded(utterance.speechId, reason);
  }
}

/**
 * A user-facing sentence for a synthesis failure.
 *
 * Provider internals — exit codes, stderr, local paths — stay in the log. What
 * reaches the timeline says what happened and nothing about where Axon lives
 * on disk.
 */
export function describeSynthesisFailure(error: unknown): string {
  const kind = (error as { kind?: string } | null)?.kind;
  switch (kind) {
    case 'UNAVAILABLE':
      return 'Axon could not reach the system speech synthesiser, so it stayed silent.';
    case 'TIMEOUT':
      return 'Speech synthesis took too long, so Axon stayed silent.';
    case 'CANCELLED':
      return 'Speech was cancelled.';
    case 'EMPTY':
      return 'There was nothing for Axon to say.';
    case 'TOO_LARGE':
      return 'That reply was too long to speak.';
    case 'MALFORMED':
      return 'Axon produced audio it could not verify, so it stayed silent.';
    case 'PROVIDER':
      return 'The system speech synthesiser failed, so Axon stayed silent.';
    default:
      return 'Axon could not speak that reply.';
  }
}
