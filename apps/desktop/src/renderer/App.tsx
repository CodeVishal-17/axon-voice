/**
 * Axon's window.
 *
 * VOICE-FIRST, AND THE ORB IS THE INTERFACE. At rest the window shows the orb,
 * the word AXON and one short line — "Say “Hey Axon”". Clicking the orb is the
 * same activation as the wake phrase. While Axon works, the line says what it
 * is doing in plain words, and the current exchange sits beneath it; earlier
 * conversation stays folded away.
 *
 * PRESENTATION ONLY. Everything shown comes from the real state and events
 * main sends. Nothing here authorises anything: the orb asks main to start or
 * stop, the approval card sends a decision bound to the fingerprint of what it
 * showed, and main decides. There is no renderer-side shortcut for either.
 */

import { useCallback, useMemo, useState } from 'react';
import { AxonOrb } from './components/orb/AxonOrb.js';
import { ApprovalDialog } from './components/approval/ApprovalDialog.js';
import { Composer } from './components/composer/Composer.js';
import { ToolConsole } from './components/console/ToolConsole.js';
import { PresencePanel } from './components/presence/PresencePanel.js';
import { SettingsPanel } from './components/settings/SettingsPanel.js';
import { TitleBar, type PrivacyIndicator } from './components/shell/TitleBar.js';
import { Timeline } from './components/timeline/Timeline.js';
import { currentExchange, hostOf, isPresentable, presenceFor } from './state/presence.js';
import { useAxonRuntime } from './state/useAxonRuntime.js';
import { orbActionFor, type OrbActionKind } from './state/orb-action.js';
import { stateStyle } from './state/state-colors.js';
import { cancelSpeech, requestListening, stopListening } from './state/voice-actions.js';
import { useTheme } from './state/useTheme.js';

export function App(): React.JSX.Element {
  const runtime = useAxonRuntime();
  const { theme, setTheme, toggle } = useTheme();

  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [typing, setTyping] = useState(false);

  const listening = runtime.state === 'LISTENING';
  const showNotice = useCallback((message: string | null) => {
    setNotice(message === null ? null : isPresentable(message) ? message : 'Axon could not start listening.');
  }, []);

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
  const exchange = useMemo(() => currentExchange(runtime.events), [runtime.events]);

  /**
   * What clicking the orb does right now. Null when there is nothing it can do.
   *
   * The panel owns no microphone and no speaker — the overlay does — so every
   * action here is a request to main, exactly as it is from the overlay.
   */
  const orbAction = useMemo((): { readonly kind: OrbActionKind; readonly label: string; run(): void } | null => {
    const action = orbActionFor({
      state: runtime.state,
      voiceActive: runtime.voiceAgent.active,
      voiceAvailable: runtime.voiceAgent.available,
      listeningAvailable: runtime.listening.available,
      approvalPending: runtime.pendingApproval !== null,
    });
    if (!action) return null;
    const run = (): void => {
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
          showNotice(null);
          void runtime.startVoiceSession().then((result) => {
            if (!result.accepted) showNotice(result.error);
          });
          return;
        case 'listen':
          showNotice(null);
          void requestListening().then(showNotice);
          return;
      }
    };
    return { kind: action.kind, label: action.label, run };
  }, [runtime, showNotice]);

  const privacy = useMemo((): PrivacyIndicator => {
    if (runtime.voiceAgent.active) {
      return { label: 'Live', tone: 'live', title: 'Your voice is being sent to the voice service for this conversation.' };
    }
    if (listening) {
      // Push-to-talk is recognised by Windows on this computer; only the words
      // it produces go anywhere. The chip says what is true of the audio.
      return { label: 'Listening', tone: 'armed', title: 'The microphone is open. Speech is recognised on this device.' };
    }
    if (runtime.voiceAgent.armed) {
      return {
        label: 'On-device',
        tone: 'armed',
        title: 'Listening for the wake phrase on this device. Nothing is sent until you activate Axon.',
      };
    }
    return { label: 'Mic off', tone: 'off', title: 'The microphone is closed.' };
  }, [runtime.voiceAgent.active, runtime.voiceAgent.armed, listening]);

  if (runtime.connectionError) {
    return (
      <div className="fatal" role="alert">
        <h1>Axon could not connect to its runtime</h1>
        <p>{runtime.connectionError}</p>
      </div>
    );
  }

  const browsingHost = runtime.browser.open ? hostOf(runtime.browser.url) : null;
  const canType = runtime.ready && runtime.brain.available;

  return (
    <div className={`app state-${runtime.state.toLowerCase()} tone-${presence.tone}`} style={stateStyle(runtime.state, theme) as React.CSSProperties}>
      <TitleBar
        theme={theme}
        privacy={privacy}
        activityOpen={activityOpen}
        showActivity={runtime.devConsoleEnabled}
        onToggleTheme={toggle}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleActivity={() => setActivityOpen((open) => !open)}
      />

      <main className="stage">
        <button
          type="button"
          className="orb-button"
          onClick={() => orbAction?.run()}
          disabled={orbAction === null || runtime.pendingApproval !== null}
          aria-label={orbAction ? `${orbAction.label}. ${presence.headline}` : presence.headline}
          title={orbAction?.label}
        >
          {/* The microphone and the speaker live in the overlay, so the
              panel's orb uses only its own motion — never a fake signal. */}
          <AxonOrb state={runtime.state} theme={theme} />
        </button>

        <PresencePanel
          presence={presence}
          exchange={exchange}
          notice={notice}
          browsingHost={browsingHost}
          speaking={runtime.state === 'SPEAKING'}
          onStopSpeaking={cancelSpeech}
          // Only the actions that stop something. See `PresencePanelProps`.
          stopAction={orbAction && (orbAction.kind === 'end-conversation' || orbAction.kind === 'stop-listening') ? orbAction : null}
        />

        {canType ? (
          <div className="stage-foot">
            {typing ? (
              <Composer
                busy={runtime.busy}
                disabled={!runtime.ready}
                placeholder="Type to Axon…"
                onSend={(text) => {
                  void runtime.sendMessage(text);
                }}
              />
            ) : (
              <button type="button" className="link-button" onClick={() => setTyping(true)}>
                Type instead
              </button>
            )}
          </div>
        ) : null}
      </main>

      {/* The raw event log and tool console name tools, ids and states, so they
          exist only in a development build. A packaged window never shows them. */}
      {activityOpen && runtime.devConsoleEnabled ? (
        <aside className="activity" aria-label="Developer activity">
          <Timeline events={runtime.events} />
          <ToolConsole state={runtime.state} invokeTool={runtime.invokeTool} requestState={runtime.requestState} />
        </aside>
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          theme={theme}
          onThemeChange={setTheme}
          voiceAgent={runtime.voiceAgent}
          listening={runtime.listening}
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
            // The fingerprint of the request THIS card rendered. Main refuses
            // an ALLOW that does not match the live request, so a card left
            // over from a moment ago cannot authorise whatever replaced it.
            void runtime.resolveApproval(callId, decision, fingerprint);
          }}
        />
      ) : null}
    </div>
  );
}
