/**
 * The overlay: Axon, materialised at the bottom of the screen.
 *
 * WHAT THIS PAGE IS. A transparent layer over the whole work area, shown only
 * while Axon is active. It holds a small orb at the bottom centre, a short
 * caption, the current exchange, the approval card when one is waiting, and a
 * soft light along the left and right edges in the orb's colour. Everything
 * else is empty and click-through: the application underneath keeps working.
 *
 * WHY IT ALSO HOLDS THE MICROPHONE. This page exists from the moment Axon
 * starts, hidden. It is the one page that opens the microphone — for the local
 * wake phrase, for push-to-talk and for a conversation — and the one that
 * plays Axon's voice. That is what lets "Hey Axon" work with no Axon window
 * open. Main routes capture commands and speech here and accepts audio from
 * here only.
 *
 * PRESENTATION ONLY. Main decides when this page is shown (the phase), what
 * state Axon is in, and whether anything is allowed. The orb asks; the card
 * sends a decision bound to the request it rendered; main decides.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AxonEvent, OverlayPhase } from '@axon/core';
import { AxonOrb } from './components/orb/AxonOrb.js';
import { ApprovalDialog } from './components/approval/ApprovalDialog.js';
import { currentExchange, isPresentable, presenceFor } from './state/presence.js';
import { orbActionFor } from './state/orb-action.js';
import { stateStyle } from './state/state-colors.js';
import { useAxonRuntime } from './state/useAxonRuntime.js';
import { useMicrophone } from './state/useMicrophone.js';
import { useSpeechPlayback } from './state/useSpeechPlayback.js';
import { useTheme } from './state/useTheme.js';
import { cancelSpeech, requestListening, stopListening } from './state/voice-actions.js';

type Phase = 'hidden' | OverlayPhase;

export function OverlayApp(): React.JSX.Element | null {
  const runtime = useAxonRuntime();
  const microphone = useMicrophone();
  const speech = useSpeechPlayback();
  const { theme } = useTheme();

  const [phase, setPhase] = useState<Phase>('hidden');
  const [notice, setNotice] = useState<string | null>(null);
  const interactive = useRef(false);
  /** The last event before this activation, so only this activation's exchange is shown. */
  const activationMark = useRef<AxonEvent | null>(null);
  const eventsRef = useRef(runtime.events);
  eventsRef.current = runtime.events;

  useEffect(() => {
    const off = window.axon?.onOverlayPhase((next) => {
      if (next === 'enter') {
        setPhase((current) => {
          if (current !== 'enter') {
            const events = eventsRef.current;
            activationMark.current = events[events.length - 1] ?? null;
            setNotice(null);
          }
          return 'enter';
        });
      } else {
        setPhase('leave');
      }
    });
    return off;
  }, []);

  // Tell main when the pointer is over one of this page's controls, so the
  // window takes that click; everywhere else clicks pass through.
  useEffect(() => {
    const report = (value: boolean): void => {
      if (interactive.current === value) return;
      interactive.current = value;
      window.axon?.setOverlayInteractive(value);
    };
    const onMove = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      report(Boolean(target?.closest('[data-interactive]')));
    };
    const onLeave = (): void => report(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'enter' && interactive.current) {
      interactive.current = false;
      window.axon?.setOverlayInteractive(false);
    }
  }, [phase]);

  const presence = useMemo(
    () =>
      presenceFor({
        state: runtime.state,
        events: runtime.events,
        voiceAgent: runtime.voiceAgent,
        listening: runtime.listening,
      }),
    [runtime.state, runtime.events, runtime.voiceAgent, runtime.listening],
  );

  const exchange = useMemo(() => {
    const mark = activationMark.current;
    const index = mark ? runtime.events.lastIndexOf(mark) : -1;
    return currentExchange(index >= 0 ? runtime.events.slice(index + 1) : runtime.events);
  }, [runtime.events, phase]);

  const action = orbActionFor({
    state: runtime.state,
    voiceActive: runtime.voiceAgent.active,
    voiceAvailable: runtime.voiceAgent.available,
    listeningAvailable: runtime.listening.available,
    approvalPending: runtime.pendingApproval !== null,
  });

  const runAction = (): void => {
    if (!action) return;
    setNotice(null);
    const refuse = (message: string | null): void => {
      setNotice(message && isPresentable(message) ? message : message ? 'Axon could not do that right now.' : null);
    };
    switch (action.kind) {
      case 'end-conversation':
        void runtime.stopVoiceSession();
        return;
      case 'stop-listening':
        stopListening();
        return;
      case 'stop-speaking':
        cancelSpeech();
        return;
      case 'talk':
        void runtime.startVoiceSession().then((result) => refuse(result.accepted ? null : result.error));
        return;
      case 'listen':
        void requestListening().then(refuse);
        return;
    }
  };

  if (runtime.connectionError) return null;

  const listening = runtime.state === 'LISTENING';
  const idle = runtime.state === 'IDLE';
  // Once Axon has answered and gone quiet, the answer is the caption.
  const caption = idle && exchange.axon ? null : presence.headline;

  return (
    <div
      className={`overlay phase-${phase} state-${runtime.state.toLowerCase()} tone-${presence.tone}`}
      style={stateStyle(runtime.state, theme) as React.CSSProperties}
    >
      <div className="aura aura-left" aria-hidden="true" />
      <div className="aura aura-right" aria-hidden="true" />

      <div className="dock">
        {runtime.pendingApproval ? (
          <div className="dock-approval" data-interactive="">
            <ApprovalDialog
              variant="docked"
              request={runtime.pendingApproval}
              onDecide={(callId, decision, fingerprint) => {
                void runtime.resolveApproval(callId, decision, fingerprint);
              }}
            />
          </div>
        ) : null}

        {!runtime.pendingApproval && (exchange.user || exchange.axon) ? (
          <div className="dock-exchange" aria-label="Current conversation">
            {exchange.user ? (
              <p className="dock-line dock-user">
                <span className="dock-who">You</span>
                {exchange.user.text}
              </p>
            ) : null}
            {exchange.axon ? (
              <p className="dock-line dock-axon">
                <span className="dock-who">Axon</span>
                {exchange.axon.text}
              </p>
            ) : null}
          </div>
        ) : null}

        {notice ? (
          <p className="dock-caption dock-notice" role="alert">
            {notice}
          </p>
        ) : null}

        <p className={`dock-caption${caption ? '' : ' dock-caption-empty'}`} role="status" aria-live="polite">
          {caption ?? ''}
        </p>

        <button
          type="button"
          className="dock-orb"
          data-interactive=""
          onClick={runAction}
          disabled={action === null}
          aria-label={action ? `${action.label}. ${presence.headline}` : presence.headline}
          title={action?.label}
        >
          {/* Mounted only while shown: a hidden page draws nothing. Real samples
              drive it — the microphone while listening, the speakers while
              speaking — and never a fake signal. */}
          {phase !== 'hidden' ? (
            <AxonOrb
              state={runtime.state}
              theme={theme}
              amplitude={(listening ? microphone.amplitude : speech.amplitude) ?? undefined}
            />
          ) : null}
        </button>
      </div>
    </div>
  );
}
