/**
 * The event bus.
 *
 * One ordered stream, one place that stamps envelopes, one place that
 * validates. Emitters supply a payload; the bus assigns id, sequence number
 * and timestamp so ordering cannot be forged by a careless caller.
 *
 * Every event is validated against the schema on the way out. That costs a few
 * microseconds and buys two guarantees: the JSONL log can never contain a line
 * that fails to parse, and a payload that is not JSON-serializable (a Buffer,
 * a class instance) fails loudly at its source instead of silently arriving in
 * the renderer as `{}`.
 */

import { randomUUID } from 'node:crypto';
import { AxonEventSchema, type AxonEvent, type AxonEventInput } from '@axon/core';

export type EventListener = (event: AxonEvent) => void;

/** A durable destination for events, e.g. the JSONL file. */
export interface EventSink {
  write(event: AxonEvent): void;
}

export interface EventBusOptions {
  readonly sessionId?: string;
  /** How many events to retain for the renderer's initial snapshot. */
  readonly backlogSize?: number;
  readonly now?: () => Date;
}

const DEFAULT_BACKLOG = 500;

export class EventBus {
  readonly sessionId: string;

  private seq = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly sinks: EventSink[] = [];
  private readonly backlog: AxonEvent[] = [];
  private readonly backlogSize: number;
  private readonly now: () => Date;

  constructor(options: EventBusOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.backlogSize = options.backlogSize ?? DEFAULT_BACKLOG;
    this.now = options.now ?? (() => new Date());
  }

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Most recent events, oldest first. */
  recent(limit = this.backlogSize): readonly AxonEvent[] {
    return this.backlog.slice(-limit);
  }

  emit(input: AxonEventInput): AxonEvent {
    const candidate = {
      ...input,
      id: randomUUID(),
      sessionId: this.sessionId,
      seq: this.seq++,
      at: this.now().toISOString(),
    };

    // Throws on a malformed payload. This is deliberate: an unrepresentable
    // event is a programming error, and swallowing it would corrupt the one
    // record we rely on to explain what Axon did.
    const event = AxonEventSchema.parse(candidate);

    this.backlog.push(event);
    if (this.backlog.length > this.backlogSize) {
      this.backlog.splice(0, this.backlog.length - this.backlogSize);
    }

    for (const sink of this.sinks) {
      try {
        sink.write(event);
      } catch {
        // A failing sink (disk full, file locked) must not take down the
        // running agent or block the UI from seeing the event.
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Same reasoning: one bad subscriber must not stop the others.
      }
    }

    return event;
  }
}
