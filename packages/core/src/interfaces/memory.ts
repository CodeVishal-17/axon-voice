/**
 * Conversation and task memory.
 *
 * Implemented alongside the brain. The interface is intentionally small: an
 * append-only record plus retrieval. Whether that is backed by an in-process
 * array (Step 2) or SQLite with embeddings (Step 6) is not the brain's
 * business.
 */

import type { JsonValue } from '../json.js';

export interface MemoryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly at: string;
  readonly kind: 'utterance' | 'reply' | 'fact' | 'task';
  readonly text: string;
  readonly detail: JsonValue | null;
}

export interface MemoryQuery {
  readonly sessionId?: string;
  readonly kind?: MemoryRecord['kind'];
  readonly limit?: number;
}

export interface Memory {
  readonly name: string;
  append(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord>;
  recent(query: MemoryQuery): Promise<readonly MemoryRecord[]>;
  clear(sessionId: string): Promise<void>;
}
