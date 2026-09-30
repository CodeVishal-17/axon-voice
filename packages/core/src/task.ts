/**
 * A task, its steps, and the two things that can end one early.
 *
 * WHAT PHASE 3 IS ACTUALLY FIXING.
 *
 * Axon had tools and it had a turn. What it did not have was a TASK — a thing
 * with an identity, a goal, a sequence of steps, and an end. Three failures
 * followed from that absence, and all three showed up in live use:
 *
 * 1. A slow tool produced two contradictory sentences. The agent answered from
 *    nothing, the result arrived afterwards, and Axon corrected itself out
 *    loud. Correct, eventually, and horrible to listen to.
 *
 * 2. A result that arrived after the user had moved on had nothing to belong
 *    to, so nothing could decide whether it was still wanted.
 *
 * 3. "Stop." had no object. There was a turn to abort, but no way to say which
 *    work was being abandoned, and no way to stop a result that was already in
 *    flight from starting the next step of something the user had cancelled.
 *
 * So a task is minted when the user asks for something, every proposed action
 * becomes a step inside it, and both carry ids that travel with the events.
 * Cancellation bumps a generation; anything that comes back afterwards
 * belongs to a task that no longer wants it and is dropped.
 *
 * WHAT A TASK IS NOT. It is not a plan the model gets to execute. Axon does
 * not hold a queue of approved future actions — there is no such thing here,
 * deliberately, because a queue is exactly the structure that lets one
 * approval authorise a second act. Every step is proposed, validated, gated
 * and verified on its own, and the task is the thread they are strung on, not
 * a permission that covers them.
 *
 * Pure: no Node, no Electron, no clock of its own.
 */

/**
 * Bounds on the task lifecycle.
 *
 * `inlineBudgetMs` is the load-bearing one and the least obvious. See
 * `IN_PROGRESS_TOOL_RESULT` below for what it buys.
 */
export const TASK_LIMITS = {
  /**
   * How long a tool may run before Axon stops holding the conversation open
   * for it and answers "working on it" instead.
   *
   * THE NUMBER THAT DECIDES WHETHER A REPLY IS COHERENT.
   *
   * Below this, the tool's real result reaches the agent inside the same turn
   * and the user hears one sentence: "Calculator is open." Above it, the agent
   * would otherwise compose a reply with no result in hand — which in live use
   * meant it invented one, and Axon then contradicted itself when the truth
   * arrived.
   *
   * SQUEEZED FROM BOTH SIDES, AND THE VALUE COMES FROM MEASUREMENT.
   *
   * TOO LOW and every trivial action grows a preamble. Nobody wants to hear
   * "Opening Calculator." followed a heartbeat later by "Calculator is open."
   * — the announcement takes longer than the work and makes a fast assistant
   * sound slow.
   *
   * TOO HIGH and a genuine pause is silence. A person who has asked for a
   * page and heard nothing for eight seconds assumes it is broken, and the
   * eventual answer does not undo that. Worse, above the provider's own tool
   * timeout it recreates the original bug exactly: the call is abandoned, the
   * agent composes a reply with nothing in hand, and it guesses — which in
   * live testing meant "GitHub did not load" about a page on the user's
   * screen.
   *
   * So it sits where the measurements separate: `system.time` ~1ms and
   * `app.open` ~0.9-1.5s including its window verification stay SILENT and
   * answer in one sentence. `system.screenshot` measures 2.0-3.2s across runs
   * and a real navigation ranges from under a second warm to many seconds
   * cold — those STRADDLE the threshold, and announce exactly when the
   * particular run is slow. That is the intended behaviour rather than a
   * fuzzy boundary: the acknowledgement is a fallback against silence, so a
   * fast run answering in one sentence is the better outcome. The numbers are
   * taken by `verify-tools.cjs`, against the real tools on a real machine,
   * rather than chosen by taste.
   *
   * `voice-agent-timing.test.ts` asserts the relationship with
   * `VOICE_AGENT_LIMITS.toolTimeoutSeconds` from the other end.
   */
  inlineBudgetMs: 2_500,
  /**
   * The inline budget for READING a page in the user's browser, and for the
   * steps that lead from one reading to the next (`PAGE_STEP_TOOLS`).
   *
   * Browsing is a chain — read, click, read again — and the model can only
   * take the next step from a result it actually holds. A result later than
   * `inlineBudgetMs` reaches it as a one-line spoken outcome (the right thing
   * for a single action, measured in Phase 3) and the chain ends there: live,
   * "check my latest PR" stopped at "I've found the pull requests link",
   * because a page read takes 6–9 s. So these steps wait inline longer — still
   * inside `VOICE_AGENT_LIMITS.toolTimeoutSeconds` with room for the dispatch,
   * which `voice-agent-timing.test.ts` asserts — and only past this do they
   * fall back to the acknowledgement path.
   */
  pageInlineBudgetMs: 11_000,
  /**
   * Steps one task may contain.
   *
   * A bound on a multi-step request, not on a conversation: "open YouTube,
   * search, open the first result" is four or five steps, and forty is a task
   * that has stopped converging. The per-turn tool-call budget still applies
   * on top of this and is spent at the dispatcher; this one exists so a task
   * can be reported as having given up rather than merely stopping.
   */
  maxStepsPerTask: 40,
  /**
   * How long a completed task still recognises its own late results.
   *
   * After this, a result arriving for it is discarded rather than delivered.
   * A task nobody is thinking about any more should not start talking.
   */
  lateResultGraceMs: 60_000,
} as const;

