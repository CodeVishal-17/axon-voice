/**
 * One spoken conversation.
 *
 * Owns the provider protocol and nothing else: it does not own Axon's state
 * (the orchestrator does), it does not own the approval (the dispatcher does),
 * and it does not own the microphone (the renderer does, at main's request).
 * What it owns is the translation between a duplex audio protocol and the
 * event stream Axon already has.
 *
 *     renderer mic ─frames─> Orchestrator ─> this ─base64─> provider
 *                                             │
 *     transcript.user   ────────────────────> USER_MESSAGE
 *     tool.call         ────────────────────> ToolBridge -> Dispatcher
 *     transcript.agent  ────────────────────> ASSISTANT_MESSAGE
 *     reply.audio       ────────────────────> SpeechChunk -> renderer
 *
 * WHAT NEVER HAPPENS HERE.
 *
 * No audio is written to disk. No audio is placed in an event. No transcript
 * is persisted by this class. No credential is read — the socket holds it and
 * this class never sees it. Those are asserted structurally in
 * `agent-voice-security.test.ts` rather than left to review.
 *
 * TURN-TAKING IS THE PROVIDER'S JOB. It runs its own voice-activity detection
 * and tells us when speech starts and stops. Axon's own VAD is not used in
 * this mode — running two detectors over one microphone produces exactly the
 * disagreement about "is the user still talking?" that makes an assistant feel
 * broken. Axon's VAD still serves the local wake word, where it is the only
 * detector there is.
 */

import { randomUUID } from 'node:crypto';
import {
  VOICE_AGENT_ENCODING,
  VOICE_AGENT_LIMITS,
  type JsonValue,
  type SpeechChunk,
  type ToolCall,
  type ToolResult,
  type ToolSchema,
  type VoiceAgentPhase,
} from '@axon/core';
import { VoiceSocket, describeSocketError, type VoiceSocketError } from './assemblyai-client.js';
import { buildAgentSystemPrompt, buildAgentTools } from './agent-tool-surface.js';
import { ToolBridge } from './tool-bridge.js';

export interface VoiceAgentSessionOptions {
  readonly apiKey: string;
  readonly tools: readonly ToolSchema[];
  readonly platform: string;
  readonly workspaceRoot: string;
  /** Injected so the protocol is testable against a local fake server. */
  readonly createSocket?: (handlers: {
    onMessage(message: Record<string, unknown>): void;
    onClosed(error: VoiceSocketError | null): void;
  }) => VoiceSocket;
  readonly newCallId?: () => string;
  readonly now?: () => Date;

  // --- outward wiring, all supplied by the orchestrator ------------------
  dispatch(call: ToolCall): Promise<ToolResult>;
  willRequireApproval(tool: string, input: JsonValue): boolean;
  /** The user said something. Becomes USER_MESSAGE. */
  onUserTranscript(text: string): void;
  /** The agent said something. Becomes ASSISTANT_MESSAGE. */
  onAgentTranscript(text: string): void;
  /** One chunk of reply audio, on its way to the speakers. */
  onAudioChunk(chunk: SpeechChunk): void;
  /** The connection phase moved. Drives the orb through the orchestrator. */
  onPhase(phase: VoiceAgentPhase, detail: string): void;
  /** Something worth showing in the timeline. Never provider text verbatim. */
  onNotice(summary: string): void;
  /** The session ended. `error` is null for an ordinary close. */
  onClosed(error: VoiceSocketError | null): void;
}

export class VoiceAgentSession {
  private readonly options: VoiceAgentSessionOptions;
  private readonly bridge: ToolBridge;
  private readonly now: () => Date;

  private socket: VoiceSocket | null = null;
  private phase: VoiceAgentPhase = 'IDLE';
  private closed = false;

  /** The provider's session id, for resumption. Never leaves main. */
  private providerSessionId: string | null = null;
  private reconnectAttempts = 0;

  /** The utterance currently being streamed to the speakers. */
  private speechId: string | null = null;
  private chunkSequence = 0;

