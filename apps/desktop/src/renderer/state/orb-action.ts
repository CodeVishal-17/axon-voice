/**
 * What clicking the orb does right now.
 *
 * PURE, and shared by the panel and the overlay so the orb means the same
 * thing wherever it is. Every action is a request to main, which decides.
 * Mid-task and while an approval is waiting a click has nothing honest to do,
 * so there is no action: the task or the card has the floor.
 */

import type { AxonState } from '@axon/core';

export type OrbActionKind = 'end-conversation' | 'stop-listening' | 'stop-speaking' | 'talk' | 'listen';

export interface OrbAction {
  readonly kind: OrbActionKind;
  readonly label: string;
}

export interface OrbActionInput {
  readonly state: AxonState;
  readonly voiceActive: boolean;
  readonly voiceAvailable: boolean;
  readonly listeningAvailable: boolean;
  readonly approvalPending: boolean;
}

export function orbActionFor(input: OrbActionInput): OrbAction | null {
  if (input.approvalPending) return null;
  if (input.voiceActive) return { kind: 'end-conversation', label: 'End the conversation' };
  if (input.state === 'LISTENING') return { kind: 'stop-listening', label: 'Stop listening' };
  if (input.state === 'SPEAKING') return { kind: 'stop-speaking', label: 'Stop speaking' };
  if (input.state === 'THINKING' || input.state === 'EXECUTING' || input.state === 'WAITING_FOR_APPROVAL') return null;
  if (input.voiceAvailable) return { kind: 'talk', label: 'Talk to Axon' };
  if (input.listeningAvailable) return { kind: 'listen', label: 'Talk to Axon' };
  return null;
}
