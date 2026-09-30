<!-- GENERATED from apps/desktop/tests/support/canonical-demo.ts. Edit that file, then run `npm run demo:doc`. -->

# The Axon demo

Two to five minutes, three acts, one story: **voice → reasoning → action → verification → safety.**

The script below is not a suggestion. It is executed against the real orchestrator, tool bridge,
dispatcher, policy and approval broker on every test run (`npm run rehearse` prints the record), so if
this document says a beat works, the suite has just proved it.

## Before you walk on

```bash
npm run preflight
```

You want `READY FOR DEMO`. One line will always say *not established here* — the renderer — because the
preflight has no window. Anything marked ✗ is a real problem; fix it before you start.

| Check | What it actually establishes |
|---|---|
| AssemblyAI key | The runtime reports a provider. The key itself is never printed. |
| AssemblyAI reachable | A TCP connect to the provider host. Proves the network lets Axon out — not that the key is accepted. |
| Microphone | The Windows permission. The device itself is opened by the window. |
| Audio output | The speech engine is available. |
| Wake word | The local recognizer starts and stops. |
| Renderer | Always "not established here" — the preflight has no window. The app proves it at startup. |
| Main process | Electron is ready. |
| Tool registry | Tools are registered. |
| Policy | Asked a real question: does submitting text need a human? It must say yes. |
| Browser | The browser window is available. |
| Desktop accessibility | Runs `window.list` — the one probe that executes a tool, because it is the only way to know UI Automation answers. |
| Task ledger | Answers about a task that does not exist without inventing one. |
| Approval system | Refuses a decision for an approval nobody asked for. |

Then, optionally:

```bash
npm run rehearse
```

```bash
npm run attacks
```

The first prints the whole demo as a record; the second prints the attack table to put on a second screen.

## The script

### Act I — voice and the web

**You say:** *"Hey Axon."*

- **Shows:** The name is heard locally. Nothing has been streamed anywhere yet.
- **You hear:** A tone, and the orb opens. Axon does not answer the wake word with words.
- **Orb:** `IDLE -> LISTENING`
- **Approval dialog:** no
- **Note:** Activation only. The microphone opens here and not before.

**You say:** *"Open YouTube."*

- **Shows:** One sentence in, one action out, and the answer waits for the page to actually be there.
- **You hear:** "YouTube is open." — or "Opening YouTube." first, if the network is slow.
- **Orb:** `LISTENING -> THINKING -> EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `browser.open`
  - `browser.open` — Verified by looking at the page afterwards.

**You say:** *"Search for AssemblyAI Voice Agent."*

- **Shows:** Submitting anything sends data to somebody else’s server, so it asks. Even a search.
- **You hear:** Something like "I need your OK to submit that search on YouTube." Allow it; the results follow.
- **Orb:** `EXECUTING -> WAITING_FOR_APPROVAL -> EXECUTING`
- **Approval dialog:** **yes**
- **Axon does:** `browser.type`
  - `browser.type` — The approval names the act and where it lands. LIVE, it appears only if the model submits the search form: opening a results address, or clicking the script-driven search icon on YouTube, is an ordinary page action and asks nothing. The approval that is guaranteed is the one on "Submit it."

**You say:** *"Open the first result."*

- **Shows:** Two results Axon cannot tell apart. It asks rather than picking one.
- **You hear:** "Which one do you mean — ..." — a question, in as few words as it takes.
- **Orb:** `EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `browser.read` → `browser.click`
  - `browser.read` — Read first: a click acts on what Axon has actually seen.
  - `browser.click` — The page moved underneath, so the reference re-resolves by identity and finds two matches.

**You say:** *"The first one."*

- **Shows:** An answer continues the task that asked the question — it does not start a new one.
- **You hear:** Axon carries on with what it was already doing.
- **Orb:** `LISTENING -> THINKING`
- **Approval dialog:** no
- **Axon does:** `browser.read` → `browser.click`
  - `browser.read` — A fresh reading, because the last one is what went stale.
  - `browser.click` — Now unambiguous: the reference was taken from a reading nothing has moved since.

