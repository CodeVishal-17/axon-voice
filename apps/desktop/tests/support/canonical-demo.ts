/**
 * THE CANONICAL DEMO — the exact sequence that goes on stage, as data.
 *
 * WHY IT IS DATA AND NOT PROSE. A demo script in a document drifts from the
 * product within a week and nobody notices until the room is full. This one is
 * executed by `rehearsal.test.ts` on every test run, against the real
 * orchestrator, the real tool bridge, the real dispatcher, the real policy and
 * the real approval broker — so a change that breaks the demo breaks the
 * suite. `docs/DEMO.md` is generated from the same array by
 * `demo-script.test.ts`, which is what keeps the document honest.
 *
 * THE STORY IT TELLS, in three acts, and each act earns the next:
 *
 *   I  — VOICE and the WEB. Axon hears, opens, searches, and asks when two
 *        results are indistinguishable rather than picking one.
 *   II — the DESKTOP. Axon opens a real application and reads the machine's
 *        own clock, so "it is a computer agent" stops being a claim.
 *   III— the BOUNDARY. Axon reads an application form, fills what is safe,
 *        refuses what is not, and stops before submitting. This is the act
 *        the whole product is for.
 *
 * WHAT IS REAL WHEN THIS RUNS IN THE SUITE, AND WHAT IS NOT.
 *
 * Real: the orchestrator, the task ledger, the tool bridge, the dispatcher and
 * every gate in it, the policy, the risk assessment, the approval broker and
 * its binding, the tools, the observation store, and the events.
 *
 * Not real: the MODEL — the `steps` below stand in for what Claude would
 * propose, and they reach the world through `bridge.handleToolCall`, the same
 * door and the same authority, which is none. And the SITES — a page model
 * rather than the internet, so a rehearsal does not depend on a venue's wifi.
 *
 * A rehearsal therefore proves the pipeline holds for this sequence. It is not
 * evidence that the model proposes this sequence; `smoke-assemblyai.cjs` is
 * the evidence for that, against the real provider, and the two claims are
 * kept apart deliberately.
 */

import type { JsonValue } from '@axon/core';

export interface DemoElement {
  readonly ref: string;
  readonly label: string;
  readonly role: string;
}

/** What a step can look at when it decides what to propose. */
export interface DemoContext {
  /** Elements from the most recent result Axon handed the model. */
  readonly elements: readonly DemoElement[];
  /** Every element seen so far this beat, for a step that acts on an earlier reading. */
  readonly seen: readonly DemoElement[];
}

export interface DemoStep {
  readonly tool: string;
  readonly input: (context: DemoContext) => JsonValue;
  /** Set when this step is expected NOT to succeed — a refusal or a question. */
  readonly expect?: 'refused' | 'question' | 'approval';
  /**
   * The live page moves to this path just before the step runs.
   *
   * Not a test convenience: a results page that updates while somebody is
   * still talking is the ordinary behaviour of the web, and it is what makes
   * a stored element reference dangerous. The demo does it on purpose,
   * because Axon asking "which one?" is only interesting if the situation
   * that produces it is one the audience believes in.
   */
  readonly drift?: string;
  /** Why this step is in the demo. Printed in the rehearsal record. */
  readonly note?: string;
}

export interface DemoBeat {
  readonly act: 'I — voice and the web' | 'II — the desktop' | 'III — the boundary';
  readonly id: string;
  /** The exact words the presenter says. */
  readonly say: string;
  /** What the audience is being shown. */
  readonly demonstrates: string;
  /** What the presenter should expect to hear. Documentation, not an assertion. */
  readonly presenterHears: string;
  /** The orb state the audience should see while this beat runs. */
  readonly orb: string;
  /** Whether the approval dialog appears during this beat. */
  readonly approval: 'none' | 'appears';
  readonly steps: readonly DemoStep[];
  /** Set when the beat is spoken but proposes nothing — a wake, or arithmetic. */
  readonly noTools?: string;
}

const YOUTUBE = 'https://www.youtube.com/';
const APPLICATION = 'https://careers.example.com/internship/apply';

function labelled(context: DemoContext, startsWith: string): DemoElement {
  const match =
    context.elements.find((element) => element.label.startsWith(startsWith)) ??
    context.seen.find((element) => element.label.startsWith(startsWith));
  if (!match) throw new Error(`the demo expected an element labelled "${startsWith}" and the page had none`);
  return match;
}

