/**
 * The persistence service — what the rest of Axon talks to.
 *
 * Owns the database's lifetime, the current conversation, the settings, and
 * the profile. Everything above it (the orchestrator, the memory tools, the
 * IPC bridge) calls these methods; nothing above it sees SQL, a row, or a
 * connection.
 *
 * DEGRADED MODE IS A FIRST-CLASS STATE.
 *
 * If the database cannot be opened or migrated, Axon still runs. Conversations
 * live in memory for the session, the UI says persistence is unavailable and
 * why, and nothing is deleted or recreated to "fix" it — a damaged database is
 * somebody's history, and the recovery is their decision. Every method below
 * therefore has to work with no store at all, which is why they return empty
 * lists and `false` rather than throwing.
 *
 * The alternative — refusing to start — would mean a corrupted file makes the
 * application unopenable by the one person who might want to rescue it.
 */

import {
  PERSISTENCE_LIMITS,
  type AxonProfile,
  type AxonSettings,
  type MemoryEntry,
  type MemorySource,
  type MessageRecord,
  type PersistenceStatus,
  type SessionContext,
  type SessionRecord,
} from '@axon/core';
import { migrate, readVersion } from './migrations.js';
import { buildSessionContext, restoreHistory, summarizeSession } from './session-context.js';
import { toSessionDigests } from './temporal.js';
import { DEFAULT_SETTINGS, loadSettings, toRows } from './settings-schema.js';
import { PersistenceStore } from './store.js';
import { DatabaseError } from './errors.js';
import { openDatabase, type SqlDatabase } from './sqlite.js';

export interface PersistenceServiceOptions {
  /** Absolute path from trusted configuration. Never from input. */
  readonly databasePath: string;
  /** Notified of anything the timeline should show. Sanitized already. */
  onEvent?(event: PersistenceNotice): void;
  /** Injected in tests and the verification harness. */
  readonly openDatabase?: (path: string) => SqlDatabase;
  readonly now?: () => Date;
}

/** What the service tells the orchestrator about. Metadata only. */
export type PersistenceNotice =
  | { readonly kind: 'session'; readonly action: 'created' | 'restored' | 'renamed' | 'archived' | 'deleted'; readonly sessionId: string; readonly title: string }
  | { readonly kind: 'memory'; readonly action: 'created' | 'updated' | 'deleted' | 'cleared'; readonly memoryId: string | null; readonly category: string | null; readonly key: string | null; readonly count: number }
  | { readonly kind: 'settings'; readonly keys: readonly string[] }
  | { readonly kind: 'error'; readonly scope: string; readonly message: string };

export class PersistenceService {
  private readonly options: PersistenceServiceOptions;
  private readonly notify: (notice: PersistenceNotice) => void;

  private db: SqlDatabase | null = null;
  private store: PersistenceStore | null = null;
  private unavailableReason: string | null = 'Persistence has not been started.';
  private schemaVersion = 0;

  private settings: AxonSettings = DEFAULT_SETTINGS;
  private currentSessionId: string | null = null;

  constructor(options: PersistenceServiceOptions) {
    this.options = options;
    this.notify = options.onEvent ?? ((): void => {});
  }

  /**
   * Open the database and bring it up to date.
   *
   * Called once, during startup, BEFORE the window exists. Returns whether
   * persistence is available; never throws, because a failure here must
   * degrade the application rather than prevent it from starting.
   */
  start(): boolean {
    try {
      const open = this.options.openDatabase ?? ((path: string): SqlDatabase => openDatabase({ path }));
      const db = open(this.options.databasePath);

      // Fails closed: a migration that throws leaves the database at the
      // version it was already at and takes persistence offline.
      migrate(db);

      this.db = db;
      this.store = new PersistenceStore(db, { now: this.options.now });
      this.schemaVersion = readVersion(db);
      this.unavailableReason = null;

      const loaded = loadSettings(this.store.readSettingRows());
      this.settings = loaded.settings;

      if (loaded.repaired.length > 0) {
        // A stored value that failed validation was replaced with a default.
        // Said out loud: the user changed that setting once and it is not in
        // force any more, which they are entitled to know.
        this.notify({
          kind: 'error',
          scope: 'settings',
          message: `Some saved settings could not be read and were reset: ${loaded.repaired.join(', ')}.`,
        });
      }

      return true;
    } catch (error) {
      this.unavailableReason = describe(error);
      this.notify({ kind: 'error', scope: 'database', message: this.unavailableReason });
      return false;
    }
  }

