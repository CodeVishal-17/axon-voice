/**
 * The `Memory` contract, backed by SQLite.
 *
 * Step 2 shipped `ConversationMemory`, an in-process array, against the
 * `Memory` interface in `@axon/core` — with a comment saying that a
 * SQLite-backed store would implement the same contract later and that
 * swapping it would be a change to one line in `runtime.ts`. This is that
 * store, and that is what it was.
 *
 * The consequence is worth stating: `ClaudeBrain` is UNCHANGED by this
 * milestone. It calls `memory.append` and `memory.recent` exactly as before
 * and cannot tell that the records now outlive the process. The brain gains
 * persistence without gaining a database, which is the whole point of having
 * had an interface there.
 *
 * WHAT THIS IS NOT. This is conversation history — the transcript. Long-term
 * memory is a different table, reached through the memory tools and the
 * dispatcher, and deliberately not exposed through this interface: an
 * automatic `append` on every turn is the right behaviour for a transcript and
 * exactly the wrong behaviour for something that is meant to be deliberate.
 */

import type { Memory, MemoryQuery, MemoryRecord } from '@axon/core';
import type { PersistenceService } from './persistence-service.js';

/**
 * Falls back to memory when the database is unavailable.
 *
 * A degraded Axon still holds a conversation; it just forgets it on exit. The
 * in-process array here is what makes that true, and it is capped for the same
 * reason `ConversationMemory` was: an assistant left running for a week should
 * not be holding every word of it in the heap.
 */
const MAX_FALLBACK_RECORDS = 400;

export class PersistentConversationMemory implements Memory {
  readonly name = 'sqlite';

  private readonly persistence: PersistenceService;
  private readonly fallback: MemoryRecord[] = [];
  private counter = 0;

  constructor(persistence: PersistenceService) {
    this.persistence = persistence;
  }

  /**
   * Record one turn.
   *
   * `utterance` and `reply` are the transcript and are persisted. The other
   * two kinds the contract allows — `fact` and `task` — are NOT written here:
   * they are long-term memory, and long-term memory is deliberate. A brain
   * that could create one by appending a record would bypass the policy, the
   * approval and the user entirely, which is the single thing the memory
   * design exists to prevent.
   */
  append(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
    const stored: MemoryRecord = { ...record, id: `mem-${(this.counter += 1)}` };

    if (record.kind === 'utterance' || record.kind === 'reply') {
      this.persistence.appendMessage(
        record.kind === 'utterance' ? 'user' : 'assistant',
        record.text,
        // The transcript records how a message arrived; `detail` is where the
        // orchestrator puts that, and anything else there is not persisted.
        readSource(record.detail),
      );
    }

    this.fallback.push(stored);
    if (this.fallback.length > MAX_FALLBACK_RECORDS) {
      this.fallback.splice(0, this.fallback.length - MAX_FALLBACK_RECORDS);
    }

    return Promise.resolve(stored);
  }

  /**
   * Recent records for a session, oldest first.
   *
   * Reads from the database when it is available, so a conversation resumed
   * after a restart has its history. Falls back to the in-process list
   * otherwise. Either way the result is bounded by the caller's limit AND by
   * the store's own ceiling — the brain asks for a window, and cannot ask for
   * a bigger one than persistence will give.
   */
  recent(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const sessionId = query.sessionId;
    const limit = typeof query.limit === 'number' && query.limit >= 0 ? query.limit : undefined;

    if (this.persistence.available && sessionId) {
      const messages = this.persistence.messages(sessionId, limit);
      const records: MemoryRecord[] = messages.map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        at: message.createdAt,
        kind: message.role === 'user' ? 'utterance' : 'reply',
        text: message.content,
        detail: null,
      }));
      return Promise.resolve(query.kind ? records.filter((record) => record.kind === query.kind) : records);
    }

    const pool = sessionId ? this.fallback.filter((record) => record.sessionId === sessionId) : this.fallback;
    const filtered = query.kind ? pool.filter((record) => record.kind === query.kind) : pool;
    return Promise.resolve(limit === undefined ? [...filtered] : filtered.slice(-limit));
  }

  /**
   * Forget a conversation.
   *
   * Deletes it from the database too. A `clear` that only emptied an array
   * would leave the transcript on disk while telling the caller it was gone.
   */
  clear(sessionId: string): Promise<void> {
    for (let i = this.fallback.length - 1; i >= 0; i -= 1) {
      if (this.fallback[i]?.sessionId === sessionId) this.fallback.splice(i, 1);
    }
    this.persistence.deleteSession(sessionId);
    return Promise.resolve();
  }
}

/** The one field of `detail` this store reads. Everything else is ignored. */
function readSource(detail: MemoryRecord['detail']): 'text' | 'voice' {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return (detail as Record<string, unknown>).source === 'voice' ? 'voice' : 'text';
  }
  return 'text';
}