### Act II — the desktop

**You say:** *"Open Calculator."*

- **Shows:** A real application, launched from a fixed registry of applications, and then verified.
- **You hear:** "Calculator is open." — one sentence, because it is fast.
- **Orb:** `THINKING -> EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `app.open`
  - `app.open` — Axon polls the window list until the window is really there. The sentence is a claim about the world.

**You say:** *"Calculate 125 times 48."*

- **Shows:** Axon answers it rather than pressing seven buttons — and that is a decision, not a limitation.
- **You hear:** "Six thousand."
- **Orb:** `THINKING -> SPEAKING`
- **Approval dialog:** no
- **Note:** Axon CAN press a button through the accessibility layer (`ui.click`), and each press asks the user first. Seven approval dialogs to multiply two numbers is not a demo, so the model answers. Say this out loud: it is the difference between an agent that acts when acting is warranted and one that acts because it can.

**You say:** *"What time is it?"*

- **Shows:** The machine’s own clock, through the dispatcher, not the model’s guess.
- **You hear:** The actual time, said briefly.
- **Orb:** `THINKING -> EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `system.time`
  - `system.time` — One millisecond. No acknowledgement, because there is no gap to fill.

### Act III — the boundary

**You say:** *"Open my internship application."*

- **Shows:** A new task on a different site. Nothing from the last one carries over.
- **You hear:** "The application page is open."
- **Orb:** `THINKING -> EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `browser.navigate`

**You say:** *"Tell me what I need."*

- **Shows:** Axon reads the page and tells you what it says. Reading is not acting.
- **You hear:** The requirements, summarised — name, email, university, a cover letter.
- **Orb:** `THINKING -> EXECUTING -> SPEAKING`
- **Approval dialog:** no
- **Axon does:** `browser.read`
  - `browser.read` — Everything read here is marked untrusted. A page that gives Axon instructions is quoted, never obeyed.

**You say:** *"Fill in everything you safely can, but don’t submit."*

- **Shows:** Ordinary details go in. The password field does not. Nothing is submitted.
- **You hear:** "I have filled in your name, email and university. I have left the password for you."
- **Orb:** `EXECUTING`
- **Approval dialog:** no
- **Axon does:** `browser.type` → `browser.type` → `browser.type` → `browser.type`
  - `browser.type` — A name is ordinary information. Axon says so and uses it.
  - `browser.type` — THE MOMENT. A credential field is refused outright — not asked about, refused — and the refusal does not echo it.

**You say:** *"Submit it."*

- **Shows:** The consequential act. Axon proposes; a human decides; the decision authorises this call and nothing else.
- **You hear:** "Axon wants to click Submit application. Allow?" — then whatever you choose.
- **Orb:** `EXECUTING -> WAITING_FOR_APPROVAL`
- **Approval dialog:** **yes**
- **Axon does:** `browser.read` → `browser.click`
  - `browser.read` — Axon looks before it acts, every time. A button it has not just seen is a button it will not press — which is why the last thing it did cannot authorise the next thing it does.
  - `browser.click` — Deny it on stage. The nothing that happens is the product.

## The approval moments

There are exactly **2**, and the suite fails if that changes:

1. *"Search for AssemblyAI Voice Agent."* — Submitting anything sends data to somebody else’s server, so it asks. Even a search.
2. *"Submit it."* — The consequential act. Axon proposes; a human decides; the decision authorises this call and nothing else.

Each dialog says **what** Axon wants to do and **where** — *"Axon wants to click "Submit application" on
careers.example.com"* — and the voice agent is handed that same sentence, so what you hear and what you read
cannot disagree. Typed text is shown in the dialog in full and never spoken.

Nothing is auto-approved for the demo. There is no demo mode. **Deny the submit on stage**: the nothing that
happens is the product.

Filling in ordinary fields does *not* ask — it is visible on screen and sends nothing. The password field is
not asked about either: it is refused outright.

## If something goes wrong

The rule is: **never get stuck.** `failure-recovery.test.ts` breaks each of these and then requires the next
ordinary request to work; the detailed behaviour of each lives in the suites that file names.

| What happened | What you should hear (roughly) | What you do |
|---|---|---|
| A page will not load | "YouTube didn't load, so I stopped." | Say the next thing. Axon is already listening. |
| A navigation errors but the page is there | The page is reported as open — Axon looked. | Nothing. This is the behaviour working. |
| The page moved under a click | "That changed. Which one do you mean?" | Answer the question; it continues the same task. |
| Two things match | "Which one do you mean — …?" | Answer it. "The first one." is enough. |
| You deny an approval | "OK, I won't." | Nothing ran. Say what you want instead. |
| Nobody answers an approval | It expires into a denial. | Ask again if you meant it. |
| You say "stop" | "Stopped." | The dialog closes, the tool is aborted, the next request starts clean. |
| A result arrives after "stop" | Silence. A cancelled task does not speak. | Nothing. |
| The model asks for a tool Axon does not have | It is told there is no such tool. | Nothing. It shows up in `npm run attacks`. |
| An internal fault in an executor | "Something went wrong inside Axon while doing that." | Carry on. The full error is in the event log. |
| An app never shows a window | "Calculator didn't open." | Axon never claims an app is open without seeing it. |
| The wifi blips | Nothing — it reconnects and resumes the same conversation. | Keep going. |
| The voice service is unreachable | The orb turns red: "Axon could not reach the voice provider." | Activate again; a new session clears the error. |

No message the model receives contains a stack trace, a file path, or a raw JavaScript error.

## The wake word — a manual check

The automated live test feeds *synthesised* speech to the Windows recognizer, and that recognizer does not
reliably finalise a synthesised phrase. Measured: it hears synthesised "Hey Axon" as "A Exxon". The name half
is accepted; the greeting half deliberately is not — accepting "a" as a greeting would make the most common
word in English half of the wake phrase, and a wake word that fires by accident uploads a room. So that test
step fails, has failed identically in every run, and is **not** papered over. A person checks the microphone:

1. Start Axon (`npm run dev`). The orb is idle.
2. From about a metre away, at a normal speaking volume, say **"Hey Axon."** — the orb should open within about a second.
3. Close the session. Say **"Hello Axon."** — same result.
4. Close the session. Say **"Hi Axon."** — same result.
5. Say something that is *not* the phrase — "Hey Alex", "Axolotl". Nothing should happen.
6. Repeat 2–4 with the venue's background noise if you can get into the room beforehand.

If the wake word will not fire in the room, **click the orb**. It is the same activation path with a
different trigger, and the rest of the demo is identical.

## Recording a demo

For debugging afterwards, a development build records a structured timeline when asked to:

```powershell
$env:AXON_DEMO_RECORDING='1'; npm run dev
```

On quit, `demo-recording.jsonl` in the `logs` folder under `AXON_HOME` (by default `Axon` in your user folder) holds one row per step: time, task, step, tool, status,
latency, policy, approval and verification. It never contains tool arguments, page text, typed values, keys,
tokens or audio, and a goal that looks like a credential is dropped rather than written.

## What is real, and what is not

- **On stage, everything is real**: AssemblyAI, the model, the browser, the desktop.
- **In `npm run rehearse`**, the orchestrator, bridge, dispatcher, policy, approvals, task ledger and tools are
  the shipping code. The model is replaced by the script, and the sites by page models, so a rehearsal does not
  depend on the venue's wifi. It proves the pipeline holds for this sequence; `npm run smoke:assemblyai` is
  the evidence that the real model proposes it.
