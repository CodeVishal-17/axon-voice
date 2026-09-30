/**
 * Settings — only what actually exists.
 *
 * Every control here changes something real, through main, which validates it:
 * the push-to-talk shortcut, spoken replies, the workspace folder, reopening the
 * last conversation, and memory. Appearance is the one local preference, kept
 * by the page. The Wake word, Privacy and About pages explain; they do not
 * pretend to configure things that cannot be configured.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AxonSettings,
  ListeningStatus,
  MemoryEntry,
  PersistenceStatus,
  SessionRecord,
  StartupStatus,
  VoiceAgentStatus,
} from '@axon/core';
import type { Theme } from '../../state/theme.js';

export interface SettingsPanelProps {
  readonly theme: Theme;
  onThemeChange(theme: Theme): void;
  readonly voiceAgent: VoiceAgentStatus;
  readonly listening: ListeningStatus;
  readonly settings: AxonSettings;
  readonly persistence: PersistenceStatus;
  readonly hotkeyInForce: string | null;
  readonly conversationId: string | null;
  onClose(): void;
  onUpdate(patch: Partial<AxonSettings>): Promise<string | null>;
  onReset(): Promise<string | null>;
  listSessions(): Promise<readonly SessionRecord[]>;
  selectSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  createSession(): Promise<void>;
  listMemories(): Promise<readonly MemoryEntry[]>;
  setMemoryEnabled(id: string, enabled: boolean): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;
}

const TABS = [
  ['appearance', 'Appearance'],
  ['voice', 'Voice'],
  ['wake', 'Wake word'],
  ['conversations', 'Conversations'],
  ['memory', 'Memory'],
  ['privacy', 'Privacy'],
  ['about', 'About'],
] as const;

type Tab = (typeof TABS)[number][0];

function prettyHotkey(accelerator: string): string {
  return accelerator.replace(/\bControl\b/g, 'Ctrl').split('+').join(' + ');
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('appearance');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([]);
  const [memories, setMemories] = useState<readonly MemoryEntry[]>([]);
  const [hotkeyDraft, setHotkeyDraft] = useState(props.settings.voiceHotkey ?? '');
  const [workspaceDraft, setWorkspaceDraft] = useState(props.settings.workspacePath ?? '');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const { listSessions, listMemories, onClose } = props;

  const refresh = useCallback(async (): Promise<void> => {
    const [nextSessions, nextMemories] = await Promise.all([listSessions(), listMemories()]);
    setSessions(nextSessions);
    setMemories(nextMemories);
  }, [listSessions, listMemories]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escape closes, as any dialog should.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const apply = useCallback(
    async (patch: Partial<AxonSettings>): Promise<void> => {
      setError(await props.onUpdate(patch));
    },
    [props],
  );

  return (
    <div
      className="settings-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={`settings-tab${tab === name ? ' settings-tab-active' : ''}`}
              onClick={() => setTab(name)}
            >
              {label}
            </button>
          ))}
        </nav>

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}

        {tab === 'appearance' ? (
          <section className="settings-body" role="tabpanel" aria-label="Appearance">
            <h3 className="settings-section">Theme</h3>
            <div className="theme-choice" role="radiogroup" aria-label="Theme">
              {(['dark', 'light'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={props.theme === choice}
                  className={`theme-option theme-option-${choice}${props.theme === choice ? ' theme-option-active' : ''}`}
                  onClick={() => props.onThemeChange(choice)}
                >
                  <span className="theme-swatch" aria-hidden="true">
                    <span className="theme-swatch-orb" />
                  </span>
                  {choice === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
            <p className="settings-note">Remembered on this computer.</p>
          </section>
        ) : null}

        {tab === 'voice' ? (
          <section className="settings-body" role="tabpanel" aria-label="Voice">
            <p className="settings-note">
              {props.voiceAgent.available
                ? 'Spoken conversation is available.'
                : (props.voiceAgent.reason ?? 'Spoken conversation is unavailable.')}
            </p>

            <label className="settings-field">
              <span className="settings-label">Push-to-talk shortcut</span>
              <span className="settings-hint">
                {props.hotkeyInForce ? `Currently ${prettyHotkey(props.hotkeyInForce)}.` : 'No shortcut is registered.'}{' '}
                Leave empty to let Axon choose.
              </span>
              <span className="settings-row">
                <input
                  className="settings-input"
                  value={hotkeyDraft}
                  placeholder="Control+Shift+Space"
                  onChange={(event) => setHotkeyDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="settings-apply"
                  onClick={() => void apply({ voiceHotkey: hotkeyDraft.trim() === '' ? null : hotkeyDraft.trim() })}
                >
                  Apply
                </button>
              </span>
            </label>

            <Toggle
              label="Speak replies aloud"
              hint="Axon reads its answers out through the Windows voice."
              checked={props.settings.speechEnabled}
              onChange={(value) => void apply({ speechEnabled: value })}
            />
          </section>
        ) : null}

        {tab === 'wake' ? (
          <section className="settings-body" role="tabpanel" aria-label="Wake word">
            <p className={`wake-status wake-status-${props.voiceAgent.armed ? 'on' : 'off'}`} role="status">
              <span className="wake-status-dot" aria-hidden="true" />
              {props.voiceAgent.armed
                ? 'Listening for your wake phrase on this device.'
                : props.listening.available
                  ? 'Not listening for the wake phrase right now.'
                  : (props.listening.reason ?? 'The local recognizer is unavailable on this computer.')}
            </p>

            <p className="settings-lead">
              Axon listens locally for your wake phrase. Audio is sent to the voice service only after activation.
            </p>

            <StartupToggle />

            <h3 className="settings-section">What wakes Axon</h3>
            <p className="settings-note">
              Say <strong>“Hey Axon”</strong>, <strong>“Hello Axon”</strong> or <strong>“Hi Axon”</strong>. Axon does not
              wake on its name alone, on a greeting alone, or on a sentence that simply mentions it. Say the phrase on its own, then what you need.
            </p>

            <h3 className="settings-section">What happens to the audio</h3>
            <p className="settings-note">
              A recognizer on this computer hears short moments of speech and keeps none of them. Nothing is recorded,
              and nothing leaves the machine until you activate a conversation.
            </p>

            <h3 className="settings-section">If it does not respond</h3>
            <p className="settings-note">
              Click the orb in this window, or press the push-to-talk shortcut. Either is the same activation as saying
              the phrase.
            </p>
          </section>
        ) : null}

        {tab === 'conversations' ? (
          <section className="settings-body" role="tabpanel" aria-label="Conversations">
            <Toggle
              label="Reopen my last conversation"
              hint="When Axon starts, continue where you left off instead of starting fresh."
              checked={props.settings.restoreLastSession}
              onChange={(value) => void apply({ restoreLastSession: value })}
            />

            <div className="settings-field">
              <span className="settings-row settings-row-spread">
                <span className="settings-label">Recent conversations</span>
                <button type="button" className="settings-apply" onClick={() => void props.createSession().then(refresh)}>
                  New
                </button>
              </span>
              <ul className="settings-list">
                {sessions.length === 0 ? <li className="settings-empty">No saved conversations yet.</li> : null}
                {sessions.slice(0, 12).map((session) => (
                  <li
                    key={session.id}
                    className={`settings-item${session.id === props.conversationId ? ' settings-item-current' : ''}`}
                  >
                    <button
                      type="button"
                      className="settings-item-main"
                      onClick={() => void props.selectSession(session.id).then(refresh)}
                    >
                      <span className="settings-item-title">{session.title}</span>
                      <span className="settings-item-meta">
                        {shortDate(session.updatedAt)} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="settings-item-delete"
                      aria-label={`Delete ${session.title}`}
                      onClick={() => void props.deleteSession(session.id).then(refresh)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <h3 className="settings-section">Workspace</h3>
            <label className="settings-field">
              <span className="settings-label">Folder Axon may write to without asking</span>
              <span className="settings-hint">
                Anywhere else still asks you first. Leave empty for the default inside your Axon folder.
              </span>
              <span className="settings-row">
                <input
                  className="settings-input"
                  value={workspaceDraft}
                  placeholder="C:\Users\you\Documents\Axon"
                  onChange={(event) => setWorkspaceDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="settings-apply"
                  onClick={() => void apply({ workspacePath: workspaceDraft.trim() === '' ? null : workspaceDraft.trim() })}
                >
                  Apply
                </button>
              </span>
            </label>

            <button type="button" className="settings-reset" onClick={() => void props.onReset().then(setError)}>
              Reset all settings
            </button>
          </section>
        ) : null}

        {tab === 'memory' ? (
          <section className="settings-body" role="tabpanel" aria-label="Memory">
            <Toggle
              label="Use what Axon remembers"
              hint="When off, saved memories stay on disk but are not used in conversations."
              checked={props.settings.memoryEnabled}
              onChange={(value) => void apply({ memoryEnabled: value })}
            />
            <p className="settings-note">
              Axon only remembers something when you ask it to, and it asks before saving. It refuses to store passwords,
              keys, tokens and card numbers.
            </p>
            <ul className="settings-list">
              {memories.length === 0 ? <li className="settings-empty">Axon has not been asked to remember anything.</li> : null}
              {memories.map((memory) => (
                <li key={memory.id} className="settings-item settings-item-memory">
                  <div className="settings-item-main settings-item-static">
                    <span className="settings-item-title">
                      {memory.key}
                      {memory.sensitivity === 'personal' ? <span className="settings-chip">personal</span> : null}
                    </span>
                    <span className="settings-item-value">{memory.value}</span>
                    <span className="settings-item-meta">
                      {memory.category} · saved {shortDate(memory.createdAt)}
                    </span>
                  </div>
                  <span className="settings-item-actions">
                    <button
                      type="button"
                      className="settings-item-delete"
                      onClick={() => void props.setMemoryEnabled(memory.id, !memory.enabled).then(refresh)}
                    >
                      {memory.enabled ? 'Mute' : 'Unmute'}
                    </button>
                    <button
                      type="button"
                      className="settings-item-delete"
                      aria-label={`Forget ${memory.key}`}
                      onClick={() => void props.deleteMemory(memory.id).then(refresh)}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {memories.length > 0 ? (
              confirmingClear ? (
                <span className="settings-row">
                  <button
                    type="button"
                    className="settings-danger"
                    onClick={() =>
                      void props
                        .clearMemories()
                        .then(refresh)
                        .then(() => setConfirmingClear(false))
                    }
                  >
                    Yes, forget everything
                  </button>
                  <button type="button" className="settings-apply" onClick={() => setConfirmingClear(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" className="settings-danger" onClick={() => setConfirmingClear(true)}>
                  Forget everything
                </button>
              )
            ) : null}
          </section>
        ) : null}

        {tab === 'privacy' ? (
          <section className="settings-body" role="tabpanel" aria-label="Privacy">
            <h3 className="settings-section">Conversation history</h3>
            <p className="settings-note">
              What you and Axon said to each other, saved on this computer so you can pick up where you left off.
              Deleting a conversation removes its messages for good.
            </p>
            <h3 className="settings-section">Long-term memory</h3>
            <p className="settings-note">
              Separate from your conversations. Only things you asked Axon to remember, and only after you approved each
              one. Clearing memory does not delete your conversations.
            </p>
            <h3 className="settings-section">Browser profile</h3>
            <p className="settings-note">
              Axon&apos;s browser keeps its own sign-ins and cookies, as any browser does. Axon never reads them, never copies
              them into its database, and never sees a password you type there.
            </p>
            <h3 className="settings-section">What Axon never stores</h3>
            <p className="settings-note">
              Passwords, API keys, tokens, cookies and card numbers are refused rather than saved. Microphone audio is never
              written to disk.
            </p>
            <h3 className="settings-section">Where it lives</h3>
            <p className="settings-note settings-path">
              {props.persistence.available
                ? props.persistence.databasePath
                : (props.persistence.reason ?? 'Persistence is unavailable, so nothing is being saved.')}
            </p>
          </section>
        ) : null}

        {tab === 'about' ? (
          <section className="settings-body" role="tabpanel" aria-label="About">
            <p className="settings-lead">Axon is a voice agent for your Windows desktop.</p>
            <p className="settings-note">
              A realtime voice service hears you, reasons about what you asked, and speaks. Axon decides
              which actions are allowed, asks you before anything consequential, and checks the result by looking.
            </p>
            <h3 className="settings-section">What Axon deliberately cannot do</h3>
            <p className="settings-note">
              Run shell commands, press keys or shortcuts, move the mouse, read arbitrary files, type passwords, submit or
              buy anything without your decision, or see images.
            </p>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

/**
 * Start with Windows. The operating system is the source of truth: this reads
 * the setting from main each time the page opens, and shows what main reports
 * after every change.
 */
function StartupToggle(): React.JSX.Element | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    let live = true;
    void window.axon
      ?.getStartup()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!status) return null;
  return (
    <Toggle
      label="Start Axon when I sign in"
      hint={
        status.available
          ? 'Axon starts in the background with no window, listens on this computer for “Hey Axon”, and shows its orb when you say it.'
          : (status.reason ?? 'Not available on this computer.')
      }
      checked={status.enabled}
      onChange={(value) => {
        void window.axon
          ?.setStartup(value)
          .then(setStatus)
          .catch(() => undefined);
      }}
    />
  );
}

interface ToggleProps {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  onChange(value: boolean): void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps): React.JSX.Element {
  return (
    <label className="settings-field settings-toggle">
      <span className="settings-row settings-row-spread">
        <span className="settings-label">{label}</span>
        <input className="switch" type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      </span>
      <span className="settings-hint">{hint}</span>
    </label>
  );
}
