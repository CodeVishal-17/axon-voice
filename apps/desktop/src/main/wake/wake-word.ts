/**
 * Listening for Axon's name, on this machine.
 *
 * THIS FILE IS THE PRIVACY GUARANTEE.
 *
 * Axon's promise is that microphone audio stays local until a person activates
 * a session. The wake word is what makes that promise keepable while still
 * being hands-free: the microphone is open, and the audio goes to a local
 * recognizer and nowhere else. No socket exists, no bytes are sent, nothing is
 * written to disk, and nothing is logged. The only thing that escapes this
 * class is a single boolean event — "somebody said the name" — and it carries
 * no text with it.
 *
 * That last detail matters more than it looks. If a wake-word detector emitted
 * the transcripts it rejected, it would be a continuous local transcription
 * service quietly filling an event log with everything said near the machine.
 * `onWake` takes no arguments for exactly that reason.
 *
 * WHAT ACTIVATION MEANS.
 *
 *     armed   -> microphone open, audio to a LOCAL recognizer only
 *     woken   -> the user has activated a session; audio may now be streamed
 *     asleep  -> microphone closed
 *
 * The transition from armed to woken is the moment audio starts leaving the
 * machine, and it happens here, on a phrase a person said deliberately.
 *
 * THE TRADE-OFF, STATED PLAINLY.
 *
 * This runs the same offline dictation recognizer Step 4 uses, and matches its
 * output against three phrases. A purpose-built wake-word engine (a constrained
 * grammar, or a small neural spotter) would use less CPU and would not need to
 * transcribe anything it is not listening for. The reason this design was
 * chosen anyway is that it adds NO new subprocess, no new native dependency,
 * no new model download and no second audio path to audit — it reuses a
 * recognizer whose security properties are already established and tested.
 * The cost is CPU on an idle desktop; the benefit is that the surface which
 * could leak audio does not grow at all. If the CPU cost becomes a problem,
 * the replacement is a constrained grammar in `windows-stt.ts`, and nothing
 * above this file changes.
 */

import { LISTENING_LIMITS, type SpeechToText, type SpeechToTextSession } from '@axon/core';

/**
 * The phrases, in full.
 *
 * Exactly three, and deliberately not configurable. A configurable wake phrase
 * is a string from outside deciding when a microphone starts uploading, and
 * there is no version of that which is worth the flexibility.
 */
export const WAKE_PHRASES: readonly string[] = ['hey axon', 'hello axon', 'hi axon'];

/**
 * What a recognizer might plausibly hear instead of "axon".
 *
 * Speech recognizers do not know the word, and a wake word that only fires on
 * a perfect transcription is a wake word that does not fire. These are the
 * near-misses an English dictation engine actually produces for the name;
 * each one is only accepted directly after a greeting, so the greeting is
 * carrying most of the precision.
 */
const NAME_VARIANTS: readonly string[] = [
  'axon',
  'axion',
  'access on',
  'axe on',
  'acts on',
  'ax on',
  'action', // common, and only reachable after "hey"/"hi"/"hello"
  'axons',
  // Measured, not guessed: feeding a synthesised "Hey Axon" through
  // `System.Speech.Recognition` produced "A Exxon". The name half is worth
  // accepting; the greeting half is not — see below.
  'exxon',
];

/**
 * Greetings, and why this list is not widened to fix the case above.
 *
 * The same measurement that produced "exxon" also showed the recognizer
 * hearing "hey" as "a". Adding "a" here would make the phrase match — and
 * would also make the most common word in English the first half of Axon's
 * wake phrase. "A action", "a accent on", and a hundred ordinary sentences
 * would start uploading a microphone.
 *
 * So the greeting requirement stays strict. A wake word that occasionally
 * misses is a feature that occasionally needs repeating; a wake word that
 * occasionally fires is a microphone that occasionally uploads a room, and
 * those two failures are not comparable.
 */

const GREETINGS: readonly string[] = ['hey', 'hello', 'hi'];

/**
 * Normalize a transcript for matching.
 *
 * Lowercase, strip punctuation, collapse whitespace. Nothing here retains the
 * text: the caller discards it immediately, and this function exists so the
 * comparison is not defeated by "Hey, Axon!".
 */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this transcript contain the wake phrase?
 *
 * PURE, and the most heavily tested function in this subsystem — because both
 * of its failure modes are bad in different ways. A false negative is a
 * feature that does not work. A false positive is a microphone that starts
 * uploading because the television said something, which is a privacy
 * failure. The greeting requirement is what keeps the second rare: "axon"
 * alone never wakes it, and the name has to arrive directly after a greeting.
 */
