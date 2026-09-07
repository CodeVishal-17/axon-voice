/**
 * Event serialization tests.
 *
 * The event stream has to survive two hops it does not control: Electron's
 * structured-clone IPC boundary, and a JSONL line on disk. If an event cannot
 * round-trip, the timeline the user saw and the log we debug from are
 * different artefacts — which defeats the purpose of having one stream.
 */

import { describe, expect, it } from 'vitest';
import {
  AXON_EVENT_TYPES,
  AxonEventSchema,
  parseEvent,
  safeParseEvent,
  serializeEvent,
  toJsonValue,
  type AxonEvent,
} from '@axon/core';

const envelope = { id: 'evt-1', sessionId: 'sess-1', seq: 0, at: '2026-09-01T10:00:00.000Z' };

const SAMPLES: readonly AxonEvent[] = [
  { ...envelope, type: 'STATE_CHANGED', from: 'IDLE', to: 'THINKING', reason: 'user spoke' },
  { ...envelope, seq: 1, type: 'STATE_CHANGED', from: null, to: 'IDLE', reason: 'boot' },
  { ...envelope, seq: 2, type: 'LISTENING', trigger: 'hotkey' },
  { ...envelope, seq: 3, type: 'THINKING', note: 'parsing the request' },
  { ...envelope, seq: 4, type: 'PLANNING', summary: 'two steps', steps: ['open', 'write'] },
  {
    ...envelope,
    seq: 5,
    type: 'TOOL_CALL',
    callId: 'call-1',
    tool: 'fs.write',
    input: { path: 'a.txt', content: 'hi', nested: { deep: [1, true, null] } },
    risk: 'REQUIRES_APPROVAL',
    riskReason: 'outside the workspace',
  },
  {
    ...envelope,
    seq: 6,
    type: 'TOOL_RESULT',
    callId: 'call-1',
    tool: 'fs.write',
    ok: true,
    durationMs: 12,
    output: { path: 'a.txt', bytesWritten: 2 },
    failure: null,
  },
  {
    ...envelope,
    seq: 7,
    type: 'TOOL_RESULT',
    callId: 'call-2',
    tool: 'shell.run',
    ok: false,
    durationMs: 1,
    output: null,
    failure: { kind: 'UNKNOWN_TOOL', message: 'no such tool', detail: null },
  },
  { ...envelope, seq: 8, type: 'OBSERVATION', callId: 'call-1', summary: 'wrote 2 bytes', detail: null },
  {
    ...envelope,
    seq: 9,
    type: 'APPROVAL_REQUIRED',
    request: {
      callId: 'call-3',
      tool: 'fs.write',
      risk: 'REQUIRES_APPROVAL',
      title: 'Axon wants to write a file',
      detail: 'outside the workspace',
      parameters: [{ label: 'Path', value: 'C:/Users/x/notes.txt' }],
      binding: {
        tool: 'fs.write',
        action: 'write a file',
        target: 'C:/Users/x/notes.txt',
        effect: 'LOCAL',
        fingerprint: '0123456789abcdef0123456789abcdef',
      },
      requestedAt: '2026-09-01T10:00:00.000Z',
      expiresAt: '2026-09-01T10:01:00.000Z',
    },
  },
  { ...envelope, seq: 10, type: 'APPROVAL_RESOLVED', callId: 'call-3', decision: 'ALLOW', resolvedBy: 'user' },
  {
    ...envelope,
    seq: 27,
    type: 'VOICE_SESSION',
    action: 'activated',
    activation: 'wake-word',
    phase: 'CONNECTING',
    detail: 'Voice conversation starting',
  },
  {
    ...envelope,
    seq: 28,
    type: 'VOICE_SESSION',
    action: 'armed',
    activation: null,
    phase: 'IDLE',
    detail: 'Listening locally for the wake phrase',
  },
  { ...envelope, seq: 11, type: 'COMPLETED', summary: 'done' },
  { ...envelope, seq: 12, type: 'ERROR', scope: 'voice', message: 'no device', detail: { code: 7 } },
  { ...envelope, seq: 13, type: 'USER_MESSAGE', text: 'open notepad', source: 'text' },
  { ...envelope, seq: 14, type: 'USER_MESSAGE', text: 'open notepad', source: 'voice' },
  // Multi-line and non-ASCII, because a reply goes through JSONL and IPC and
  // both have to survive it byte-for-byte.
  { ...envelope, seq: 15, type: 'ASSISTANT_MESSAGE', text: 'Opened Notepad.\nAnything else? — “yes”' },
  { ...envelope, seq: 16, type: 'SPEECH_STARTED', speechId: 'sp-1', characters: 15, durationMs: 1420, truncated: false },
  { ...envelope, seq: 17, type: 'SPEECH_STARTED', speechId: 'sp-2', characters: 2000, durationMs: 90_000, truncated: true },
  { ...envelope, seq: 18, type: 'SPEECH_ENDED', speechId: 'sp-1', reason: 'completed' },
  { ...envelope, seq: 19, type: 'SPEECH_ENDED', speechId: 'sp-2', reason: 'timeout' },
  { ...envelope, seq: 20, type: 'SESSION_CHANGED', action: 'created', conversationId: 'c-1', title: 'New conversation' },
  { ...envelope, seq: 21, type: 'SESSION_CHANGED', action: 'restored', conversationId: 'c-1', title: 'Refactoring the parser' },
  { ...envelope, seq: 22, type: 'SESSION_CHANGED', action: 'deleted', conversationId: 'c-1', title: 'Refactoring the parser' },
  {
    ...envelope,
    seq: 23,
    type: 'MEMORY_CHANGED',
    action: 'created',
    memoryId: 'm-1',
    category: 'project',
    key: 'current project',
    count: 1,
  },
  { ...envelope, seq: 24, type: 'MEMORY_CHANGED', action: 'cleared', memoryId: null, category: null, key: null, count: 7 },
  { ...envelope, seq: 25, type: 'SETTINGS_UPDATED', keys: ['voiceHotkey', 'workspacePath'] },
  { ...envelope, seq: 26, type: 'PERSISTENCE_ERROR', scope: 'database', message: 'The database is locked.' },
];

