/**
 * The persistence store — every row Axon reads or writes.
 *
 * Sits directly on `sqlite.ts` and is the only module that knows the schema.
 * Everything above it (the orchestrator, the memory tools, the settings
 * service) talks to these methods and never sees SQL.
 *
 * SECURITY — three properties this file is responsible for.
 *
 * 1. EVERY QUERY IS PARAMETERIZED. There is no string concatenation into SQL
 *    anywhere below. A message, a memory value, a session title, a URL and a
 *    model's tool argument all arrive as bound parameters, which means the
 *    classic `'; DROP TABLE messages; --` is stored, retrieved and displayed
 *    as those exact characters. `persistence-security.test.ts` asserts the
 *    absence of interpolation in this file's source, and the real harness
 *    proves the round trip against real SQLite.
 *
 * 2. WHAT REACHES DISK IS ENUMERATED. Sessions, messages, memories, settings
 *    and a small profile. Not tool arguments, not tool results, not page text,
 *    not audio, not reasoning, not environment. If a future feature wants to
 *    persist something new it has to add a table here, which is a visible act.
 *
 * 3. EVERYTHING IS BOUNDED. Every insert enforces a length, and every table
 *    has a ceiling that prunes oldest-first. A database that grows without
 *    limit is a bug that only shows up after months of real use.
 */

import { randomUUID } from 'node:crypto';
import {
  PERSISTENCE_LIMITS,
  type AxonProfile,
  type MemoryEntry,
  type MemorySensitivity,
  type MemorySource,
  type MessageRecord,
  type MessageRole,
  type SessionRecord,
  type SessionStatus,
} from '@axon/core';
import { redactSecrets } from './redaction.js';
import type { SqlDatabase } from './sqlite.js';

type SessionRow = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  seq: number;
  source: string;
  created_at: string;
};

