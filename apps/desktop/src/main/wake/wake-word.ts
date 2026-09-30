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
 * class is a single signal — "somebody said the name" — and `onWake` carries
 * no text with it.
 *
 * This file imports nothing but `@axon/core`, and that is a rule with a test:
 * everything the wake word can reach is visible in its one import line. The
 * voice activity detector it segments audio with is therefore handed in by
 * the runtime rather than imported here.
 *
 * WHAT ACTIVATION MEANS.
 *
 *     armed   -> microphone open, audio to a LOCAL recognizer only
 *     woken   -> the user has activated a session; audio may now be streamed
 *     asleep  -> microphone closed
 *
 * HOW IT HEARS, AND WHY IT CHANGED.
 *
 * The first design ran one sixty-second recognition window at a time. The
 * Windows recognizer is BATCH — it reads all of its audio, then recognises —
 * so a phrase was only recognised when its window closed, up to a minute after
 * it was said. Worse, a session accepts at most twenty-five seconds of audio,
 * so anything said in the last thirty-five seconds of a window was silently
 * dropped. And it listened with free dictation, which does not know the word
 * "axon" and turned "Hey Axon" into "A Exxon". Together: on a real
 * microphone, the wake word almost never worked.
 *
 * Now the audio is cut into UTTERANCES here. Silence reaches no recognizer at
 * all. When somebody starts speaking, that utterance — with the few hundred
 * milliseconds before the onset, so the start of "hey" is not clipped — goes to
 * a recognizer that is already warm, and it is recognised as soon as they
 * pause. That is the two-stage design: a cheap local activity detector first,
 * then a constrained recognizer that only ever judges one short utterance.
 *
 * The recognizer listens with Axon's fixed wake grammar against a grammar of
 * near-miss sound-alikes, and WITHOUT free dictation (see `windows-stt.ts` for
 * the measurement, including the human microphone test that showed dictation
 * beating the wake grammar). Only a result from the wake grammar, above a
 * confidence floor, wakes Axon.
 *
 * AND THE PHRASE MUST BE THE UTTERANCE. A recognizer with a small grammar
 * finds the nearest thing it knows inside a longer sentence: measured, "I was
 * talking about Axon yesterday" came back as "hi axon", stretched over 1.9
 * seconds of the sentence. So a wake-grammar match is also checked against the
 * audio it came from — the phrase may not span longer than two words take, and
 * there may not be more than half a second of speech outside it. What is
 * compared is timing and a voiced/unvoiced flag per frame, never the audio.
 * "Hey Axon" on its own wakes Axon; "Hey Axon, open Calculator" in one breath
 * does not — say the name, then the request.
 *
 * What is held in memory, and for how long: the last 0.4 seconds of audio
 * while nobody is speaking, and at most three seconds of one utterance while
 * it is handed to the local recognizer. Nothing is kept past that, and none of
 * it is ever written anywhere.
 */

import { LISTENING_LIMITS, type SpeechToText, type SpeechToTextSession, type TranscriptChunk } from '@axon/core';

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
 * Used ONLY for providers that cannot say which grammar produced a result.
 * The Windows recognizer can, and for it the wake grammar does the hearing —
 * see `decideWake`. Each variant is only accepted directly after a greeting,
 * so the greeting is carrying most of the precision.
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
  // Measured, not guessed: feeding a synthesised "Hey Axon" through free
  // dictation produced "A Exxon".
  'exxon',
];

/**
 * Greetings, and why this list is not widened.
 *
 * Dictation also heard "hey" as "a". Adding "a" here would make the most
 * common word in English the first half of Axon's wake phrase. The fix for
 * mis-hearing is the wake grammar, not a looser text match: a wake word that
 * occasionally fires is a microphone that occasionally uploads a room.
 */
const GREETINGS: readonly string[] = ['hey', 'hello', 'hi'];

