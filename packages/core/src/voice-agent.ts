/**
 * Voice-agent contracts.
 *
 * Axon's voice path used to be three local pieces — a Windows recognizer, a
 * Windows synthesiser, and a model in between. A voice agent collapses those
 * into one duplex session: microphone audio goes out, spoken audio comes back,
 * and in the middle a model decides things and asks for tools.
 *
 * WHAT CHANGED ABOUT THE PRIVACY STORY, STATED PLAINLY.
 *
 * Step 4's guarantee was "the audio never leaves the machine". That is no
 * longer true, and pretending otherwise would be the worst possible outcome.
 * The guarantee is now narrower and still meaningful:
 *
 *   Before activation, microphone audio stays on this machine.
 *   After the user activates a session — by wake phrase, hotkey or button —
 *   that session's audio is streamed to the voice-agent provider.
 *   Axon never persists or logs raw microphone audio, at any point.
 *
 * The first line is what the local wake word buys. It is the difference
 * between "a microphone that is always uploading" and "a microphone that
 * uploads when you ask it to", and it is enforced by there being no socket at
 * all until activation.
 *
 * WHAT DID NOT CHANGE.
 *
 * The provider is a model, and Axon does not trust models. Everything it asks
 * for goes through the same dispatcher, the same risk policy, the same
 * approval gate and the same budget as every other proposal. A voice agent is
 * a new way to *propose*; it is not a new way to *act*.
 *
 * Pure: no Node, no Electron, no SDK, no socket. The renderer imports this
 * package, so anything reachable from here is reachable from the sandbox.
 */

/**
 * Hard ceilings, enforced in the main process.
 *
 * A duplex audio session is unbounded by nature — it ends when someone stops
 * talking — so every one of these exists to put a wall somewhere the provider,
 * the network and the user's own forgetfulness cannot move.
 */
export const VOICE_AGENT_LIMITS = {
  /**
   * Sample rate for audio in both directions.
   *
   * 24 kHz because that is what the Voice Agent API documents for `audio/pcm`.
   * Axon captures at this rate and resamples down for the local wake-word
   * recognizer, rather than capturing low and interpolating up: throwing away
   * detail once is better than inventing it.
   */
  sampleRate: 24_000,
  /**
   * Milliseconds of audio per outbound chunk.
   *
   * The documentation asks for roughly 50 ms and notes the server buffers
   * across chunks, so this is a latency choice rather than a protocol
   * requirement.
   */
  outboundChunkMs: 50,
  /** Largest single base64 audio payload accepted from the provider. */
  maxInboundAudioBytes: 512 * 1024,
  /**
   * Total audio one session may send.
   *
   * The bound that turns "Axon forgot to close the session" from an unbounded
   * bill into a session that ends and says why. Twenty minutes at 24 kHz.
   */
  maxSessionAudioBytes: 24_000 * 2 * 60 * 20,
  /** A session with no speech and no reply for this long closes itself. */
  idleTimeoutMs: 90_000,
  /** Absolute ceiling on one session, however active it is. */
  maxSessionMs: 30 * 60_000,
  /** How long to wait for `session.ready` before giving up on a connection. */
  handshakeTimeoutMs: 15_000,
  /**
   * How long the provider will hold a dropped session open for resumption.
   *
   * Documented as 30 seconds. Axon reconnects inside it and gives up after,
   * rather than reconnecting into a session that no longer exists.
   */
  resumeWindowMs: 30_000,
  /** Reconnection attempts before Axon stops trying and says so. */
  maxReconnectAttempts: 3,
  /** Characters of transcript accepted in one message from the provider. */
  maxTranscriptCharacters: 4_000,
  /** Tool calls one session may make. A per-turn budget still applies. */
  maxToolCallsPerSession: 64,
  /**
   * How long the provider waits for a tool result before giving up on it.
   *
   * Deliberately SHORT relative to Axon's approval timeout, because Axon does
   * not hold a tool call open across a human decision — see `DEFERRED_TOOL`
   * below. A tool that needs a person is answered immediately with "pending",
   * and the outcome is spoken afterwards.
   */
  toolTimeoutSeconds: 15,
} as const;

/**
 * The audio encoding both directions use.
 *
 * `audio/pcm` in the Voice Agent API means 16-bit signed little-endian PCM,
 * mono, base64-encoded inside a JSON message. Named as a constant because it
 * appears in the session configuration, in the outbound framing and in the
 * renderer's decoder, and those three must never disagree.
 */
export const VOICE_AGENT_ENCODING = 'audio/pcm';

/**
 * What Axon tells the provider when a tool needs a human first.
 *
 * THE DEFERRED-RESULT PATTERN, AND WHY IT IS NOT A COMPROMISE.
 *
 * The obvious implementation holds the provider's tool call open while the
 * approval dialog is on screen. It is wrong in three ways: the provider times
 * tool calls out in seconds and approvals take as long as a person takes; a
 * held call means the agent sits mute while the user reads; and it couples the
 * lifetime of a security decision to the lifetime of a network request, so a
 * dropped socket during an approval becomes ambiguous.
 *
 * So Axon answers immediately and truthfully — "this needs the user's
 * approval, it has not run" — and lets the conversation continue. The approval
 * proceeds on Axon's own clock, under Axon's own expiry rules. When it
 * resolves, the action executes, is verified, and the outcome is delivered
 * back into the conversation as a new turn.
 *
 * The agent learns the true state of the world at every step. What it never
 * gets is the ability to wait out, hurry, or route around a human.
 */
