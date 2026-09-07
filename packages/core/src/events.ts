/**
 * The AxonEvent stream — the single source of truth for everything the user
 * sees.
 *
 * Every layer (voice, brain, dispatcher, executors, state machine) emits into
 * one ordered stream. The renderer consumes it and holds no independent notion
 * of what Axon is doing; the JSONL log on disk is the same stream, so what the
 * user saw and what we can debug later are by construction identical.
 *
 * Schemas are defined with Zod and the TypeScript types are derived from them,
 * so the validator and the type can never drift apart.
 *
 * Convention: optional payload fields are modelled as `.nullable()`, never as
 * `.optional()`. A missing key and an explicitly-null key serialize
 * differently, and round-tripping through JSONL must be exact.
 */

import { z } from 'zod';
import { AXON_STATES } from './states.js';
import { RISK_LEVELS } from './risk.js';
import { APPROVAL_DECISIONS } from './approval.js';
import { SIDE_EFFECT_CLASSES } from './agent.js';
import { VOICE_ACTIVATIONS, VOICE_AGENT_PHASES } from './voice-agent.js';
import { JsonValueSchema } from './json.js';

export const AXON_EVENT_TYPES = [
  'STATE_CHANGED',
  'LISTENING',
  'THINKING',
  'PLANNING',
  'TOOL_CALL',
  'TOOL_RESULT',
  'OBSERVATION',
  'APPROVAL_REQUIRED',
  'APPROVAL_RESOLVED',
  'COMPLETED',
  'ERROR',
  'USER_MESSAGE',
  'ASSISTANT_MESSAGE',
  'SPEECH_STARTED',
  'SPEECH_ENDED',
  'SESSION_CHANGED',
  'MEMORY_CHANGED',
  'SETTINGS_UPDATED',
  'PERSISTENCE_ERROR',
  'VOICE_SESSION',
] as const;

export type AxonEventType = (typeof AXON_EVENT_TYPES)[number];

const AxonStateSchema = z.enum(AXON_STATES);
const RiskLevelSchema = z.enum(RISK_LEVELS);
const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);

/** Fields present on every event, regardless of type. */
const envelope = {
  /** Unique per event. */
  id: z.string().min(1),
  /** Groups events belonging to one run of the agent. */
  sessionId: z.string().min(1),
  /** Monotonic within a session — gives the timeline a total order that
   *  survives same-millisecond bursts, which timestamps alone do not. */
  seq: z.number().int().nonnegative(),
  /** ISO-8601 UTC. */
  at: z.string().min(1),
};

const ApprovalParameterSchema = z.object({
  label: z.string(),
  value: z.string(),
});

/**
 * What an approval authorises, carried on the event so the log records the
 * exact act the user was shown — not merely that they were asked something.
 */
const ApprovalBindingSchema = z.object({
  tool: z.string().min(1),
  action: z.string(),
  target: z.string().nullable(),
  effect: z.enum(SIDE_EFFECT_CLASSES),
  fingerprint: z.string().min(1),
});

const ApprovalRequestSchema = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  risk: RiskLevelSchema,
  title: z.string(),
  detail: z.string(),
  binding: ApprovalBindingSchema,
  // `.readonly()` so the inferred type matches `ApprovalRequest` in
  // approval.ts, which declares its arrays readonly. Without it the two
  // descriptions of the same object are structurally incompatible.
  parameters: z.array(ApprovalParameterSchema).readonly(),
  requestedAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

const ToolFailureSchema = z.object({
  kind: z.enum([
    'UNKNOWN_TOOL',
    'INVALID_INPUT',
    'FORBIDDEN',
    'DENIED',
    'APPROVAL_TIMEOUT',
    'CANCELLED',
    'EXECUTION_ERROR',
    'STALE_REFERENCE',
    'BUDGET_EXCEEDED',
    'DUPLICATE_SIDE_EFFECT',
    'APPROVAL_MISMATCH',
  ]),
  message: z.string(),
  detail: JsonValueSchema.nullable(),
});

