/**
 * Persistence contracts.
 *
 * Axon now remembers things across restarts, and that changes what it is. A
 * process that forgets everything when it closes is bounded by its own
 * lifetime; one that writes to disk accumulates a record of somebody's work,
 * their projects, and — if nobody is careful — their secrets.
 *
 * So persistence is treated as a security boundary in its own right, and these
 * contracts are shaped around four rules:
 *
 * 1. THREE STORES, NOT ONE. Conversation history, long-term memory and the
 *    browser profile are separate things with separate lifetimes and separate
 *    delete buttons. Collapsing them into "Axon's data" would mean a user
 *    clearing their chat history could not tell whether they had also signed
 *    themselves out of GitHub. They had not, and the UI must be able to say so.
 *
 * 2. EVERYTHING IS BOUNDED. Every table has a ceiling, every field has a
 *    length, and the context restored into a prompt is capped in code rather
 *    than trusted to a model. An agent that runs for a year must not carry a
 *    year of context, and a database that grows without limit is a bug that
 *    takes months to show up.
 *
 * 3. MEMORY IS DELIBERATE, NOT AUTOMATIC. Axon does not remember everything
 *    said to it. A memory is written when it is asked for and approved, it
 *    carries where it came from, and it can be read, edited and deleted by the
 *    person it is about.
 *
 * 4. SECRETS ARE NOT PERSISTED. There is a classifier, it is not perfect, and
 *    the architecture assumes it will fail: the default is not to persist, the
 *    things most likely to be secret never reach the database at all, and no
 *    page or model output can grant itself permission.
 */

/**
 * Hard ceilings, enforced in the main process.
 *
 * Chosen so that ordinary use never meets them and pathological use meets them
 * immediately. Deliberately not user-configurable: a limit that exists to
 * bound a security surface is not a preference.
 */
export const PERSISTENCE_LIMITS = {
  /** Conversations kept. The oldest are pruned once this is exceeded. */
  maxSessions: 100,
  /** Messages kept per conversation. */
  maxMessagesPerSession: 500,
  /** Characters in one stored message. Longer messages are truncated. */
  maxMessageCharacters: 20_000,
  /** Characters in a conversation title. */
  maxTitleCharacters: 120,
  /** Characters in a stored session summary. */
  maxSummaryCharacters: 1_000,

  /** Long-term memories kept, in total, across all sessions. */
  maxMemories: 200,
  /** Characters in one memory's key. */
  maxMemoryKeyCharacters: 80,
  /** Characters in one memory's value. */
  maxMemoryValueCharacters: 1_000,
  /** Memories returned by one search. */
  maxMemorySearchResults: 20,

  /**
   * Messages restored into a prompt.
   *
   * The bound that stops persistence becoming an unbounded context window.
   * Storing a thousand messages is fine; sending them is not.
   */
  maxRestoredMessages: 24,
  /** Characters of restored conversation handed to the brain. */
  maxRestoredCharacters: 12_000,
  /** Memories included in a prompt without the model asking for them. */
  maxContextMemories: 20,
  /**
   * Earlier conversations described to the brain for temporal grounding.
   *
   * "The issue I was working on yesterday" is only answerable if the model
   * knows what yesterday contained — but the answer must come from real
   * timestamps in the database, not from the model's guess about dates. Six
   * is enough to cover a working week without the digest becoming a second
   * transcript.
   */
  maxContextSessions: 6,
  /** Characters of one earlier conversation's digest. */
  maxSessionDigestCharacters: 240,
} as const;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ['active', 'archived'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * One conversation.
 *
 * `summary` is an operational description of what was worked on — the thing
 * that makes "what was I doing yesterday?" answerable. It is deliberately not
 * a record of how Axon reasoned: hidden reasoning is never requested, never
 * stored, and has nowhere to live in this shape.
 */
export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  /** Monotonic within a session; gives a total order timestamps cannot. */
  readonly seq: number;
  readonly createdAt: string;
  /** How the message arrived. Metadata, never content. */
  readonly source: 'text' | 'voice';
}

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

/**
 * How sensitive a memory is.
 *
 * `personal` exists so the UI can mark what a person might not want on screen
 * during a demo, and so a future feature can treat it differently. `secret` is
 * a classification the store REFUSES — it is present in the type because the
 * classifier returns it, never because a row can hold it.
 */
