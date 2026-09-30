/**
 * Speech-to-text.
 *
 * Implemented in Step 4. Declared now so the capture pipeline can be built
 * against a stable seam.
 *
 * Note for implementers: Electron's Chromium does NOT provide a working
 * Web Speech API (`webkitSpeechRecognition` is bound to a Google endpoint
 * keyed to Chrome itself). Every implementation of this interface is either a
 * network service or a local model — there is no free browser fallback.
 */

export interface TranscriptChunk {
  readonly text: string;
  /** False while the recognizer may still revise this text. */
  readonly isFinal: boolean;
  /** 0..1 where the provider reports it, else null. */
  readonly confidence: number | null;
  /**
   * Which grammar produced this text, where the provider can say.
   *
   * `wake-phrase` means the recognizer matched Axon's fixed wake grammar —
   * the only grammar allowed to wake Axon. `dictation` is free text, which in
   * a wake session is the competing grammar that absorbs ordinary speech so
   * it is NOT forced onto the wake phrase. Absent for providers that do not
   * distinguish, which fall back to text matching.
   */
  readonly source?: 'wake-phrase' | 'near-miss' | 'dictation';
  /**
   * Where in the session's audio the recognised words were, in milliseconds
   * from the first byte sent, where the provider can say.
   *
   * The wake word uses it to insist that the phrase IS the utterance: a
   * recognizer can find "hi axon" inside "I was talking about Axon
   * yesterday", and only the timing shows the rest of the sentence was there.
   * Timing only — never audio.
   */
  readonly span?: { readonly startMs: number; readonly durationMs: number };
}

/**
 * How a recognition session should listen.
 *
 * `dictation` (the default) transcribes whatever was said. `wake` listens
 * ONLY for the wake phrases, against a grammar of near-miss sound-alikes
 * ("axon" alone, "action", "hey jackson"...) that exists to catch speech which
 * is not a wake phrase. There is no free dictation in a wake session: on a
 * real human voice, dictation out-competed the wake grammar ("Hey Axon" came
 * back as "But who").
 */
export interface SpeechToTextOptions {
  readonly mode?: 'dictation' | 'wake';
  /**
   * Developer diagnostics from the recognizer itself: which engine and
   * culture loaded, which grammars, when it detected speech, and candidates it
   * rejected. Plain text, never audio. Absent means nobody is listening.
   */
  readonly onDiagnostic?: (line: string) => void;
}

export interface SpeechToTextSession {
  /** Feed 16-bit PCM mono frames as captured by the renderer. */
  push(frame: Int16Array): void;
  /** Signal end of utterance and flush any buffered audio. */
  end(): Promise<void>;
  close(): void;
}

export interface SpeechToText {
  readonly name: string;
  readonly sampleRate: number;
  /** True when the provider is configured and usable (e.g. key present). */
  isAvailable(): boolean;
  start(onChunk: (chunk: TranscriptChunk) => void, options?: SpeechToTextOptions): Promise<SpeechToTextSession>;
}
