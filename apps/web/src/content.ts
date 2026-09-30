/**
 * Everything the site says, in one file.
 *
 * SOURCE OF TRUTH: the repository. Every capability below is a tool that exists
 * in `apps/desktop/src/main/tools/executors/`, every refusal is one the README
 * states, and the interaction states are the ones `state-colors.ts` defines,
 * with its actual colours. Nothing here is aspirational: there are no user
 * counts, no benchmarks, no testimonials, no logos, and no platform beyond the
 * one the desktop app supports.
 *
 * If a claim on the website is wrong, it is wrong here, in one place.
 */

/**
 * The small line drawing on a capability card.
 *
 * A shape, not an illustration: a window frame, a browser chrome, a field with
 * a caret. It is drawn from the same thin strokes as the rest of the page and
 * moves only on hover. See `components/CardGlyph.tsx`.
 */
export type Glyph = 'app' | 'browser' | 'form' | 'tree' | 'control' | 'clock' | 'capture' | 'file' | 'memory';

export interface Capability {
  readonly title: string;
  readonly detail: string;
  /** Something a person could actually say. */
  readonly say: string;
  /** The real tool names behind it, for people who want to check. */
  readonly tools: readonly string[];
  readonly glyph: Glyph;
}

/** What Axon can do today. One entry per group of real tools. */
export const CAPABILITIES: readonly Capability[] = [
  {
    title: 'Open your applications',
    detail: 'Opens applications installed on this PC, found by name in the Start menu — asking you first for any it doesn’t already trust — then confirms by the process that owns the window that it really opened.',
    say: 'Open Spotify.',
    tools: ['app.open', 'app.launch', 'app.focus'],
    glyph: 'app',
  },
  {
    title: 'Browse the web',
    detail: 'Hands a page to your own default browser, whichever one Windows says it is. Or opens it in Axon’s own browser window, where it can read, scroll and follow links from the page structure.',
    say: 'Open YouTube in my browser.',
    tools: ['web.open', 'browser.open', 'browser.navigate', 'browser.read', 'browser.scroll'],
    glyph: 'browser',
  },
  {
    title: 'Fill in a form',
    detail: 'Types into fields it can name from the page, one field at a time. Submitting is a separate decision, and yours.',
    say: 'Fill in my name and email.',
    tools: ['browser.type', 'browser.click'],
    glyph: 'form',
  },
  {
    title: 'Read an application',
    detail: 'Reads an application’s controls through native Windows UI Automation — the accessibility tree, not pixels — with no per-app integration. Works where the app exposes its interface to UI Automation.',
    say: 'What do you see in Spotify?',
    tools: ['ui.read', 'window.list', 'window.focus'],
    glyph: 'tree',
  },
  {
    title: 'Press an on-screen control',
    detail: 'Presses or fills a control by reference, in another application, with your approval first.',
    say: 'Click the Save button.',
    tools: ['ui.click', 'keyboard.type'],
    glyph: 'control',
  },
  {
    title: 'Draw in Paint',
    detail: 'After you approve, opens a new Paint window and builds a simple drawing up in it step by step — a house, a sunset, a cat or a tree — through Paint’s own Paste, then reads the canvas back to check it. No mouse automation. Image generation from any description is not configured yet, and Axon says so.',
    say: 'Open Paint and draw a house.',
    tools: ['draw.paint', 'draw.generate'],
    glyph: 'capture',
  },
  {
    title: 'Tell the time',
    detail: 'Reads the clock on this machine. No network, no location, no calendar.',
    say: 'What time is it?',
    tools: ['system.time'],
    glyph: 'clock',
  },
  {
    title: 'Save a screenshot',
    detail: 'Captures the screen to its own folder. Axon cannot see images — there is no vision model in the loop.',
    say: 'Take a screenshot.',
    tools: ['system.screenshot'],
    glyph: 'capture',
  },
  {
    title: 'Write in its workspace',
    detail: 'Writes files inside one directory it owns. Everywhere else on disk is off limits, and it cannot read your files.',
    say: 'Write these notes to a file.',
    tools: ['fs.write'],
    glyph: 'file',
  },
  {
    title: 'Remember what you approve',
    detail: 'Keeps facts you agreed it should keep, in a local database, and forgets them when you say so.',
    say: 'Remember that I use Chrome for work.',
    tools: ['memory.save', 'memory.search', 'memory.forget'],
    glyph: 'memory',
  },
];

