/**
 * A tool that answers after nobody is listening has not answered.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT, WHICH A LIVE TEST FOUND.
 *
 * Axon's tool deadlines and the voice provider's tool timeout were set in
 * different files, by different reasoning, and nothing related them. The
 * numbers ended up inverted: `browser.open` was allowed eighteen seconds, the
 * provider gave up after fifteen, and the model — never having received the
 * result — told the user "GitHub did not load" about a page that had loaded
 * perfectly and was on screen in front of them. `system.screenshot` did the
 * same thing once it started reading the accessibility tree.
 *
 * That is worse than slowness. It is Axon reporting a failure that did not
 * happen, which is precisely the invented outcome the whole verification layer
 * exists to prevent — arrived at from the other direction.
 *
 * The constraint is simple and it is invisible until it is violated in front
 * of a person, which is exactly the kind of thing that belongs in a test:
 *
 *   every deadline a tool can spend  <  the provider's tool timeout
 *
 * These assertions are about the CONTRACT, not about any one implementation,
 * so a future change to either side has to change this file to pass — which
 * is the point.
 */

import { describe, expect, it } from 'vitest';
import { BROWSING_LIMITS, OBSERVATION_LIMITS, TASK_LIMITS, VOICE_AGENT_LIMITS } from '@axon/core';

/** What the provider allows one tool call, in milliseconds. */
const WIRE_TIMEOUT_MS = VOICE_AGENT_LIMITS.toolTimeoutSeconds * 1_000;

/**
 * Room left for everything that is not the deadline itself.
 *
 * A tool call also has to cross the socket, pass the schema, resolve risk,
 * spend the budget, capture a screen or start a navigation, and travel back.
 * A deadline set to exactly the wire timeout would therefore still miss it.
 */
const OVERHEAD_MS = 2_000;

describe('every tool deadline fits inside the voice provider’s tool timeout', () => {
  it('states the wire timeout in one place, and it is short', () => {
    // Short on purpose: a voice agent that sits mute for a minute has already
    // failed the conversation, whatever it eventually says.
    expect(WIRE_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(WIRE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('bounds a navigation and its verification together', () => {
    // The two happen in sequence within one call, so it is their SUM that has
    // to fit — the mistake the live test exposed was checking them separately.
    const worstCase = BROWSING_LIMITS.navigationBudgetMs + BROWSING_LIMITS.navigationVerifyMs;
    expect(worstCase + OVERHEAD_MS).toBeLessThanOrEqual(WIRE_TIMEOUT_MS);
  });

  it('bounds a look at the screen', () => {
    // The capture is fast; the accessibility walk is not, and it is the part
    // that grew when Phase 2 made a screenshot into an observation.
    expect(OBSERVATION_LIMITS.enumerateTimeoutMs + OVERHEAD_MS).toBeLessThanOrEqual(WIRE_TIMEOUT_MS);
  });

  it('bounds acting on a control, including the verification that follows it', () => {
    // `ui.click` and `keyboard.type` act and then re-read, so both deadlines
    // are spent inside one call — and the ungated cases (focus, expand,
    // select) run INLINE, on the wire, so their sum is what has to fit.
    //
    // Anything that actually activates a control is gated, answered as
    // `pending_user_approval` immediately, and its outcome spoken as a later
    // turn — so it never holds a tool call open. That is the mechanism, not
    // an excuse for the sum: the inline path is real and it is bounded here.
    const worstCase = OBSERVATION_LIMITS.actTimeoutMs + OBSERVATION_LIMITS.enumerateTimeoutMs;
    expect(worstCase + OVERHEAD_MS).toBeLessThanOrEqual(WIRE_TIMEOUT_MS);
  });

  it('keeps the mechanism’s own timeout above the tool’s, not below it', () => {
    // The tool stops WAITING at its deadline; the browser stops TRYING at
    // its. Inverting these would mean the tool waiting for something that had
    // already been abandoned.
    expect(BROWSING_LIMITS.navigationBudgetMs).toBeLessThan(BROWSING_LIMITS.navigationTimeoutMs);
    expect(BROWSING_LIMITS.navigationVerifyMs).toBeLessThan(BROWSING_LIMITS.scriptTimeoutMs);
  });

  it('leaves a reference alive at least as long as a look takes to produce it', () => {
    // A target reference that expired before the observation that minted it
    // could be acted on would make the whole reference model unusable.
    expect(OBSERVATION_LIMITS.targetTtlMs).toBeGreaterThan(OBSERVATION_LIMITS.enumerateTimeoutMs);
    expect(OBSERVATION_LIMITS.imageTtlMs).toBeGreaterThan(OBSERVATION_LIMITS.targetTtlMs);
  });

  it('answers a slow tool before the provider gives up on the call', () => {
    // THE RELATIONSHIP THAT MAKES THE IN-PROGRESS ANSWER WORK. If the inline
    // budget were above the wire timeout, the fallback would arrive after the
    // provider had already abandoned the call — which is the original bug,
    // reached by a longer route: the agent composes a reply with nothing in
    // hand and guesses.
    expect(TASK_LIMITS.inlineBudgetMs + OVERHEAD_MS).toBeLessThanOrEqual(WIRE_TIMEOUT_MS);
  });

  it('sets the threshold where trivial work and a real pause actually separate', () => {
    // SQUEEZED FROM BOTH SIDES. Too low and every action grows a preamble;
    // too high and a genuine pause is silence. The value is taken from
    // measurement — `verify-tools.cjs` times the real tools on a real machine
    // — and what this asserts is that the two sides have not crossed.
    //
    // Below: a launch, measured at about 1.5s including its window
    // verification, must stay on the silent side so "Open Calculator" is one
    // sentence.
    expect(TASK_LIMITS.inlineBudgetMs).toBeGreaterThan(1_500);
    // Above: a pause long enough for a person to think something is broken
    // must be announced rather than sat through.
    expect(TASK_LIMITS.inlineBudgetMs).toBeLessThan(5_000);
    // And it still has to fit inside the deadlines of the tools it wraps, so
    // the slowest of them is announced rather than abandoned.
    expect(TASK_LIMITS.inlineBudgetMs).toBeLessThan(BROWSING_LIMITS.navigationBudgetMs);
    expect(TASK_LIMITS.inlineBudgetMs).toBeLessThan(OBSERVATION_LIMITS.enumerateTimeoutMs);
  });

  it('keeps every per-call deadline well inside the whole-turn budget', () => {
    // The turn budget is the backstop. If a single tool could exhaust it, the
    // backstop would be the only bound that ever fired, which is how the
    // original "browser.open ran for minutes" failure happened.
    const turnMs = 5 * 60_000;
    for (const deadline of [
      BROWSING_LIMITS.navigationBudgetMs,
      BROWSING_LIMITS.navigationTimeoutMs,
      OBSERVATION_LIMITS.enumerateTimeoutMs,
      OBSERVATION_LIMITS.actTimeoutMs,
    ]) {
      expect(deadline).toBeLessThan(turnMs / 4);
    }
  });
});
