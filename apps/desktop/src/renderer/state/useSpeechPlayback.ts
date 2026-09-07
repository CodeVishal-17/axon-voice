/**
 * Binds the speech player to the bridge.
 *
 * Owns one `SpeechPlayer` for the lifetime of the window, subscribes to the
 * audio main pushes, and reports playback back so main can leave SPEAKING as
 * soon as the sound stops rather than waiting out its watchdog.
 *
 * The hook reports; it does not decide. Nothing here sets Axon's state — the
 * orb follows `runtime.state`, which is what the main process said, exactly as
 * every other view in this app does. A renderer that could declare itself to
 * be speaking would be a renderer whose UI could disagree with reality.
 */

import { useEffect, useRef, useState } from 'react';
import type { SpeechDelivery } from '@axon/core';
import { SpeechPlayer } from '../audio/speech-player.js';
import { PcmStreamPlayer } from '../audio/pcm-stream-player.js';
import type { AmplitudeSource } from '../components/orb/amplitude.js';
import { SmoothedAmplitudeSource } from '../components/orb/amplitude.js';

export interface SpeechPlayback {
  /** Live level while speaking, or null. Feed straight to the orb. */
  readonly amplitude: AmplitudeSource | null;
  /** True from the moment audio starts until it stops. */
  readonly playing: boolean;
  /** Ask main to stop speaking. Main decides and drives the state change. */
  cancel(): void;
}

export function useSpeechPlayback(): SpeechPlayback {
  const [amplitude, setAmplitude] = useState<AmplitudeSource | null>(null);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const streamRef = useRef<PcmStreamPlayer | null>(null);

  useEffect(() => {
    const bridge = window.axon;
    if (!bridge) return;

    const report = (speechId: string, status: 'started' | 'ended' | 'failed'): void => {
      // Advisory, and main validates the id. A rejected report is not worth
      // surfacing: main's watchdog covers the case where it never arrives.
      void bridge.reportSpeech({ speechId, status, error: null }).catch(() => {});
    };

    const player = new SpeechPlayer({
      onStarted: (speechId) => {
        setPlaying(true);
        report(speechId, 'started');
      },
      onEnded: (speechId) => {
        setPlaying(false);
        report(speechId, 'ended');
      },
      onFailed: (speechId, reason) => {
        setPlaying(false);
        console.warn('[speech]', reason);
        report(speechId, 'failed');
      },
      onAmplitude: (source) => {
        // Smoothed with the same follower the microphone will use in Step 4,
        // so the orb's response to a voice is characteristic of the orb rather
        // than of whichever source happens to be driving it.
        setAmplitude(source ? new SmoothedAmplitudeSource(source, 0.04, 0.18) : null);
      },
    });
    playerRef.current = player;

    /**
     * The streaming twin, for voice-agent audio.
     *
     * A second player rather than a mode on the first: a finished WAV and a
     * live PCM stream need different scheduling, and conflating them would
     * mean either buffering the stream (losing the latency the streaming API
     * exists for) or faking a duration for the one-shot path (making its
     * watchdog lie). They share the same handler shape, so the orb and the
     * UI cannot tell which one is speaking — which is correct, because from
     * the user's point of view Axon is simply talking.
     *
     * No playback report is sent for streamed audio: `reportSpeech` belongs to
     * the synthesiser's watchdog, and reporting against an id it never issued
     * would be noise main has to reject.
     */
    const stream = new PcmStreamPlayer({
      onStarted: () => {
        setPlaying(true);
      },
      onEnded: () => {
        setPlaying(false);
      },
      onFailed: (_speechId, reason) => {
        setPlaying(false);
        console.warn('[speech:stream]', reason);
      },
      onAmplitude: (source) => {
        setAmplitude(source ? new SmoothedAmplitudeSource(source, 0.04, 0.18) : null);
      },
    });
    streamRef.current = stream;

    const offAudio = bridge.onSpeech((delivery: SpeechDelivery) => {
      // A one-shot utterance supersedes a stream and vice versa: Axon has one
      // voice, and two things talking at once is never what was intended.
      stream.stop();
      void player.play(delivery.speechId, delivery.bytes);
    });
    const offChunk = bridge.onSpeechChunk((chunk) => {
      player.stop();
      stream.push(chunk.speechId, chunk.pcm, chunk.sampleRate, chunk.final);
    });
    const offStop = bridge.onSpeechStop(() => {
      // Main names the utterance, but each player only ever has one; stopping
      // whatever is current is both correct and impossible to point elsewhere.
      player.stop();
      stream.stop();
      setPlaying(false);
    });

    return () => {
      offAudio();
      offChunk();
      offStop();
      // Closes the AudioContext and disconnects every node. Without this a
      // reload would leak a context per mount.
      player.dispose();
      stream.dispose();
      playerRef.current = null;
      streamRef.current = null;
    };
  }, []);

  return {
    amplitude,
    playing,
    cancel: (): void => {
      // Stop locally at once so the user hears silence immediately, then tell
      // main, which is authoritative and drives the state change.
      streamRef.current?.stop();
      playerRef.current?.stop();
      void window.axon?.cancelSpeech().catch(() => {});
    },
  };
}