/**
 * The lowest recognizer confidence that may wake Axon.
 *
 * Measured on the Windows recognizer with the wake grammar against the
 * near-miss grammar: genuine wake phrases scored 0.66-0.95 on synthesised
 * voices. Non-wake speech did not reach the wake grammar at all in that
 * measurement — the near-miss grammar caught it — so the floor is a second
 * line, not the first. It exists for a noisy room where the acoustic match is
 * poor enough that a grammar result is closer to a guess than a hearing.
 * `npm run wake:live` prints the confidence of every attempt, so a floor that
 * is wrong for a real voice shows up as a number rather than as a mystery.
 */
export const WAKE_MIN_CONFIDENCE = 0.5;

/**
 * How the runtime should configure the activity detector it hands in.
 *
 * Shorter trailing silence than push-to-talk, because a wake phrase is two
 * words; and no timeouts measured from arming, because the detector runs for
 * as long as Axon is armed. The utterance ceiling is enforced per utterance,
 * below.
 */
export const WAKE_ACTIVITY_OPTIONS = {
  silenceMs: 500,
  speechStartTimeoutMs: Number.POSITIVE_INFINITY,
  maxUtteranceMs: Number.POSITIVE_INFINITY,
} as const;

/** The part of a voice activity detector the wake word uses. */
export interface ActivityDetector {
  /** `level` is the frame's RMS on the same 0..1 scale as `threshold`, where the detector reports it. */
  push(frame: Int16Array): { readonly event: string; readonly level?: number };
  /** The current speech threshold, for debug reporting. */
  readonly threshold: number;
}

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
 * uploading because the television said something. The greeting requirement is
 * what keeps the second rare: "axon" alone never wakes it, and the name has to
 * arrive directly after a greeting.
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

export interface WakeDecision {
  readonly wake: boolean;
  /** Why, in words a developer can read in debug mode. Never shown to users. */
  readonly reason: string;
}

/**
 * Should this recognition result wake Axon?
 *
 * PURE. Three kinds of provider result, three rules:
 *
 * - From the WAKE GRAMMAR: it wakes when it is one of the three phrases and the
 *   recognizer's confidence is at or above the floor.
 * - From the NEAR-MISS GRAMMAR: never. It exists to catch what only sounds
 *   like the wake phrase.
 * - From DICTATION (a provider that transcribes freely): it wakes only if the
 *   whole utterance is exactly one of the three phrases — never a sentence
 *   that merely contains one, and never a fuzzy variant.
 * - From a provider that does not say (tests, other recognizers): the text
 *   matcher above, unchanged.
 */
export function decideWake(chunk: TranscriptChunk): WakeDecision {
  if (!chunk.isFinal) return { wake: false, reason: 'an interim result' };

  const confident = chunk.confidence === null || chunk.confidence >= WAKE_MIN_CONFIDENCE;
  const normalized = normalizePhrase(chunk.text);

  if (chunk.source === 'wake-phrase') {
    if (!WAKE_PHRASES.includes(normalized)) {
      return { wake: false, reason: 'the wake grammar returned something that is not a wake phrase' };
    }
    if (!confident) {
      return { wake: false, reason: `confidence below ${WAKE_MIN_CONFIDENCE.toFixed(2)}` };
    }
    return { wake: true, reason: 'the wake grammar matched' };
  }

  if (chunk.source === 'near-miss') {
    return { wake: false, reason: 'a near-miss sound-alike, not the wake phrase' };
  }

  if (chunk.source === 'dictation') {
    if (WAKE_PHRASES.includes(normalized) && confident) {
      return { wake: true, reason: 'dictation heard exactly a wake phrase' };
    }
    return { wake: false, reason: 'ordinary speech, not a wake phrase' };
  }

  return matchesWakePhrase(chunk.text)
    ? { wake: true, reason: 'the text matched a wake phrase' }
    : { wake: false, reason: 'the text is not a wake phrase' };
}

/** One stretch of an utterance's audio, and whether it carried speech. Lengths and flags, never samples. */
export interface VoicedStretch {
  readonly samples: number;
  readonly voiced: boolean;
}

/**
 * The longest a two-word wake phrase may take.
 *
 * Measured on the Windows recognizer: genuine "Hey / Hello / Hi Axon" spanned
 * 880-1110 ms across two synthesised voices; the false match found inside "I
 * was talking about Axon yesterday" spanned 1890 ms. The ceiling sits well
 * above the first and below the second.
 */