  get available(): boolean {
    return this.store !== null;
  }

  status(): PersistenceStatus {
    return {
      available: this.available,
      reason: this.unavailableReason,
      // The path is shown so a user can find and delete the file. It is a
      // location in their own profile directory, not a secret.
      databasePath: this.available ? this.options.databasePath : null,
      schemaVersion: this.schemaVersion,
      sessionCount: this.guard(() => this.store?.countSessions() ?? 0, 0),
      memoryCount: this.guard(() => this.store?.countMemories() ?? 0, 0),
    };
  }

  // --- conversations --------------------------------------------------------

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Decide which conversation to open at startup.
   *
   * Restores the most recent one when the user asked for that and there is
   * one; otherwise starts fresh. Either way the application ends up with
   * exactly one current session, so nothing downstream has to handle "none".
   */
  openInitialSession(): SessionRecord | null {
    if (!this.store) return null;

    return this.guard(() => {
      const store = this.store;
      if (!store) return null;

      if (this.settings.restoreLastSession) {
        const recent = store.mostRecentSession();
        if (recent) {
          this.currentSessionId = recent.id;
          this.notify({ kind: 'session', action: 'restored', sessionId: recent.id, title: recent.title });
          return recent;
        }
      }

      const created = store.createSession();
      this.currentSessionId = created.id;
      this.notify({ kind: 'session', action: 'created', sessionId: created.id, title: created.title });
      return created;
    }, null);
  }

  createSession(title?: string): SessionRecord | null {
    return this.guard(() => {
      const created = this.store?.createSession(title);
      if (!created) return null;
      this.currentSessionId = created.id;
      this.notify({ kind: 'session', action: 'created', sessionId: created.id, title: created.title });
      return created;
    }, null);
  }

  /** Reopen an existing conversation. Returns false if there is no such one. */
  selectSession(id: string): SessionRecord | null {
    return this.guard(() => {
      const session = this.store?.getSession(id);
      if (!session) return null;
      this.currentSessionId = session.id;
      this.notify({ kind: 'session', action: 'restored', sessionId: session.id, title: session.title });
      return session;
    }, null);
  }

  listSessions(): readonly SessionRecord[] {
    return this.guard(() => this.store?.listSessions() ?? [], []);
  }

  renameSession(id: string, title: string): boolean {
    return this.guard(() => {
      const renamed = this.store?.renameSession(id, title) ?? false;
      if (renamed) this.notify({ kind: 'session', action: 'renamed', sessionId: id, title });
      return renamed;
    }, false);
  }

  archiveSession(id: string): boolean {
    return this.guard(() => {
      const session = this.store?.getSession(id);
      const archived = this.store?.setSessionStatus(id, 'archived') ?? false;
      if (archived) this.notify({ kind: 'session', action: 'archived', sessionId: id, title: session?.title ?? '' });
      return archived;
    }, false);
  }

  /**
   * Delete a conversation and its messages.
   *
   * Irreversible on purpose. An undo would mean keeping the data after the
   * user asked for it to be gone, which is the opposite of what the button
   * says. If the deleted conversation was the current one, a fresh session
   * takes its place so Axon is never left pointing at something that no
   * longer exists.
   */
  deleteSession(id: string): boolean {
    return this.guard(() => {
      const session = this.store?.getSession(id);
      const deleted = this.store?.deleteSession(id) ?? false;
      if (!deleted) return false;

      this.notify({ kind: 'session', action: 'deleted', sessionId: id, title: session?.title ?? '' });
      if (this.currentSessionId === id) {
        this.currentSessionId = null;
        this.createSession();
      }
      return true;
    }, false);
  }