  private startedAt = 0;
  private lastActivityAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Audio accumulating toward one outbound chunk.
   *
   * The renderer sends ~64 ms blocks; the provider prefers ~50 ms. Rather than
   * re-cut the renderer's timing — which also feeds the orb — frames are
   * concatenated here and flushed when they reach the target. Bounded by
   * construction: it is flushed every time it fills.
   */
  private outbound: Uint8Array[] = [];
  private outboundBytes = 0;

  constructor(options: VoiceAgentSessionOptions) {
    this.options = options;
    this.now = options.now ?? ((): Date => new Date());

    this.bridge = new ToolBridge({
      dispatch: options.dispatch,
      tools: options.tools,
      newCallId: options.newCallId ?? ((): string => randomUUID()),
      willRequireApproval: options.willRequireApproval,
      onDeferredOutcome: (summary) => {
        this.speakOutcome(summary);
      },
      onNotice: options.onNotice,
    });
  }

  get currentPhase(): VoiceAgentPhase {
    return this.phase;
  }

  get active(): boolean {
    return !this.closed && this.socket !== null;
  }

  /** Open the socket and configure the agent. Resolves once it is ready. */
  async start(): Promise<void> {
    this.setPhase('CONNECTING', 'Connecting to the voice service');
    this.startedAt = this.now().getTime();
    this.lastActivityAt = this.startedAt;

    await this.connect();

    // Absolute ceiling on one session, independent of activity. A conversation
    // that never falls idle must still end eventually.
    this.ceilingTimer = timer(() => {
      this.options.onNotice('This voice session reached its time limit and was ended.');
      this.stop();
    }, VOICE_AGENT_LIMITS.maxSessionMs);

    this.armIdleTimer();
  }

  /**
   * Feed one frame of microphone audio.
   *
   * Called for every frame the renderer sends while a session is live. Frames
   * are buffered to the provider's preferred chunk size and forwarded; nothing
   * is retained past the flush.
   */
  pushAudio(pcm: Uint8Array): void {
    if (!this.active || !this.socket?.open) return;

    this.outbound.push(pcm);
    this.outboundBytes += pcm.byteLength;

    // bytes = rate * 2 (16-bit) * seconds
    const target = (VOICE_AGENT_LIMITS.sampleRate * 2 * VOICE_AGENT_LIMITS.outboundChunkMs) / 1000;
    if (this.outboundBytes < target) return;

    const chunk = concat(this.outbound, this.outboundBytes);
    this.outbound = [];
    this.outboundBytes = 0;
    this.socket.sendAudio(chunk);
  }

