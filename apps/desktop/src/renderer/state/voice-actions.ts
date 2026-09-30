/**
 * Requests to main about listening and speaking.
 *
 * Thin on purpose: each is one parameterless bridge call. The microphone and
 * the speaker themselves belong to the overlay page (see `OverlayApp.tsx`);
 * any window may ask, and main decides.
 */

/** Ask main to listen. Resolves to a presentable refusal, or null when accepted. */
export async function requestListening(): Promise<string | null> {
  const bridge = window.axon;
  if (!bridge) return 'The Axon bridge is unavailable.';
  try {
    const result = await bridge.startListening();
    return result.accepted ? null : result.error;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function stopListening(): void {
  void window.axon?.stopListening().catch(() => {});
}

export function cancelSpeech(): void {
  void window.axon?.cancelSpeech().catch(() => {});
}
