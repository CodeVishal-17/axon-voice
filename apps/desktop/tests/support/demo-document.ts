/**
 * `docs/DEMO.md`, generated.
 *
 * The stage script is written ONCE, as data, in `canonical-demo.ts`. This
 * renders it into the document a presenter reads, and `demo-script.test.ts`
 * fails if the file on disk differs from what this produces — so the document
 * cannot drift from the demo that the suite actually performs.
 *
 * Regenerate with `npm run demo:doc`.
 */

import { CANONICAL_DEMO, demoActs } from './canonical-demo.js';

const RECOVERY: readonly (readonly [string, string, string])[] = [
  ['A page will not load', '"YouTube didn\'t load, so I stopped."', 'Say the next thing. Axon is already listening.'],
  ['A navigation errors but the page is there', 'The page is reported as open — Axon looked.', 'Nothing. This is the behaviour working.'],
  ['The page moved under a click', '"That changed. Which one do you mean?"', 'Answer the question; it continues the same task.'],
  ['Two things match', '"Which one do you mean — …?"', 'Answer it. "The first one." is enough.'],
  ['You deny an approval', '"OK, I won\'t."', 'Nothing ran. Say what you want instead.'],
  ['Nobody answers an approval', 'It expires into a denial.', 'Ask again if you meant it.'],
  ['You say "stop"', '"Stopped."', 'The dialog closes, the tool is aborted, the next request starts clean.'],
  ['A result arrives after "stop"', 'Silence. A cancelled task does not speak.', 'Nothing.'],
  ['The model asks for a tool Axon does not have', 'It is told there is no such tool.', 'Nothing. It shows up in `npm run attacks`.'],
  ['An internal fault in an executor', '"Something went wrong inside Axon while doing that."', 'Carry on. The full error is in the event log.'],
  ['An app never shows a window', '"Calculator didn\'t open."', 'Axon never claims an app is open without seeing it.'],
  ['The wifi blips', 'Nothing — it reconnects and resumes the same conversation.', 'Keep going.'],
  ['The voice service is unreachable', 'The orb turns red: "Axon could not reach the voice provider."', 'Activate again; a new session clears the error.'],
];

const PREFLIGHT: readonly (readonly [string, string])[] = [
  ['AssemblyAI key', 'The runtime reports a provider. The key itself is never printed.'],
  ['AssemblyAI reachable', 'A TCP connect to the provider host. Proves the network lets Axon out — not that the key is accepted.'],
  ['Microphone', 'The Windows permission. The device itself is opened by the window.'],
  ['Audio output', 'The speech engine is available.'],
  ['Wake word', 'The local recognizer starts and stops.'],
  ['Renderer', 'Always "not established here" — the preflight has no window. The app proves it at startup.'],
  ['Main process', 'Electron is ready.'],
  ['Tool registry', 'Tools are registered.'],
  ['Policy', 'Asked a real question: does submitting text need a human? It must say yes.'],
  ['Browser', 'The browser window is available.'],
  ['Desktop accessibility', 'Runs `window.list` — the one probe that executes a tool, because it is the only way to know UI Automation answers.'],
  ['Task ledger', 'Answers about a task that does not exist without inventing one.'],
  ['Approval system', 'Refuses a decision for an approval nobody asked for.'],
];

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
  ];
}

