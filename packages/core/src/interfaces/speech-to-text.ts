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
  start(onChunk: (chunk: TranscriptChunk) => void): Promise<SpeechToTextSession>;
}
