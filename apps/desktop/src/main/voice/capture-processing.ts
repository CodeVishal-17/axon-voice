/**
 * A controlled A/B of the browser's microphone processing.
 *
 * PURE. Development builds only (`config.ts` drops the variable otherwise).
 *
 * Axon captures with echo cancellation, noise suppression and automatic gain
 * control ON, and those stay the product defaults: echo cancellation is what
 * lets a person interrupt Axon while it speaks. Whether any of the three harms
 * wake-word recall on a real voice is a question for a measurement, and a
 * measurement changes ONE variable at a time. So this accepts exactly one
 * change per run:
 *
 *     AXON_CAPTURE_PROCESSING=ec=off     echo cancellation off
 *     AXON_CAPTURE_PROCESSING=ns=off     noise suppression off
 *     AXON_CAPTURE_PROCESSING=agc=off    automatic gain control off
 *
 * Anything else — two changes, an unknown name, a typo — is refused rather than
 * partly applied, and the capture uses the defaults. MAIN decides this and puts
 * it in the capture command; the renderer is told, never asked.
 */

import type { CaptureProcessing } from '@axon/core';

export const DEFAULT_CAPTURE_PROCESSING: CaptureProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface ParsedProcessing {
  /** The processing to request, or null for "the defaults". */
  readonly processing: CaptureProcessing | null;
  /** A short label for reports: 'default', 'ec=off', ... */
  readonly label: string;
  /** Why a value was refused, when it was. */
  readonly refused: string | null;
}

const NAMES: Readonly<Record<string, keyof CaptureProcessing>> = {
  ec: 'echoCancellation',
  ns: 'noiseSuppression',
  agc: 'autoGainControl',
};

export function parseCaptureProcessing(raw: string | undefined): ParsedProcessing {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'default') {
    return { processing: null, label: 'default', refused: null };
  }
  const value = raw.trim().toLowerCase();
  const match = /^(ec|ns|agc)=(on|off)$/.exec(value);
  if (!match) {
    return {
      processing: null,
      label: 'default',
      refused: `"${value.slice(0, 32)}" is not one change of ec, ns or agc to on/off; using the defaults`,
    };
  }
  const key = NAMES[match[1] ?? ''];
  if (key === undefined) return { processing: null, label: 'default', refused: 'unknown processing name' };
  return {
    processing: { ...DEFAULT_CAPTURE_PROCESSING, [key]: match[2] === 'on' },
    label: value,
    refused: null,
  };
}