  /** End the conversation. Idempotent. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;

    clearTimer(this.idleTimer);
    clearTimer(this.ceilingTimer);
    this.idleTimer = null;
    this.ceilingTimer = null;

    this.bridge.close();
    this.finishSpeech();

    const socket = this.socket;
    this.socket = null;
    socket?.close();

    this.setPhase('CLOSED', 'Voice session ended');
    this.options.onClosed(null);
  }

  // --- connection ---------------------------------------------------------

  private async connect(): Promise<void> {
    const socket =
      this.options.createSocket?.({
        onMessage: (message) => {
          this.receive(message);
        },
        onClosed: (error) => {
          this.onSocketClosed(error);
        },
      }) ??
      new VoiceSocket(
        { apiKey: this.options.apiKey },
        {
          onMessage: (message) => {
            this.receive(message);
          },
          onClosed: (error) => {
            this.onSocketClosed(error);
          },
        },
      );

    this.socket = socket;
    await socket.open_();

    // Resume where possible, so a dropped connection does not lose the
    // conversation. Outside the provider's resumption window this is a new
    // session, and saying so is better than silently starting over.
    if (this.providerSessionId) {
      socket.send({ type: 'session.resume', session_id: this.providerSessionId });
    }

    socket.send({
      type: 'session.update',
      session: {
        system_prompt: buildAgentSystemPrompt({
          tools: this.options.tools,
          platform: this.options.platform,
          now: this.now().toISOString(),
          workspaceRoot: this.options.workspaceRoot,
        }),
        input: { format: { encoding: VOICE_AGENT_ENCODING, sample_rate: VOICE_AGENT_LIMITS.sampleRate } },
        output: { format: { encoding: VOICE_AGENT_ENCODING, sample_rate: VOICE_AGENT_LIMITS.sampleRate } },
        // Client-side tools only. `buildAgentTools` cannot produce an `http`
        // block, which is what keeps every proposal on this socket and inside
        // the dispatcher — see `agent-tool-surface.ts`.
        tools: buildAgentTools(this.options.tools),
      },
    });
  }

  /**
   * The socket went away.
   *
   * Reconnects inside the provider's resumption window, a bounded number of
   * times. Anything else ends the session and says why — an assistant that
   * silently reconnects forever is one whose microphone state the user cannot
   * reason about.
   */
  private onSocketClosed(error: VoiceSocketError | null): void {
    if (this.closed) return;
    this.socket = null;
    this.finishSpeech();

    const elapsed = this.now().getTime() - this.lastActivityAt;
    const resumable =
      error !== null &&
      error.retryable &&
      elapsed < VOICE_AGENT_LIMITS.resumeWindowMs &&
      this.reconnectAttempts < VOICE_AGENT_LIMITS.maxReconnectAttempts;

    if (!resumable) {
      this.closed = true;
      clearTimer(this.idleTimer);
      clearTimer(this.ceilingTimer);
      this.bridge.close();
      this.setPhase(error ? 'FAILED' : 'CLOSED', error ? error.message : 'Voice session ended');
      this.options.onClosed(error);
      return;
    }

    this.reconnectAttempts += 1;
    this.setPhase('CONNECTING', 'Reconnecting to the voice service');
    this.options.onNotice('The voice connection dropped. Reconnecting.');

    void this.connect().catch((reason: unknown) => {
      // A failed reconnect is a closure like any other, and recurses through
      // this same method until the attempt budget runs out.
      this.onSocketClosed(describeSocketError(reason));
    });
  }

  // --- protocol -----------------------------------------------------------

  /**
   * One server event.
   *
   * Every field is read defensively and re-shaped. The provider is a network
   * peer, and a peer's message is input — the same posture the browser layer
   * takes toward a page's return value.
   */
  private receive(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.lastActivityAt = this.now().getTime();
    this.armIdleTimer();

    const type = String(message.type);

    switch (type) {
      case 'session.ready': {
        this.providerSessionId = str(message.session_id, 128) || null;
        this.reconnectAttempts = 0;
        this.setPhase('LISTENING', 'Listening');
        return;
      }

      case 'session.updated':
        return;

      case 'input.speech.started': {
        // Barge-in. The user talking over the agent stops the agent's audio,
        // through the same path the stop button uses.
        this.finishSpeech();
        this.setPhase('LISTENING', 'Listening');
        return;
      }

      case 'input.speech.stopped': {
        this.setPhase('THINKING', 'Working out what to do');
        return;
      }

      case 'transcript.user.delta':
        // Partial text. Deliberately dropped: a transcript that is still being
        // revised has no business in an append-only event stream, and the
        // final one arrives a moment later.
        return;

      case 'transcript.user': {
        const text = str(message.text, VOICE_AGENT_LIMITS.maxTranscriptCharacters).trim();
        if (text !== '') this.options.onUserTranscript(text);
        return;
      }

      case 'reply.started': {
        this.beginSpeech();
        this.setPhase('SPEAKING', 'Speaking');
        return;
      }

      case 'reply.audio': {
        this.receiveAudio(message.data);
        return;
      }

      case 'transcript.agent': {
        const text = str(message.text, VOICE_AGENT_LIMITS.maxTranscriptCharacters).trim();
        if (text !== '') this.options.onAgentTranscript(text);
        return;
      }

      case 'tool.call': {
        const callId = str(message.call_id, 128);
        const name = str(message.name, 120);
        if (callId === '' || name === '') return;

        this.setPhase('TOOL', `Running ${name}`);
        // Never awaited here: this is a socket handler, and blocking it would
        // stall every subsequent frame including the user's own audio.
        void this.bridge.handleToolCall(callId, name, message.arguments);
        return;
      }

      case 'reply.done': {
        const status = str(message.status, 32) || 'completed';
        this.finishSpeech();

        // The protocol's rule: results are flushed here, not when they are
        // ready, and an interrupted turn discards them.
        for (const pending of this.bridge.flush(status)) {
          this.socket?.send({ type: 'tool.result', call_id: pending.callId, result: pending.result });
        }

        this.setPhase('LISTENING', 'Listening');
        return;
      }

      case 'session.ended': {
        this.stop();
        return;
      }

      case 'session.error':
      case 'error': {
        // The provider's `message` is NOT shown. A code is a value we choose
        // the wording for; a message is text from a remote party that could
        // end up on screen or in a log.
        const code = str(message.code, 64) || 'unknown';
        this.options.onNotice(`The voice service reported a problem (${code}).`);
        this.setPhase('FAILED', 'The voice service reported a problem');
        return;
      }

      default:
        // An unrecognised event is ignored rather than guessed at.
        return;
    }
  }