/**
 * Where a task is.
 *
 * `CANCELLED` and `SUPERSEDED` are separate because they mean different things
 * to a person: the first is "you told me to stop", the second is "you asked me
 * for something else instead". Only the first is worth saying out loud.
 */
export const TASK_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED', 'SUPERSEDED', 'FAILED'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What happened to one step. Mirrors the dispatcher's own vocabulary. */
export const STEP_OUTCOMES = [
  'PROPOSED',
  'REFUSED',
  'AWAITING_APPROVAL',
  'DENIED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/**
 * One step's trace.
 *
 * The whole of "what did Axon do and why" for a single action, in the order it
 * happened. Deliberately carries NO ARGUMENTS and NO OUTPUT — a step trace is
 * read in logs and shown in a timeline, and a typed password or a page of text
 * has no business in either. What it carries is the shape of the decision.
 */
export interface TaskStepTrace {
  readonly taskId: string;
  readonly stepId: string;
  /** Which tool was proposed. A name, never a callable. */
  readonly tool: string;
  readonly outcome: StepOutcome;
  /**
   * The dispatcher call this step became, once it has become one.
   *
   * Null on the PROPOSED trace, because the call does not exist yet. Present
   * on the outcome, which is what lets a timeline join a step to its
   * TOOL_CALL, its approval and its result EXACTLY rather than by guessing
   * from ordering — and a developer timeline that guesses is one that
   * misattributes an approval under load, which is the moment it matters.
   */
  readonly callId: string | null;
  /** The risk level the policy resolved, once it has been resolved. */
  readonly risk: string | null;
  /** Whether a human was asked, and what they said. */
  readonly approval: 'not-required' | 'requested' | 'allowed' | 'denied' | null;
  /** Whether Axon established the effect by looking, rather than assuming. */
  readonly verified: boolean | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * The facts Axon has established about the task in flight.
 *
 * WHAT THIS IS FOR: "search for AssemblyAI".
 *
 * A person talking to an assistant drops the subject constantly. "Open
 * YouTube" then "search for AssemblyAI" then "open the first one" — none of
 * the later sentences name what they are about, and all of them are perfectly
 * clear to a human because the human remembers where they are.
 *
 * The model has the conversation, so it remembers what was SAID. What it does
 * not have is what Axon SAW: which page actually loaded, what actually got
 * clicked, how many steps have been taken. Those are the facts a reference
 * resolves against, and a model reasoning about them from its own memory of
 * its own intentions is a model that will confidently act on a page that never
 * opened.
 *
 * So this travels back with every tool result: not as permission, not as
 * instruction, but as GROUNDING. Every field is something Axon observed
 * itself.
 *
 * WHAT IT DELIBERATELY IS NOT. It resolves nothing. Axon does not decide that
 * "it" means YouTube — that is language, and the model is the thing that reads
 * language. Axon supplies the facts and then validates whatever the model
 * proposes against them, exactly as before. A context that resolved references
 * would be a context that could resolve one wrongly, silently, with no gate in
 * between.
 */
export interface TaskContext {
  readonly taskId: string;
  /** What the user asked for, in their words. Never the model's paraphrase. */
  readonly goal: string;
  /** Steps taken so far in this task. A counter, for the model's own pacing. */
  readonly stepsTaken: number;
  /**
   * The page Axon last read, when there is one.
   *
   * Axon's own reading, not the address it was asked for — those differ after
   * a redirect, and the difference is exactly what a model needs to know
   * before it says "search there".
   */
  readonly currentPage: string | null;
  /** What Axon last successfully acted on, as Axon described it. */
  readonly lastActedOn: string | null;
  /**
   * The question Axon is waiting for an answer to, if any.
   *
   * Present means the next thing the user says is an ANSWER, not a new
   * request — see `TaskLedger.awaitClarification`.
   */
  readonly awaitingAnswerTo: string | null;
}

/**
 * How Axon describes an action it is about to take, in the present tense.
 *
 * "Opening YouTube." — a statement of INTENT, which is safe to say before
 * anything has happened, as distinct from "YouTube is open", which is a claim
 * about the world and must wait for verification.
 *
 * Returns null for work too trivial to announce. A person does not want to
 * hear "Checking the time." before being told the time; the announcement would
 * take longer than the answer. Only operations that leave a real silence get
 * one.
 *
 * Derived from the tool and its ARGUMENTS, by Axon, so the phrasing cannot
 * describe something other than what is about to run.
 */
function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The page tools whose results the model needs in hand to take the next step
 * (see `TASK_LIMITS.pageInlineBudgetMs`). Read-only or navigation only: an
 * approval-gated click never runs inline anyway.
 */
export const PAGE_STEP_TOOLS: ReadonlySet<string> = new Set(['web.read', 'web.find', 'web.click', 'web.type', 'web.scroll']);

export function describeProgress(tool: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'browser.open':
    case 'browser.navigate': {
      const site = friendlySite(typeof args.url === 'string' ? args.url : '');
      return site ? `Opening ${site}` : 'Opening the page';
    }
    case 'browser.click':
      return 'Clicking';
    case 'browser.type':
      return args.submit === true ? 'Submitting' : 'Filling that in';
    case 'browser.read':
      return 'Reading the page';
    // Registry keys are lower-case ("calculator"); what is said is a name.
    // Casing only — an app is never renamed into something it is not.
    case 'app.open':
      return typeof args.app === 'string' && args.app !== '' ? `Opening ${capitalise(args.app)}` : 'Opening it';
    case 'app.launch':
      return typeof args.app === 'string' && args.app !== '' ? `Opening ${capitalise(args.app)}` : 'Opening it';
    case 'web.open': {
      if (typeof args.url !== 'string' || args.url === '') return 'Opening your browser';
      const site = friendlySite(args.url);
      return site ? `Opening ${site}` : 'Opening the page';
    }
    case 'ui.read':
      return typeof args.app === 'string' && args.app !== '' ? `Looking at ${capitalise(args.app)}` : 'Looking at the screen';
    case 'web.read':
      return 'Reading the page';
    case 'web.find':
      return 'Looking for that';
    case 'web.click':
      return 'Clicking';
    case 'web.type':
      return 'Filling that in';
    case 'web.scroll':
      return 'Scrolling';
    case 'draw.paint':
      return 'Drawing that in Paint';
    case 'draw.generate':
      return 'Creating that image';
    case 'app.focus':
      return typeof args.app === 'string' && args.app !== '' ? `Switching to ${capitalise(args.app)}` : 'Switching over';
    case 'system.screenshot':
      return 'Looking at the screen';
    case 'ui.click':
      return 'Doing that';
    case 'keyboard.type':
      return 'Typing that in';
    // Everything else is either instant or has no honest present tense.
    // `system.time`, `memory.search` and the window tools all answer faster
    // than an announcement would take to say.
    default:
      return null;
  }
}

/**
 * A site name a person would recognise, from a URL.
 *
 * "YouTube", not "www.youtube.com". Nothing is invented: this only trims what
 * is already in the host, so an unfamiliar address comes back as its own host
 * rather than as a guess about what it is.
 */
export function friendlySite(url: string): string | null {
  if (typeof url !== 'string' || url === '') return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (host === '') return null;

  const bare = host.replace(/^www\./, '');
  const label = bare.split('.')[0] ?? bare;
  if (label === '') return bare;

  // Names people actually write a particular way. This is CASING, not
  // identification: an address not on this list still comes back as its own
  // host, never as a guess about what site it is.
  const known = KNOWN_SITE_NAMES[label.toLowerCase()];
  if (known) return known;

  // Capitalised, because it is a name and it is going to be read aloud.
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** How a handful of familiar sites spell themselves. Casing only. */
const KNOWN_SITE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  youtube: 'YouTube',
  github: 'GitHub',
  gitlab: 'GitLab',
  stackoverflow: 'Stack Overflow',
  linkedin: 'LinkedIn',
  gmail: 'Gmail',
  npmjs: 'npm',
  assemblyai: 'AssemblyAI',
  openai: 'OpenAI',
  duckduckgo: 'DuckDuckGo',
  wikipedia: 'Wikipedia',
});

