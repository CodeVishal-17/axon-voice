/**
 * The ways Axon can look at a screen.
 *
 * WHY A SEAM HERE AT ALL.
 *
 * `system.screenshot` used to reach for a `ScreenCapturer` and a `DesktopUi`
 * directly, which was fine while there were exactly two ways to observe and no
 * prospect of a third. It stops being fine the moment somebody asks the
 * obvious question — "can Axon see the screenshot?" — because the answer is
 * two different answers depending on which modality you mean, and a tool that
 * calls two ports inline has nowhere to put that distinction.
 *
 * So looking is a set of PROVIDERS, each of which knows two things about
 * itself: whether it can produce an observation, and whether a model can
 * actually be handed one. Those are not the same question, and conflating them
 * is precisely how a system ends up claiming to see.
 *
 *   AccessibilityObservationProvider   produces a control list. Deliverable:
 *                                      it is text, and text is what the
 *                                      protocol carries.
 *
 *   ScreenshotObservationProvider      produces pixels. NOT deliverable: the
 *                                      voice provider's protocol has no image
 *                                      channel, so the bytes are held in the
 *                                      main process and no consumer receives
 *                                      them.
 *
 *   VisionObservationProvider          DOES NOT EXIST. There is no such file,
 *                                      no such class, and no stub. A provider
 *                                      that returned "a description of the
 *                                      image" without a vision model behind it
 *                                      would be the single most dishonest
 *                                      thing this codebase could contain: it
 *                                      would read exactly like sight, and be a
 *                                      guess. `screen-observation.test.ts`
 *                                      asserts its absence so adding one is a
 *                                      deliberate edit rather than a quiet
 *                                      afternoon's work.
 *
 * WHAT THIS SEAM DOES NOT DO. It grants nothing and gates nothing. A provider
 * is a way to READ; every action taken on the strength of a reading still goes
 * through the dispatcher, the risk policy and the approval gate exactly as it
 * did before. Adding a provider adds a way to see, never a way to act.
 */

import { OBSERVATION_LIMITS, type ObservationModality, type ObservationModalityStatus } from '@axon/core';
import type { ScreenCapturer } from '../platform/ports.js';
import type { DesktopScreenReading, DesktopUi } from '../platform/windows-desktop.js';
import type { CapturedImage } from './visual-observation.js';

/**
 * One way of looking at the screen.
 *
 * Deliberately narrow: a provider answers what it is, whether it works here,
 * and whether anything can receive what it produces. It does not decide when
 * to look, what to do with the result, or who may act on it.
 */
export interface ObservationProvider {
  readonly modality: ObservationModality;
  /** Whether this provider can produce an observation on this machine. */
  readonly available: boolean;
  /**
   * Whether a model can actually be handed what this produces.
   *
   * Separate from `available` on purpose. See the header: pixels are captured
   * and are not deliverable, and a design that could not express that would
   * invite exactly the wrong conclusion.
   */
  readonly deliverableToModel: boolean;
  /** Why it is unavailable or undeliverable, phrased for a person. */
  readonly reason: string;
}

/** Axon's own reading of the controls an application publishes. */
export interface AccessibilityObservationProvider extends ObservationProvider {
  readonly modality: 'accessibility';
  /** Read one window's controls. A null handle means the window in front. */
  read(windowHandle: string | null): Promise<DesktopScreenReading>;
}

/** The pixels. Captured, held briefly, and delivered to nobody. */
export interface ScreenshotObservationProvider extends ObservationProvider {
  readonly modality: 'pixels';
  capture(): Promise<CapturedImage>;
}

/** An empty reading with a reason. Never an exception: looking must not throw. */
function noReading(note: string): DesktopScreenReading {
  return { available: false, windowHandle: null, windowTitle: '', controls: [], truncated: false, note };
}

/**
 * The accessibility provider, over the desktop port.
 *
 * A missing port is not an error — it is a platform where this way of looking
 * does not exist, and the reading says so rather than coming back empty and
 * letting a model conclude the screen is blank.
 */
export function createAccessibilityProvider(ui: DesktopUi | null): AccessibilityObservationProvider {
  const available = ui?.uiAvailable === true;
  return {
    modality: 'accessibility',
    available,
    // Text, which is exactly what the protocol carries.
    deliverableToModel: available,
    reason: available
      ? 'Axon reads the controls an application publishes for screen readers, and can describe them.'
      : 'Reading on-screen controls is only available on Windows.',
    read: (windowHandle) =>
      available && ui
        ? ui.observeControls(windowHandle)
        : Promise.resolve(noReading('Reading on-screen controls is only available on Windows.')),
  };
}

/**
 * The pixel provider.
 *
 * `deliverableToModel` is FALSE and that is the whole point of it having a
 * field. Axon really does capture the screen; what it cannot do is put the
 * image in front of the model, because the voice provider speaks a text
 * protocol with no image channel. The bytes are held in
 * `VisualObservationStore` on a short clock so that a future consumer is a new
 * reader rather than a redesign — and until there is one, this says so.
 */
export function createScreenshotProvider(capturer: ScreenCapturer): ScreenshotObservationProvider {
  return {
    modality: 'pixels',
    available: true,
    deliverableToModel: false,
    reason:
      'Axon captures the screen, but the voice provider has no channel that carries an image, ' +
      'so nothing can be shown the picture. What it gets is the control list instead.',
    capture: async () => {
      const captured = await capturer.capturePrimaryDisplay();
      return {
        png: captured.png,
        width: captured.width,
        height: captured.height,
        displayLabel: captured.displayLabel,
      };
    },
  };
}

/**
 * What Axon can and cannot observe, as a list.
 *
 * Reported in the tool surface so the answer to "can you see my screen?" comes
 * from the system rather than from the model's impression of itself. `vision`
 * is included with `captured: false` deliberately: naming the absent capability
 * is what stops it being assumed.
 */
export function describeModalities(providers: readonly ObservationProvider[]): readonly ObservationModalityStatus[] {
  const listed = providers.map((provider) => ({
    modality: provider.modality,
    captured: provider.available,
    deliverableToModel: provider.available && provider.deliverableToModel,
    reason: provider.reason,
  }));

  return [
    ...listed,
    // Stated rather than omitted. An absent entry reads as an oversight; an
    // entry saying "no" reads as a decision, which is what it is.
    {
      modality: 'vision' as const,
      captured: false,
      deliverableToModel: false,
      reason:
        'Axon has no vision model. It cannot describe what a picture looks like, and it will not guess. ' +
        'Anything it says about the screen comes from the control list.',
    },
  ];
}

/** How long a reading may take before it is abandoned. Re-exported for callers. */
export const OBSERVATION_READ_TIMEOUT_MS = OBSERVATION_LIMITS.enumerateTimeoutMs;
