/**
 * How a capture instruction reaches the window.
 *
 * The inbound twin of `speech-transport.ts`, and the same shape for the same
 * reason: the listening service is built during runtime assembly, before any
 * window exists, so it cannot hold a reference to something that can send to
 * one. It holds this instead, and the renderer bridge attaches itself once IPC
 * is up.
 *
 * Only commands travel this way — "open the microphone for session X", "close
 * it". Audio travels the other direction, on its own channel, and is accepted
 * only while a session this transport opened is still current.
 */

import type { CaptureCommand } from '@axon/core';
import type { MicGate } from './mic-gate.js';

/** Implemented by the renderer bridge. */
export interface CaptureSink {
  command(command: CaptureCommand): void;
}

export class CaptureTransport {
  private sink: CaptureSink | null = null;
  private readonly gate: MicGate | null;

  /**
   * Every capture command passes through here, which is why the permission
   * window is opened here and nowhere else. A command that did not open the
   * gate would produce a microphone the renderer is asked for and refused;
   * a gate opened anywhere else would be one no command justified.
   */
  constructor(gate: MicGate | null = null) {
    this.gate = gate;
  }

  attach(sink: CaptureSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = null;
  }

  /**
   * Send a command to whatever is listening.
   *
   * Silently drops when nothing is attached, which happens legitimately during
   * shutdown. A dropped 'start' means no microphone opens — the safe failure —
   * and a dropped 'stop' cannot strand one either, because the renderer closes
   * its own stream when the window goes away.
   */
  command(command: CaptureCommand): void {
    if (command.action === 'start') this.gate?.expect(command.captureId);
    else this.gate?.settle(command.captureId);
    this.sink?.command(command);
  }
}
