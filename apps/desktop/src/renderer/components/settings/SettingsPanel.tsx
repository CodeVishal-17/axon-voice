/**
 * Settings, memory and privacy.
 *
 * One drawer with three sections rather than a settings dashboard. Axon has
 * five settings; a page of nested tabs for five settings is ceremony that
 * makes a product feel bigger and understand itself less.
 *
 * THE PRIVACY SECTION IS THE POINT. Axon now keeps three separate things on
 * disk — conversations, long-term memory, and the browser's own profile — and
 * they have different lifetimes and different delete buttons. A user who
 * clears their chat history and assumes they have signed out of GitHub has
 * been misled by the interface, not by the code. So the three are named
 * separately, explained in a sentence each, and their controls are apart.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AxonSettings, MemoryEntry, PersistenceStatus, SessionRecord } from '@axon/core';

export interface SettingsPanelProps {
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

type Tab = 'general' | 'memory' | 'privacy';

/** "Control+Shift+Space" -> "Ctrl + Shift + Space". */
function prettyHotkey(accelerator: string): string {
  return accelerator.replace(/\bControl\b/g, 'Ctrl').split('+').join(' + ');
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('general');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([]);
  const [memories, setMemories] = useState<readonly MemoryEntry[]>([]);
  const [hotkeyDraft, setHotkeyDraft] = useState(props.settings.voiceHotkey ?? '');
  const [workspaceDraft, setWorkspaceDraft] = useState(props.settings.workspacePath ?? '');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const { listSessions, listMemories } = props;

  const refresh = useCallback(async (): Promise<void> => {
    const [nextSessions, nextMemories] = await Promise.all([listSessions(), listMemories()]);
    setSessions(nextSessions);
    setMemories(nextMemories);
  }, [listSessions, listMemories]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escape closes. A settings drawer that traps you is a settings drawer people
  // avoid opening.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [props]);

  const apply = useCallback(
    async (patch: Partial<AxonSettings>): Promise<void> => {
      const failure = await props.onUpdate(patch);
      setError(failure);
    },
    [props],
  );

  return (
    <div className="settings-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <aside className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="settings-close" onClick={props.onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <nav className="settings-tabs" role="tablist">
          {(['general', 'memory', 'privacy'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={`settings-tab${tab === name ? ' settings-tab-active' : ''}`}
              onClick={() => setTab(name)}
            >
              {name === 'general' ? 'General' : name === 'memory' ? 'Memory' : 'Privacy'}
            </button>
          ))}
        </nav>

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}

        {tab === 'general' ? (
          <section className="settings-body">
            <h3 className="settings-section">Voice</h3>

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
                  placeholder="C:\\Users\\you\\Documents\\Axon"
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

            <h3 className="settings-section">Conversations</h3>

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
                  <li key={session.id} className={`settings-item${session.id === props.conversationId ? ' settings-item-current' : ''}`}>
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

            <button type="button" className="settings-reset" onClick={() => void props.onReset().then(setError)}>
              Reset all settings
            </button>
          </section>
        ) : null}

        {tab === 'memory' ? (
          <section className="settings-body">
            <Toggle
              label="Use what Axon remembers"
              hint="When off, saved memories stay on disk but are not used in conversations."
              checked={props.settings.memoryEnabled}
              onChange={(value) => void apply({ memoryEnabled: value })}
            />

            <p className="settings-note">
              Axon only remembers something when you ask it to, and it asks before saving. It refuses to store
              passwords, keys, tokens and card numbers.
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
                  <button type="button" className="settings-danger" onClick={() => void props.clearMemories().then(refresh).then(() => setConfirmingClear(false))}>
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
          <section className="settings-body">
            {/* Three stores, named separately, because they are three things.
                Conflating them in the interface is how a user ends up believing
                they have signed out of something they have not. */}
            <h3 className="settings-section">Conversation history</h3>
            <p className="settings-note">
              What you and Axon said to each other, saved on this computer so you can pick up where you left off.
              Deleting a conversation removes its messages for good.
            </p>

            <h3 className="settings-section">Long-term memory</h3>
            <p className="settings-note">
              Separate from your conversations. Only things you asked Axon to remember, and only after you approved
              each one. Clearing memory does not delete your conversations.
            </p>

            <h3 className="settings-section">Browser profile</h3>
            <p className="settings-note">
              Axon&apos;s browser keeps its own sign-ins and cookies, exactly as any browser does — and separately from
              everything above. Axon never reads them, never copies them into its database, and never sees a password
              you type there. Clearing your conversations or memory does <strong>not</strong> sign you out of anything.
            </p>

            <h3 className="settings-section">What Axon never stores</h3>
            <p className="settings-note">
              Passwords, API keys, tokens, cookies and card numbers are refused rather than saved. Microphone audio is
              never written to disk — only the text of what you said. Axon has no hidden record of its own reasoning.
            </p>

            <h3 className="settings-section">Where it lives</h3>
            <p className="settings-note settings-path">
              {props.persistence.available
                ? props.persistence.databasePath
                : (props.persistence.reason ?? 'Persistence is unavailable, so nothing is being saved.')}
            </p>
          </section>
        ) : null}
      </aside>
    </div>
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
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      </span>
      <span className="settings-hint">{hint}</span>
    </label>
  );
}
