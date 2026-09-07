/**
 * In-memory conversation store — the Step 2 `Memory` implementation.
 *
 * Deliberately not persistent. The `Memory` contract in `@axon/core` is the
 * same one a SQLite-backed store will implement later; nothing above this file
 * knows which it is talking to, so swapping the implementation is a change to
 * one line in `runtime.ts`.
 *
 * Lives under `brain/` because it is pure data structure — no Node, no
 * filesystem, no Electron — and the brain must be able to import it without
 * crossing its boundary.
 *
 * Records are capped per session. An assistant that has been running for a
 * week should not be holding every word of it in the heap, and a conversation
 * long enough to hit the cap has long since stopped fitting in a context
 * window anyway.
 */

import type { Memory, MemoryQuery, MemoryRecord } from '@axon/core';

const DEFAULT_MAX_RECORDS_PER_SESSION = 400;

export interface ConversationMemoryOptions {
  readonly maxRecordsPerSession?: number;
  readonly now?: () => Date;
  /** Injected so tests get deterministic ids without stubbing globals. */
  readonly newId?: () => string;
}

export class ConversationMemory implements Memory {
  readonly name = 'in-memory';

  private readonly bySession = new Map<string, MemoryRecord[]>();
  private readonly maxRecordsPerSession: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private counter = 0;

  constructor(options: ConversationMemoryOptions = {}) {
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? DEFAULT_MAX_RECORDS_PER_SESSION;
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.newId ?? ((): string => `mem-${++this.counter}`);
  }

  append(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
    const stored: MemoryRecord = { ...record, id: this.newId() };

    const existing = this.bySession.get(record.sessionId);
    const records = existing ?? [];
    if (!existing) this.bySession.set(record.sessionId, records);

    records.push(stored);
    if (records.length > this.maxRecordsPerSession) {
      records.splice(0, records.length - this.maxRecordsPerSession);
    }

    return Promise.resolve(stored);
  }

  /**
   * Most recent records, oldest first.
   *
   * `limit` trims from the *end* — the caller wants the newest N, but wants
   * them in the order they happened, which is the order a model must read
   * them in.
   */
  recent(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const pool = query.sessionId
      ? (this.bySession.get(query.sessionId) ?? [])
      : Array.from(this.bySession.values()).flat();

    const filtered = query.kind ? pool.filter((record) => record.kind === query.kind) : pool;
    const limit = query.limit;
    const window = typeof limit === 'number' && limit >= 0 ? filtered.slice(-limit) : filtered;

    return Promise.resolve([...window]);
  }

  clear(sessionId: string): Promise<void> {
    this.bySession.delete(sessionId);
    return Promise.resolve();
  }

  /** Timestamp helper so callers do not each invent their own clock. */
  timestamp(): string {
    return this.now().toISOString();
  }
}
