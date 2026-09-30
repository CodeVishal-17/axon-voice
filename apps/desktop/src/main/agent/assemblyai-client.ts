/**
 * The socket, and the one place the credential exists.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * This is the only module in Axon that opens a network connection for voice,
 * and the only one that names `ASSEMBLYAI_API_KEY`. Both facts are asserted by
 * `tests/agent-voice-security.test.ts`, so this comment is checked rather than
 * merely believed.
 *
 * WHY THE MAIN PROCESS AND NOT THE RENDERER.
 *
 * The Voice Agent API authenticates with a Bearer header on the WebSocket
 * upgrade. A renderer holding that key would put the credential inside the
 * sandbox, one XSS away from a page — and Axon's renderer displays text that
 * came from web pages. The provider also offers short-lived tokens so browsers
 * can connect directly; Axon deliberately does not use them, because the point
 * is not that the credential is short-lived, it is that the renderer has no
 * socket at all. Audio reaches this class over the existing IPC channel that
 * already carries microphone frames, and goes out from here.
 *
 * WHAT THIS CLASS DOES NOT DO.
 *
 * It does not interpret the protocol — `voice-agent-session.ts` does that. It
 * does not know what a tool is. It moves frames and parses envelopes, and it
 * is deliberately small enough to audit in one sitting, because it is the
 * component holding the key.
 *
 * ERRORS ARE CLASSIFIED, NEVER PASSED THROUGH. A handshake failure from `ws`
 * can carry the request headers, which is to say the key. Nothing from the
 * socket reaches an event, a log or the UI without going through
 * `describeSocketError` below.
 */

import { WebSocket, type RawData } from 'ws';
import { VOICE_AGENT_LIMITS } from '@axon/core';

/** The documented Voice Agent endpoint. A constant, never configuration. */
export const VOICE_AGENT_ENDPOINT = 'wss://agents.assemblyai.com/v1/ws';

export type SocketFailureKind =
  | 'UNAUTHORIZED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'CLOSED'
  | 'RATE_LIMIT'
  | 'UNKNOWN';

export class VoiceSocketError extends Error {
  readonly kind: SocketFailureKind;
  /** True when opening a fresh connection could plausibly work. */
  readonly retryable: boolean;

  constructor(kind: SocketFailureKind, message: string, retryable = false) {
    super(message);
    this.name = 'VoiceSocketError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

/**
 * Turn any socket failure into something safe to show a person.
 *
 * The rule is inversion of the usual one: instead of redacting known-bad
 * substrings out of a provider message, nothing from the provider is used at
 * all. Only the shape of the failure crosses this function, so there is no
 * message format the provider could choose that would leak through it.
 */
export function describeSocketError(error: unknown): VoiceSocketError {
  if (error instanceof VoiceSocketError) return error;

  const raw = error instanceof Error ? error.message : String(error);

  // Matched against the ERROR CODE only. The matched text is never echoed.
  if (/\b401\b|unauthorized|forbidden|\b403\b/i.test(raw)) {
    return new VoiceSocketError(
      'UNAUTHORIZED',
      'The voice provider rejected Axon\'s credentials. Check ASSEMBLYAI_API_KEY in your .env and restart Axon.',
    );
  }
  if (/\b429\b|rate.?limit/i.test(raw)) {
    return new VoiceSocketError('RATE_LIMIT', 'The voice provider is rate-limiting Axon. Try again shortly.', true);
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket hang up/i.test(raw)) {
    return new VoiceSocketError('NETWORK', 'Axon could not reach the voice provider. Check your connection.', true);
  }
  return new VoiceSocketError('UNKNOWN', 'The voice connection failed.', true);
}

/** What the session layer needs from a socket. Injected in tests. */
export interface VoiceSocketHandlers {
  /** One parsed server envelope. Never raw text. */
  onMessage(message: Record<string, unknown>): void;
  /** The socket closed, however it closed. */
  onClosed(error: VoiceSocketError | null): void;
}

export interface VoiceSocketOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  /**
   * Opens a socket. Injected so the protocol can be tested against a local
   * server with no key and no network — the product path has one
   * implementation and it is the one below.
   */
  readonly connect?: (url: string, headers: Record<string, string>) => WebSocket;
  readonly handshakeTimeoutMs?: number;
}

/**
 * A connection to the voice provider.
 *
 * One socket, one lifetime. Reconnection creates a new instance rather than
 * reviving this one: a socket that can be resurrected is a socket whose state
 * is ambiguous, and ambiguity here means "is audio still being sent?".
 */
/**
 * How a closed connection should be understood.
 *
 * Every close used to be reported as an ORDINARY end, which meant the
 * session's reconnect-and-resume logic was reachable only through an 'error'
 * event — and a connection that simply drops (a laptop changing access point,
 * a venue's wifi hiccuping) produces a close with code 1006 and often no
 * error at all. So a two-second network blip mid-demo ended the conversation
 * as though the user had closed it, and resumption never had a chance.
 *
 * The codes that mean "the connection went away, not the conversation" are
 * reported as a retryable NETWORK failure, which the session already knows how
 * to resume inside its bounded window. Everything else — a normal close, a
 * going-away, a policy close from the provider — stays an ordinary end: an
 * assistant that reconnects when the other side meant to hang up is one whose
 * microphone state nobody can reason about.
 *
 * Nothing from the close REASON text is read. Only the numeric code crosses
 * this function, for the same reason `describeSocketError` ignores provider
 * messages.
 */
export function describeClose(code: number): VoiceSocketError | null {
  // 1006: closed without a close frame — the network, not a decision.
  // 1011-1014: server error, restart, try again later, bad gateway.
  if (code === 1006 || (code >= 1011 && code <= 1014)) {
    return new VoiceSocketError('NETWORK', 'The voice connection dropped.', true);
  }
  return null;
}

export class VoiceSocket {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly handshakeTimeoutMs: number;
  private readonly connect: (url: string, headers: Record<string, string>) => WebSocket;
  private readonly handlers: VoiceSocketHandlers;

