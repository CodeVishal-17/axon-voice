/**
 * Text-to-speech.
 *
 * Implemented in Step 3. Synthesis returns audio bytes rather than playing
 * them: playback happens in the renderer so the same Web Audio graph that
 * plays the voice also drives the orb's amplitude. Speaking and the animation
 * of speaking come from one signal, never from a simulation of one.
 */

export interface SpeechAudio {
  /** Encoded audio (WAV for the offline Windows SAPI backend). */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sampleRate: number;
}

export interface TextToSpeech {
  readonly name: string;
  isAvailable(): boolean;
  synthesize(text: string, signal?: AbortSignal): Promise<SpeechAudio>;
}