export function renderDemoDocument(): string {
  const lines: string[] = [
    '<!-- GENERATED from apps/desktop/tests/support/canonical-demo.ts. Edit that file, then run `npm run demo:doc`. -->',
    '',
    '# The Axon demo',
    '',
    'Two to five minutes, three acts, one story: **voice → reasoning → action → verification → safety.**',
    '',
    'The script below is not a suggestion. It is executed against the real orchestrator, tool bridge,',
    'dispatcher, policy and approval broker on every test run (`npm run rehearse` prints the record), so if',
    'this document says a beat works, the suite has just proved it.',
    '',
    '## Before you walk on',
    '',
    '```bash',
    'npm run preflight',
    '```',
    '',
    'You want `READY FOR DEMO`. One line will always say *not established here* — the renderer — because the',
    'preflight has no window. Anything marked ✗ is a real problem; fix it before you start.',
    '',
    ...table(['Check', 'What it actually establishes'], PREFLIGHT),
    '',
    'Then, optionally:',
    '',
    '```bash',
    'npm run rehearse',
    '```',
    '',
    '```bash',
    'npm run attacks',
    '```',
    '',
    'The first prints the whole demo as a record; the second prints the attack table to put on a second screen.',
    '',
    '## The script',
    '',
  ];

  for (const { act, beats } of demoActs()) {
    lines.push(`### Act ${act}`, '');
    for (const beat of beats) {
      lines.push(`**You say:** *"${beat.say}"*`, '');
      lines.push(`- **Shows:** ${beat.demonstrates}`);
      lines.push(`- **You hear:** ${beat.presenterHears}`);
      lines.push(`- **Orb:** \`${beat.orb}\``);
      lines.push(`- **Approval dialog:** ${beat.approval === 'appears' ? '**yes**' : 'no'}`);
      if (beat.steps.length > 0) {
        lines.push(`- **Axon does:** ${beat.steps.map((step) => `\`${step.tool}\``).join(' → ')}`);
      }
      if (beat.noTools) lines.push(`- **Note:** ${beat.noTools}`);
      for (const step of beat.steps) {
        if (step.note) lines.push(`  - \`${step.tool}\` — ${step.note}`);
      }
      lines.push('');
    }
  }

  const approvals = CANONICAL_DEMO.filter((beat) => beat.approval === 'appears');
  lines.push(
    '## The approval moments',
    '',
    `There are exactly **${approvals.length}**, and the suite fails if that changes:`,
    '',
    ...approvals.map((beat, index) => `${index + 1}. *"${beat.say}"* — ${beat.demonstrates}`),
    '',
    'Each dialog says **what** Axon wants to do and **where** — *"Axon wants to click "Submit application" on',
    'careers.example.com"* — and the voice agent is handed that same sentence, so what you hear and what you read',
    'cannot disagree. Typed text is shown in the dialog in full and never spoken.',
    '',
    'Nothing is auto-approved for the demo. There is no demo mode. **Deny the submit on stage**: the nothing that',
    'happens is the product.',
    '',
    'Filling in ordinary fields does *not* ask — it is visible on screen and sends nothing. The password field is',
    'not asked about either: it is refused outright.',
    '',
    '## If something goes wrong',
    '',
    'The rule is: **never get stuck.** `failure-recovery.test.ts` breaks each of these and then requires the next',
    'ordinary request to work; the detailed behaviour of each lives in the suites that file names.',
    '',
    ...table(['What happened', 'What you should hear (roughly)', 'What you do'], RECOVERY),
    '',
    'No message the model receives contains a stack trace, a file path, or a raw JavaScript error.',
    '',
    '## The wake word — a manual check',
    '',
    'The automated live test feeds *synthesised* speech to the Windows recognizer, and that recognizer does not',
    'reliably finalise a synthesised phrase. Measured: it hears synthesised "Hey Axon" as "A Exxon". The name half',
    'is accepted; the greeting half deliberately is not — accepting "a" as a greeting would make the most common',
    'word in English half of the wake phrase, and a wake word that fires by accident uploads a room. So that test',
    'step fails, has failed identically in every run, and is **not** papered over. A person checks the microphone:',
    '',
    '1. Start Axon (`npm run dev`). The orb is idle.',
    '2. From about a metre away, at a normal speaking volume, say **"Hey Axon."** — the orb should open within about a second.',
    '3. Close the session. Say **"Hello Axon."** — same result.',
    '4. Close the session. Say **"Hi Axon."** — same result.',
    '5. Say something that is *not* the phrase — "Hey Alex", "Axolotl". Nothing should happen.',
    '6. Repeat 2–4 with the venue\'s background noise if you can get into the room beforehand.',
    '',
    'If the wake word will not fire in the room, **click the orb**. It is the same activation path with a',
    'different trigger, and the rest of the demo is identical.',
    '',
    '## Recording a demo',
    '',
    'For debugging afterwards, a development build records a structured timeline when asked to:',
    '',
    '```powershell',
    "$env:AXON_DEMO_RECORDING='1'; npm run dev",
    '```',
    '',
    'On quit, `demo-recording.jsonl` in the `logs` folder under `AXON_HOME` (by default `Axon` in your user folder) holds one row per step: time, task, step, tool, status,',
    'latency, policy, approval and verification. It never contains tool arguments, page text, typed values, keys,',
    'tokens or audio, and a goal that looks like a credential is dropped rather than written.',
    '',
    '## What is real, and what is not',
    '',
    '- **On stage, everything is real**: AssemblyAI, the model, the browser, the desktop.',
    '- **In `npm run rehearse`**, the orchestrator, bridge, dispatcher, policy, approvals, task ledger and tools are',
    '  the shipping code. The model is replaced by the script, and the sites by page models, so a rehearsal does not',
    '  depend on the venue\'s wifi. It proves the pipeline holds for this sequence; `npm run smoke:assemblyai` is',
    '  the evidence that the real model proposes it.',
    '',
  );

  return lines.join('\n');
}