type MemoryRow = {
  id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  sensitivity: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export interface StoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The result of appending a message, including whether anything was removed. */
export interface AppendResult {
  readonly message: MessageRecord;
  /** True when a credential-shaped span was replaced before storing. */
  readonly redacted: boolean;
}

export class PersistenceStore {
  private readonly db: SqlDatabase;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.newId ?? ((): string => randomUUID());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  // --- sessions -----------------------------------------------------------

  createSession(title = 'New conversation'): SessionRecord {
    const at = this.timestamp();
    const id = this.newId();
    const clean = trim(title, PERSISTENCE_LIMITS.maxTitleCharacters) || 'New conversation';

    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO sessions (id, title, summary, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
        [id, clean, 'active', at, at],
      );
      this.pruneSessions();
    });

    return { id, title: clean, summary: null, status: 'active', createdAt: at, updatedAt: at, messageCount: 0 };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.get<SessionRow>(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s WHERE s.id = ?`,
      [id],
    );
    return row ? toSession(row) : null;
  }

  /** Most recently updated first — the order a session list is read in. */
  listSessions(limit: number = PERSISTENCE_LIMITS.maxSessions): readonly SessionRecord[] {
    const rows = this.db.all<SessionRow>(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`,
      [bound(limit, 1, PERSISTENCE_LIMITS.maxSessions)],
    );
    return rows.map(toSession);
  }

  /** The conversation to reopen on launch, if any. */
  mostRecentSession(): SessionRecord | null {
    const row = this.db.get<SessionRow>(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s WHERE s.status = 'active' ORDER BY s.updated_at DESC LIMIT 1`,
    );
    return row ? toSession(row) : null;
  }

  renameSession(id: string, title: string): boolean {
    const clean = trim(title, PERSISTENCE_LIMITS.maxTitleCharacters);
    if (clean === '') return false;
    return this.db.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [clean, this.timestamp(), id])
      .changes > 0;
  }

  setSessionStatus(id: string, status: SessionStatus): boolean {
    return this.db.run('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?', [status, this.timestamp(), id])
      .changes > 0;
  }

  /**
   * Store an operational summary of what a conversation was about.
   *
   * Bounded, and never reasoning: what reaches here is built from the visible
   * transcript by `session-summary.ts`, which has no access to anything else.
   */
  setSessionSummary(id: string, summary: string | null): boolean {
    const clean = summary === null ? null : trim(summary, PERSISTENCE_LIMITS.maxSummaryCharacters) || null;
    return this.db.run('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?', [clean, this.timestamp(), id])
      .changes > 0;
  }

  /**
   * Delete a conversation and everything in it.
   *
   * Really deletes. The messages go with it through `ON DELETE CASCADE`, which
   * is only true because every connection sets `foreign_keys = ON` — see
   * `sqlite.ts`. A "delete" that left the messages behind would be the worst
   * kind of privacy bug: one the UI reports as done.
   */
  deleteSession(id: string): boolean {
    return this.db.transaction(() => this.db.run('DELETE FROM sessions WHERE id = ?', [id]).changes > 0);
  }

  // --- messages -----------------------------------------------------------

  /**
   * Append a message to a conversation.
   *
   * The session's `updated_at`, the message and the pruning all happen in one
   * transaction: a conversation whose row says it was touched but whose
   * message is missing would put the session list and the transcript into
   * permanent disagreement.
   */
  appendMessage(input: {
    sessionId: string;
    role: MessageRole;
    content: string;
    source?: 'text' | 'voice';
  }): AppendResult {
    // A message is a record of what was said, so a credential-shaped span is
    // replaced rather than the whole message dropped — and the replacement is
    // visible. See `redaction.ts` for why memories are treated differently.
    const { text, redacted } = redactSecrets(input.content);
    const content = trim(text, PERSISTENCE_LIMITS.maxMessageCharacters);
    const at = this.timestamp();
    const id = this.newId();

    const message = this.db.transaction((): MessageRecord => {
      const next = this.db.get<{ next: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?',
        [input.sessionId],
      );
      const seq = next?.next ?? 1;

      this.db.run(
        'INSERT INTO messages (id, session_id, role, content, seq, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, input.sessionId, input.role, content, seq, input.source ?? 'text', at],
      );
      this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [at, input.sessionId]);
      this.pruneMessages(input.sessionId);

      return { id, sessionId: input.sessionId, role: input.role, content, seq, createdAt: at, source: input.source ?? 'text' };
    });

    return { message, redacted };
  }

  /**
   * The most recent messages of a conversation, oldest first.
   *
   * Newest N selected, then reversed: the caller wants the latest slice, but a
   * model must read it in the order it happened.
   */
  recentMessages(sessionId: string, limit: number = PERSISTENCE_LIMITS.maxRestoredMessages): readonly MessageRecord[] {
    const rows = this.db.all<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
      [sessionId, bound(limit, 0, PERSISTENCE_LIMITS.maxMessagesPerSession)],
    );
    return rows.map(toMessage).reverse();
  }

  countMessages(sessionId: string): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?', [sessionId]);
    return row?.c ?? 0;
  }

  // --- memories -----------------------------------------------------------

  /**
   * Write or update one memory.
   *
   * Upserts on category+key, so remembering the same thing twice corrects it
   * rather than leaving the model to choose between two contradictory rows.
   *
   * NOTE what this method does NOT do: it does not decide whether the memory
   * is allowed. That is `memory-policy.ts`, applied by the caller before it
   * gets here, and the separation is deliberate — a store that also judged
   * would be a store that could be talked into judging differently.
   */
  saveMemory(input: {
    category: string;
    key: string;
    value: string;
    source: MemorySource;
    sensitivity: MemorySensitivity;
  }): MemoryEntry {
    const at = this.timestamp();

    return this.db.transaction((): MemoryEntry => {
      const existing = this.db.get<MemoryRow>('SELECT * FROM memories WHERE category = ? AND key = ?', [
        input.category,
        input.key,
      ]);

      if (existing) {
        this.db.run('UPDATE memories SET value = ?, source = ?, sensitivity = ?, updated_at = ? WHERE id = ?', [
          input.value,
          input.source,
          input.sensitivity,
          at,
          existing.id,
        ]);
        return toMemory({ ...existing, value: input.value, source: input.source, sensitivity: input.sensitivity, updated_at: at });
      }

      const id = this.newId();
      this.db.run(
        `INSERT INTO memories (id, category, key, value, source, sensitivity, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, input.category, input.key, input.value, input.source, input.sensitivity, at, at],
      );
      this.pruneMemories();

      return {
        id,
        category: input.category,
        key: input.key,
        value: input.value,
        source: input.source,
        sensitivity: input.sensitivity,
        enabled: true,
        createdAt: at,
        updatedAt: at,
      };
    });
  }

  listMemories(): readonly MemoryEntry[] {
    const rows = this.db.all<MemoryRow>(
      'SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?',
      [PERSISTENCE_LIMITS.maxMemories],
    );
    return rows.map(toMemory);
  }

  /** Enabled memories, for a prompt. Bounded well below the storage limit. */
  activeMemories(limit: number = PERSISTENCE_LIMITS.maxContextMemories): readonly MemoryEntry[] {
    const rows = this.db.all<MemoryRow>(
      'SELECT * FROM memories WHERE enabled = 1 ORDER BY updated_at DESC LIMIT ?',
      [bound(limit, 0, PERSISTENCE_LIMITS.maxContextMemories)],
    );
    return rows.map(toMemory);
  }

  /**
   * Search memories by substring.
   *
   * `LIKE` with an escaped pattern bound as a parameter. The escape matters:
   * without it a query containing `%` matches everything, which is a small
   * information leak rather than an injection — but it is still the query
   * doing something other than what was asked.
   */
  searchMemories(query: string, limit: number = PERSISTENCE_LIMITS.maxMemorySearchResults): readonly MemoryEntry[] {
    const needle = trim(query, 200);
    if (needle === '') return this.activeMemories(limit);

    const pattern = `%${escapeLike(needle)}%`;
    const rows = this.db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE enabled = 1 AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC LIMIT ?`,
      [pattern, pattern, pattern, bound(limit, 1, PERSISTENCE_LIMITS.maxMemorySearchResults)],
    );
    return rows.map(toMemory);
  }

  setMemoryEnabled(id: string, enabled: boolean): boolean {
    return this.db.run('UPDATE memories SET enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      this.timestamp(),
      id,
    ]).changes > 0;
  }

  deleteMemory(id: string): boolean {
    return this.db.run('DELETE FROM memories WHERE id = ?', [id]).changes > 0;
  }

  /** Delete every memory. Returns how many there were. */
  clearMemories(): number {
    return this.db.transaction(() => {
      const before = this.countMemories();
      this.db.run('DELETE FROM memories');
      return before;
    });
  }

  countMemories(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM memories')?.c ?? 0;
  }

  countSessions(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM sessions')?.c ?? 0;
  }

  // --- settings and profile ------------------------------------------------

  readSettingRows(): Record<string, string> {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row.key === 'string' && typeof row.value === 'string') out[row.key] = row.value;
    }
    return out;
  }

  /**
   * Replace the stored settings with exactly these rows.
   *
   * One transaction, and a delete of anything not in the new set: a setting
   * that was removed from the schema should not linger as a row that a future
   * build might read and act on.
   */
  writeSettingRows(rows: Readonly<Record<string, string>>): void {
    const at = this.timestamp();
    this.db.transaction(() => {
      this.db.run('DELETE FROM settings WHERE key NOT IN (SELECT key FROM settings WHERE 0)');
      for (const [key, value] of Object.entries(rows)) {
        this.db.run(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, value, at],
        );
      }
      // Rows the new set does not mention are stale.
      const keep = Object.keys(rows);
      for (const existing of this.db.all<{ key: string }>('SELECT key FROM settings')) {
        if (!keep.includes(existing.key) && !PROFILE_KEYS.has(existing.key)) {
          this.db.run('DELETE FROM settings WHERE key = ?', [existing.key]);
        }
      }
    });
  }

  /**
   * The local profile.
   *
   * Kept in the settings table rather than a table of its own: it is three
   * optional fields, and a table for three fields would be ceremony. The keys
   * are namespaced so `writeSettingRows` does not treat them as stale.
   */
  readProfile(): AxonProfile {
    const rows = this.readSettingRows();
    return {
      displayName: readableName(rows['profile.displayName']),
      language: readableLanguage(rows['profile.language']),
      createdAt: rows['profile.createdAt'] ?? this.timestamp(),
      profileVersion: 1,
    };
  }

  writeProfile(profile: { displayName?: string | null; language?: string | null }): AxonProfile {
    const at = this.timestamp();
    const existing = this.readProfile();

    this.db.transaction(() => {
      const set = (key: string, value: string | null): void => {
        if (value === null) {
          this.db.run('DELETE FROM settings WHERE key = ?', [key]);
          return;
        }
        this.db.run(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, value, at],
        );
      };

      if (profile.displayName !== undefined) set('profile.displayName', readableName(profile.displayName ?? undefined));
      if (profile.language !== undefined) set('profile.language', readableLanguage(profile.language ?? undefined));
      if (!this.readSettingRows()['profile.createdAt']) set('profile.createdAt', existing.createdAt);
    });

    return this.readProfile();
  }

  // --- retention ------------------------------------------------------------

  /**
   * Keep the newest conversations and drop the rest.
   *
   * Oldest-first by `updated_at`, so a conversation someone keeps returning to
   * survives even if it was started long ago. Archived sessions go first.
   */
  private pruneSessions(): void {
    const excess = this.countSessions() - PERSISTENCE_LIMITS.maxSessions;
    if (excess <= 0) return;

    this.db.run(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions ORDER BY (status = 'active') ASC, updated_at ASC LIMIT ?
       )`,
      [excess],
    );
  }

  private pruneMessages(sessionId: string): void {
    const excess = this.countMessages(sessionId) - PERSISTENCE_LIMITS.maxMessagesPerSession;
    if (excess <= 0) return;

    this.db.run(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?
       )`,
      [sessionId, excess],
    );
  }

  private pruneMemories(): void {
    const excess = this.countMemories() - PERSISTENCE_LIMITS.maxMemories;
    if (excess <= 0) return;

    // Disabled memories first — a memory the user switched off is the one they
    // least want kept when something has to go.
    this.db.run(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories ORDER BY enabled ASC, updated_at ASC LIMIT ?
       )`,
      [excess],
    );
  }
}