export const DEFERRED_TOOL_RESULT = {
  status: 'pending_user_approval',
  executed: false,
} as const;

/**
 * Where a voice-agent session is.
 *
 * NOT a state machine. Axon has exactly one of those, in the orchestrator, and
 * this milestone does not add a second. These describe the *connection*, and
 * each maps onto an `AxonState` the existing machine already owns:
 *
 *   IDLE        -> IDLE          nothing is connected, no audio is captured
 *   ARMED       -> LISTENING     the wake word is listening, locally, offline
 *   CONNECTING  -> THINKING      a socket is opening
 *   LISTENING   -> LISTENING     audio is streaming to the provider
 *   THINKING    -> THINKING      the provider is composing a reply
 *   SPEAKING    -> SPEAKING      the provider's audio is playing
 *   TOOL        -> EXECUTING     a proposal is in the dispatcher
 *   APPROVAL    -> WAITING_FOR_APPROVAL
 *   CLOSED      -> IDLE
 *   FAILED      -> ERROR
 */
export const VOICE_AGENT_PHASES = [
  'IDLE',
  'ARMED',
  'CONNECTING',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'TOOL',
  'APPROVAL',
  'CLOSED',
  'FAILED',
] as const;

export type VoiceAgentPhase = (typeof VOICE_AGENT_PHASES)[number];

export function isVoiceAgentPhase(value: unknown): value is VoiceAgentPhase {
  return typeof value === 'string' && (VOICE_AGENT_PHASES as readonly string[]).includes(value);
}

/**
 * What the renderer is told about the voice agent.
 *
 * A provider name, three booleans and a reason. Deliberately absent: the API
 * key, the endpoint, the session id, the socket, and anything derived from
 * any of them. This is the whole of the voice agent's exposure to the
 * sandboxed page — the same shape `BrainStatus` and `SpeechStatus` use, for
 * the same reason.
 */
export interface VoiceAgentStatus {
  /** True when a provider is configured and usable. */
  readonly available: boolean;
  /** Provider name, e.g. "assemblyai". Never a URL and never a credential. */
  readonly name: string;
  /** Why it is unavailable, phrased for a person. Never echoes a key. */
  readonly reason: string | null;
  /** True while a session is connected. Main is authoritative. */
  readonly active: boolean;
  /** Where the session is. Null when there is none. */
  readonly phase: VoiceAgentPhase;
  /**
   * True while the local wake word is listening.
   *
   * The single most important thing the UI can say, because it is the
   * difference between "this microphone is uploading" and "this microphone is
   * waiting for you to say its name, on this machine".
   */
  readonly armed: boolean;
  /**
   * What is doing the listening, and whether it is well.
   *
   * Bounded and printable by construction: an engine name, a short
   * description, a restart count, and two booleans. There is no channel here
   * for anything anybody said — a wake detector that could report text would
   * be a wake detector that had transcribed a room.
   */
  readonly wake: WakeStatus;
}

/**
 * The local wake detector's health, as the tray and the settings panel see it.
 *
 * Lives in core because the renderer renders it, and the renderer must never
 * import anything from `main/wake/`.
 */
export interface WakeStatus {
  /** 'keyword-spotter', 'windows-speech', or 'disabled'. */
  readonly engine: string;
  /** The runtime doing the hearing, in a few words. Never a path, never audio. */
  readonly detail: string;
  /** False when this machine cannot run the engine at all. */
  readonly available: boolean;
  /** Why it cannot listen, when it cannot. Phrased for a person. */
  readonly unavailableReason: string | null;
  /** How many times the engine has had to be restarted under it. */
  readonly restarts: number;
  /** True while armed and no microphone audio has arrived recently. */
  readonly starvedOfAudio: boolean;
}

/**
 * One chunk of agent audio, on its way to the speakers.
 *
 * SEPARATE FROM `SpeechDelivery`, deliberately. That contract carries a whole
 * utterance with a duration Axon computed from the bytes, which is what makes
 * its playback watchdog honest. A streamed reply has no duration until it
 * ends, so forcing it into that shape would mean either buffering the whole
 * reply (latency the user hears) or inventing a duration (a watchdog that
 * lies).
 *
 * What it keeps from `SpeechDelivery` is the part that matters: the renderer
 * receives BYTES and a rate. It never receives a path, a URL or a filename,
 * and there is no counterpart that lets it ask for audio — this flows one way,
 * main to renderer, chosen by main.
 */
export interface SpeechChunk {
  /** Correlates with SPEECH_STARTED and any later stop. Minted in main. */
  readonly speechId: string;
  /** Raw 16-bit signed little-endian PCM, mono. Never encoded audio. */
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
  /** Ordinal within this utterance, so a dropped chunk is detectable. */
  readonly sequence: number;
  /** True on the last chunk, so the player knows to drain rather than wait. */
  readonly final: boolean;
}

/**
 * How a voice session was started.
 *
 * Recorded because "did a person ask for this?" is the question the privacy
 * guarantee turns on, and a log that cannot answer it is not an audit trail.
 * Every one of these is an explicit human act.
 */
export const VOICE_ACTIVATIONS = ['wake-word', 'hotkey', 'manual'] as const;
export type VoiceActivation = (typeof VOICE_ACTIVATIONS)[number];

/** Outcome of asking Axon to start or stop a voice session. */
export interface VoiceSessionResult {
  readonly accepted: boolean;
  readonly error: string | null;
}
