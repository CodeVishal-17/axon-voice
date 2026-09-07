/**
 * Append-only JSONL sink.
 *
 * One event per line, so the log stays readable with `tail -f` and survives a
 * crash mid-write: the truncated final line is the only casualty, and
 * `safeParseEvent` skips it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { serializeEvent, type AxonEvent } from '@axon/core';
import type { EventSink } from './event-bus.js';

export class JsonlEventSink implements EventSink {
  private readonly stream: fs.WriteStream;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  }

  write(event: AxonEvent): void {
    this.stream.write(`${serializeEvent(event)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => {
        resolve();
      });
    });
  }
}