/** What Axon deliberately cannot do. Straight from the README. */
export const REFUSALS: readonly string[] = [
  'Run shell or PowerShell commands',
  'Press keys or keyboard shortcuts',
  'Move the mouse or click by coordinate',
  'Read arbitrary files on your disk',
  'Type a password or an API key',
  'Submit, send or buy without your decision',
  'See images — it works from the accessibility tree',
];

export interface PipelineStep {
  readonly label: string;
  readonly detail: string;
}

export interface DemoBeat {
  /** Who is speaking or acting, in the left column. */
  readonly who: string;
  /** The line itself. Quoted when `spoken`. */
  readonly text: string;
  readonly spoken: boolean;
  /** The tool the request resolves to, when this beat is a request. */
  readonly tool?: string;
  /** The short note beside it: policy, or the verification. */
  readonly note?: string;
  /** Which orb state this beat is, using the desktop app's own colours. */
  readonly orb: { readonly rgb: readonly [number, number, number]; readonly motion: 'listening' | 'thinking' | 'executing' | 'speaking' };
}

/**
 * The illustrative run in the demo section.
 *
 * ILLUSTRATIVE, and labelled as such on screen. It is the same exchange as the
 * hero's trace — the simplest true one Axon does — written out beat by beat so
 * the shape of a turn is visible: a sentence, a request that had to be allowed,
 * and a result that was checked rather than claimed.
 *
 * Every part of it is real: `app.open` exists, opening Notepad is low risk and
 * runs without an approval prompt, and the executor really does confirm the
 * window appeared before Axon says it is open. Nothing here is a screenshot of
 * a session, and the page does not suggest it is.
 */
export const DEMO_BEATS: readonly DemoBeat[] = [
  {
    who: 'You',
    text: 'Open Notepad.',
    spoken: true,
    orb: { rgb: [74, 150, 255], motion: 'listening' },
  },
  {
    who: 'Axon',
    text: 'Request',
    spoken: false,
    tool: 'app.open',
    note: 'allowed by policy — low risk, no approval needed',
    orb: { rgb: [150, 126, 255], motion: 'thinking' },
  },
  {
    who: 'Result',
    text: 'Notepad is open.',
    spoken: true,
    note: 'Verified — its window is on screen',
    // Speaking, not executing: by the time Axon says this, the action has run
    // and it is telling you about it. The verified result takes the teal, on
    // the card rather than on the orb, which is how the rest of the page marks
    // a checked outcome.
    orb: { rgb: [96, 190, 255], motion: 'speaking' },
  },
];

/**
 * The two shapes, side by side, for the idea section.
 *
 * This is a description of an interaction model, not a comparison of products:
 * a chat box is a good way to get an answer, and nothing here says otherwise.
 * What it says is where each one stops.
 */
export const CHAT_LOOP: readonly PipelineStep[] = [
  { label: 'Question', detail: 'You type what you want.' },
  { label: 'Answer', detail: 'Text comes back. The doing is still yours.' },
];

export const AXON_LOOP: readonly PipelineStep[] = [
  { label: 'Voice', detail: 'You say it out loud, in a sentence.' },
  { label: 'Understand', detail: 'Speech becomes a proposed action, with real arguments.' },
  { label: 'Act', detail: 'Axon’s own rules decide whether it runs, and whether to ask you first.' },
  { label: 'Verify', detail: 'It looks at the result, and tells you what actually happened.' },
];

/** The architecture, for the how-it-works section. */
export const ARCHITECTURE: readonly PipelineStep[] = [
  { label: 'Your voice', detail: 'Axon opens the microphone only while it is listening, and Windows shows its own recording indicator throughout.' },
  { label: 'AssemblyAI Voice Agent', detail: 'Recognition, reasoning and the spoken reply, over one WebSocket held by Axon’s main process.' },
  { label: 'Axon’s control plane', detail: 'Every proposed action arrives here as a request — never as a command that has already run.' },
  { label: 'Validate', detail: 'Schema checks, the goal boundary, sensitivity checks. A malformed or out-of-scope request stops here.' },
  { label: 'Policy and risk', detail: 'Risk is resolved from the real arguments. It can be raised, and it is never downgraded.' },
  { label: 'Your approval', detail: 'Anything consequential waits for a person. An approval nobody answers becomes a denial, never a hang.' },
  { label: 'Execute', detail: 'Re-checked first: the act about to run must still be the one that was approved.' },
  { label: 'Verify', detail: 'Axon looks at the result — the window that opened, the field that changed — and reports what it sees.' },
  { label: 'Spoken answer', detail: 'Axon tells you what it did, in the same conversation.' },
];

/** The approval gate, for the trust section. */
export const GATE: readonly string[] = ['Model request', 'Validate', 'Policy', 'Approval', 'Execute', 'Verify'];

