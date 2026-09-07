/**
 * Building the brain, or explaining why there isn't one.
 *
 * A missing API key is a normal configuration state, not a crash. Axon without
 * a brain is still the Step 1 product — the orb, the timeline, the dispatcher
 * and the Tool Console all work — so this returns a reason instead of throwing
 * and lets the app start.
 *
 * SECURITY: this is the boundary the API key does not cross. The key arrives
 * as an argument, goes into the Anthropic client, and is never returned,
 * stored on the result, logged, or included in `BrainStatus`. The caller in
 * `runtime.ts` reads it from `process.env` and holds it in a local; nothing
 * downstream of this function can reach it.
 */

import type { Brain, Memory } from '@axon/core';
import { createAnthropicClient, DEFAULT_MODEL } from './anthropic-client.js';
import { ClaudeBrain } from './claude-brain.js';

export interface BrainFactoryOptions {
  /** Read from ANTHROPIC_API_KEY by the caller. Empty means "not configured". */
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
  readonly memory: Memory;
  readonly workspaceRoot: string;
  readonly platform: string;
  readonly newCallId: () => string;
}

export interface BrainCreation {
  readonly brain: Brain | null;
  /** Null when a brain was built. Never contains the key or any of its bytes. */
  readonly unavailableReason: string | null;
  /** The model that would be used, for logs. Safe to display. */
  readonly model: string;
}

export function createBrain(options: BrainFactoryOptions): BrainCreation {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const apiKey = options.apiKey?.trim() ?? '';

  if (apiKey === '') {
    return {
      brain: null,
      unavailableReason:
        // Phrased as an OPTIONAL provider that is not configured, because that
        // is what it is. Axon's reasoning comes from the voice agent; this one
        // powers the typed composer and nothing else. The variable is still
        // named, so somebody who wants typed chat knows exactly what to set.
        'Typing to Axon needs an ANTHROPIC_API_KEY, which is optional and not configured. ' +
        'Speaking to Axon works without it. ' +
        'Set it in your .env and restart if you want the typed composer as well.',
      model,
    };
  }

  const brain = new ClaudeBrain({
    client: createAnthropicClient({ apiKey, model }),
    memory: options.memory,
    workspaceRoot: options.workspaceRoot,
    platform: options.platform,
    newCallId: options.newCallId,
  });

  return { brain, unavailableReason: null, model };
}
