/**
 * The bound between "what is stored" and "what is sent".
 *
 * Persistence without these limits would be a slow-motion bug: every
 * conversation grows, every prompt grows with it, and the failure arrives
 * weeks later on the machine of whoever used Axon most. These are enforced in
 * code rather than asked of the model, so they are testable exhaustively — and
 * this file is where the claim "restoring history cannot produce an unbounded
 * prompt" is actually checked.
 */

import { describe, expect, it } from 'vitest';
import { PERSISTENCE_LIMITS, type MemoryEntry, type MessageRecord } from '@axon/core';
import {
  buildSessionContext,
  restoreHistory,
  summarizeSession,
  toContextMemories,
} from '../src/main/persistence/session-context.js';

function message(seq: number, content: string, role: 'user' | 'assistant' = 'user'): MessageRecord {
  return {
    id: `m-${seq}`,
    sessionId: 's-1',
    role,
    content,
    seq,
    createdAt: `2026-09-01T10:${String(seq).padStart(2, '0')}:00.000Z`,
    source: 'text',
  };
}

function memory(key: string, value = 'v', overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem-${key}`,
    category: 'project',
    key,
    value,
    source: 'user',
    sensitivity: 'ordinary',
    enabled: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('restoring history is bounded by message count', () => {
  it('returns everything when it fits', () => {
    const stored = [message(1, 'a'), message(2, 'b'), message(3, 'c')];
    const restored = restoreHistory(stored);

    expect(restored.messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
    expect(restored.truncated).toBe(false);
  });

  it('keeps the NEWEST messages, not the oldest', () => {
    // The most relevant history is the most recent. Trimming from the wrong
    // end would give the model the beginning of a conversation it has already
    // moved on from.
    const stored = Array.from({ length: 50 }, (_, i) => message(i + 1, `m${i + 1}`));
    const restored = restoreHistory(stored, { maxMessages: 5 });

    expect(restored.messages.map((m) => m.content)).toEqual(['m46', 'm47', 'm48', 'm49', 'm50']);
    expect(restored.truncated).toBe(true);
  });

  it('returns them oldest-first, which is the order they must be read in', () => {
    const stored = Array.from({ length: 10 }, (_, i) => message(i + 1, `m${i + 1}`));
    const restored = restoreHistory(stored, { maxMessages: 3 });

    const seqs = restored.messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('honours the default message limit', () => {
    const stored = Array.from({ length: 500 }, (_, i) => message(i + 1, 'x'));
    expect(restoreHistory(stored).messages.length).toBeLessThanOrEqual(PERSISTENCE_LIMITS.maxRestoredMessages);
  });
});

describe('restoring history is bounded by characters too', () => {
  it('stops at the character budget even when the count would allow more', () => {
    // The count alone is not enough: twenty-four messages can be a hundred
    // characters or a hundred thousand, and only one of those is a prompt.
    const stored = Array.from({ length: 20 }, (_, i) => message(i + 1, 'x'.repeat(1_000)));
    const restored = restoreHistory(stored, { maxMessages: 20, maxCharacters: 3_500 });

    expect(restored.messages.length).toBe(3);
    expect(restored.messages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(3_500);
    expect(restored.truncated).toBe(true);
  });

  it('always returns at least one message, however long it is', () => {
    // A single message longer than the whole budget should still be replayed:
    // leaving the model with nothing at all to answer from is worse.
    const stored = [message(1, 'x'.repeat(100_000))];
    const restored = restoreHistory(stored, { maxCharacters: 100 });

    expect(restored.messages).toHaveLength(1);
  });

  it('bounds a pathological conversation under the default limits', () => {
    const stored = Array.from({ length: 500 }, (_, i) => message(i + 1, 'x'.repeat(20_000)));
    const restored = restoreHistory(stored);
    const total = restored.messages.reduce((sum, m) => sum + m.content.length, 0);

    // Well under a context window, from a database holding ten million
    // characters.
    expect(total).toBeLessThanOrEqual(PERSISTENCE_LIMITS.maxRestoredCharacters + 20_000);
    expect(restored.messages.length).toBeLessThanOrEqual(PERSISTENCE_LIMITS.maxRestoredMessages);
  });

  it('handles an empty history', () => {
    expect(restoreHistory([]).messages).toEqual([]);
    expect(restoreHistory([]).truncated).toBe(false);
  });
});

describe('memories reaching a prompt', () => {
  it('projects to three fields and nothing else', () => {
    // No ids, no timestamps, no sensitivity, no source. Every field withheld
    // is one the model cannot repeat back or write somewhere else.
    const projected = toContextMemories([memory('current project', 'Axon')]);

    expect(projected).toEqual([{ category: 'project', key: 'current project', value: 'Axon' }]);
    expect(Object.keys(projected[0] ?? {}).sort()).toEqual(['category', 'key', 'value']);
  });

  it('excludes disabled memories', () => {
    const projected = toContextMemories([memory('on'), memory('off', 'v', { enabled: false })]);
    expect(projected.map((m) => m.key)).toEqual(['on']);
  });

  it('is bounded', () => {
    const many = Array.from({ length: 200 }, (_, i) => memory(`k${i}`));
    expect(toContextMemories(many).length).toBeLessThanOrEqual(PERSISTENCE_LIMITS.maxContextMemories);
  });
});

describe('assembling the context', () => {
  it('carries the summary, the memories and whether history was trimmed', () => {
    const context = buildSessionContext({
      sessionId: 's-1',
      summary: 'Refactoring the parser',
      memories: [memory('current project', 'Axon')],
      history: { messages: [], truncated: true },
      memoryEnabled: true,
      now: '2026-09-04T10:00:00.000Z',
    });

    expect(context.sessionId).toBe('s-1');
    expect(context.summary).toBe('Refactoring the parser');
    expect(context.memories).toHaveLength(1);
    expect(context.truncated).toBe(true);
  });

  it('gives no memories at all when the user turned memory off', () => {
    // None, rather than a filtered few: "off" has to mean off.
    const context = buildSessionContext({
      sessionId: 's-1',
      summary: null,
      memories: [memory('a'), memory('b')],
      history: { messages: [], truncated: false },
      memoryEnabled: false,
      now: '2026-09-04T10:00:00.000Z',
    });

    expect(context.memories).toEqual([]);
  });

  it('truncates an over-long stored summary', () => {
    const context = buildSessionContext({
      sessionId: 's-1',
      summary: 'x'.repeat(5_000),
      memories: [],
      history: { messages: [], truncated: false },
      memoryEnabled: true,
      now: '2026-09-04T10:00:00.000Z',
    });

    expect(context.summary?.length).toBe(PERSISTENCE_LIMITS.maxSummaryCharacters);
  });
});

describe('summarizing a conversation', () => {
  it('describes what the user asked for', () => {
    const summary = summarizeSession([
      message(1, 'Refactor the parser in the axon repo'),
      message(2, 'Sure, which file?', 'assistant'),
      message(3, 'The tokenizer'),
    ]);

    expect(summary).toContain('Refactor the parser');
    expect(summary).toContain('The tokenizer');
  });

  it('never includes what the assistant said', () => {
    // The summary is a trace of the user's requests. It cannot leak reasoning
    // because it never sees any — the assistant's replies are excluded
    // outright rather than filtered.
    const summary = summarizeSession([
      message(1, 'do the thing'),
      message(2, 'Let me think about this carefully. Step one...', 'assistant'),
    ]);

    expect(summary).not.toContain('Let me think');
    expect(summary).toBe('do the thing');
  });

  it('returns null for a conversation with no user messages', () => {
    expect(summarizeSession([])).toBeNull();
    expect(summarizeSession([message(1, 'hello', 'assistant')])).toBeNull();
  });

  it('is bounded', () => {
    const messages = Array.from({ length: 50 }, (_, i) => message(i + 1, 'x'.repeat(500)));
    const summary = summarizeSession(messages) ?? '';
    expect(summary.length).toBeLessThanOrEqual(PERSISTENCE_LIMITS.maxSummaryCharacters);
  });

  it('is deterministic', () => {
    // No model call, so no cost, no failure mode at startup, and no output
    // derived from anything the model was thinking.
    const messages = [message(1, 'first'), message(2, 'second'), message(3, 'third')];
    expect(summarizeSession(messages)).toBe(summarizeSession(messages));
  });

  it('collapses whitespace so one message is one line', () => {
    expect(summarizeSession([message(1, 'a\n\n   b')])).toBe('a b');
  });
});