  private socket: WebSocket | null = null;
  private closed = false;
  /** Bytes of audio sent. The session's spend against `maxSessionAudioBytes`. */
  private audioBytesSent = 0;

  constructor(options: VoiceSocketOptions, handlers: VoiceSocketHandlers) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? VOICE_AGENT_ENDPOINT;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? VOICE_AGENT_LIMITS.handshakeTimeoutMs;
    this.connect =
      options.connect ??
      ((url, headers): WebSocket => new WebSocket(url, { headers }));
    this.handlers = handlers;
  }

  /**
   * Bytes accepted by `send` but not yet written to the network.
   *
   * For diagnostics: a number that keeps growing is audio queued behind a slow
   * connection, which reaches the provider late and in bursts.
   */
  get bufferedBytes(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  get open(): boolean {
    return this.socket !== null && !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  get bytesSent(): number {
    return this.audioBytesSent;
  }

  /**
   * Open the connection.
   *
   * Resolves when the socket is open at the transport level. The PROTOCOL
   * handshake — waiting for `session.ready` — belongs to the session layer,
   * because that is where the meaning of "ready" lives.
   */
  async open_(): Promise<void> {
    if (this.socket) throw new VoiceSocketError('PROTOCOL', 'This voice connection has already been used.');

    // The one place the key is used. It goes into a header object that lives
    // for the duration of this call and is never stored on the instance in a
    // form anything else can read.
    const socket = this.connect(this.endpoint, { Authorization: `Bearer ${this.apiKey}` });
    this.socket = socket;

    // ATTACHED BEFORE THE HANDSHAKE IS AWAITED, and that ordering is a bug fix
    // rather than a style choice. The provider sends `session.ready` the
    // instant the connection is accepted, and `ws` does not buffer messages
    // that arrive with no listener attached — so subscribing after awaiting
    // 'open' loses the first frame whenever the server is quick, which on
    // loopback is always and over a network is intermittent. An intermittently
    // lost handshake is the worst kind of bug to find later.
    socket.on('message', (data: RawData) => {
      this.receive(data);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(new VoiceSocketError('TIMEOUT', 'The voice provider did not respond in time.', true));
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }, this.handshakeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      let settled = false;
      const settle = (error: VoiceSocketError | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      socket.once('open', () => {
        settle(null);
      });
      socket.once('error', (error: Error) => {
        const described = describeSocketError(error);
        settle(described);
        // After the handshake, an error is a closure the session must hear
        // about; before it, the rejection above is the whole story.
        if (settled) this.fail(described);
      });
      socket.once('unexpected-response', (_request: unknown, response: { statusCode?: number }) => {
        // The auth failure path. `statusCode` is a number we produced the
        // meaning for; the response body is never read.
        settle(describeSocketError(new Error(`HTTP ${response.statusCode ?? 0}`)));
      });
    });

    socket.on('close', (code: number) => {
      this.fail(describeClose(code));
    });
  }

  /**
   * Send one client event.
   *
   * Takes a structured object, never a string: there is no path through this
   * class that puts caller-controlled text onto the wire unserialized.
   */
  send(message: Record<string, unknown>): void {
    if (!this.open) return;
    try {
      this.socket?.send(JSON.stringify(message));
    } catch (error) {
      this.fail(describeSocketError(error));
    }
  }

  /**
   * Send one chunk of microphone audio.
   *
   * Separate from `send` so the audio budget is spent in exactly one place and
   * cannot be bypassed by a caller assembling the envelope itself.
   */
  sendAudio(pcm: Uint8Array): boolean {
    if (!this.open) return false;

    if (this.audioBytesSent + pcm.byteLength > VOICE_AGENT_LIMITS.maxSessionAudioBytes) {
      this.fail(
        new VoiceSocketError(
          'PROTOCOL',
          'This voice session reached its audio limit and was ended. Start a new one if you still need Axon.',
        ),
      );
      return false;
    }
    this.audioBytesSent += pcm.byteLength;

    this.send({
      type: 'input.audio',
      audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
    });
    return true;
  }

  /** Close politely, telling the provider the session is over. */
  close(): void {
    if (this.closed) return;
    if (this.open) this.send({ type: 'session.end' });
    this.shutdown();
  }

  // --- internals ----------------------------------------------------------

  private receive(data: RawData): void {
    // Binary frames are not part of this protocol. Anything that is not a JSON
    // object is discarded rather than coerced — a provider that starts sending
    // something new should be ignored until Axon is taught what it means.
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (typeof (parsed as Record<string, unknown>).type !== 'string') return;

    this.handlers.onMessage(parsed as Record<string, unknown>);
  }

  private fail(error: VoiceSocketError | null): void {
    if (this.closed) return;
    this.shutdown();
    this.handlers.onClosed(error);
  }

  private shutdown(): void {
    this.closed = true;
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.removeAllListeners();
      // Closing a socket that is still CONNECTING makes `ws` emit 'error'
      // ("closed before the connection was established") on the next tick.
      // With no listener that is an uncaught exception in the main process —
      // reachable by ending a session while it is still connecting.
      socket.on('error', () => {});
      socket.close();
    } catch {
      /* already gone */
    }
  }
}
