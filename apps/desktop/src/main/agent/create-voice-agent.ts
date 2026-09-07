/**
 * Building the voice agent, or explaining why there isn't one.
 *
 * The same shape as `create-stt.ts`, `create-tts.ts` and `create-brain.ts`,
 * deliberately: a missing credential is a normal configuration state, not a
 * crash. Axon without a voice agent is still the whole typed product — the
 * dispatcher, the tools, the browser, the timeline and the approval dialog all
 * work — so this returns a reason instead of throwing.
 *
 * SECURITY: this is the boundary the API key does not cross. The key arrives
 * as an argument, is held for the lifetime of the factory's closure, and is
 * never returned on the result, stored on the runtime, written to an event, or
 * included in `VoiceAgentStatus`. `runtime.ts` reads it from `process.env`
 * into a local and hands it here; nothing downstream can reach it.
 *
 * The only thing that escapes with knowledge of the key is a `VoiceSocket`,
 * which uses it once for an Authorization header and never exposes it.
 */

import type { JsonValue, ToolCall, ToolResult, ToolSchema, VoiceAgentPhase, SpeechChunk } from '@axon/core';
import { VoiceAgentSession } from './voice-agent-session.js';
import type { VoiceSocketError } from './assemblyai-client.js';

export interface VoiceAgentFactoryOptions {
  /** Read from ASSEMBLYAI_API_KEY by the caller. Empty means "not configured". */
  readonly apiKey: string | undefined;
  /** `AXON_VOICE_AGENT_PROVIDER`: 'assemblyai' (default) or 'none'. */
  readonly provider: string | undefined;
  readonly platform: string;
  readonly workspaceRoot: string;
}

/** What the session needs that only the orchestrator can supply. */
export interface VoiceAgentWiring {
  readonly tools: readonly ToolSchema[];
  dispatch(call: ToolCall): Promise<ToolResult>;
  willRequireApproval(tool: string, input: JsonValue): boolean;
  onUserTranscript(text: string): void;
  onAgentTranscript(text: string): void;
  onAudioChunk(chunk: SpeechChunk): void;
  onPhase(phase: VoiceAgentPhase, detail: string): void;
  onNotice(summary: string): void;
  onClosed(error: VoiceSocketError | null): void;
}

/**
 * Creates sessions, holding the credential so nothing above it has to.
 *
 * A factory rather than a long-lived session, because a session IS a live
 * microphone stream: one exists only while the user is talking to Axon, and
 * the absence of one is the resting state the privacy guarantee depends on.
 */
export interface VoiceAgentProvider {
  readonly name: string;
  create(wiring: VoiceAgentWiring): VoiceAgentSession;
}

export interface VoiceAgentCreation {
  readonly provider: VoiceAgentProvider | null;
  /** Null when a provider was built. Never contains the key or any of its bytes. */
  readonly unavailableReason: string | null;
}

export function createVoiceAgent(options: VoiceAgentFactoryOptions): VoiceAgentCreation {
  const provider = (options.provider ?? 'assemblyai').trim().toLowerCase();

  if (provider === 'none' || provider === 'off') {
    return {
      provider: null,
      unavailableReason: 'Spoken conversation is turned off (AXON_VOICE_AGENT_PROVIDER=none).',
    };
  }

  if (provider !== 'assemblyai') {
    return {
      provider: null,
      // Echoes configuration, which is the user's own input and never a
      // secret — bounded so a pathological value cannot flood the UI. Note it
      // is a NAME, never a URL: there is no configuration path that points
      // Axon's microphone at an arbitrary endpoint.
      unavailableReason: `Unknown voice agent "${provider.slice(0, 32)}". Axon will not hold a spoken conversation.`,
    };
  }

  const apiKey = options.apiKey?.trim() ?? '';
  if (apiKey === '') {
    return {
      provider: null,
      unavailableReason:
        'No ASSEMBLYAI_API_KEY is configured, so Axon cannot hold a spoken conversation. ' +
        'Set it in your .env and restart Axon. Typing to Axon still works.',
    };
  }

  return {
    provider: {
      name: 'assemblyai',
      create: (wiring): VoiceAgentSession =>
        new VoiceAgentSession({
          apiKey,
          platform: options.platform,
          workspaceRoot: options.workspaceRoot,
          ...wiring,
        }),
    },
    unavailableReason: null,
  };
}