export const AxonEventSchema = z.discriminatedUnion('type', [
  /** The authoritative state machine moved. Emitted only by the orchestrator. */
  z.object({
    ...envelope,
    type: z.literal('STATE_CHANGED'),
    from: AxonStateSchema.nullable(),
    to: AxonStateSchema,
    reason: z.string(),
  }),

  /** The voice layer opened the microphone. */
  z.object({
    ...envelope,
    type: z.literal('LISTENING'),
    trigger: z.enum(['hotkey', 'wake-word', 'manual']),
  }),

  /** Understanding the request. Rendered as "Understanding" in the timeline. */
  z.object({
    ...envelope,
    type: z.literal('THINKING'),
    note: z.string(),
  }),

  /** A plan was produced. */
  z.object({
    ...envelope,
    type: z.literal('PLANNING'),
    summary: z.string(),
    steps: z.array(z.string()),
  }),

  /** A tool call entered the dispatcher and passed validation. */
  z.object({
    ...envelope,
    type: z.literal('TOOL_CALL'),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: JsonValueSchema,
    risk: RiskLevelSchema,
    riskReason: z.string(),
  }),

  /** A tool call finished — successfully or not. Always emitted, exactly once. */
  z.object({
    ...envelope,
    type: z.literal('TOOL_RESULT'),
    callId: z.string().min(1),
    tool: z.string().min(1),
    ok: z.boolean(),
    durationMs: z.number().nonnegative(),
    output: JsonValueSchema.nullable(),
    failure: ToolFailureSchema.nullable(),
  }),

  /** Something Axon noticed — progress from inside an executor, or a reading
   *  of the world. Attributed to a call when one is in flight. */
  z.object({
    ...envelope,
    type: z.literal('OBSERVATION'),
    callId: z.string().min(1).nullable(),
    summary: z.string(),
    detail: JsonValueSchema.nullable(),
  }),

  /** A human decision is required before the pending call may proceed. */
  z.object({
    ...envelope,
    type: z.literal('APPROVAL_REQUIRED'),
    request: ApprovalRequestSchema,
  }),

  /** The pending decision was settled. `resolvedBy` distinguishes a real human
   *  "allow" from an automatic deny. */
  z.object({
    ...envelope,
    type: z.literal('APPROVAL_RESOLVED'),
    callId: z.string().min(1),
    decision: ApprovalDecisionSchema,
    resolvedBy: z.enum(['user', 'timeout', 'shutdown']),
  }),

  /** A task finished end to end. */
  z.object({
    ...envelope,
    type: z.literal('COMPLETED'),
    summary: z.string(),
  }),

  /** A failure that is not attributable to a single tool call. */
  z.object({
    ...envelope,
    type: z.literal('ERROR'),
    scope: z.string(),
    message: z.string(),
    detail: JsonValueSchema.nullable(),
  }),

  /** What the user said, verbatim. The first half of the transcript. */
  z.object({
    ...envelope,
    type: z.literal('USER_MESSAGE'),
    text: z.string(),
    source: z.enum(['text', 'voice']),
  }),

  /**
   * What Axon said back.
   *
   * This is the model's *visible* output only. Reasoning is never carried
   * here: the brain requests the model's thinking in its omitted form, so
   * there is no hidden chain-of-thought anywhere in this stream to leak.
   */
  z.object({
    ...envelope,
    type: z.literal('ASSISTANT_MESSAGE'),
    text: z.string(),
  }),

  /**
   * Axon began speaking an utterance.
   *
   * Metadata only. The audio travels on its own IPC channel (see speech.ts),
   * and the words are already in the ASSISTANT_MESSAGE that preceded this —
   * repeating them here would put a second copy in the log for no gain.
   */
  z.object({
    ...envelope,
    type: z.literal('SPEECH_STARTED'),
    speechId: z.string().min(1),
    /** How much text was synthesised, after truncation. */
    characters: z.number().int().nonnegative(),
    /** Duration measured from the audio itself, not estimated from the text. */
    durationMs: z.number().nonnegative(),
    truncated: z.boolean(),
  }),

  /** Axon stopped speaking — normally, or because it was cut short. */
  z.object({
    ...envelope,
    type: z.literal('SPEECH_ENDED'),
    speechId: z.string().min(1),
    reason: z.enum(['completed', 'cancelled', 'failed', 'timeout']),
  }),

  /**
   * A conversation was created, restored, renamed, archived or deleted.
   *
   * One event with an action rather than five event types: they carry the same
   * fields, they are rendered the same way, and a reader of the log wants them
   * adjacent. `title` is the user-visible name and nothing else — never the
   * messages, never the summary.
   */
  z.object({
    ...envelope,
    type: z.literal('SESSION_CHANGED'),
    action: z.enum(['created', 'restored', 'renamed', 'archived', 'deleted']),
    // Deliberately NOT `sessionId`: the envelope already carries one, and it
    // means something else. `sessionId` identifies a RUN of the process, which
    // is what the JSONL log is grouped by; a conversation outlives a run and a
    // run may span several conversations.
    conversationId: z.string().min(1),
    title: z.string(),
  }),

  /**
   * Long-term memory changed.
   *
   * Carries the category and key — enough for the timeline to say what was
   * remembered — and deliberately NOT the value. A memory's value is the part
   * most likely to be personal, and the event stream is written to a JSONL
   * file the user may share when reporting a problem.
   */
  z.object({
    ...envelope,
    type: z.literal('MEMORY_CHANGED'),
    action: z.enum(['created', 'updated', 'deleted', 'cleared']),
    memoryId: z.string().nullable(),
    category: z.string().nullable(),
    key: z.string().nullable(),
    /** How many entries the action affected. */
    count: z.number().int().nonnegative(),
  }),

  /**
   * Settings changed.
   *
   * Names the keys, never the values: a workspace path is a filesystem layout
   * and a hotkey is uninteresting, but the rule that the log carries metadata
   * rather than contents is worth keeping unconditional.
   */
  z.object({
    ...envelope,
    type: z.literal('SETTINGS_UPDATED'),
    keys: z.array(z.string()),
  }),

  /**
   * A voice-agent session opened, moved, or closed.
   *
   * THE PRIVACY AUDIT TRAIL. Axon's guarantee is that microphone audio stays
   * local until a person activates a session, so the log has to be able to
   * answer "when did audio start leaving this machine, and who asked?".
   * `activation` is that answer, and it is why the field is not optional.
   *
   * Carries no transcript, no audio, no session id from the provider and no
   * endpoint — the metadata rule the whole event stream follows. What was
   * SAID arrives as USER_MESSAGE and ASSISTANT_MESSAGE, exactly as it does
   * for typed conversation.
   */
  z.object({
    ...envelope,
    type: z.literal('VOICE_SESSION'),
    action: z.enum(['armed', 'disarmed', 'activated', 'connected', 'reconnecting', 'ended', 'failed']),
    /** How the session was asked for. Null for events that are not an opening. */
    activation: z.enum(VOICE_ACTIVATIONS).nullable(),
    phase: z.enum(VOICE_AGENT_PHASES),
    /** One sentence for the timeline. Never a provider message verbatim. */
    detail: z.string(),
  }),

  /**
   * Persistence failed at something.
   *
   * Separate from ERROR because a database problem is not a failed turn: Axon
   * keeps working, in memory, and the user needs to know that what they are
   * saying is not being saved.
   */
  z.object({
    ...envelope,
    type: z.literal('PERSISTENCE_ERROR'),
    scope: z.string(),
    message: z.string(),
  }),
]);

export type AxonEvent = z.infer<typeof AxonEventSchema>;

/** Narrow an event to one variant, e.g. `EventOf<'TOOL_RESULT'>`. */
export type EventOf<T extends AxonEventType> = Extract<AxonEvent, { type: T }>;

/** The payload an emitter supplies; the bus stamps the envelope. */
export type AxonEventInput = {
  [T in AxonEventType]: Omit<EventOf<T>, keyof typeof envelope>;
}[AxonEventType];

export function isAxonEventType(value: unknown): value is AxonEventType {
  return typeof value === 'string' && (AXON_EVENT_TYPES as readonly string[]).includes(value);
}

/** Serialize to a single JSONL line (no trailing newline). */
export function serializeEvent(event: AxonEvent): string {
  return JSON.stringify(event);
}

/** Parse one JSONL line back into a validated event. Throws on bad input. */
export function parseEvent(line: string): AxonEvent {
  return AxonEventSchema.parse(JSON.parse(line) as unknown);
}

/** Non-throwing counterpart of `parseEvent`, for reading logs that may be
 *  truncated by a crash mid-write. */
export function safeParseEvent(line: string): AxonEvent | null {
  try {
    const result = AxonEventSchema.safeParse(JSON.parse(line) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
