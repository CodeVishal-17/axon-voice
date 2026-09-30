/**
 * Binds the microphone to the bridge.
 *
 * Owns one `MicrophoneCapture` for the lifetime of the window and opens it
 * only when main sends a capture command. The mirror of `useSpeechPlayback`,
 * and the same discipline: the hook reports, it does not decide.
 *
 * Nothing here sets Axon's state. There is no local "listening" flag driving
 * the UI — the orb and the caption follow `runtime.state`, which is what the
 * main process said. A renderer that could declare itself to be listening
 * would be a renderer whose microphone indicator could disagree with its own
 * user interface.
 *
 * The frames it produces go straight out over the bridge, stamped with the
 * capture id main minted. They are not stored, not accumulated, and never
 * placed in React state — a re-render must never be able to carry audio with
 * it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureCommand } from '@axon/core';
import { MicrophoneCapture } from '../audio/microphone.js';
import type { AmplitudeSource } from '../components/orb/amplitude.js';
import { SmoothedAmplitudeSource } from '../components/orb/amplitude.js';

export interface MicrophoneBinding {
  /** Live level while the microphone is open, or null. Feed to the orb. */
  readonly amplitude: AmplitudeSource | null;
  /** True from the moment the stream opens until it closes. */
  readonly capturing: boolean;
  /** Ask main to start listening. Main decides. */
  start(): Promise<string | null>;
  /** Ask main to stop listening. */
  stop(): void;
}

export function useMicrophone(): MicrophoneBinding {
  const [amplitude, setAmplitude] = useState<AmplitudeSource | null>(null);
  const [capturing, setCapturing] = useState(false);
  const captureIdRef = useRef<string | null>(null);

  useEffect(() => {
    const bridge = window.axon;
    if (!bridge) return;

    const report = (status: 'started' | 'ended' | 'failed', failure: Parameters<typeof bridge.reportCapture>[0]['failure']): void => {
      const captureId = captureIdRef.current;
      if (!captureId) return;
      void bridge.reportCapture({ captureId, status, failure }).catch(() => {});
    };

    const microphone = new MicrophoneCapture({
      onFrame: (samples) => {
        const captureId = captureIdRef.current;
        // A frame with no session is dropped here as well as in main. Both
        // checks are cheap and neither is sufficient on its own.
        if (!captureId) return;
        bridge.sendAudioFrame(captureId, samples);
      },
      onStarted: () => {
        setCapturing(true);
        report('started', null);
      },
      onEnded: () => {
        setCapturing(false);
        report('ended', null);
        captureIdRef.current = null;
      },
      onFailed: (failure) => {
        setCapturing(false);
        report('failed', failure);
        captureIdRef.current = null;
      },
      onDiagnostics: (report) => {
        // Numbers about format, timing and loudness, for main's developer
        // console. Dropped by main unless it asked for them.
        bridge.reportCaptureDiagnostics(report);
      },
      onAmplitude: (source) => {
        // Smoothed with the same follower speech playback uses, so the orb's
        // response is characteristic of the orb rather than of whichever
        // source happens to be driving it. Slightly quicker on both edges than
        // for speech: a voice arriving at a microphone should feel like it
        // lands the moment it is heard.
        setAmplitude(source ? new SmoothedAmplitudeSource(source, 0.03, 0.14) : null);
      },
    });

    const offCommand = bridge.onCaptureCommand((command: CaptureCommand) => {
      if (command.action === 'start') {
        captureIdRef.current = command.captureId;
        void microphone.start(command.sampleRate, {
          captureId: command.captureId,
          diagnostics: command.diagnostics === true,
          ...(command.processing ? { processing: command.processing } : {}),
        });
        return;
      }
      // 'stop' — from the voice activity detector, a timeout, a cancellation
      // or shutdown. Whichever it was, the microphone closes now.
      microphone.stop();
      setCapturing(false);
      captureIdRef.current = null;
    });

    return () => {
      offCommand();
      // Stops every track, disconnects every node and closes the
      // AudioContext. Without this a reload would leave a live microphone
      // behind the window that used to own it.
      microphone.stop();
      captureIdRef.current = null;
    };
  }, []);

  const start = useCallback(async (): Promise<string | null> => {
    const bridge = window.axon;
    if (!bridge) return 'The Axon bridge is unavailable.';
    try {
      const result = await bridge.startListening();
      return result.accepted ? null : result.error;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, []);

  const stop = useCallback((): void => {
    void window.axon?.stopListening().catch(() => {});
  }, []);

  return { amplitude, capturing, start, stop };
}