/** What always needs a human. */
export const APPROVAL_TRIGGERS: readonly string[] = [
  'Submitting a form',
  'Sending a message',
  'Buying anything',
  'Deleting anything',
  'Anything that leaves this machine',
];

export interface OrbState {
  readonly name: string;
  readonly caption: string;
  /** The desktop app's own colour for this state, from `state-colors.ts`. */
  readonly rgb: readonly [number, number, number];
}

/**
 * The orb's states, with the colours the desktop app really uses.
 *
 * The working states sit in one cool family and differ in luminance and motion;
 * amber is reserved for the one state that wants your attention. Colour means
 * something in Axon rather than decorating it.
 */
export const ORB_STATES: readonly OrbState[] = [
  { name: 'Idle', caption: 'Listening for its name, on this machine.', rgb: [150, 166, 198] },
  { name: 'Listening', caption: 'The microphone is open and you have the floor.', rgb: [74, 150, 255] },
  { name: 'Thinking', caption: 'Working out what to ask for.', rgb: [150, 126, 255] },
  { name: 'Executing', caption: 'An approved action is running.', rgb: [34, 206, 188] },
  { name: 'Speaking', caption: 'Telling you what happened.', rgb: [96, 190, 255] },
  { name: 'Approval', caption: 'Stopped, and waiting for you.', rgb: [255, 166, 72] },
];

export interface PrivacyFact {
  readonly title: string;
  readonly detail: string;
  /** Where the audio or data goes: shapes how the row is marked. */
  readonly scope: 'local' | 'network';
}

/**
 * Privacy, stated precisely.
 *
 * The distinction that matters, and the one a blanket "everything stays on your
 * device" claim would erase: the wake word is local, and the conversation is not.
 */
/**
 * The whole privacy question in two columns, before the detail.
 *
 * One side is everything that happens here; the other side is the single thing
 * that does not, named, with what it is for. A summary that listed only the
 * first column would be the blanket claim this section exists to avoid.
 */
export const PRIVACY_SPLIT: readonly { readonly scope: 'local' | 'network'; readonly title: string; readonly items: readonly string[] }[] = [
  {
    scope: 'local',
    title: 'On this device',
    items: [
      'Wake-word detection — “Hey Axon” is recognised on-device, offline',
      'Your conversations, in a local SQLite database',
      'Approved memories and your settings',
      'Screenshots Axon takes, in a folder it owns',
      'Raw audio is never written to disk, by anything',
    ],
  },
  {
    scope: 'network',
    title: 'Leaves this device',
    items: [
      'While a conversation is active, your speech is streamed to AssemblyAI',
      'AssemblyAI provides the recognition, the reasoning and the spoken reply',
      'That connection opens when you activate Axon, and closes with the session',
    ],
  },
];

export const PRIVACY: readonly PrivacyFact[] = [
  {
    title: 'The wake word never leaves your machine',
    detail:
      'Waiting for “Hey Axon” runs entirely on-device: a 3.3M-parameter keyword spotter (sherpa-onnx, Apache-2.0) in its own process, with no network and no credential. Until you say the phrase, nothing is sent anywhere.',
    scope: 'local',
  },
  {
    title: 'A conversation streams audio to AssemblyAI',
    detail:
      'Once you activate Axon, your speech is streamed to AssemblyAI’s Voice Agent API, which provides recognition, reasoning and the spoken reply. That is a network service, and this is the one place audio leaves the machine.',
    scope: 'network',
  },
  {
    title: 'Raw audio is never written to disk',
    detail: 'Not by the wake word, not by the conversation. There is no recording on your computer to find, and none to delete.',
    scope: 'local',
  },
  {
    title: 'Credentials are refused, and redacted',
    detail:
      'Axon will not type a password or an API key. Anything that looks like a credential on its way into the transcript is stored as “[redacted]”, and the database has no column that could hold one.',
    scope: 'local',
  },
  {
    title: 'Your data stays on your computer',
    detail:
      'Conversations, approved memories and settings live in a local SQLite database. Screenshots are kept to the last twelve. Axon’s browser keeps its own profile and never copies credentials out of your browser.',
    scope: 'local',
  },
  {
    title: 'There is no Axon account',
    detail: 'No sign-in, no sync, no telemetry service of ours. You bring your own AssemblyAI key, and the voice service sees what you say to Axon.',
    scope: 'local',
  },
];

/** Requirements, from the README's table. */
export const REQUIREMENTS: readonly string[] = [
  'Windows 10 or 11, 64-bit',
  'A microphone',
  'An AssemblyAI API key for spoken conversation',
];
