import { useCallback, useMemo, useState } from 'react';
import type { AxonState } from '@axon/core';
import { AxonOrb } from './components/orb/AxonOrb.js';
import { Timeline } from './components/timeline/Timeline.js';
import { ApprovalDialog } from './components/approval/ApprovalDialog.js';
import { ToolConsole } from './components/console/ToolConsole.js';
import { Composer } from './components/composer/Composer.js';
import { Transcript } from './components/transcript/Transcript.js';
import { TalkButton } from './components/voice/TalkButton.js';
import { VoiceSessionControl } from './components/voice/VoiceSessionControl.js';
import { SettingsPanel } from './components/settings/SettingsPanel.js';
import { useAxonRuntime } from './state/useAxonRuntime.js';
import { useMicrophone } from './state/useMicrophone.js';
import { useSpeechPlayback } from './state/useSpeechPlayback.js';

/**
 * Static description of each state, for the line under the orb.
 *
 * The line beneath it is the *reason* carried by the real STATE_CHANGED event,
 * so the UI shows both what state Axon is in and why it entered it.
 */
const STATE_COPY: Readonly<Record<AxonState, string>> = {
  IDLE: 'Standing by',
  LISTENING: "I'm listening…",
  THINKING: 'Working out what to do',
  EXECUTING: 'Acting on your computer',
  SPEAKING: 'Responding',
  WAITING_FOR_APPROVAL: 'Waiting for your decision',
  ERROR: 'Something went wrong',
};