export function matchesWakePhrase(text: string): boolean {
  const normalized = normalizePhrase(text);
  if (normalized === '') return false;

  // The exact phrases first, as a fast path and as the documented contract.
  for (const phrase of WAKE_PHRASES) {
    if (normalized === phrase || normalized.startsWith(`${phrase} `) || normalized.includes(` ${phrase}`)) {
      return true;
    }
  }

  // Then greeting + a plausible hearing of the name, ADJACENT. Requiring
  // adjacency is what stops "hi, I was reading about axons in biology" from
  // opening a socket.
  const words = normalized.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined || !GREETINGS.includes(word)) continue;

    const rest = words.slice(i + 1).join(' ');
    for (const variant of NAME_VARIANTS) {
      if (rest === variant || rest.startsWith(`${variant} `)) return true;
    }
  }

  return false;
}

export interface WakeWordOptions {
  /** The local recognizer. Null means no wake word is possible. */
  readonly stt: SpeechToText | null;
  /** Fires when the phrase is heard. Takes NO transcript — see the header. */
  onWake(): void;
  /** Armed or disarmed, for the UI and the audit trail. */
  onArmedChanged(armed: boolean): void;
  /** A problem worth showing, phrased for a person. */
  onNotice(message: string): void;
  /**
   * How long one local recognition window runs before being recycled.
   *
   * The recognizer is restarted periodically rather than run forever: a
   * long-lived engine accumulates state, and a bounded window means a
   * recognizer that wedges recovers on its own rather than leaving Axon
   * silently deaf.
   */
  readonly windowMs?: number;
}

const DEFAULT_WINDOW_MS = 60_000;

/**
 * A local wake-word detector.
 *
 * Owns a recognizer session and nothing else. It does not own the microphone —
 * main opens that, through the same capture command Step 4 built — and it does
 * not decide what happens when the phrase is heard. It says "now", once.
 */
export class WakeWordDetector {
  private readonly options: WakeWordOptions;
  private readonly windowMs: number;

  private session: SpeechToTextSession | null = null;
  private armed = false;
  private recycling: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a stale session's transcript waking a disarmed detector. */
  private generation = 0;

  constructor(options: WakeWordOptions) {
    this.options = options;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get available(): boolean {
    return this.options.stt !== null && this.options.stt.isAvailable();
  }

  /** Begin listening locally. Idempotent. */
  async arm(): Promise<boolean> {
    if (this.armed) return true;
    if (!this.available) {
      this.options.onNotice('Axon cannot listen for a wake phrase: no local recognizer is available.');
      return false;
    }

    this.armed = true;
    this.options.onArmedChanged(true);
    await this.openWindow();
    return true;
  }

  /** Stop listening locally. Idempotent, and reached from every exit. */
  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.generation += 1;

    if (this.recycling) clearTimeout(this.recycling);
    this.recycling = null;

    const session = this.session;
    this.session = null;
    session?.close();

    this.options.onArmedChanged(false);
  }

  /**
   * One frame of microphone audio.
   *
   * Straight to the local recognizer. Note what this method does not do: it
   * does not log, does not emit, does not buffer and does not return anything.
   * The frame's entire journey through the wake word is this line.
   */
  pushFrame(frame: Int16Array): void {
    if (!this.armed) return;
    if (frame.length === 0 || frame.length > LISTENING_LIMITS.maxFrameSamples) return;
    this.session?.push(frame);
  }

  // --- internals ----------------------------------------------------------

  private async openWindow(): Promise<void> {
    const stt = this.options.stt;
    if (!stt || !this.armed) return;

    const generation = this.generation;

    try {
      const session = await stt.start((chunk) => {
        // Interim results are ignored: a phrase the recognizer is still
        // revising is not a phrase somebody said.
        if (!chunk.isFinal) return;
        if (generation !== this.generation || !this.armed) return;
        // `chunk.text` is read, matched, and dropped. It is never stored,
        // emitted, logged or passed on — `onWake` takes no argument.
        if (matchesWakePhrase(chunk.text)) this.options.onWake();
      });

      if (generation !== this.generation || !this.armed) {
        session.close();
        return;
      }
      this.session = session;
    } catch {
      // A recognizer that will not start is reported once, not repeatedly:
      // an assistant that complains every sixty seconds is worse than one
      // that is quietly not listening and says so in the UI.
      this.armed = false;
      this.options.onArmedChanged(false);
      this.options.onNotice('Axon could not start listening for the wake phrase.');
      return;
    }

    this.recycling = setTimeout(() => {
      void this.recycle();
    }, this.windowMs);
    if (typeof this.recycling.unref === 'function') this.recycling.unref();
  }

  /** Close the current recognition window and open a fresh one. */
  private async recycle(): Promise<void> {
    if (!this.armed) return;
    const session = this.session;
    this.session = null;
    this.generation += 1;

    try {
      await session?.end();
    } catch {
      /* a window that failed to close cleanly is still closed */
    }
    session?.close();

    await this.openWindow();
  }
}