/**
 * What Axon tells the agent when a tool is going to take a while.
 *
 * THE THIRD ANSWER A TOOL CALL CAN HAVE, AND WHY IT IS NECESSARY.
 *
 * `DEFERRED_TOOL_RESULT` says "a human is being asked". This says "Axon is
 * doing it, and does not know the answer yet". They are different states and
 * collapsing them would be a lie in one direction or the other.
 *
 * Without this, a tool slower than `inlineBudgetMs` leaves the agent composing
 * a reply with nothing in hand. In live use it filled that gap by guessing,
 * and it guessed FAILURE — telling the user "GitHub did not load" about a page
 * that was on their screen. Axon then corrected itself when the real result
 * arrived, so the user heard two contradictory sentences about one action.
 *
 * The fix is not a better guess. It is to make the intermediate state sayable:
 * the agent is told, truthfully, that the work is under way and that it does
 * not yet have an outcome, and it is told to acknowledge briefly and stop.
 * The outcome then arrives as the FIRST statement anybody makes about what
 * happened, so there is nothing to contradict.
 *
 *   "One moment."          <- this result
 *   "GitHub is open."      <- the outcome, delivered as a follow-up turn
 *
 * `executed: false` is the field that matters. It is the same promise
 * `DEFERRED_TOOL_RESULT` makes and it is equally load-bearing: an agent that
 * read this as success would announce something that has not happened.
 */