  /** Persist one message. Silently a no-op when persistence is unavailable. */
  appendMessage(role: 'user' | 'assistant', content: string, source: 'text' | 'voice' = 'text'): void {
    const sessionId = this.currentSessionId;
    if (!this.store || !sessionId) return;

    this.guard(() => {
      const result = this.store?.appendMessage({ sessionId, role, content, source });
      if (result?.redacted) {
        this.notify({
          kind: 'error',
          scope: 'privacy',
          message: 'Something in that message looked like a credential, so it was removed before saving.',
        });
      }
      // Refreshed from the visible transcript each time. Cheap, deterministic,
      // and it means a session's summary is never staler than its last message.
      this.refreshSummary(sessionId);
      return true;
    }, false);
  }

  messages(sessionId: string, limit?: number): readonly MessageRecord[] {
    return this.guard(() => this.store?.recentMessages(sessionId, limit) ?? [], []);
  }

  private refreshSummary(sessionId: string): void {
    const store = this.store;
    if (!store) return;
    const recent = store.recentMessages(sessionId, PERSISTENCE_LIMITS.maxRestoredMessages);
    store.setSessionSummary(sessionId, summarizeSession(recent));
  }

  // --- the bounded context handed to a turn ---------------------------------

  /**
   * What the brain gets to know about earlier work.
   *
   * The one place stored history becomes prompt content, and the reason the
   * brain has no database access: it receives this object as an argument.
   */
  contextForTurn(): { context: SessionContext | null; history: readonly MessageRecord[] } {
    const sessionId = this.currentSessionId;
    if (!this.store || !sessionId) return { context: null, history: [] };

    return this.guard(
      () => {
        const store = this.store;
        if (!store) return { context: null, history: [] };

        const stored = store.recentMessages(sessionId, PERSISTENCE_LIMITS.maxRestoredMessages);
        const history = restoreHistory(stored);
        const session = store.getSession(sessionId);
        const memories = this.settings.memoryEnabled ? store.activeMemories() : [];

        // The clock, read once, so `now` and every `when` below are computed
        // against the same instant. Two reads a millisecond apart could put a
        // conversation on either side of midnight.
        const now = this.options.now?.() ?? new Date();

        return {
          context: buildSessionContext({
            sessionId,
            summary: session?.summary ?? null,
            memories,
            history,
            memoryEnabled: this.settings.memoryEnabled,
            now: now.toISOString(),
            // Dated digests of earlier conversations, so "the issue I was
            // working on yesterday" resolves against real timestamps rather
            // than against the model's idea of what day it is. Titles and
            // deterministic summaries only: no message bodies, and nothing
            // derived from how anything was reasoned about.
            recent: toSessionDigests(store.listSessions(), { now, excludeId: sessionId }),
          }),
          history: history.messages,
        };
      },
      { context: null, history: [] },
    );
  }

  // --- memory ----------------------------------------------------------------

  /**
   * Write a memory that has ALREADY passed `evaluateMemory`.
   *
   * The policy is applied by the caller — the memory tool — before anything
   * reaches here. Keeping the judgement outside the store means there is one
   * place to read to know what Axon will remember, and it is not the same file
   * as the one that knows how to write a row.
   */
  saveMemory(input: {
    category: string;
    key: string;
    value: string;
    source: MemorySource;
    sensitivity: MemoryEntry['sensitivity'];
  }): MemoryEntry | null {
    return this.guard(() => {
      const existing = this.store?.searchMemories(input.key, 1) ?? [];
      const entry = this.store?.saveMemory(input) ?? null;
      if (!entry) return null;

      const updated = existing.some((memory) => memory.category === entry.category && memory.key === entry.key);
      this.notify({
        kind: 'memory',
        action: updated ? 'updated' : 'created',
        memoryId: entry.id,
        category: entry.category,
        key: entry.key,
        count: 1,
      });
      return entry;
    }, null);
  }

  listMemories(): readonly MemoryEntry[] {
    return this.guard(() => this.store?.listMemories() ?? [], []);
  }

  searchMemories(query: string, limit?: number): readonly MemoryEntry[] {
    return this.guard(() => this.store?.searchMemories(query, limit) ?? [], []);
  }

  setMemoryEnabled(id: string, enabled: boolean): boolean {
    return this.guard(() => this.store?.setMemoryEnabled(id, enabled) ?? false, false);
  }