export const MAX_PHRASE_SPAN_MS = 1_500;

/**
 * The most voiced audio allowed outside the matched phrase.
 *
 * Measured: "Hey Axon, open calculator" matched the phrase in under a second
 * and left about 1.7 seconds of speech after it.
 */
export const MAX_SPEECH_OUTSIDE_PHRASE_MS = 500;

/** With no timing from the recognizer, the most voiced audio an utterance may hold and still be only a wake phrase. */
export const MAX_VOICED_WITHOUT_SPAN_MS = 1_600;

/** Slack either side of the phrase for the recognizer's own alignment. */
const PHRASE_EDGE_MARGIN_MS = 200;

const TIMELINE_RATE = LISTENING_LIMITS.sampleRate;

/** Total voiced audio in a timeline, in milliseconds. */
export function voicedMs(timeline: readonly VoicedStretch[]): number {
  let samples = 0;
  for (const stretch of timeline) if (stretch.voiced) samples += stretch.samples;
  return Math.round((samples / TIMELINE_RATE) * 1000);
}

/** Voiced audio that lies outside the phrase (plus its alignment slack), in milliseconds. */
export function speechOutsidePhraseMs(
  timeline: readonly VoicedStretch[],
  span: { readonly startMs: number; readonly durationMs: number },
): number {
  const from = span.startMs - PHRASE_EDGE_MARGIN_MS;
  const to = span.startMs + span.durationMs + PHRASE_EDGE_MARGIN_MS;
  let offset = 0;
  let outside = 0;
  for (const stretch of timeline) {
    const start = (offset / TIMELINE_RATE) * 1000;
    offset += stretch.samples;
    const end = (offset / TIMELINE_RATE) * 1000;
    if (!stretch.voiced) continue;
    const inside = Math.max(0, Math.min(end, to) - Math.max(start, from));
    outside += end - start - inside;
  }
  return Math.round(outside);
}

export interface PhraseCoverage {
  readonly ok: boolean;
  /** Why, for debug mode. */
  readonly reason: string;
  /** The measurement, for debug mode. */
  readonly note: string;
}

/**
 * Was the wake phrase the whole utterance?
 *
 * PURE, and it can only refuse: it is applied after the wake grammar has
 * already matched, and it never turns a non-match into a wake.
 */
export function judgePhraseCoverage(
  timeline: readonly VoicedStretch[],
  span: { readonly startMs: number; readonly durationMs: number } | undefined,
): PhraseCoverage {
  if (!span) {
    const voiced = voicedMs(timeline);
    const note = `(no timing from the recognizer; ${voiced}ms of speech)`;
    return voiced > MAX_VOICED_WITHOUT_SPAN_MS
      ? { ok: false, reason: 'the utterance held more speech than a wake phrase', note }
      : { ok: true, reason: 'the wake grammar matched a short utterance', note };
  }
  const outside = speechOutsidePhraseMs(timeline, span);
  const note = `(phrase at ${span.startMs}+${span.durationMs}ms, ${outside}ms of speech outside it)`;
  if (span.durationMs > MAX_PHRASE_SPAN_MS) {
    return { ok: false, reason: 'the match was stretched over more audio than the phrase takes', note };
  }
  if (outside > MAX_SPEECH_OUTSIDE_PHRASE_MS) {
    return { ok: false, reason: 'the wake phrase was part of longer speech', note };
  }
  return { ok: true, reason: 'the wake grammar matched, and the phrase was the whole utterance', note };
}