export const IN_PROGRESS_TOOL_RESULT = {
  status: 'in_progress',
  executed: false,
} as const;

/**
 * Phrases that mean "stop what you are doing".
 *
 * Matched against the user's OWN WORDS — the transcript, never the agent's
 * paraphrase of it. A model that could restate the user's request could
 * restate it as a cancellation, or fail to, and neither is a decision it
 * should be making.
 */
export const CANCELLATION_PHRASES: readonly string[] = [
  'stop',
  'stop it',
  'stop that',
  'stop please',
  'cancel',
  'cancel it',
  'cancel that',
  'never mind',
  'nevermind',
  'forget it',
  'forget that',
  'abort',
  'abort it',
  'do not do that',
  'dont do that',
  'do not do it',
  'dont do it',
  'leave it',
  'quit it',
  'halt',
];

/**
 * Words that may surround a cancellation without changing it.
 *
 * "Okay Axon, stop please" is a cancellation. Stripping these before matching
 * is what lets the match itself stay strict.
 */
const FILLER_WORDS: readonly string[] = [
  'ok',
  'okay',
  'alright',
  'right',
  'please',
  'axon',
  'hey',
  'um',
  'uh',
  'er',
  'well',
  'just',
  'actually',
  'wait',
  'no',
  'now',
  'yeah',
  'yes',
];