describe('event serialization', () => {
  it('covers every declared event type', () => {
    expect(new Set(SAMPLES.map((e) => e.type)).size).toBe(AXON_EVENT_TYPES.length);
  });

  it.each(SAMPLES.map((event) => [event.type, event] as const))(
    'round-trips %s exactly',
    (_type, event) => {
      const line = serializeEvent(event);
      expect(line).not.toContain('\n');
      expect(parseEvent(line)).toEqual(event);
    },
  );

  it('produces one JSONL line per event, all re-parseable', () => {
    const log = SAMPLES.map(serializeEvent).join('\n');
    const parsed = log.split('\n').map(parseEvent);
    expect(parsed).toEqual(SAMPLES);
  });
});

describe('event validation', () => {
  it('rejects an unknown event type', () => {
    expect(AxonEventSchema.safeParse({ ...envelope, type: 'DANCING' }).success).toBe(false);
  });

  it('rejects a missing envelope field', () => {
    const { id: _id, ...withoutId } = envelope;
    expect(AxonEventSchema.safeParse({ ...withoutId, type: 'COMPLETED', summary: 'x' }).success).toBe(false);
  });

  it('rejects an invalid state in STATE_CHANGED', () => {
    const result = AxonEventSchema.safeParse({ ...envelope, type: 'STATE_CHANGED', from: null, to: 'BUSY', reason: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative sequence number', () => {
    expect(AxonEventSchema.safeParse({ ...envelope, seq: -1, type: 'COMPLETED', summary: 'x' }).success).toBe(false);
  });

  it('rejects a non-JSON payload, so unserializable values fail at the source', () => {
    const result = AxonEventSchema.safeParse({
      ...envelope,
      type: 'OBSERVATION',
      callId: null,
      summary: 'binary',
      detail: Buffer.from('nope'),
    });
    expect(result.success).toBe(false);
  });
});

describe('safeParseEvent', () => {
  it('returns null for a line truncated by a crash mid-write', () => {
    const line = serializeEvent(SAMPLES[0] as AxonEvent);
    expect(safeParseEvent(line.slice(0, line.length - 8))).toBeNull();
  });

  it('returns null for structurally valid JSON that is not an event', () => {
    expect(safeParseEvent('{"hello":"world"}')).toBeNull();
  });

  it('returns the event for a good line', () => {
    expect(safeParseEvent(serializeEvent(SAMPLES[2] as AxonEvent))).toEqual(SAMPLES[2]);
  });
});

describe('toJsonValue', () => {
  it('converts an Error into something serializable', () => {
    expect(toJsonValue(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  it('replaces non-finite numbers rather than dropping them', () => {
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(toJsonValue(Number.NaN)).toBe('NaN');
  });

  it('survives a JSON.stringify round-trip for nested structures', () => {
    const value = toJsonValue({ a: [1, 'two', { three: new Date('2026-01-01T00:00:00Z') }], f: () => 1 });
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});