export const MEMORY_SENSITIVITIES = ['ordinary', 'personal', 'secret'] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

/** Where a memory came from. Recorded so the user can judge it. */
export const MEMORY_SOURCES = ['user', 'assistant', 'system'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface MemoryEntry {
  readonly id: string;
  /** A short category, e.g. "project" or "preference". Not a namespace. */
  readonly category: string;
  readonly key: string;
  readonly value: string;
  readonly source: MemorySource;
  readonly sensitivity: MemorySensitivity;
  /** False hides it from prompts without deleting it. */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Settings and identity
// ---------------------------------------------------------------------------

/**
 * The settings a user may change.
 *
 * A closed shape rather than a key/value bag at this level: every field has a
 * validator, a normalizer and a safe default, and a persisted value that fails
 * validation falls back rather than being executed. The database stores rows;
 * this is what those rows are allowed to mean.
 */
export interface AxonSettings {
  /** Push-to-talk accelerator, or null to use the built-in candidates. */
  readonly voiceHotkey: string | null;
  /** Absolute path Axon may write to without asking, or null for the default. */
  readonly workspacePath: string | null;
  /** Speak replies aloud. */
  readonly speechEnabled: boolean;
  /** Restore the most recent conversation on launch. */
  readonly restoreLastSession: boolean;
  /** Include approved long-term memories in prompts. */
  readonly memoryEnabled: boolean;
}

/**
 * Local application identity. Not authentication, and not an account.
 *
 * Deliberately tiny: a name Axon can use, a language preference, and when it
 * was created. There is no email, no device id, no telemetry id, and nothing
 * here is sent anywhere.
 */
export interface AxonProfile {
  readonly displayName: string | null;
  readonly language: string | null;
  readonly createdAt: string;
  readonly profileVersion: number;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Whether persistence is working, and where it lives. */
export interface PersistenceStatus {
  readonly available: boolean;
  /** Why not, when it is not. Never a stack trace. */
  readonly reason: string | null;
  /** The database file. Shown so a user can find and delete it. */
  readonly databasePath: string | null;
  readonly schemaVersion: number;
  readonly sessionCount: number;
  readonly memoryCount: number;
}

/**
 * The bounded context handed to the brain at the start of a turn.
 *
 * Built in the main process from the database, capped in code, and passed as
 * an argument. The brain never queries for it, which is what keeps "the brain
 * has no database access" true rather than merely intended.
 */
export interface SessionContext {
  readonly sessionId: string;
  /** Operational summary of earlier work. Never reasoning. */
  readonly summary: string | null;
  /** Approved, enabled memories, already truncated to the limits above. */
  readonly memories: readonly ContextMemory[];
  /** True when older messages were dropped to fit the limits. */
  readonly truncated: boolean;
  /**
   * Now, as ISO-8601, from the machine's clock.
   *
   * Present so "yesterday" resolves against a real date. A model asked to
   * reason about relative time without being told the current time will
   * confidently use its training cutoff instead, and then open the wrong
   * issue — a wrong answer that looks exactly like a right one.
   */
  readonly now: string;
  /** Earlier conversations, newest first, for resolving temporal references. */
  readonly recent: readonly SessionDigest[];
}

/**
 * One earlier conversation, as the brain sees it.
 *
 * A title, a deterministic summary of what the USER asked for, and when. No
 * message bodies, no ids the model could act on, and nothing derived from how
 * anything was reasoned about.
 */
export interface SessionDigest {
  readonly title: string;
  readonly summary: string | null;
  /** ISO-8601, from the database. */
  readonly updatedAt: string;
  /** How that timestamp reads relative to now: "yesterday", "3 days ago". */
  readonly when: string;
}

/** A memory as the brain sees it: three strings, no ids, no timestamps. */
export interface ContextMemory {
  readonly category: string;
  readonly key: string;
  readonly value: string;
}

/** Outcome of a settings change. Refusal is a normal answer. */
export interface SettingsUpdateResult {
  readonly accepted: boolean;
  readonly settings: AxonSettings;
  /** Why a value was refused, phrased for a person. */
  readonly error: string | null;
}