  deleteMemory(id: string): boolean {
    return this.guard(() => {
      const entry = this.store?.listMemories().find((memory) => memory.id === id) ?? null;
      const deleted = this.store?.deleteMemory(id) ?? false;
      if (deleted) {
        this.notify({
          kind: 'memory',
          action: 'deleted',
          memoryId: id,
          category: entry?.category ?? null,
          key: entry?.key ?? null,
          count: 1,
        });
      }
      return deleted;
    }, false);
  }

  clearMemories(): number {
    return this.guard(() => {
      const count = this.store?.clearMemories() ?? 0;
      this.notify({ kind: 'memory', action: 'cleared', memoryId: null, category: null, key: null, count });
      return count;
    }, 0);
  }

  // --- settings and profile ---------------------------------------------------

  currentSettings(): AxonSettings {
    return this.settings;
  }

  /**
   * Replace the settings in memory and on disk.
   *
   * Takes already-validated settings: validation, hotkey re-registration and
   * rollback live in `settings-service.ts`, which owns the side effects. This
   * only records the outcome.
   */
  commitSettings(settings: AxonSettings, changedKeys: readonly string[]): void {
    this.settings = settings;
    this.guard(() => {
      this.store?.writeSettingRows(toRows(settings));
      return true;
    }, false);
    if (changedKeys.length > 0) this.notify({ kind: 'settings', keys: changedKeys });
  }

  profile(): AxonProfile {
    return this.guard(
      () => this.store?.readProfile() ?? { displayName: null, language: null, createdAt: '', profileVersion: 1 },
      { displayName: null, language: null, createdAt: '', profileVersion: 1 },
    );
  }

  updateProfile(patch: { displayName?: string | null; language?: string | null }): AxonProfile {
    const updated = this.guard(() => this.store?.writeProfile(patch) ?? null, null);
    return updated ?? this.profile();
  }

  // --- lifetime ---------------------------------------------------------------

  /**
   * Close the database.
   *
   * Bounded and synchronous. `node:sqlite` writes synchronously and WAL means
   * a close is a checkpoint rather than a flush of unwritten data, so there is
   * nothing to wait for — which is what keeps shutdown from hanging on a
   * database that is busy.
   */
  close(): void {
    const db = this.db;
    this.db = null;
    this.store = null;
    if (!db) return;
    try {
      db.close();
    } catch {
      // Already closed, or the handle is gone. Either way there is nothing
      // left to do, and a quit must not fail on it.
    }
  }

  /**
   * Run a database operation, degrading rather than throwing.
   *
   * A persistence failure is not a reason for the agent to stop working. It is
   * a reason to say so and carry on without saving — which is why every call
   * site gets a fallback value rather than an exception.
   */
  private guard<T>(work: () => T, fallback: T): T {
    if (!this.store) return fallback;
    try {
      return work();
    } catch (error) {
      const message = describe(error);
      this.notify({ kind: 'error', scope: 'database', message });

      // A damaged or unreachable database is not going to recover on the next
      // call. Taking persistence offline once is better than reporting the
      // same failure on every keystroke — and it is NOT a repair: the file is
      // left exactly as it is, for the user to decide about.
      if (error instanceof DatabaseError && (error.kind === 'CORRUPT' || error.kind === 'CLOSED')) {
        this.unavailableReason = message;
        this.store = null;
      }
      return fallback;
    }
  }
}

/**
 * A sentence about a database failure, for a person.
 *
 * Engine text, file paths and stack traces stay in the cause. What reaches the
 * timeline says what happened and what it means for them.
 */
function describe(error: unknown): string {
  if (error instanceof DatabaseError) {
    switch (error.kind) {
      case 'OPEN_FAILED':
        return 'Axon could not open its database, so this conversation will not be saved.';
      case 'MIGRATION_FAILED':
        return `${error.message} Axon will run without saving until this is resolved.`;
      case 'CORRUPT':
        return 'The Axon database file is damaged. Nothing has been deleted; saving is off until it is replaced.';
      case 'LOCKED':
        return 'Another Axon window is using the database, so this one will not save.';
      case 'CLOSED':
        return 'The database was closed, so nothing further will be saved.';
      default:
        return 'Axon could not save to its database.';
    }
  }
  return 'Axon could not save to its database.';
}