/**
 * Is this the user asking Axon to stop?
 *
 * STRICT ON PURPOSE, and the asymmetry is the reason. A false negative costs
 * the user saying it again, which is mildly annoying. A false positive
 * abandons work they wanted, halfway through, for no reason they can see —
 * and "Axon randomly gives up" is a far worse product than "Axon needs telling
 * twice". So:
 *
 * - The utterance must be SHORT. "Stop the video" is a request to act on
 *   something, not a request to stop acting, and length is the cheapest signal
 *   that separates them.
 * - After filler is removed, what remains must be EXACTLY a cancellation
 *   phrase. Not "contains one" — `"don't stop"` and `"stop by the shop"` both
 *   contain "stop", and neither is a cancellation.
 *
 * Pure and allocation-light: this runs on every transcript.
 */
export function matchesCancellation(text: string): boolean {
  if (typeof text !== 'string') return false;

  const normalized = text
    .toLowerCase()
    // Apostrophes are dropped rather than mapped, so "don't" becomes "dont"
    // and matches the entry spelled that way. Transcripts are inconsistent
    // about them and neither spelling should win.
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized === '') return false;

  const words = normalized.split(' ');
  // A cancellation is a short utterance. Anything longer is a request.
  if (words.length > 6) return false;

  const stripped = words.filter((word) => !FILLER_WORDS.includes(word)).join(' ');
  if (stripped === '') return false;

  return CANCELLATION_PHRASES.includes(stripped);
}

/**
 * What the user can ask of the conversation itself.
 *
 *   sleep    end the conversation. The microphone stops streaming at once;
 *            the LOCAL wake word keeps listening, so "Hey Axon" wakes it.
 *   mic-off  end the conversation AND stop the wake word. Nothing is listened
 *            to — not even locally — until the user explicitly starts Axon
 *            again (the orb, the hotkey, the tray).
 *
 * FOUND IN A REAL CONVERSATION. Neither existed. Every one of these was said,
 * and every one was answered by the model while the session carried on
 * streaming the microphone:
 *
 *     "You can, you can go to sleep for now."   -> "Goodnight!"
 *     "Yeah, stop listening."                   -> "Understood. I will stop listening now."
 *     "I want you to stop listening to me."     -> "Stopped."
 *     "No, you are still listening."            -> "Stopped."
 *
 * The model narrated an act nothing performed. So, like cancellation, this is
 * matched from the USER'S OWN WORDS in main, before the model is consulted: a
 * model asked whether it has been told to stop listening is the thing being
 * stopped.
 *
 * LOOSER THAN `matchesCancellation`, deliberately and in one direction. Real
 * speech repeats itself ("you can, you can go to sleep for now"), and an exact
 * phrase list would have missed three of the four above. The asymmetry that
 * makes that acceptable: a false positive ends a conversation the user can
 * restart with one word; a false negative keeps streaming a microphone the
 * user asked to stop. The guards below remove the false positives that are
 * predictable — a negation ("don't stop listening"), a question ("did you go
 * to sleep?"), a phrase that is the OBJECT of another request ("play Stop
 * Listening", "remind me to go to sleep"), and "stop listening to music".
 */