/** The host of a URL, for display. Never the path or query, which can carry
 *  session tokens and search terms the user did not ask to have on screen. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'a page';
  }
}

export function App(): React.JSX.Element {
  const runtime = useAxonRuntime();
  const speech = useSpeechPlayback();
  const microphone = useMicrophone();
  const [listenError, setListenError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const listening = runtime.state === 'LISTENING';

  // Cleared on the next activation rather than on a timer: a refusal the user
  // never saw is not worth showing, and one they did see should stay put until
  // they try again.
  const startListening = useCallback(() => {
    setListenError(null);
    void microphone.start().then((error) => setListenError(error));
  }, [microphone]);

  const lastReason = useMemo(() => {
    for (let i = runtime.events.length - 1; i >= 0; i -= 1) {
      const event = runtime.events[i];
      if (event?.type === 'STATE_CHANGED') return event.reason;
    }
    return null;
  }, [runtime.events]);

  if (runtime.connectionError) {
    return (
      <div className="fatal">
        <h1>Axon could not connect to its runtime</h1>
        <p>{runtime.connectionError}</p>
      </div>
    );
  }

  return (
    <div className={`app state-${runtime.state.toLowerCase()}`}>
      <header className="titlebar">
        <span className="wordmark">
          <span className="wordmark-dot" aria-hidden="true" />
          AXON
        </span>
        <span className="titlebar-meta">
          {/* A quiet, permanent statement that conversations are being kept —
              and, when they are not, that they are not. Persistence that is
              invisible until it fails is persistence a user cannot trust. */}
          {runtime.ready ? (
            <span className={runtime.persistence.available ? 'saving-on' : 'saving-off'}>
              {runtime.persistence.available ? 'saved locally' : 'not saving'}
            </span>
          ) : (
            'connecting…'
          )}
          <button
            type="button"
            className="titlebar-settings"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings and privacy"
            title="Settings and privacy"
          >
            Settings
          </button>
        </span>
      </header>

      <main className="stage">
        <section className="orb-stage" aria-live="polite">
          <div className="orb-frame">
            {/* Real samples, from whichever direction audio is actually
                moving: the microphone while listening, the speakers while
                speaking. When neither is running this is null and the orb
                falls back to its own intrinsic motion - it never animates to a
                fake signal, and there is no simulated waveform anywhere. */}
            <AxonOrb
              state={runtime.state}
              amplitude={(listening ? microphone.amplitude : speech.amplitude) ?? undefined}
            />
          </div>

          <div className="orb-caption">
            <h1 className="state-name">{runtime.state.replace(/_/g, ' ')}</h1>
            <p className="state-copy">{STATE_COPY[runtime.state]}</p>
            {lastReason ? <p className="state-reason">{lastReason}</p> : null}

            {/* Speech is announced in text as well as in motion. Someone with
                animation turned off, or using a screen reader, still learns
                that Axon is talking - and gets the control to stop it. */}
            {/* The browser is a separate visible window, so the badge is a
                pointer to it rather than a substitute: it says what Axon has
                open, and the user can look at the real thing. */}
            {runtime.browser.open && runtime.browser.url ? (
              <p className="speaking-row">
                <span className="browser-badge" role="status">
                  <span className="browser-dot" aria-hidden="true" />
                  Browsing <span className="browser-badge-host">{hostOf(runtime.browser.url)}</span>
                </span>
              </p>
            ) : null}

            {/* Listening is announced in text as well as in motion, and comes
                with the control that ends it. Someone with animation turned
                off, or using a screen reader, still learns that the microphone
                is open and can close it. */}
            {listening ? (
              <p className="speaking-row">
                <span className="listening-badge" role="status">
                  <span className="listening-dot" aria-hidden="true" />
                  Axon is listening
                </span>
                <button type="button" className="speaking-stop" onClick={() => microphone.stop()}>
                  Stop
                </button>
              </p>
            ) : null}

            {runtime.state === 'SPEAKING' ? (
              <p className="speaking-row">
                <span className="speaking-badge" role="status">
                  <span className="speaking-dot" aria-hidden="true" />
                  Axon is speaking
                </span>
                <button type="button" className="speaking-stop" onClick={() => speech.cancel()}>
                  Stop
                </button>
              </p>
            ) : null}
          </div>

          <Transcript events={runtime.events} busy={runtime.busy} />

          {/* WHAT IS WARNED ABOUT, AND WHAT IS NOT.
              Axon's reasoning now comes from the voice agent. The typed
              composer is driven by a SEPARATE, OPTIONAL provider, and its
              absence is not a fault — it is a feature that is not configured.
              Warning about it while Axon is perfectly able to hold a
              conversation would train the user to ignore this banner, which is
              the same approval-fatigue failure in a different costume.
              So the warning appears only when Axon genuinely cannot do
              anything: no voice agent AND no typed brain. */}
          {runtime.ready && !runtime.voiceAgent.available && !runtime.brain.available ? (
            <p className="brain-notice" role="status">
              {runtime.voiceAgent.reason ?? runtime.brain.reason}
            </p>
          ) : null}

          {/* The spoken path first: it is the primary way to use Axon now, and
              the indicator above it is how the user knows whether their
              microphone is uploading. The transcribe-then-type button below
              remains for when no voice agent is configured. */}
          <VoiceSessionControl
            status={runtime.voiceAgent}
            busy={runtime.busy || listening}
            onStart={() => {
              setListenError(null);
              void runtime.startVoiceSession().then((result) => {
                if (!result.accepted) setListenError(result.error);
              });
            }}
            onStop={() => {
              void runtime.stopVoiceSession();
            }}
          />

          <TalkButton
            listening={listening}
            available={runtime.listening.available}
            reason={runtime.listening.reason}
            hotkey={runtime.listening.hotkey}
            busy={runtime.busy}
            onStart={startListening}
            onStop={() => microphone.stop()}
          />

          {listenError ? (
            <p className="brain-notice" role="status">
              {listenError}
            </p>
          ) : null}

          {/* Typing needs the optional text provider, and says so in terms of
              what the user can do INSTEAD — "no brain attached" reads like a
              broken application, which it is not when Axon is sitting there
              waiting to be spoken to. */}
          <Composer
            busy={runtime.busy}
            disabled={!runtime.ready || !runtime.brain.available}
            placeholder={
              runtime.brain.available
                ? 'Ask Axon anything…'
                : runtime.voiceAgent.available
                  ? // Deliberately does not name the model vendor. `verify-tools.cjs`
                    // greps the renderer bundle for it as a cheap, robust proxy for
                    // "the SDK was not bundled into the sandbox", and a vendor name
                    // in UI copy would blunt that check for no benefit — main already
                    // supplies the actionable sentence in `brain.reason`.
                    'Say "Hey Axon", or press Talk to Axon — typed chat needs an optional key'
                  : 'Axon has no provider configured'
            }
            onSend={(text) => {
              void runtime.sendMessage(text);
            }}
          />
        </section>

        <aside className="rail">
          <Timeline events={runtime.events} />
        </aside>
      </main>

      {runtime.devConsoleEnabled ? (
        <footer className="dock">
          <ToolConsole
            state={runtime.state}
            invokeTool={runtime.invokeTool}
            requestState={runtime.requestState}
          />
        </footer>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          settings={runtime.settings}
          persistence={runtime.persistence}
          hotkeyInForce={runtime.listening.hotkey}
          conversationId={runtime.conversationId}
          onClose={() => setSettingsOpen(false)}
          onUpdate={async (patch) => (await runtime.updateSettings(patch)).error}
          onReset={async () => (await runtime.resetSettings()).error}
          listSessions={runtime.listSessions}
          selectSession={runtime.selectSession}
          deleteSession={runtime.deleteSession}
          createSession={runtime.createSession}
          listMemories={runtime.listMemories}
          setMemoryEnabled={runtime.setMemoryEnabled}
          deleteMemory={runtime.deleteMemory}
          clearMemories={runtime.clearMemories}
        />
      ) : null}

      {runtime.pendingApproval ? (
        <ApprovalDialog
          request={runtime.pendingApproval}
          onDecide={(callId, decision, fingerprint) => {
            // The fingerprint of the request THIS dialog rendered. Main
            // refuses an ALLOW that does not match the live request, so a
            // dialog left over from a moment ago cannot authorise whatever
            // replaced it.
            void runtime.resolveApproval(callId, decision, fingerprint);
          }}
        />
      ) : null}
    </div>
  );
}
