/**
 * The control that starts and stops a spoken conversation.
 *
 * THIS COMPONENT IS A PRIVACY INDICATOR FIRST AND A BUTTON SECOND.
 *
 * Axon's guarantee has three states and the user has to be able to tell them
 * apart at a glance, because the difference between them is whether a
 * microphone in their home is uploading:
 *
 *   off        the microphone is closed
 *   listening  open, but to a LOCAL recogniser waiting for the wake phrase —
 *              nothing is being sent anywhere
 *   live       audio is being streamed to the voice service
 *
 * So the live state is stated in words, not only in colour, and it says where
 * the audio is going rather than something vague like "active". A user who
 * cannot distinguish an accent colour still gets the sentence, and a user who
 * glances at the window still gets the dot.
 *
 * The button is deliberately not the primary affordance — the wake phrase and
 * the hotkey are — but it exists because a wake word that mishears, a noisy
 * room, and a user who would simply rather click are all real.
 */

import type { VoiceAgentStatus } from '@axon/core';

export interface VoiceSessionControlProps {
  readonly status: VoiceAgentStatus;
  /** True when Axon is busy with something that is not a voice session. */
  readonly busy: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
}

/** What the microphone is doing, in one sentence a person can act on. */
function describe(status: VoiceAgentStatus): { readonly text: string; readonly tone: string } {
  if (status.active) {
    switch (status.phase) {
      case 'CONNECTING':
        return { text: 'Connecting…', tone: 'connecting' };
      case 'SPEAKING':
        return { text: 'Axon is speaking — your microphone is live', tone: 'live' };
      case 'TOOL':
        return { text: 'Axon is doing something — your microphone is live', tone: 'live' };
      case 'APPROVAL':
        return { text: 'Waiting for your approval — your microphone is live', tone: 'live' };
      default:
        return { text: 'Listening — your voice is being sent to the voice service', tone: 'live' };
    }
  }

  if (status.armed) {
    // The sentence that carries the whole privacy story. It says both halves:
    // the microphone IS open, and nothing is leaving.
    return { text: 'Say "Hey Axon" — listening on this machine only, nothing is being sent', tone: 'armed' };
  }

  return { text: 'Microphone off', tone: 'off' };
}

export function VoiceSessionControl({
  status,
  busy,
  onStart,
  onStop,
}: VoiceSessionControlProps): React.JSX.Element {
  const state = describe(status);

  if (!status.available) {
    return (
      <div className="voice-control voice-control-unavailable" role="status">
        <span className="voice-dot voice-dot-off" aria-hidden="true" />
        {/* The reason comes from main and never contains a credential. */}
        <span className="voice-text">{status.reason ?? 'Spoken conversation is unavailable.'}</span>
      </div>
    );
  }

  return (
    <div className={`voice-control voice-control-${state.tone}`}>
      <span className={`voice-dot voice-dot-${state.tone}`} aria-hidden="true" />
      <span className="voice-text" role="status">
        {state.text}
      </span>

      {status.active ? (
        <button type="button" className="btn btn-stop-voice" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-start-voice"
          onClick={onStart}
          disabled={busy}
          // Named for what it does to the microphone, not for the feature.
          title="Start talking to Axon. Your voice will be sent to the voice service."
        >
          Talk to Axon
        </button>
      )}
    </div>
  );
}
