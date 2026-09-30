/**
 * When the bottom-centre orb is on screen.
 *
 * PURE, apart from the scheduler it is handed. Main decides; the overlay page
 * only animates what it is told.
 *
 *   hidden --(Axon becomes active)--> show + enter
 *   shown  --(Axon goes quiet)------> lingers, so the last reply can be read
 *          --(still quiet)----------> leave (the page fades out)
 *          --(after the fade)-------> hide (the window is taken off screen)
 *
 * Anything that makes Axon active again during the linger or the fade cancels
 * it and brings the orb straight back.
 */

import type { AxonState } from '@axon/core';

export interface OverlayInputs {
  readonly state: AxonState;
  /** A spoken conversation is open. */
  readonly voiceActive: boolean;
  /** Push-to-talk is listening. */
  readonly listeningActive: boolean;
  /** Something is waiting for the user's decision. */
  readonly approvalPending: boolean;
}

/**
 * Whether Axon is doing something the user should see.
 *
 * ERROR on its own does not hold the orb up: it is shown by the linger that
 * follows whatever failed, then the orb leaves. Otherwise a single failure
 * would leave an orb on screen indefinitely.
 */
export function overlayWanted(inputs: OverlayInputs): boolean {
  return (
    inputs.voiceActive ||
    inputs.listeningActive ||
    inputs.approvalPending ||
    (inputs.state !== 'IDLE' && inputs.state !== 'ERROR')
  );
}

export type OverlayCommand = 'show' | 'enter' | 'leave' | 'hide';

export interface OverlayPresenceOptions {
  /** How long the orb stays after Axon goes quiet. */
  readonly lingerMs: number;
  /** How long the page's fade-out takes before the window is hidden. */
  readonly leaveMs: number;
  /** Run later; returns a cancel function. */
  schedule(run: () => void, ms: number): () => void;
  apply(command: OverlayCommand): void;
}

type Phase = 'hidden' | 'shown' | 'lingering' | 'leaving';

export class OverlayPresence {
  private readonly options: OverlayPresenceOptions;
  private phase: Phase = 'hidden';
  private cancel: (() => void) | null = null;

  constructor(options: OverlayPresenceOptions) {
    this.options = options;
  }

  get visible(): boolean {
    return this.phase !== 'hidden';
  }

  update(wanted: boolean): void {
    if (wanted) {
      this.clear();
      if (this.phase === 'hidden') {
        this.options.apply('show');
        this.options.apply('enter');
      } else if (this.phase === 'leaving') {
        this.options.apply('enter');
      }
      this.phase = 'shown';
      return;
    }

    if (this.phase !== 'shown') return;
    this.phase = 'lingering';
    this.cancel = this.options.schedule(() => {
      this.phase = 'leaving';
      this.options.apply('leave');
      this.cancel = this.options.schedule(() => {
        this.cancel = null;
        this.phase = 'hidden';
        this.options.apply('hide');
      }, this.options.leaveMs);
    }, this.options.lingerMs);
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The overlay covers the display's WORK AREA — the screen minus the taskbar —
 * so the orb, placed at the bottom centre of the page, always sits just above
 * the taskbar wherever the taskbar is, and never on top of it.
 */
export function overlayBounds(workArea: Area): Area {
  return {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width: Math.max(1, Math.round(workArea.width)),
    height: Math.max(1, Math.round(workArea.height)),
  };
}