/** Profile keys live in the settings table and are not settings. */
const PROFILE_KEYS = new Set(['profile.displayName', 'profile.language', 'profile.createdAt']);

function toSession(row: SessionRow): SessionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    messageCount: typeof row.message_count === 'number' ? row.message_count : 0,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    // A row whose role is not one of the two we write is a corrupt row, and a
    // corrupt row must not become an unexpected message role in a prompt.
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: String(row.content),
    seq: Number(row.seq),
    createdAt: String(row.created_at),
    source: row.source === 'voice' ? 'voice' : 'text',
  };
}

function toMemory(row: MemoryRow): MemoryEntry {
  const sensitivity = row.sensitivity;
  return {
    id: String(row.id),
    category: String(row.category),
    key: String(row.key),
    value: String(row.value),
    source: row.source === 'assistant' || row.source === 'system' ? row.source : 'user',
    // An unrecognised classification is treated as the more cautious one.
    sensitivity: sensitivity === 'personal' || sensitivity === 'secret' ? (sensitivity as MemorySensitivity) : 'ordinary',
    enabled: Number(row.enabled) !== 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function trim(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit);
}

function bound(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Escape LIKE's own wildcards so a search means what it says. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function readableName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\s+/g, ' ').slice(0, 60);
  return clean === '' ? null : clean;
}

function readableLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().slice(0, 20);
  // A BCP-47-ish tag and nothing else. This value ends up in a prompt.
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(clean) ? clean : null;
}
