/**
 * Event delivery: bus -> sinks -> subscribers -> (IPC) -> renderer.
 *
 * The renderer never invents state, so the guarantee that matters is that the
 * events it receives are the same events the main process emitted and the same
 * events that reached the log. The IPC hop itself is simulated with a
 * JSON round-trip, which is the lossy part of Electron's structured clone —
 * anything that survives it survives the real boundary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent, safeParseEvent, serializeEvent, type AxonEvent } from '@axon/core';
import { EventBus } from '../src/main/bus/event-bus';
import { JsonlEventSink } from '../src/main/bus/jsonl-sink';

let tempRoot = '';

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-events-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('EventBus', () => {
  it('stamps id, session, sequence and timestamp', () => {
    const bus = new EventBus({ sessionId: 'sess-x', now: () => new Date('2026-09-01T12:00:00.000Z') });
    const event = bus.emit({ type: 'COMPLETED', summary: 'done' });

    expect(event.sessionId).toBe('sess-x');
    expect(event.seq).toBe(0);
    expect(event.at).toBe('2026-09-01T12:00:00.000Z');
    expect(event.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('numbers events monotonically so same-millisecond bursts stay ordered', () => {
    const bus = new EventBus({ now: () => new Date('2026-09-01T12:00:00.000Z') });
    const seqs = Array.from({ length: 5 }, (_, i) => bus.emit({ type: 'COMPLETED', summary: `#${i}` }).seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects an event that could not survive serialization', () => {
    const bus = new EventBus();
    expect(() =>
      bus.emit({
        type: 'OBSERVATION',
        callId: null,
        summary: 'binary payload',
        detail: Buffer.from('nope') as never,
      }),
    ).toThrow();
  });

  it('delivers to every subscriber, and stops on unsubscribe', () => {
    const bus = new EventBus();
    const a: AxonEvent[] = [];
    const b: AxonEvent[] = [];

    const stop = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit({ type: 'COMPLETED', summary: 'one' });
    stop();
    bus.emit({ type: 'COMPLETED', summary: 'two' });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('keeps running when one subscriber throws', () => {
    // A crashing panel in the renderer must not stop the log from being written
    // or the other listeners from hearing about it.
    const bus = new EventBus();
    const received: AxonEvent[] = [];

    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    bus.subscribe((e) => received.push(e));

    expect(() => bus.emit({ type: 'COMPLETED', summary: 'still delivered' })).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('keeps a bounded backlog for the renderer snapshot', () => {
    const bus = new EventBus({ backlogSize: 3 });
    for (let i = 0; i < 10; i += 1) bus.emit({ type: 'COMPLETED', summary: `#${i}` });

    const recent = bus.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.seq)).toEqual([7, 8, 9]);
  });
});

describe('JSONL sink', () => {
  it('writes one parseable line per event', async () => {
    const logPath = path.join(tempRoot, 'nested', 'events.jsonl');
    const bus = new EventBus();
    const sink = new JsonlEventSink(logPath);
    bus.addSink(sink);

    const emitted = [
      bus.emit({ type: 'LISTENING', trigger: 'hotkey' }),
      bus.emit({ type: 'THINKING', note: 'working it out' }),
      bus.emit({ type: 'COMPLETED', summary: 'done' }),
    ];
    await sink.close();

    const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map(parseEvent)).toEqual(emitted);
  });

  it('appends across sessions rather than truncating the audit trail', async () => {
    const logPath = path.join(tempRoot, 'events.jsonl');

    const first = new JsonlEventSink(logPath);
    const busA = new EventBus();
    busA.addSink(first);
    busA.emit({ type: 'COMPLETED', summary: 'session one' });
    await first.close();

    const second = new JsonlEventSink(logPath);
    const busB = new EventBus();
    busB.addSink(second);
    busB.emit({ type: 'COMPLETED', summary: 'session two' });
    await second.close();

    const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => safeParseEvent(l)?.sessionId)).toHaveLength(2);
  });

  it('does not let a failing sink stop delivery to the UI', () => {
    const bus = new EventBus();
    const received: AxonEvent[] = [];

    bus.addSink({
      write: () => {
        throw new Error('disk full');
      },
    });
    bus.subscribe((e) => received.push(e));

    expect(() => bus.emit({ type: 'COMPLETED', summary: 'x' })).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

describe('main -> renderer delivery', () => {
  /**
   * Stands in for `installRendererBridge`, which cannot be imported here
   * because it binds Electron's `ipcMain`. The subscription and the serialize
   * hop are the parts that can lose data, and both are exercised.
   */
  function fakeWindowChannel(bus: EventBus): { delivered: AxonEvent[]; stop: () => void } {
    const delivered: AxonEvent[] = [];
    const stop = bus.subscribe((event) => {
      // Electron structured-clones the payload across the boundary; a JSON
      // round-trip is the strictly harsher version of that.
      delivered.push(JSON.parse(JSON.stringify(event)) as AxonEvent);
    });
    return { delivered, stop };
  }

  it('delivers every emitted event, in order, unchanged', () => {
    const bus = new EventBus();
    const channel = fakeWindowChannel(bus);

    const emitted = [
      bus.emit({ type: 'STATE_CHANGED', from: 'IDLE', to: 'THINKING', reason: 'a request arrived' }),
      bus.emit({
        type: 'TOOL_CALL',
        callId: 'c1',
        tool: 'fs.write',
        input: { path: 'a.txt', content: 'x', nested: { list: [1, null, true] } },
        risk: 'REQUIRES_APPROVAL',
        riskReason: 'outside the workspace',
      }),
      bus.emit({
        type: 'APPROVAL_REQUIRED',
        request: {
          callId: 'c1',
          tool: 'fs.write',
          risk: 'REQUIRES_APPROVAL',
          title: 'Axon wants to write a file',
          detail: 'outside the workspace',
          parameters: [{ label: 'Path', value: 'C:/x/a.txt' }],
          binding: {
            tool: 'fs.write',
            action: 'write a file',
            target: 'C:/x/a.txt',
            effect: 'LOCAL',
            fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          requestedAt: '2026-09-01T12:00:00.000Z',
          expiresAt: '2026-09-01T12:01:00.000Z',
        },
      }),
    ];

    expect(channel.delivered).toEqual(emitted);
    expect(channel.delivered.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('delivers events that are still valid against the schema on arrival', () => {
    const bus = new EventBus();
    const channel = fakeWindowChannel(bus);
    bus.emit({ type: 'OBSERVATION', callId: 'c1', summary: 'wrote a file', detail: { bytes: 12 } });

    const arrived = channel.delivered[0]!;
    expect(parseEvent(serializeEvent(arrived))).toEqual(arrived);
  });

  it('stops delivering once the window is disposed', () => {
    const bus = new EventBus();
    const channel = fakeWindowChannel(bus);

    bus.emit({ type: 'COMPLETED', summary: 'before' });
    channel.stop();
    bus.emit({ type: 'COMPLETED', summary: 'after' });

    expect(channel.delivered).toHaveLength(1);
  });

  it('gives a late subscriber the backlog it missed, with no gaps or repeats', () => {
    // This is the renderer's cold-start path: snapshot first, then live events,
    // merged on the sequence number.
    const bus = new EventBus();
    bus.emit({ type: 'COMPLETED', summary: 'missed one' });
    bus.emit({ type: 'COMPLETED', summary: 'missed two' });

    const snapshot = bus.recent();
    const channel = fakeWindowChannel(bus);
    bus.emit({ type: 'COMPLETED', summary: 'live' });

    const merged = [...snapshot, ...channel.delivered];
    const seqs = merged.map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