export const CANONICAL_DEMO: readonly DemoBeat[] = [
  // --- Act I ---------------------------------------------------------------
  {
    act: 'I — voice and the web',
    id: 'wake',
    say: 'Hey Axon.',
    demonstrates: 'The name is heard locally. Nothing has been streamed anywhere yet.',
    presenterHears: 'A tone, and the orb opens. Axon does not answer the wake word with words.',
    orb: 'IDLE -> LISTENING',
    approval: 'none',
    noTools: 'Activation only. The microphone opens here and not before.',
    steps: [],
  },
  {
    act: 'I — voice and the web',
    id: 'open-youtube',
    say: 'Open YouTube.',
    demonstrates: 'One sentence in, one action out, and the answer waits for the page to actually be there.',
    presenterHears: '"YouTube is open." — or "Opening YouTube." first, if the network is slow.',
    orb: 'LISTENING -> THINKING -> EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [{ tool: 'browser.open', input: () => ({ url: YOUTUBE }), note: 'Verified by looking at the page afterwards.' }],
  },
  {
    act: 'I — voice and the web',
    id: 'search',
    say: 'Search for AssemblyAI Voice Agent.',
    demonstrates: 'Submitting anything sends data to somebody else’s server, so it asks. Even a search.',
    presenterHears: 'Something like "I need your OK to submit that search on YouTube." Allow it; the results follow.',
    orb: 'EXECUTING -> WAITING_FOR_APPROVAL -> EXECUTING',
    approval: 'appears',
    steps: [
      {
        tool: 'browser.type',
        input: (context) => ({ ref: labelled(context, 'Search').ref, text: 'AssemblyAI Voice Agent', submit: true }),
        expect: 'approval',
        note:
          'The approval names the act and where it lands. LIVE, it appears only if the model submits the search ' +
          'form: opening a results address, or clicking the script-driven search icon on YouTube, is an ordinary ' +
          'page action and asks nothing. The approval that is guaranteed is the one on "Submit it."',
      },
    ],
  },
  {
    act: 'I — voice and the web',
    id: 'ambiguous',
    say: 'Open the first result.',
    demonstrates: 'Two results Axon cannot tell apart. It asks rather than picking one.',
    presenterHears: '"Which one do you mean — ..." — a question, in as few words as it takes.',
    orb: 'EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [
      { tool: 'browser.read', input: () => ({}), note: 'Read first: a click acts on what Axon has actually seen.' },
      {
        tool: 'browser.click',
        input: (context) => ({ ref: labelled(context, 'AssemblyAI').ref }),
        expect: 'question',
        drift: '/results',
        note: 'The page moved underneath, so the reference re-resolves by identity and finds two matches.',
      },
    ],
  },
  {
    act: 'I — voice and the web',
    id: 'answer',
    say: 'The first one.',
    demonstrates: 'An answer continues the task that asked the question — it does not start a new one.',
    presenterHears: 'Axon carries on with what it was already doing.',
    orb: 'LISTENING -> THINKING',
    approval: 'none',
    steps: [
      { tool: 'browser.read', input: () => ({}), note: 'A fresh reading, because the last one is what went stale.' },
      {
        tool: 'browser.click',
        input: (context) => ({ ref: labelled(context, 'AssemblyAI').ref }),
        note: 'Now unambiguous: the reference was taken from a reading nothing has moved since.',
      },
    ],
  },

  // --- Act II --------------------------------------------------------------
  {
    act: 'II — the desktop',
    id: 'calculator',
    say: 'Open Calculator.',
    demonstrates: 'A real application, launched from a fixed registry of applications, and then verified.',
    presenterHears: '"Calculator is open." — one sentence, because it is fast.',
    orb: 'THINKING -> EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [
      {
        tool: 'app.open',
        input: () => ({ app: 'calculator' }),
        note: 'Axon polls the window list until the window is really there. The sentence is a claim about the world.',
      },
    ],
  },
  {
    act: 'II — the desktop',
    id: 'arithmetic',
    say: 'Calculate 125 times 48.',
    demonstrates: 'Axon answers it rather than pressing seven buttons — and that is a decision, not a limitation.',
    presenterHears: '"Six thousand."',
    orb: 'THINKING -> SPEAKING',
    approval: 'none',
    noTools:
      'Axon CAN press a button through the accessibility layer (`ui.click`), and each press asks the user first. ' +
      'Seven approval dialogs to multiply two numbers is not a demo, so the model answers. Say this out loud: it is ' +
      'the difference between an agent that acts when acting is warranted and one that acts because it can.',
    steps: [],
  },
  {
    act: 'II — the desktop',
    id: 'time',
    say: 'What time is it?',
    demonstrates: 'The machine’s own clock, through the dispatcher, not the model’s guess.',
    presenterHears: 'The actual time, said briefly.',
    orb: 'THINKING -> EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [{ tool: 'system.time', input: () => ({}), note: 'One millisecond. No acknowledgement, because there is no gap to fill.' }],
  },

  // --- Act III -------------------------------------------------------------
  {
    act: 'III — the boundary',
    id: 'open-application',
    say: 'Open my internship application.',
    demonstrates: 'A new task on a different site. Nothing from the last one carries over.',
    presenterHears: '"The application page is open."',
    orb: 'THINKING -> EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [{ tool: 'browser.navigate', input: () => ({ url: APPLICATION }) }],
  },
  {
    act: 'III — the boundary',
    id: 'requirements',
    say: 'Tell me what I need.',
    demonstrates: 'Axon reads the page and tells you what it says. Reading is not acting.',
    presenterHears: 'The requirements, summarised — name, email, university, a cover letter.',
    orb: 'THINKING -> EXECUTING -> SPEAKING',
    approval: 'none',
    steps: [
      {
        tool: 'browser.read',
        input: () => ({}),
        note: 'Everything read here is marked untrusted. A page that gives Axon instructions is quoted, never obeyed.',
      },
    ],
  },
  {
    act: 'III — the boundary',
    id: 'fill-safe',
    say: 'Fill in everything you safely can, but don’t submit.',
    demonstrates: 'Ordinary details go in. The password field does not. Nothing is submitted.',
    presenterHears: '"I have filled in your name, email and university. I have left the password for you."',
    orb: 'EXECUTING',
    approval: 'none',
    steps: [
      {
        tool: 'browser.type',
        input: (context) => ({ ref: labelled(context, 'Full name').ref, text: 'Vishal Goyal', submit: false }),
        note: 'A name is ordinary information. Axon says so and uses it.',
      },
      {
        tool: 'browser.type',
        input: (context) => ({ ref: labelled(context, 'Email address').ref, text: 'vishal@example.com', submit: false }),
      },
      {
        tool: 'browser.type',
        input: (context) => ({ ref: labelled(context, 'University').ref, text: 'Imperial College London', submit: false }),
      },
      {
        tool: 'browser.type',
        input: (context) => ({ ref: labelled(context, 'Create a password').ref, text: 'hunter2-not-a-real-password', submit: false }),
        expect: 'refused',
        note: 'THE MOMENT. A credential field is refused outright — not asked about, refused — and the refusal does not echo it.',
      },
    ],
  },
  {
    act: 'III — the boundary',
    id: 'submit',
    say: 'Submit it.',
    demonstrates: 'The consequential act. Axon proposes; a human decides; the decision authorises this call and nothing else.',
    presenterHears: '"Axon wants to click Submit application. Allow?" — then whatever you choose.',
    orb: 'EXECUTING -> WAITING_FOR_APPROVAL',
    approval: 'appears',
    steps: [
      {
        tool: 'browser.read',
        input: () => ({}),
        note:
          'Axon looks before it acts, every time. A button it has not just seen is a button it will not press — ' +
          'which is why the last thing it did cannot authorise the next thing it does.',
      },
      {
        tool: 'browser.click',
        input: (context) => ({ ref: labelled(context, 'Submit application').ref }),
        expect: 'approval',
        note: 'Deny it on stage. The nothing that happens is the product.',
      },
    ],
  },
];

/** Beats grouped by act, for rendering the script. */
export function demoActs(): readonly { readonly act: string; readonly beats: readonly DemoBeat[] }[] {
  const acts: { act: string; beats: DemoBeat[] }[] = [];
  for (const beat of CANONICAL_DEMO) {
    let group = acts.find((entry) => entry.act === beat.act);
    if (!group) {
      group = { act: beat.act, beats: [] };
      acts.push(group);
    }
    group.beats.push(beat);
  }
  return acts;
}