export interface WakeWordOptions {
  /** The local recognizer. Null means no wake word is possible. */
  readonly stt: SpeechToText | null;
  /**
   * A fresh voice activity detector, configured with `WAKE_ACTIVITY_OPTIONS`.
   *
   * Handed in rather than imported, so this file's only import stays
   * `@axon/core`. One detector serves one utterance; a new one is asked for
   * after each.
   */
  readonly activity: () => ActivityDetector;
  /** Fires when the phrase is heard. Takes NO transcript — see the header. */
  onWake(): void;
  /** Armed or disarmed, for the UI and the audit trail. */
  onArmedChanged(armed: boolean): void;
  /** A problem worth showing, phrased for a person. */
  onNotice(message: string): void;
  /**
   * How long a warm, idle recognizer is kept before it is replaced.
   *
   * A long-lived engine accumulates state, and a bounded lifetime means a
   * recognizer that wedges recovers on its own rather than leaving Axon
   * silently deaf.
   */
  readonly windowMs?: number;
  /**
   * Developer diagnostics: what was heard, and why it did or did not wake.
   *
   * Absent — the default — means silent. The runtime supplies it only in a
   * development build with AXON_WAKE_DEBUG=1, and routes it to the developer
   * console: never to the event log, never over IPC. Lines carry recognised
   * text and levels, never audio.
   */
  readonly debug?: ((line: string) => void) | null;
  /** Wall clock, injected in tests. */
  readonly now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;

/** How each result source is named in debug output. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'wake-phrase': 'WAKE GRAMMAR',
  'near-miss': 'NEAR-MISS GRAMMAR',
  dictation: 'DICTATION',
};

/** The longest utterance handed to the recognizer. A wake phrase is well under a second. */
const MAX_UTTERANCE_MS = 3_000;
/** Audio kept from just before speech is detected, so the first syllable is not clipped. */
const PRE_ROLL_MS = 400;
/** A gap this long between frames means the capture paused; nothing spans it. */
const FRAME_GAP_MS = 1_000;
/** How often debug mode reports the microphone level. */
const LEVEL_REPORT_MS = 5_000;

const SAMPLE_RATE = LISTENING_LIMITS.sampleRate;
const MAX_UTTERANCE_SAMPLES = (SAMPLE_RATE * MAX_UTTERANCE_MS) / 1000;
const PRE_ROLL_SAMPLES = (SAMPLE_RATE * PRE_ROLL_MS) / 1000;

interface Utterance {
  /** Frames waiting for the recognizer to finish warming. Bounded by the utterance ceiling. */
  readonly pending: Int16Array[];
  /** Whether each stretch of this utterance was voiced, in the order it was sent. Flags, never samples. */
  readonly timeline: VoicedStretch[];
  samples: number;
  ended: boolean;
  abandoned: boolean;
}

/** Which utterance a recognizer's results belong to, once it has been given one. */
interface SessionBinding {
  utterance: Utterance | null;
}

/** Root-mean-square level of a frame, 0..1. For debug reporting only. */
function levelOf(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = (frame[i] ?? 0) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * A local wake-word detector.
 *
 * Owns its recognizer sessions and nothing else. It does not own the
 * microphone — main opens that, through the same capture command every other
 * consumer uses — and it does not decide what happens when the phrase is
 * heard. It says "now", once.
 */
export class WakeWordDetector {
  private readonly options: WakeWordOptions;
  private readonly windowMs: number;
  private readonly now: () => number;

  private armed = false;
  /** Whether the recognizer's own description has been logged since arming. */
  private describedRecognizer = false;
  /** Guards against a stale session's result waking a disarmed detector. */
  private generation = 0;

  /** The warm recognizer the next utterance will use. */
  private spare: Promise<SpeechToTextSession | null> | null = null;
  /** The utterance the warm spare will serve, bound when speech starts. */
  private spareBinding: SessionBinding | null = null;
  /** The recognizer the current utterance is being fed to, once it is warm. */
  private session: SpeechToTextSession | null = null;
  /** Every recognizer process this detector has open, so every exit can close them. */
  private readonly open = new Set<SpeechToTextSession>();
  private recycling: ReturnType<typeof setTimeout> | null = null;

  private vad: ActivityDetector;
  private utterance: Utterance | null = null;
  private preRoll: Int16Array[] = [];
  private preRollTimeline: VoicedStretch[] = [];
  private preRollSamples = 0;
  private lastFrameAt = 0;

  private framesSinceArm = 0;
  private peakLevel = 0;
  private lastLevelReportAt = 0;

  constructor(options: WakeWordOptions) {
    this.options = options;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.vad = options.activity();
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get available(): boolean {
    return this.options.stt !== null && this.options.stt.isAvailable();
  }

  /**
   * What is listening, and whether it is well.
   *
   * Part of the `WakeDetector` seam that this class and the keyword spotter
   * share. The return type is written out rather than imported because this
   * file's import line is a guarantee — `architecture.test.ts` holds that it
   * says `@axon/core` and nothing else — and TypeScript checks structurally, so
   * `wake-detector.test.ts` can assert this class satisfies the interface
   * without a single import crossing into here.
   */
  getStatus(): {
    readonly engine: 'windows-speech';
    readonly detail: string;
    readonly armed: boolean;
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly restarts: number;
    readonly starvedOfAudio: boolean;
  } {
    const available = this.available;
    return {
      engine: 'windows-speech',
      detail: `Windows speech recognizer with the fixed wake grammar (${this.options.stt?.name ?? 'no recognizer'})`,
      armed: this.armed,
      available,
      unavailableReason: available ? null : 'No local speech recognizer is available on this machine.',
      // The recognizer is recycled on a timer by design rather than after a
      // fault, so there is no restart count here that would mean what it means
      // for the spotter. Reporting zero is the honest answer, not a placeholder.
      restarts: 0,
      starvedOfAudio: this.armed && this.lastFrameAt !== 0 && this.now() - this.lastFrameAt > 10_000,
    };
  }

  /** Begin listening locally. Idempotent. */
  async arm(): Promise<boolean> {
    if (this.armed) return true;
    if (!this.available) {
      this.options.onNotice('Axon cannot listen for a wake phrase: no local recognizer is available.');
      return false;
    }

    this.armed = true;
    this.describedRecognizer = false;
    this.resetAudio();
    this.framesSinceArm = 0;
    this.options.onArmedChanged(true);
    this.debug('armed; starting the local recognizer and waiting for microphone audio');
    await this.warmSpare();
    return true;
  }

  /** Stop listening locally. Idempotent, and reached from every exit. */
  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.generation += 1;

    if (this.recycling) clearTimeout(this.recycling);
    this.recycling = null;

    this.abandonUtterance();
    this.spare = null;
    this.closeAll();

    this.options.onArmedChanged(false);
    this.debug('disarmed; every local recognizer closed');
  }

  /**
   * One frame of microphone audio.
   *
   * To the activity detector, and — only while somebody is speaking — to the
   * local recognizer. Note what this method does not do: it does not log
   * audio, does not emit, does not persist and does not return anything.
   */
  pushFrame(frame: Int16Array): void {
    if (!this.armed) return;
    if (frame.length === 0 || frame.length > LISTENING_LIMITS.maxFrameSamples) return;

    const now = this.now();
    if (this.lastFrameAt !== 0 && now - this.lastFrameAt > FRAME_GAP_MS) {
      // The capture paused — the microphone was lent to a conversation, the
      // window reloaded. Audio on either side of the gap is not one utterance.
      this.abandonUtterance();
      this.resetAudio();
    }
    this.lastFrameAt = now;
    this.noteLevel(frame, now);

    const result = this.vad.push(frame);
    // Speech-level energy, as the activity detector judged it: one flag per
    // frame, kept only for the length of one utterance.
    const voiced = typeof result.level === 'number' && result.level >= this.vad.threshold;

    const utterance = this.utterance;
    if (utterance) {
      this.feed(utterance, frame, voiced);
      if (
        result.event === 'speech-ended' ||
        result.event === 'max-duration' ||
        utterance.samples >= MAX_UTTERANCE_SAMPLES
      ) {
        this.finishUtterance();
      }
      return;
    }

    this.remember(frame, voiced);
    if (result.event === 'speech-started') this.beginUtterance();
  }

  // --- recognizers --------------------------------------------------------

  /** Start the recognizer the next utterance will use. */
  private warmSpare(): Promise<void> {
    const stt = this.options.stt;
    if (!stt || !this.armed) return Promise.resolve();

    const generation = this.generation;
    const startedAt = this.now();
    const binding: SessionBinding = { utterance: null };

    const warming = stt
      .start(
        (chunk) => {
          this.onResult(generation, chunk, binding.utterance);
        },
        { mode: 'wake', onDiagnostic: this.options.debug ? (line) => this.onDiagnostic(generation, line) : undefined },
      )
      .then((session): SpeechToTextSession | null => {
        if (generation !== this.generation || !this.armed) {
          session.close();
          return null;
        }
        this.open.add(session);
        this.debug(`local recognizer ready in ${this.now() - startedAt}ms`);
        return session;
      })
      .catch((): null => {
        if (generation === this.generation && this.armed) this.failToStart();
        return null;
      });

    this.spare = warming;
    this.spareBinding = binding;
    this.scheduleRecycle();
    return warming.then(() => undefined);
  }

  /**
   * A recognizer that will not start is reported once, and the detector
   * disarms: an assistant that complains every sixty seconds is worse than
   * one that is quietly not listening and says so in the UI.
   */
  private failToStart(): void {
    this.armed = false;
    this.generation += 1;
    if (this.recycling) clearTimeout(this.recycling);
    this.recycling = null;
    this.abandonUtterance();
    this.spare = null;
    this.closeAll();
    this.options.onArmedChanged(false);
    this.options.onNotice('Axon could not start listening for the wake phrase.');
    this.debug('the local recognizer would not start; disarmed');
  }

  /** Replace an idle warm recognizer that has been kept for a full window. */
  private scheduleRecycle(): void {
    if (this.recycling) clearTimeout(this.recycling);
    this.recycling = setTimeout(() => {
      void this.recycle();
    }, this.windowMs);
    if (typeof this.recycling.unref === 'function') this.recycling.unref();
  }

  private async recycle(): Promise<void> {
    if (!this.armed) return;
    const old = this.spare;
    this.spare = null;
    const session = await old;
    if (session) this.release(session);
    await this.warmSpare();
  }

  private release(session: SpeechToTextSession): void {
    this.open.delete(session);
    session.close();
  }

  private closeAll(): void {
    for (const session of this.open) session.close();
    this.open.clear();
  }

  // --- utterances ---------------------------------------------------------

  private beginUtterance(): void {
    const sessionReady = this.spare ?? Promise.resolve(null);
    const binding = this.spareBinding;
    this.spare = null;
    this.spareBinding = null;
    this.session = null;

    const utterance: Utterance = {
      pending: this.preRoll,
      timeline: this.preRollTimeline,
      samples: this.preRollSamples,
      ended: false,
      abandoned: false,
    };
    if (binding) binding.utterance = utterance;
    this.preRoll = [];
    this.preRollTimeline = [];
    this.preRollSamples = 0;
    this.utterance = utterance;
    this.debug('speech started');

    // The NEXT utterance gets its own warm recognizer, starting now, so a
    // second attempt at the phrase does not wait for a process to load.
    void this.warmSpare();

    void sessionReady.then((session) => {
      if (!session) {
        utterance.abandoned = true;
        return;
      }
      if (utterance.abandoned || !this.armed) {
        this.release(session);
        return;
      }
      for (const frame of utterance.pending) session.push(frame);
      utterance.pending.length = 0;
      if (utterance.ended || this.utterance !== utterance) {
        this.complete(session);
        return;
      }
      this.session = session;
    });
  }

  private feed(utterance: Utterance, frame: Int16Array, voiced: boolean): void {
    utterance.samples += frame.length;
    utterance.timeline.push({ samples: frame.length, voiced });
    // Held only until the recognizer this utterance is waiting for is warm;
    // then every frame goes straight to it, and nowhere else.
    const warming = this.session === null;
    if (warming) utterance.pending.push(frame);
    this.session?.push(frame);
  }

  private finishUtterance(): void {
    const utterance = this.utterance;
    if (!utterance) return;
    const session = this.session;
    this.utterance = null;
    this.session = null;
    this.vad = this.options.activity();
    utterance.ended = true;
    this.debug('speech ended');
    this.debug(`utterance of ${Math.round((utterance.samples / SAMPLE_RATE) * 1000)}ms handed to the local recognizer`);
    if (session) this.complete(session);
  }

  /** Close the audio, let the recognizer report, then release it. */
  private complete(session: SpeechToTextSession): void {
    void session
      .end()
      .catch(() => undefined)
      .then(() => {
        this.release(session);
        this.debug('local recognizer finished the utterance');
      });
  }

  private abandonUtterance(): void {
    const utterance = this.utterance;
    const session = this.session;
    this.utterance = null;
    this.session = null;
    this.vad = this.options.activity();
    if (!utterance) return;
    utterance.abandoned = true;
    utterance.pending.length = 0;
    if (session) this.release(session);
  }

  private remember(frame: Int16Array, voiced: boolean): void {
    this.preRoll.push(frame);
    this.preRollTimeline.push({ samples: frame.length, voiced });
    this.preRollSamples += frame.length;
    while (this.preRollSamples > PRE_ROLL_SAMPLES && this.preRoll.length > 1) {
      const dropped = this.preRoll.shift();
      this.preRollTimeline.shift();
      this.preRollSamples -= dropped?.length ?? 0;
    }
  }

  private resetAudio(): void {
    this.vad = this.options.activity();
    this.preRoll = [];
    this.preRollTimeline = [];
    this.preRollSamples = 0;
    this.lastFrameAt = 0;
  }

  // --- results ------------------------------------------------------------

  private onResult(generation: number, chunk: TranscriptChunk, utterance: Utterance | null): void {
    if (generation !== this.generation || !this.armed) return;
    if (!chunk.isFinal) return;

    let decision = decideWake(chunk);
    let timing = '';
    if (decision.wake && chunk.source === 'wake-phrase' && utterance) {
      const coverage = judgePhraseCoverage(utterance.timeline, chunk.span);
      timing = ` ${coverage.note}`;
      if (!coverage.ok) decision = { wake: false, reason: coverage.reason };
    }
    if (this.options.debug) {
      const confidence = chunk.confidence === null ? '?' : chunk.confidence.toFixed(2);
      const label = chunk.source === undefined ? 'text' : (SOURCE_LABELS[chunk.source] ?? chunk.source);
      this.debug(
        `heard [${label} ${confidence}] "${chunk.text}" -> "${normalizePhrase(chunk.text)}"${timing} -> ` +
          `${decision.wake ? 'ACTIVATE' : 'no activation'} (${decision.reason})`,
      );
    }
    if (!decision.wake) return;

    // The microphone is about to move to the conversation. Whatever utterance
    // was in progress belongs to neither.
    this.abandonUtterance();
    this.resetAudio();
    this.options.onWake();
  }

  // --- diagnostics --------------------------------------------------------

  /**
   * The recognizer's own report. Its description (engine, culture, grammars,
   * format) is logged once per arming — a warm spare is started for every
   * utterance, and the same four lines each time would bury what matters.
   */
  private onDiagnostic(generation: number, line: string): void {
    if (generation !== this.generation || !this.armed) return;
    const describing = /^(recognizer initialized|grammar loaded|audio format)/.test(line);
    if (describing) {
      if (this.describedRecognizer) return;
      if (line.startsWith('audio format')) this.describedRecognizer = true;
    }
    this.debug(line);
  }

  private noteLevel(frame: Int16Array, now: number): void {
    if (!this.options.debug) return;
    this.framesSinceArm += 1;
    if (this.framesSinceArm === 1) {
      this.debug('microphone audio is arriving');
      this.lastLevelReportAt = now;
    }
    this.peakLevel = Math.max(this.peakLevel, levelOf(frame));
    if (now - this.lastLevelReportAt >= LEVEL_REPORT_MS) {
      this.debug(`microphone level: peak ${this.peakLevel.toFixed(3)}, speech threshold ${this.vad.threshold.toFixed(3)}`);
      this.peakLevel = 0;
      this.lastLevelReportAt = now;
    }
  }

  private debug(line: string): void {
    this.options.debug?.(line);
  }
}