  /**
   * One chunk of reply audio.
   *
   * Decoded, bounded, and forwarded straight to the renderer. Nothing is
   * accumulated: the whole point of streaming is that Axon starts speaking
   * before the reply is finished, and a buffer here would put the latency back.
   */
  private receiveAudio(data: unknown): void {
    if (typeof data !== 'string' || data === '') return;

    let pcm: Buffer;
    try {
      pcm = Buffer.from(data, 'base64');
    } catch {
      return;
    }
    if (pcm.byteLength === 0 || pcm.byteLength > VOICE_AGENT_LIMITS.maxInboundAudioBytes) return;

    const speechId = this.speechId ?? this.beginSpeech();
    this.chunkSequence += 1;

    this.options.onAudioChunk({
      speechId,
      pcm: new Uint8Array(pcm),
      sampleRate: VOICE_AGENT_LIMITS.sampleRate,
      sequence: this.chunkSequence,
      final: false,
    });
  }

  private beginSpeech(): string {
    if (this.speechId) return this.speechId;
    this.speechId = randomUUID();
    this.chunkSequence = 0;
    return this.speechId;
  }

  /** Close the current utterance, telling the player to drain. */
  private finishSpeech(): void {
    const speechId = this.speechId;
    if (!speechId) return;
    this.speechId = null;

    this.options.onAudioChunk({
      speechId,
      pcm: new Uint8Array(0),
      sampleRate: VOICE_AGENT_LIMITS.sampleRate,
      sequence: this.chunkSequence + 1,
      final: true,
    });
  }

  /**
   * Put the outcome of a deferred action back into the conversation.
   *
   * `reply.create` with instructions, rather than a synthetic tool result: the
   * tool call it belongs to was answered long ago, and re-answering it would
   * be a protocol violation. This is a new turn, which is what it actually is.
   */
  private speakOutcome(summary: string): void {
    if (!this.active || !this.socket?.open) return;
    this.socket.send({ type: 'reply.create', instructions: summary });
  }

  // --- housekeeping -------------------------------------------------------

  private setPhase(phase: VoiceAgentPhase, detail: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase, detail);
  }

  /**
   * Close a session nobody is using.
   *
   * The bound that matters most for privacy: a microphone left streaming
   * because the user walked away is exactly the failure the wake-word design
   * exists to prevent, and it must not be reintroduced at the other end.
   */
  private armIdleTimer(): void {
    clearTimer(this.idleTimer);
    this.idleTimer = timer(() => {
      this.options.onNotice('The voice session was quiet, so Axon closed it.');
      this.stop();
    }, VOICE_AGENT_LIMITS.idleTimeoutMs);
  }
}

// ---------------------------------------------------------------------------

function timer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, ms);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

function clearTimer(handle: ReturnType<typeof setTimeout> | null): void {
  if (handle) clearTimeout(handle);
}

/** A bounded string from an untrusted field. Never coerces an object. */
function str(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