export type LifecycleCommand = 'sleep' | 'mic-off';

/** Words that make the utterance a request ABOUT something, not a command to Axon. */
const LIFECYCLE_OBJECT_VERBS = new Set([
  'play', 'search', 'open', 'find', 'look', 'type', 'write', 'remind', 'remember',
  'set', 'schedule', 'tell', 'say', 'read', 'send', 'note', 'google', 'show',
]);

/** Words that make the utterance a question, not a command. */
const QUESTION_OPENERS = new Set([
  'did', 'are', 'is', 'was', 'were', 'have', 'has', 'why', 'what', 'when', 'how', 'where', 'who', 'does', 'do',
]);

const MIC_OFF_PATTERNS: readonly RegExp[] = [
  // "stop listening", "stop listening to me/us" — but not "to music".
  /\bstop listening\b(?! to (?!(?:me|us)\b))/,
  /\b(?:turn|switch|shut) (?:off|down) (?:the |your )?(?:mic|microphone)\b/,
  /\b(?:turn|switch) (?:the |your )?(?:mic|microphone) off\b/,
  /\b(?:mic|microphone) off\b/,
  /\bmute (?:yourself|the mic|the microphone|your mic|your microphone)\b/,
];

const SLEEP_PATTERNS: readonly RegExp[] = [
  /\bgo (?:back )?to sleep\b/,
  /\b(?:end|close|finish|stop) (?:the|this|our) (?:conversation|chat|session)\b/,
];

/** Whole utterances that end a conversation on their own. */
const SLEEP_PHRASES = new Set([
  'goodbye', 'good bye', 'bye', 'bye bye', 'good night', 'goodnight',
  'thats all', 'that is all', 'thanks thats all', 'thank you thats all',
  'were done', 'we are done', 'sleep',
]);

export function matchesLifecycleCommand(text: string): LifecycleCommand | null {
  if (typeof text !== 'string') return null;

  const normalized = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === '') return null;

  const words = normalized.split(' ');
  // A command about the conversation is short. The longest real one above is
  // nine words; anything much longer is a request that mentions sleep.
  if (words.length > 12) return null;

  const content = words.filter((word) => !FILLER_WORDS.includes(word));
  if (content.length === 0) return null;

  // Questions are not commands: "did you go to sleep?", "are you listening?".
  if (QUESTION_OPENERS.has(content[0] ?? '')) return null;
  // A request ABOUT sleep or listening is not a command to Axon.
  if (content.some((word) => LIFECYCLE_OBJECT_VERBS.has(word))) return null;

  const joined = content.join(' ');
  // A negation reverses it. Word-bounded, so "notepad" is not "not"; and read
  // from the text BEFORE fillers are stripped, because "no" is a filler and
  // "no need to go to sleep" must not become "need to go to sleep".
  if (/\b(?:dont|never|not|no need)\b/.test(normalized)) return null;

  // Mic-off first: when both are said ("stop listening and go to sleep"),
  // the stronger request is the one honoured.
  if (MIC_OFF_PATTERNS.some((pattern) => pattern.test(joined))) return 'mic-off';
  if (SLEEP_PATTERNS.some((pattern) => pattern.test(joined))) return 'sleep';
  if (SLEEP_PHRASES.has(joined)) return 'sleep';
  return null;
}

/**
 * Why a task ended, phrased for a person, in as few words as possible.
 *
 * "Stopped." is the whole of what a user needs to hear when they said "stop".
 * Anything longer is Axon explaining itself at the moment the user has already
 * moved on.
 */
export function describeTaskEnd(status: TaskStatus): string {
  switch (status) {
    case 'CANCELLED':
      return 'Stopped.';
    case 'SUPERSEDED':
      return 'Switching to the new request.';
    case 'FAILED':
      return 'That did not work.';
    case 'COMPLETED':
      return 'Done.';
    case 'ACTIVE':
    default:
      return '';
  }
}
