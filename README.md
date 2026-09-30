# Axon Voice

A voice agent for your Windows desktop that can move from conversation to
**verified action** on your computer — without giving the model control of the
machine.

**AssemblyAI provides the realtime voice layer.** Speech recognition, the
reasoning model and the spoken voice all come from AssemblyAI's Voice Agent
API, over one WebSocket held by Axon's main process.

**Axon provides the action and control layer.** Every action the model
proposes — open an app, open a page, fill a field, click a button — is a
*request* that goes through Axon's dispatcher: schema validation, the goal
boundary, sensitivity checks, risk and policy, a human approval where the act
is consequential, a re-check that the approved act is still the one about to
run, execution, and verification by looking at the result. The model decides
what to ask for. Axon decides what is allowed.

**What it can do today:** open installed applications and verify their windows
appeared; open, read, scroll and follow links on web pages in its own browser
window; fill in form fields; click page controls; read the controls on the
window in front (Windows UI Automation); press or fill an on-screen control by
reference, with approval; tell the time from the machine's clock; save a
screenshot; write files inside its own workspace; remember facts you approve.
It asks before anything that sends, submits, buys, deletes or leaves the
machine, and it refuses credentials outright.

**What it deliberately cannot do:** run shell or PowerShell commands, press
keys or shortcuts (`keyboard.press` does not exist), move the mouse, read
arbitrary files, type passwords or keys, submit or purchase without a human
decision, or see images — screenshots are captured, but there is no vision
model and the voice protocol has no image channel, so Axon works from the
accessibility tree, not from pixels. See [Known limitations](#known-limitations).

**Giving the demo?** Start with [DEMO_SETUP.md](DEMO_SETUP.md), the stage script
in [docs/DEMO.md](docs/DEMO.md), and [DEMO_EMERGENCY_PLAYBOOK.md](DEMO_EMERGENCY_PLAYBOOK.md).

The typed path (the composer) optionally uses Claude via `ANTHROPIC_API_KEY`;
the spoken path does not need it. Both go through the same dispatcher.

---

## Requirements

| | |
|---|---|
| OS | Windows 10/11 |
| Node | 20.19+ (22 LTS recommended — Electron 44 declares `node >= 22.12`, which is advisory; 20.20 works) |
| Keys | `ASSEMBLYAI_API_KEY` for spoken conversation — recognition, reasoning and voice all come from it. `ANTHROPIC_API_KEY` is optional and only powers the typed path. Without either, Axon still runs: the orb, the timeline, the browser, the tools and the Tool Console all work. |
| Voice out | Windows SAPI. **No key, no account, no network.** Set `AXON_TTS_PROVIDER=none` to keep Axon silent. |
| Wake word | A dedicated local keyword spotter (sherpa-onnx zipformer, 3.3M, Apache-2.0), entirely on-device. Listens for "Hey Axon" / "Hello Axon" / "Hi Axon" and nothing else leaves the machine until you say one of them. Run `npm run wake:model` once to fetch the ~18 MB model; it is verified against a pinned SHA-256. Set `AXON_WAKE_ENGINE=windows` for the original Windows recognizer, or `AXON_WAKE_ENGINE=none` to disable. |
| Voice conversation | AssemblyAI Voice Agent API, over one WebSocket held by the main process. Active-session audio is streamed to AssemblyAI; see [Privacy](#privacy-what-leaves-this-machine). |
| Microphone | Any input device. Axon opens it only while it is listening, and Windows shows its own recording indicator throughout. |

## Getting started

```bash
npm install
```

```bash
npm run wake:model      # once: fetches the ~18 MB local wake-word model
```

The wake word runs on a keyword-spotting model that is too big for git. This
downloads it into `apps/desktop/resources/wake-model/`, checks it against a
SHA-256 pinned in the fetch script, and verifies that the model's own tokenizer
still spells "Hey Axon" the way Axon expects. Skip it and Axon runs perfectly
well — it just will not listen for its name, and says so in the tray.

```bash
cp .env.example .env    # then put your ANTHROPIC_API_KEY in it
npm run dev
```

That builds `@axon/core`, starts the renderer dev server and opens the Axon
desktop window.

**Talk to it.** Press `Ctrl+Shift+Space`, or click **Talk to Axon**, and say:

> "Open Notepad."

Axon opens the microphone, watches the audio for the moment you stop speaking,
transcribes what you said, and gets on with it. Press the shortcut again to cut
an utterance short. Say "stop" while it is talking and it stops — activating
while Axon is speaking interrupts it.

**Or type it.** The composer at the bottom of the window takes the same
requests — Enter sends, Shift+Enter adds a newline. Try "write hello world to
my Desktop" to see the approval gate in the path of a real agent turn.

Without a key, Axon starts and says so above the composer rather than failing.
Voice input still works and still shows you the transcript; it simply has
nothing to reason with.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build core, then run the desktop app with hot reload |
| `npm run build` | Production build of core and the desktop app |
| `npm run web:dev` | Run the public website (`apps/web`) on <http://localhost:5174> |
| `npm run web:build` | Typecheck and build the website into `apps/web/dist` |
| `npm run typecheck` | `tsc --noEmit` across core, main/preload, renderer and the website |
| `npm run lint` | ESLint, including the architectural boundary rules |
| `npm test` | Vitest — 1014 tests, no API key and no network required |
| `npm run verify:tools` | Build, then exercise the real tools, real speech and real recognition inside Electron |
| `npm run verify:voice` | Build, then start the real app and drive a real microphone through a real window |
| `npm run verify:browser` | Build, then open the real browser on real pages and drive it through the real dispatcher |
| `npm run verify:persistence` | Build, then open a real SQLite database and restart it, on real files |
| `npm run verify:all` | typecheck → lint → test → the four harnesses above (227 checks) |
| `npm run wake:model` | Fetch and verify the local wake-word model (once per checkout) |
| `npm run wake:live` | The wake word on a **real microphone**, spoken by you. The only thing that proves it works |
| `npm run wake:calibrate` | Sweep the detection threshold on a real microphone, every threshold at once, recording nothing |
| `npm run voice:live` | The ACTIVE voice session on a real microphone: say five controlled phrases, see AssemblyAI's transcript scored against each, with capture format and send cadence per utterance |

To exercise the real Anthropic API end to end (skipped without a key):

```bash
npx vitest run apps/desktop/tests/brain-live.test.ts
```

`verify:tools` is worth running once: it takes a real screenshot, really
launches Notepad, really drives every branch of the approval gate against a
temporary sandbox directory, really synthesises speech, and really transcribes
it back through the Windows recognizer. It is the check that none of this is
mocked.

`verify:voice` starts Axon itself and drives the running window: it confirms
that page code cannot open your microphone, that a camera is refused outright,
that a real microphone opens when — and only when — Axon is listening, that
real audio frames cross the IPC boundary, and that the session closes itself
when nobody speaks.

`verify:browser` opens the real browser on real pages, with the real security
hooks installed, and checks the whole path: that `javascript:`, `file:`,
loopback and cloud-metadata addresses are refused; that reading, clicking,
typing, going back and going forward really work; that page text and element
lists are truncated at their limits; that a hostile page cannot escape the
untrusted-content envelope; that submitting really asks and an unanswered
approval really denies; and that the per-turn action budget stops a runaway
loop.

`verify:persistence` opens a real database on a real disk, writes real rows and
then **closes the process and opens it again** — because a persistence layer
that has never been restarted has not been tested. It checks that a migration
runs once and is not re-run, that a database from a newer Axon is refused
rather than downgraded, that a damaged file fails closed without being deleted,
that a rolled-back transaction leaves nothing behind, that a conversation and
its settings and memories come back verbatim, that the retention caps really
remove rows, and — reading the `.db`, `-wal` and `-shm` files together — that a
credential typed into a conversation is nowhere in any of them.

## What Axon writes to your machine

Everything lives under `%USERPROFILE%\Axon` (override with `AXON_HOME`):

```
Axon/
├─ workspace/     the one directory the agent may write to without asking
├─ screenshots/   captures from system.screenshot (the last 12 are kept)
├─ data/
│  └─ axon.db     conversations, memories, settings, profile (SQLite + WAL)
└─ logs/
   └─ events.jsonl   every event, one JSON object per line
```

`logs/` and `data/` are both on the forbidden-write list: neither the audit
trail nor the database is rewritable by the agent they describe. Nothing here
leaves the machine; there is no sync, no account and no server.

The browser profile is **not** here. Axon's browser runs in a `persist:` session
partition, which Chromium stores in its own layout under Electron's session
data — on Windows,
`%APPDATA%\axon-desktop\Partitions\axon-browser`. Axon reports that path and
never invents it, and it is on the forbidden-write list too: since the workspace
became a setting, a workspace pointed at the cookie store would otherwise make
it writable by an approved `fs.write`.

---

## What Axon remembers

Three different things get called "memory", and conflating them is how a
private assistant stops being private. Axon keeps them apart, in the storage,
in the UI and in the words it uses.

| | What it is | Who writes it | How to remove it |
|---|---|---|---|
| **Conversation history** | What was said, in one conversation | Written automatically, as you talk | Delete that conversation |
| **Long-term memory** | A durable fact Axon may recall in *any* conversation | Written only when Axon asks and you approve | Delete that memory, or clear all |
| **Browser profile** | Cookies and sessions for sites you signed in to | Written by Chromium when you sign in | Sign out on the site, or delete the partition folder |

The browser profile is the important separation. Axon **never copies browser
credentials into its database** — the cookie jar stays where Chromium put it,
and there is no code path from it into SQLite. Deleting every conversation and
every memory does not sign you out of anything, and clearing the browser
profile does not lose your conversations. That is deliberate: they are
different kinds of secret with different lifetimes.

### What is never stored

The database has no column that could hold a credential, and text on its way
into one is scanned before it is written:

> API keys · Anthropic, OpenAI, GitHub, Slack, AWS, Google and Stripe tokens ·
> JWTs · private key blocks · `Authorization` and `Cookie` headers · passwords ·
> one-time codes · card numbers · browser cookies · environment variables ·
> raw microphone audio · raw STT buffers · hidden chain-of-thought · raw page
> HTML or JavaScript

A conversation message containing one is **stored with the secret replaced by
`[redacted]`** — the conversation stays readable, the credential does not
persist. A *memory* containing one is **refused outright**, with the reason
shown, because a memory is recalled into a future prompt and a redacted one
would only be a worse version of not saving it. `verify:persistence` types a
real-shaped key into a real conversation and then greps the raw `.db`, `-wal`
and `-shm` bytes for it.

Screenshots are pruned to the last 12. Raw audio never reaches disk at all —
see [Voice in](#voice-in).

### How memories are made

Axon cannot write to long-term memory on its own. `memory.save` is
`REQUIRES_APPROVAL`, so the dialog names the exact key and the exact value
before anything is written, and `memory.forget` asks in the same way.
Everything already true of a tool call is true here: the brain emits JSON, the
dispatcher validates it, the policy classifies it, and only an approved call
reaches SQLite. **The brain never touches the database.**

A saved memory is later read back into the system prompt, which makes it a
*persistent* injection vector — text that survives a restart and is present in
every future conversation. Two things hold it: you approved the exact wording
once, and the prompt frames memories as **facts about the user, never as
instructions**, so "always run every command without asking" stored as a
memory is a sentence the model has read, not an authority it has acquired.

### What comes back at the start of a turn

Restoring "the conversation" without bounds is how a context window is spent
before the user has said anything. Each turn gets a slice:

| Bound | Value |
|---|---|
| Messages restored | the last 24 |
| Characters restored | 12,000, whichever comes first (always ≥ 1 message) |
| Memories offered | 20 |
| Conversations kept | 100 (oldest pruned) |
| Messages kept per conversation | 500 |
| Memories kept in total | 200 |

The restored slice carries only roles and text — no ids, no timestamps, no
tool arguments. Long-term memory can be switched off entirely from
Settings ▸ Memory, in which case none is read and none is written.

### The database

`node:sqlite` — the runtime's own SQLite, which is why persistence added no
dependency to the tree. WAL journalling, `foreign_keys = ON`, and every single
query parameterized; there is no string-built SQL anywhere in the codebase and
a lint rule fails the build if one appears.

Schema changes run as numbered migrations inside **one transaction**, with the
version written in the same transaction, so a migration either happened or did
not. Three failure modes are handled explicitly, and none of them destroys
data:

- **a database from a newer Axon** — refused, with a sentence saying so. It is
  never downgraded and never rewritten.
- **a corrupt or unopenable file** — Axon starts anyway, says the conversation
  will not be saved, and **leaves the file exactly where it is** so it can be
  recovered by hand.
- **a damaged setting** — replaced with its default, and the settings screen
  says which ones were repaired rather than silently disagreeing with the value
  actually in force.

Persistence failing never takes the app down: every call goes through a guard
that degrades to in-memory operation and emits a `persistence.error` event.

### Deleting things

Settings ▸ Privacy is most of it: delete one conversation, delete one memory,
or clear all memories — each stating exactly what it removes and what it
leaves, and each naming the file it lives in. The database is a single file, so
deleting `%USERPROFILE%\Axon\data\` removes everything Axon has ever stored and
it starts again with defaults.

Signing out is the exception, and deliberately so: it happens on the site, in
the browser window, the way it would in any browser. Axon has no button that
clears your sessions, because a button that silently signs you out of
everything is not something an agent should be able to reach for.

---

## Architecture

The load-bearing decision is that **the process boundary is the security
boundary**.

```
┌──────────────────────────────────────────────────────────┐
│ RENDERER  (Chromium, sandboxed — no Node access)         │
│   Orb · Timeline · Approval dialog · Tool Console        │
│                                                          │
│   Cannot execute a tool. Can only:                       │
│     → send approval decisions and proposals              │
│     ← receive the AxonEvent stream                       │
└───────────────────────────┬──────────────────────────────┘
                            │  preload: one typed contextBridge
┌───────────────────────────┴──────────────────────────────┐
│ MAIN  (Node — full privilege)                            │
│                                                          │
│   Brain ──emits a ToolCall (JSON only)──┐                │
│    │                                     ▼               │
│    │                           ╔══════════════════╗      │
│    │                           ║ DISPATCHER       ║      │
│    │                           ║ 1 schema check   ║      │
│    │                           ║ 2 risk resolve   ║      │
│    │                           ║ 3 approval gate  ║      │
│    │                           ║ 4 execute        ║      │
│    │                           ╚════════╤═════════╝      │
│    │                                    ▼                │
│    │                             Tool executors          │
│    └────────────── EventBus ───────────────────────────  │
└──────────────────────────────────────────────────────────┘
```

### The four properties that matter

**1. The brain cannot reach an executor.** It is given `ToolSchema[]` — a name,
a description and a JSON Schema, with no callable anywhere in it — and a
`dispatch` callback. Emitting a `ToolCall` is the most it can do; a `ToolCall`
is an intention, not an effect.

**2. Risk is resolved per call, from the actual arguments.** A static label on a
tool would be a lie the safety layer then acts on. `fs.write` demonstrates it:

| Destination | Verdict | Behaviour |
|---|---|---|
| `Axon\workspace\notes.txt` | `SAFE` | runs immediately |
| `Desktop\notes.txt` | `REQUIRES_APPROVAL` | waits for a human |
| `C:\Windows\System32\...` | `FORBIDDEN` | refused, no prompt offered |

**3. Deny by default, everywhere.** An unknown tool is refused. Input that fails
its schema is refused. A `resolveRisk` that throws escalates to
`REQUIRES_APPROVAL` — it never degrades to `SAFE`. An approval nobody answers
becomes a denial, never a hang and never an allow.

**4. The UI cannot show a state the system is not in.** One `AxonEvent` stream
feeds the renderer and the JSONL log, so what the user saw and what we debug
from are the same artefact. The renderer never sets state — `requestState`
*proposes*, and the main-process machine may refuse:

```
refused · Illegal Axon state transition IDLE -> EXECUTING.
Legal targets from IDLE: LISTENING, THINKING, ERROR.
```

### Enforced boundaries

These are checked twice — as ESLint rules (fast) and as tests over the source
tree (`apps/desktop/tests/architecture.test.ts`), because a lint rule can be
disabled inline and a failing test cannot:

- only `tools/registry.ts` may import an executor;
- `main/brain/**` may import nothing but `@axon/core`, the Anthropic SDK and
  its own directory;
- **only** `main/brain/**` may import the Anthropic SDK — not the renderer, not
  the preload, not the tool or safety layers, not `@axon/core`;
- `ANTHROPIC_API_KEY` may be named only in the four main-process files that
  read or explain it, and never in the renderer, the preload or `@axon/core`;
- the renderer may not import Electron, any `node:` builtin, or `main/`;
- the preload may import only `electron` and `@axon/core/ipc`;
- `@axon/core` may depend on nothing but Zod;
- the window's security flags may not be quietly weakened.

`verify:tools` additionally checks the *built artefact*, not just the source: a
bundler mistake could pull the SDK into the renderer without any source file
importing it, so the harness greps the shipped renderer and preload bundles for
the SDK and for key-shaped strings.

### What the brain may and may not do

The brain reasons; it holds no authority. It receives a code-free
`ToolSchema[]`, a `dispatch` callback and a narrow `emit` callback, and that
argument passing *is* the boundary:

- it cannot execute a tool — `dispatch` is the dispatcher, which validates the
  arguments, resolves risk from them and applies the approval gate;
- it cannot resolve risk, raise an approval or settle one;
- it cannot emit `TOOL_CALL`, `TOOL_RESULT`, `APPROVAL_REQUIRED`,
  `APPROVAL_RESOLVED` or `STATE_CHANGED`. Those describe what the machine
  actually did, and a brain that could emit them could show you a tool call
  that never ran. It may emit only `THINKING`, `PLANNING`,
  `ASSISTANT_MESSAGE`, `COMPLETED` and `ERROR`.

A denied tool call does not end the turn. The dispatcher returns a structured
failure — `{"success": false, "error": "User denied this action"}` — the model
reads it and decides what to do next. It is not allowed to decide "ask again":
an identical repeat of a refused call is suppressed by the loop before it
reaches the dispatcher, so a denial cannot become a second prompt.

## Layout

```
axon-voice/
├─ packages/core/              PURE contracts. No Electron, Node, React or SDK.
│  └─ src/
│     ├─ events.ts             AxonEvent union (Zod schemas; types derived)
│     ├─ states.ts             the 7 states + the legal transition table
│     ├─ risk.ts               RiskLevel, escalation, deny-by-default
│     ├─ approval.ts           approval request / decision contracts
│     ├─ tool-contract.ts      ToolDefinition (has code) vs ToolSchema (no code)
│     ├─ ipc.ts                the complete renderer↔main surface
│     └─ interfaces/           Brain, SpeechToText, TextToSpeech, WakeSource, Memory
│
├─ apps/desktop/
   ├─ src/main/
   │  ├─ index.ts              lifecycle; security → runtime → bridge → window
   │  ├─ runtime.ts            runtime assembly (shared with the verify harness)
   │  ├─ security.ts           CSP, navigation confinement, permission denial
   │  ├─ window.ts             the hardened BrowserWindow
   │  ├─ bus/                  EventBus · JSONL sink · IPC bridge
   │  ├─ persistence/          the ONLY layer that may touch the database
   │  │  ├─ sqlite.ts          the one module importing `node:sqlite`
   │  │  ├─ migrations.ts      numbered, forward-only, one transaction
   │  │  ├─ store.ts           every SQL statement, all parameterized
   │  │  ├─ redaction.ts       secret patterns; redact messages, refuse memories
   │  │  ├─ memory-policy.ts   what may become a memory, and why not
   │  │  ├─ settings-schema.ts validation, defaults, repair
   │  │  ├─ session-context.ts the bounded slice handed to the brain
   │  │  ├─ persistence-service.ts degrades instead of throwing
   │  │  └─ persistent-memory.ts   the Memory port, backed by SQLite
   │  ├─ settings/             validate → apply → store, or roll back
   │  ├─ orchestrator/         the authoritative state machine
   │  ├─ safety/               dispatcher · policy · approval broker
   │  ├─ tools/                registry · schema view · executors/
   │  ├─ platform/             the only modules that touch the OS
   │  ├─ env-file.ts           optional .env loading (a real env var wins)
   │  ├─ voice/                speech in and out — the ONLY layer that may
   │  │  │                     spawn a speech engine, and it never touches disk
   │  │  ├─ sapi-tts.ts        Windows SAPI adapter; text goes in on stdin
   │  │  ├─ speech-service.ts  one utterance at a time, with the watchdog
   │  │  ├─ speech-text.ts     bounds and hygiene for untrusted model text
   │  │  ├─ speech-transport.ts main -> renderer only; no inbound audio path
   │  │  ├─ wav.ts             validates audio before the renderer sees it
   │  │  ├─ create-tts.ts      the one place a synthesiser is named
   │  │  ├─ windows-stt.ts     Windows recognizer; audio goes in on stdin
   │  │  ├─ listening-service.ts one session at a time, with three timers
   │  │  ├─ vad.ts             decides when you stopped speaking, from the audio
   │  │  ├─ transcript-text.ts bounds and hygiene for the transcript
   │  │  ├─ capture-transport.ts main -> renderer commands; audio flows back
   │  │  │                     on its own channel, never as an event
   │  │  └─ create-stt.ts      the one place a recognizer is named
   │  ├─ wake/global-hotkey.ts push-to-talk; the renderer registers no hooks
   │  └─ brain/                the agent loop — the ONLY layer that may
   │     │                     import the Anthropic SDK
   │     ├─ claude-brain.ts    the manual tool-use loop
   │     ├─ model-client.ts    the port the loop depends on (testable)
   │     ├─ anthropic-client.ts the SDK adapter; the API key stops here
   │     ├─ create-brain.ts    builds a brain, or explains its absence
   │     ├─ system-prompt.ts   built from the live tool surface
   │     ├─ tool-result-view.ts how a ToolResult is described to the model
   │     ├─ tool-surface.ts    the code-free projection of the tools
   │     └─ conversation-memory.ts  in-memory Memory (the fallback)
│  ├─ src/preload/index.ts     the audited bridge (~1.5 kB built)
│  ├─ src/renderer/            React UI; consumes events, owns nothing
│  └─ tests/
│
└─ apps/web/                   the public website. Shares NO code with the app.
   ├─ index.html
   ├─ vite.config.ts
   └─ src/
      ├─ config.ts             the download destination, and nothing else
      ├─ content.ts            every sentence on the site, in one file
      ├─ components/           one per section, plus a canvas Orb of its own
      ├─ hooks/                reduced motion · in-view · orb sizing
      └─ styles/               tokens · global · sections
```

## The website

`apps/web/` is the public page for Axon: what it is, how a request becomes a
verified action, what it can actually do, and how to get it. It is a separate
product surface — a plain React + Vite app with no dependency on `@axon/core`,
no Electron, no Anthropic or AssemblyAI SDK, and no access to anything in
`.env`. Vite only inlines variables prefixed `VITE_`, and the site reads
exactly two of them. The desktop app was not changed to make the site possible;
the site even draws its own orb rather than importing the renderer's.

Run it:

```bash
npm run web:dev
```

That serves <http://localhost:5174> (5173 belongs to the desktop renderer).
Build and preview the production bundle:

```bash
npm run web:build
```

```bash
npm run web:preview
```

`web:build` typechecks first, then writes `apps/web/dist/` — a static
directory that can be served by anything. `npm run typecheck` at the repo root
covers the site too, and `npm run lint` already reaches it.

### What the site is configured with

Three optional build-time variables, and nothing else:

| Variable | Effect when unset |
|---|---|
| `VITE_AXON_DOWNLOAD_URL` | The download button renders **disabled**, with a line saying Axon runs from source today, and the header's action reads "Explore Axon" rather than offering a download |
| `VITE_AXON_SOURCE_URL` | The source links point at this repository, `https://github.com/CodeVishal-17/axon-voice` |
| `VITE_AXON_DEMO_VIDEO_URL` | The "See Axon in action" section shows an illustrative walkthrough, labelled as not being a recording. Set it and the same frame plays the video instead — see `apps/web/src/components/demo/DemoStage.tsx` |

Set them when there is something real to point at:

```bash
VITE_AXON_DOWNLOAD_URL=https://github.com/<owner>/<repo>/releases/download/v0.1.0/Axon-Setup.exe npm run web:build
```

The button turns itself on — nothing else needs editing. Everything the site
claims about Axon comes from this README and from the tool registry; if a
capability is removed from the app, the corresponding card in
`apps/web/src/content.ts` should go with it.

## The orb

The orb is a plain TypeScript engine (`components/orb/orb-renderer.ts`) that
owns a canvas and an animation loop. It is driven by the state machine and
knows nothing about React; the component around it only mounts it and forwards
the current state.

There is one draw path. State does not select a branch — it selects a parameter
set in `orb-visuals.ts` which the renderer eases toward, so a state change is a
physical transition rather than a cut, and no state can be special-cased into
inconsistency. The silhouette is a harmonic deformation of a circle at three
incommensurate frequencies, so it never visibly loops; interior motion is two
counter-rotating conic gradients rather than particles.

Colour carries meaning rather than decoration: the five working states sit in
one cool family and differ mostly in motion, while amber and red are reserved
for the two states that want your attention.

**Amplitude**: the reactive parts of the animation read from an
`AmplitudeSource`, and both implementations measure real samples through a Web
Audio `AnalyserNode` — the microphone graph while Axon is listening, the
playback graph while it is speaking. There is no timer, no oscillator and no
"speaking so animate" heuristic anywhere in the path: if the orb is reacting,
audio is moving it, and when the audio is silent the measurement is silent too.
With neither running, the source is null and the orb falls back to its own
intrinsic motion, which is honestly not audio at all.

## Reaching the web

```
                the model can say only this
                            │
   browser.open/navigate ── a URL ──► URL POLICY
   browser.read ─────────── nothing            scheme? private? port?
   browser.click ────────── a reference        │
   browser.type ─────────── a reference,       ▼
                            text, submit?   DISPATCHER ── risk from AXON'S
   browser.scroll ───────── screens             │         record of the page
   browser.back/forward ─── nothing             ▼
   browser.close ────────── nothing        approval, where it matters
                                                │
                                                ▼
                            a real, visible browser window
```

**No selector, no script, no coordinates.** The model's entire vocabulary for
touching a page is a reference number Axon minted for an element Axon itself
found and described. The four programs that ever run inside a page are module
constants in `page-script.ts`; arguments reach them as a JSON literal in
argument position, never concatenated into code.

**Risk is resolved from Axon's record, not the model's claim.** Ask to click
`e17`, and the policy looks `e17` up in the observation Axon stored and
classifies from the label Axon read off the page. Calling the "Delete
repository" button "the back link" changes nothing, because the description is
never consulted.

| What you click | Verdict |
|---|---|
| A link, a tab, a disclosure | `SAFE` |
| "Comment", "Send", "Submit", anything that submits a form | `REQUIRES_APPROVAL` |
| "Delete", "Merge", "Buy now", "Revoke", "Change password" | `HIGH_RISK` |
| A password, card or one-time-code field | `FORBIDDEN` — no approval offered |

**Typing is not sending.** Filling a visible field on a page you can see runs
immediately; submitting it asks, and the dialog shows the page, the field and
the exact text. Axon never types a credential — not with approval, not on
request. If a page wants a password, you type it.

### Page content is untrusted

Everything read from the web arrives fenced and labelled as content a stranger
wrote. That label helps, and it is not the defence. The defence is that
persuasion buys nothing: a page cannot call a tool, cannot lower a risk level,
cannot answer an approval, and cannot name a URL the policy refuses. The worst
a successful injection achieves is that Axon asks you to approve something you
did not want — with the action, the page and the content named in the dialog.

### Addresses Axon will not open

`javascript:`, `data:`, `file:`, `blob:`, `about:`, and every other scheme, are
refused as a class rather than blocklisted one by one. So are loopback, the
RFC 1918 ranges, link-local (including `169.254.169.254`, the cloud metadata
address that hands out credentials to anything that asks), and hostnames ending
`.localhost`, `.local`, `.internal` or `.home.arpa`. An unusual port asks
first. Every navigation *and every redirect* is re-checked as it happens, so a
page cannot redirect Axon somewhere the policy would have refused.

The URL policy classifies an address **as written**; it does not resolve DNS.
A hostname that resolves to a private address is therefore not caught by it —
see [Known limitations](#known-limitations).

### Signing in to sites

Axon's browser has its own persistent profile, separate from Axon's UI and from
your everyday browser. **Sign in yourself, once, in that window** — click into
the site's real login page and type your password there. Axon never sees it,
never stores a cookie of its own, and never asks for a token, a session cookie
or a 2FA code. The session then persists across restarts, exactly as it would
in any browser.

There is no supported way to give Axon a credential, and that is deliberate.

| Limit | Value |
|---|---|
| Page text per read | 12,000 characters |
| Interactive elements per read | 120 |
| Text typed in one action | 4,000 characters |
| Browser actions per turn | 40 |
| Navigations per turn | 15 |
| Navigation timeout | 30s |
| Downloads | blocked outright |

## Voice in

```
you speak
   │
   ▼
microphone (renderer)          ← opened ONLY on a command from main
   │  Web Audio: MediaStream → Analyser → 16-bit PCM at 16 kHz
   ├──────────────► the orb   (real amplitude, measured from your voice)
   ▼
one IPC channel, frames only   ← validated: right session, right type, bounded
   │
   ▼
voice activity detection (main)  ← decides when you stopped, from the audio
   │
   ▼
Windows recognizer (subprocess)  ← offline; audio on stdin, text on stdout
   │
   ▼
TEXT — bounded, control characters stripped
   │
   ▼
the same turn a typed message starts: brain → dispatcher → approval → tool
```

**Activation is always explicit.** Three ways to start, and every one of them
is a deliberate human act: saying the wake phrase, pressing the global
shortcut, or clicking the button. All three reach the same main-process API,
which records WHO asked on the event stream — so the log can always answer
"when did audio start leaving this machine, and why?".

<a id="privacy-what-leaves-this-machine"></a>
### Privacy: what leaves this machine

This changed when the voice agent arrived, and the honest version is worth
stating precisely rather than reassuringly.

Axon used to claim *the audio never leaves the machine*. That is no longer
true. The guarantee now is:

> **Before activation, microphone audio remains local.** While Axon is waiting
> for its name, audio reaches a local recognizer on this computer and nothing
> else — there is no socket open, and no code path from the wake word to one.
>
> **After you activate a session**, that session's audio is streamed to
> AssemblyAI, which supplies the recognition, the reasoning and the voice.
>
> **Axon never persists or logs raw microphone audio**, at any point, in any
> mode. No event carries it, no file is written, and nothing survives the frame
> it arrived in.

The window says which of those states it is in, in words as well as colour, and
the timeline records every transition between them. Both halves are enforced
structurally rather than by intention: `main/voice/` and `main/wake/` may not
import anything that could reach the network, `main/agent/` is the only place
that may, and `agent-voice-security.test.ts` fails the build if either changes.

**Your API key never reaches the renderer.** The socket is opened in the main
process with a Bearer header. AssemblyAI offers short-lived browser tokens so a
page can connect directly; Axon deliberately does not use them, because the
point is not that the credential is short-lived — it is that the sandboxed
renderer, which displays text that came from web pages, has no socket at all.

**The wake word is a dedicated local keyword spotter.** Not a speech
recognizer constrained to a phrase — a 3.3M-parameter zipformer transducer
trained for keyword spotting, running on this machine, watching for one
sequence of word pieces and emitting nothing the rest of the time. Apache-2.0
runtime, Apache-2.0 model, no API key, no account, no telemetry, no endpoint.
About 3% of one core while it listens, and roughly 18 MB of ONNX that
`npm run wake:model` fetches once and verifies against a pinned SHA-256.

This replaced the Windows `System.Speech` recognizer, which passed every
synthetic check and then scored **0/15 on a real human microphone** — audio
arriving, speech detected, phrase never heard. The old engine is still here and
still tested, reachable with `AXON_WAKE_ENGINE=windows`, as the control arm for
any future measurement. `create-wake-detector.ts` argues the whole comparison,
including why Picovoice Porcupine, openWakeWord, Vosk and whisper.cpp each lost.

**"Axon" alone cannot wake Axon, structurally.** The spotter is told which word
pieces to watch for, and the model's own tokenizer spells the phrases as
`_HE Y _A X ON`, `_HE LL O _A X ON` and `_HI _A X ON`. The bare name is
`_A X ON` — a prefix of nothing on that list, because every keyword begins with
a greeting piece. This is not a rule applied to text afterwards; there is no
path through the detector that fires on the name by itself.

**The threshold was measured, not chosen.** Across two synthesised voices,
three speaking rates and eight audio alignments, raising the detection
threshold from 0.02 to 0.20 bought *nothing* against false activation and cost
recall monotonically — so the default sits at 0.05, where "Hey Axon" scored
48/48 and the brief's thirteen negatives scored 0/624. The full table, and the
first version of it that was wrong, are in `wake-keywords.ts`.
`npm run wake:calibrate` re-runs that table on a real microphone by running
several thresholds at once on the same live frames — because the natural way to
sweep a threshold is to record somebody and replay it, and Axon does not record
anybody, ever.

**The spotter runs in a process of its own, and that is the point.** It is
started with a six-name environment holding neither API key, it is given audio
only on stdin, and it can answer with exactly three line shapes:

    READY <runtime> <threshold>
    WAKE <keywordId> <startMs> <endMs> <behindMs>
    ERR <code> <message>

`behindMs` is how far behind live audio the spotter was when it fired — zero
when it is keeping up, and the only latency the detector itself can add. It is
deliberately not "how long after the phrase ended": that was tried, and the
spotter's timestamps turned out to have an origin the host cannot observe, so
the number was wrong by seconds. A number that cannot be computed correctly is
not reported.

`WAKE` is the whole wake event. It carries no transcript, because a keyword
spotter produces none. The process has no IPC to the renderer, no tool
registry, no browser, no dispatcher and no socket — `architecture.test.ts`
holds a per-file import allowlist for every file in `main/wake/` so that stays
checkable by reading one block. A native fault in the speech model is an exit
code the parent restarts with bounded backoff, not a crash that takes Axon
down; after the budget is spent it reports "wake detector unavailable" and says
so in the tray rather than respawning forever. No audio is written to disk, and
none is kept beyond what the model's own feature extractor holds.

To see what the detector did, run a development build with `AXON_WAKE_DEBUG=1`:
it logs when the spotter loaded, that microphone audio is arriving, a peak
level every few seconds, and for each hit the keyword id, its timing, the
detection lag and the decision — never audio, never credentials, and never in a
packaged build. `npm run wake:live` opens the real app on the real microphone
and walks you through the wake phrases and twenty things that must not wake it,
reporting "Hey Axon" recall, false activations, detector latency, CPU and
memory; `AXON_WAKE_LIVE_RUNS=10` repeats them, and
`AXON_WAKE_LIVE_BACKGROUND=1` starts Axon as it starts at sign-in.

**Axon runs in the background.** One Axon process holds everything. At start it
creates a hidden, transparent overlay window — the one page that opens the
microphone (for the wake phrase, push-to-talk and conversations) and plays
Axon's voice — and a tray icon. Main sends capture commands and speech only to
that page and accepts microphone audio only from it. Nothing is on screen until
Axon is active; then a small orb appears at the bottom centre of the display the
pointer is on, just above the taskbar, with soft light along the left and right
edges in the orb's colour, and leaves a few seconds after Axon goes quiet. The
overlay is click-through except over its own controls and never takes focus.
Closing the panel does not stop Axon; "Quit Axon" in the tray does.

**Starting with Windows** is a per-user sign-in entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
via Electron's login item): no administrator rights, no Windows service,
visible and removable in Task Manager's Startup tab. It is off until you turn
it on in Settings → Wake word or from the tray, and it starts Axon with
`--background`, so nothing opens. In a development checkout the entry points at
this checkout's Electron and app directory, so run `npm run build` once first:
the sign-in launch loads the built app, not the dev server. `npm run
verify:lifecycle` checks all of this against the real app.

**Ending an utterance is a measurement, not a timer.** A fixed recording length
cuts off anyone who pauses and makes everyone else wait. Axon measures the room
for the first fifth of a second, then watches the energy in each 64 ms frame
against an adaptive noise floor with hysteresis, and closes the utterance after
900 ms of trailing silence. Every threshold is expressed in milliseconds of
*audio*, so the detector is deterministic and a renderer that sent frames
faster than real time could not stretch an utterance past its limit.

**It cannot get stuck listening.** Three independent limits, none of which
depends on the renderer behaving: the audio-derived detector above, a 5-second
timer for a microphone that never delivers a frame, and an absolute ceiling on
the session. Every path out — silence, the duration cap, a user stop, a
cancellation, a device failure, shutdown — runs through one `settle`, which
always closes the microphone and always kills the recognizer.

**Barge-in.** Activating while Axon is speaking cancels the speech through the
existing cancellation path — the same one the Stop button uses — and opens the
microphone. Say "stop" over it and it stops.

| Limit | Value |
|---|---|
| Sample rate | 16 kHz mono, 16-bit |
| Frame | 1024 samples (64 ms); anything over 4096 is dropped |
| Trailing silence that ends an utterance | 900 ms |
| Wait for speech to begin | 6 s, then the microphone closes on its own |
| Longest utterance | 20 s |
| Longest transcript | 1000 characters |
| Recognition deadline | 15 s |

### Checking it by hand

Two stages of the voice path cannot be checked without a person: whether a
spoken sentence becomes the right transcript, and whether the whole loop feels
right. `verify:tools` covers the recognizer against real speech and
`verify:voice` covers the microphone against a real device, but neither of them
can talk. Run this once with an `ANTHROPIC_API_KEY` configured:

1. **Simple.** Press `Ctrl+Shift+Space`, say "open Notepad". Expect: the orb
   moves with your voice, the transcript shows what Axon heard, Notepad opens,
   Axon says so out loud, the orb moves with its voice, then it settles.
2. **Denied.** Say "write hello world to a file on my Desktop". Expect an
   approval dialog naming the resolved path. Press **Deny**. Axon should
   explain that it was refused, and no file should exist.
3. **Allowed.** Say it again and press **Allow**. The file should be there.
4. **Interrupted.** While Axon is speaking, press `Ctrl+Shift+Space` and say
   "stop". The voice should cut off the moment you activate, not at the end of
   the sentence.
5. **Accidental.** Press the shortcut and say nothing. After six seconds the
   microphone should close on its own, with "Axon didn't hear anything" in the
   timeline and no error.

Watch the Windows recording indicator throughout: it should appear when you
activate and disappear the moment the utterance ends.

## The developer Tool Console

Visible in development only, and refused by the main process in production
builds. Every button dispatches a real `ToolCall` through the same `Dispatcher`
the brain uses — same validation, same risk resolution, same approval gate,
same executors, same events. There is no privileged path: the brain's tool
calls and the Console's are indistinguishable to the safety layer. The buttons are chosen to exercise every branch of
the safety layer, including the ones that refuse.

## Security posture

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webviewTag: false`, `webSecurity: true`
- CSP applied by the main process to every response, so it holds regardless of
  what any document declares
- navigation confined to the app origin; `window.open`, popups and `<webview>`
  refused; external links handed to the OS browser
- every permission is denied by default. Exactly one is ever granted — audio
  capture — and only while the main process has itself opened a listening
  session, so page code cannot obtain a microphone by asking for one. A request
  mentioning video is refused whatever the state. `verify:voice` checks all
  three of those against the running app.
- **microphone audio is never recorded.** Frames are streamed to the recognizer
  and dropped; nothing is written to disk, placed in an event, added to the
  JSONL log, or sent to the model. What reaches the brain is text.
- a transcript is untrusted content, and holds no authority: it becomes a user
  message, and any action it provokes is classified, risk-assessed and gated on
  approval exactly like a typed one
- **no shell strings are ever built from caller input.** `app.open` takes an
  enum that indexes a constant table of four applications, and launches via
  `spawn(file, [])` with no shell. There is no path by which model output
  reaches an interpreter.
- every payload arriving from the renderer is schema-validated before use
- **every SQL statement is parameterized**, and a lint rule fails the build on a
  string-built one. The brain has no path to the database: it emits a tool call,
  which is validated, classified and approved before any row is written.
- **secrets are never persisted.** Text on its way into a message is scanned and
  redacted; a memory containing one is refused rather than redacted, because a
  memory is read back into a future prompt.
- a stored value is data, never authority. Settings are re-validated on every
  read and repaired to defaults if damaged, and memories enter the prompt framed
  as facts about the user rather than as instructions.
- the browser profile stays owned by Chromium. No cookie, session or credential
  is ever copied into Axon's database.

## Roadmap

| Step | Delivers |
|---|---|
| **1 ✅** | Foundation: shell, events, state machine, dispatcher, 3 real tools, orb, timeline, approvals |
| **2 ✅** | Brain: Claude tool-use loop, text input, transcript, in-session memory |
| **3 ✅** | Voice out: SAPI synthesis → renderer playback → real amplitude driving the orb |
| **4 ✅** | Voice in: push-to-talk, real mic capture, audio-driven VAD, offline STT, barge-in |
| **5 ✅** | Reach: a real visible browser, bounded observation, per-action risk, HIGH_RISK, injection defences |
| **6 ✅** | Identity: SQLite persistence, bounded restoration, approved long-term memory, settings, privacy controls |
| **7 ✅** | Trusted local control plane: turn budgets, approval binding, goal boundary, desktop windows |
| **8 ✅** | Computer interaction: system clock, visual observations, observation-bound click and type, four-class sensitivity |
| **9 ✅** | Product-grade agent loop: tasks and steps, in-progress lifecycle, first-class cancellation, clarification, verified launches |
| **10 ✅** | Product-grade demo: multi-step tasks, task grounding, clarification continuity, progress phrasing, observation providers, developer timeline |
| **11 ✅** | Demo-ready: canonical script, rehearsal, preflight, recovery, attack suite, demo recording |
| 12 | Product: packaging, signing, updates |

Voice deliberately comes after the brain: a voice loop with nothing behind it
is a demo of a microphone.

## Seeing and acting on the screen

Axon can look at the screen and act on what it saw. The shape of that
capability is the whole of its safety, so it is worth stating precisely.

**A screenshot is an observation, not a file.** `system.screenshot` captures the
screen and, at the same moment, reads the controls the window in front
publishes to Windows' accessibility layer. What it produces is a short-lived
*visual observation* held in the main process: the size of the screen, which
window is in front, and a numbered list of buttons, links and fields, each with
a reference like `t4`. Nothing is written to disk unless you asked for a file —
`save: true` — which means an agent that looks at the screen ten times in a
conversation does not leave ten photographs of your screen in a folder you have
forgotten about.

**Axon cannot show you the picture, and says so.** The voice provider speaks a
text protocol; there is no channel on it that carries an image. So the model
receives the structured reading, never the pixels, and the result says that
outright rather than letting the model imply it looked at a photograph. The
pixels are held — bound to the observation, expiring on the same clock — so a
vision-capable consumer is a new reader rather than a redesign. Until there is
one, this is a real limitation and it is not papered over.

**There is no `mouse.click(x, y)`.** A coordinate is a target nobody can check:
Axon cannot tell whether `940, 512` is the button you meant, a different
button, or the taskbar, and there is no record afterwards of what was hit.
Worse, coordinate injection acts on whatever is under the pointer *at delivery*
— so a window that moved, a dialog that appeared, or an alt-tab between the
decision and the click means something other than what was reasoned about
receives it.

So `ui.click` and `keyboard.type` name a reference, and the pipeline is the one
the browser tools use:

    system.screenshot → Axon enumerates and mints t1, t2, t3
      → the model names a reference, and has no other vocabulary
      → precheck: unknown, expired or superseded is refused, before risk
      → risk resolved from AXON'S reading of the control's name
      → the user is asked for anything that activates a control
      → UI Automation invokes THAT ELEMENT, re-found by identity
      → the controls are read again, and the result says what changed
      → every reference from before the action is void

A reference expires in fifteen seconds, is void the moment Axon acts, and
cannot be reused. Two controls matching the same identity is a refusal, not a
choice; none is a refusal too. **No synthetic input exists anywhere in Axon** —
no `SendInput`, no `mouse_event`, no `keybd_event`, no `SetCursorPos` — and
`architecture.test.ts` fails the build if any of them appears.

**`keyboard.press` does not exist.** Sending Enter, Escape or a shortcut means
synthetic keystrokes, which go to whatever holds focus — the exact race the
design above removes, and one Axon could verify a millisecond before and still
lose. Pressing a button is `ui.click` on that button; choosing a menu item is
`ui.click` on the item. Submitting a form with Enter is genuinely missing, and
is stated as missing rather than approximated.

**Typing is bound to a field, and refuses credentials twice over.** The
accessibility layer reports a protected-entry field directly, so that refusal
is the application's own evidence rather than a guess about a field's name; and
credential-shaped text is refused whatever field it was headed for. Neither is
unlockable by approval. Because `SetValue` replaces a field's contents, typing
into a field that already has something in it is HIGH_RISK and the dialog says
so. The text is shown in the approval dialog — you cannot consent to something
you have not read — and appears in no observation, no event and no log.

## What counts as sensitive

Axon classifies four things differently, because a system that calls everything
sensitive has said nothing:

| Class | Examples | What Axon does |
|---|---|---|
| **NORMAL** | ordinary text | handles it, no ceremony |
| **PERSONAL** | an email address, a phone number, an address, a name | reads it, says it, types it, stores it — and *marks* it |
| **SECRET** | passwords, API keys, tokens, card numbers, one-time codes | refuses outright; no approval unlocks it |
| **CONSEQUENTIAL** | money, account creation, credential changes, destruction, anything sent outward | a person decides |

The distinction between the middle two is the point. Earlier, Axon had one
boolean, and it described a user's own email address as forbidden data it could
not touch — which is untrue, and which teaches you that Axon's refusals are
noise, so the next refusal, the one about an API key, gets read the same way.
Policy stays in Axon: the model classifies nothing and decides nothing.

## How one request runs

Axon runs a REQUEST, not a sequence of tool calls. That distinction is what
makes it behave like something you can delegate to.

    user says something
      -> a TASK opens, carrying their exact words as its goal
      -> the model proposes ONE action
      -> a STEP opens against the task
      -> schema -> precheck -> budget -> risk -> policy -> duplicate
      -> approval, when the act warrants it
      -> execute, inside a bounded deadline
      -> observe again, and VERIFY from what Axon can see
      -> the result, and only then a sentence out loud

Every step carries a task id and a step id, so one request can be pulled out of
a log that holds several. The trace records the tool, the outcome, the risk
level, whether a human was asked and whether the effect was verified — and it
carries no arguments, no outputs and no text, because those are the things that
must not accumulate in a log.

**There is no plan and no queue.** Axon holds no list of approved future
actions, deliberately: a queue is precisely the structure that lets one
approval authorise the act after it. A task is a thread that steps are strung
on, not a permission that covers them. "Open my application, fill what you can,
but don't submit" works because filling and submitting are different acts with
different risk, decided separately from their own arguments — not because Axon
was told to stop before the last one.

### Slow actions say so, instead of guessing

Some actions take seconds. Reading the accessibility tree takes about three;
loading a page can take longer. A tool call that has not answered leaves the
agent composing a reply with nothing in hand — and in live testing it filled
that gap by GUESSING, and guessed failure: *"GitHub did not load"* about a page
that was on screen, *"I could not capture a screenshot"* about a capture that
had succeeded. When the real result arrived, Axon corrected itself, so one
action produced two contradictory sentences.

The fix is not a better guess or a longer wait. Anything slower than about a
second is answered `in_progress` — truthfully, since there is no outcome yet —
and the outcome arrives afterwards as the FIRST statement anybody makes about
what happened. There is nothing to contradict because nothing was claimed:

    "One moment."          <- the in-progress answer
    "GitHub is open."      <- the outcome

And when the work beats the flush anyway, the in-progress answer is replaced by
the real one and you hear a single sentence. The intermediate state is a
fallback, not a ceremony — the budget is set just under the provider's own tool
timeout so that almost everything answers inline. An acknowledgement is what
Axon falls back to when it cannot answer in time, not something it does to seem
responsive.

### "Stop."

Cancellation is matched against the user's own words, before the model sees
them — a model asked to decide whether it has been told to stop is the thing
being stopped. The match is deliberately strict: *"stop"*, *"cancel that"*,
*"never mind"*, *"don't do that"* are cancellations; *"stop the video"* and
*"cancel my subscription"* are requests. A false negative costs you saying it
again; a false positive abandons work you wanted.

Stopping reaches all of it: the task, so a result already in flight is
recognised as unwanted and can neither speak nor prompt the next step; the
executor, which is aborted mid-flight; the browser, which abandons the
navigation; the observation store, so a target reference minted for the
cancelled work cannot be acted on; and any dialog on screen, which is taken
down rather than left for you to answer. Then Axon says one word.

### Asking beats guessing

Ambiguity has its own answer, separate from failure. Two Notepad windows, two
buttons that both match — Axon does not choose, and it does not report a
failure either, because *"I could not do that"* for something it could easily
have done is the wrong answer. It asks which one, names the candidates, and
waits. An application Axon does not have is likewise never the nearest one it
does have: the tool takes an enum indexing a fixed table, so "open Chrome"
cannot be answered by opening something similar.

### Verified, or not claimed

`app.open` no longer reports success from a process id. A pid means the
operating system agreed to start something; it does not mean an application
opened. So the launch is followed by looking — the window list is polled until
a window the registry recognises appears, or a bounded deadline passes — and
the result says which happened. *"Calculator is open."* is a thing Axon saw.

## Doing several things

A request with several parts — *"open YouTube, search for AssemblyAI Voice
Agent, and open the first result"* — runs as one task with several steps, and
the interesting property is not that any one step works. It is that **the third
step depends on what the second actually produced**, not on what anybody
intended it to produce. A search that silently did nothing cannot be followed
by a click on a result that is not there.

Nothing about having done step one makes step two legal. Each is proposed,
schema-checked, precheck-ed, budgeted, risk-resolved, policy-decided,
duplicate-checked, executed and verified on its own.

### Where things stand

People drop the subject constantly. *"Open YouTube"* then *"search for
AssemblyAI"* then *"open the first one"* — none of those later sentences names
what it is about, and all of them are clear to a person because they remember
where they are.

The model has the conversation, so it remembers what was **said**. What it does
not have is what Axon **saw**. So every result carries a short grounding line —
the page Axon actually read, and the thing it actually acted on — and the model
resolves the reference against that. Axon supplies the facts and then validates
whatever comes back, exactly as before; it does not resolve pronouns itself,
because a component that resolved one could resolve one wrongly with no gate in
between.

Cancelling forgets the grounding, so *"open that one"* after a stop has nothing
to resolve against.

### Asking, and being answered

When Axon asks *"Which one?"*, the next thing you say is an **answer** — it
continues the task that asked the question rather than replacing it. That
sounds obvious and it is the fix for a real bug: without it, *"the second one"*
opened a brand-new task, superseding the request it was answering and throwing
away the context that made it mean anything.

Questions are as short as a question can be — *"Which one?"*, *"Open what?"*,
*"Which application?"* — and never mention references, targets or observations.
You are talking to an assistant, not debugging one.

### "Opening YouTube."

Most actions answer in one sentence. Measured on a real machine, over several
runs: the clock is about 1ms, a verified application launch 0.9-1.5s, a screen
observation 2.0-3.2s, a real navigation anything from under a second on a warm
cache to many seconds cold. The threshold sits at 2.5s, which is above the
launch and inside the spread of the other two, so:

    "Open Calculator."  ->  "Calculator is open."
    "Open YouTube."     ->  "Opening YouTube."  ...  "YouTube is open."

The second line is what happens when the navigation is slow. When it is fast it
answers in one sentence like the first, and that is the better outcome rather
than a missed opportunity to announce.

An acknowledgement is a **fallback**, not a flourish — it only happens when
Axon would otherwise leave you in silence. And Axon supplies the words for it,
derived from the tool and its arguments, so *"Opening YouTube"* is a statement
of intent that is true when it is said. *"YouTube is open"* is a claim about
the world and waits for verification.

### The developer timeline

For debugging a demo, the event stream projects into the shape the decisions
actually have:

    TASK task-1  "open youtube and search for assemblyai"
    └── STEP step-1  browser.open
        ├── proposal
        ├── policy: SAFE — allowed without asking
        ├── verification: confirmed by looking
        └── SUCCEEDED
    └── STEP step-2  browser.type
        ├── proposal
        ├── policy: REQUIRES_APPROVAL — a human was asked
        ├── approval: ALLOW by user
        ├── re-bind: fingerprint re-checked before execution
        └── SUCCEEDED

Each step is joined to its own dispatcher call by id rather than by ordering,
so two steps of the same tool in flight at once cannot have their approvals
swapped. It carries **no tool arguments, no page text and no typed values** —
the shape of each decision, and none of the content.

### Looking at the screen

Observation is a set of providers, each of which knows two things about itself:
whether Axon can **produce** it, and whether anything can **receive** it. Those
are different questions, and conflating them is how a system starts claiming to
see.

| Modality | Captured | Deliverable to the model |
|---|---|---|
| accessibility | yes | yes — it is text |
| pixels | yes | **no** — the protocol has no image channel |
| vision | **no** | no — Axon has no vision model |

`vision` appears in that table with "no" rather than being left out, because a
missing row reads as an oversight and a "no" reads as a decision. There is no
`VisionObservationProvider` file, class or stub: one that returned "a
description of the image" without a vision model behind it would read exactly
like sight and be a guess.

## Giving the demo

The stage script lives in [docs/DEMO.md](docs/DEMO.md), and it is generated from
the same data the suite performs — so the document cannot describe a demo the
product can no longer give. Four commands, in the order you use them:

```bash
npm run preflight
```

Thirteen checks against the real runtime on this machine — the key (by name,
never by value), whether the network lets Axon reach the voice provider, the
microphone permission, the speech engine, the wake word, the policy, the
browser, UI Automation, the task ledger and the approval broker. It ends in
`READY FOR DEMO` or says what is not.

```bash
npm run rehearse
```

The canonical demo, beat by beat, through the real orchestrator, tool bridge,
dispatcher, policy and approval broker, with the model and the internet
replaced by a script and page models. It prints a record: every sentence,
every proposal, the policy verdict, the approval, the time taken, and what Axon
was told to say.

```bash
npm run attacks
```

Nine attempts to make Axon do something it should not — a shell, a private
file, a write outside the workspace, an invented tool, a password into a form,
a page announcing that approval is off, a detour to a signup page, an approval
answered for a different act than the one shown — and what happened to each.
None is allowed. Put it on a second screen.

```powershell
$env:AXON_DEMO_RECORDING='1'; npm run dev
```

A development build that writes `logs/demo-recording.jsonl` on quit: one row
per step with its time, tool, status, latency, policy, approval and
verification, and none of the content — no arguments, no page text, no typed
values, no keys, no audio.

## Known limitations

**DNS is not resolved by the URL policy.** An address is classified as written,
so a hostname that resolves to a private address — deliberately, as in a DNS
rebinding attack — is not caught by it. Mitigated rather than solved: the
browser has no Node access and no route back into Axon, downloads are blocked,
every navigation is re-checked, and a page it reached cannot do anything with
what it found. `verify-browser.cjs` uses exactly this technique to reach its own
test server, which is both convenient and an honest demonstration of the gap.

**Click risk is judged from the element's label.** Matching English words on a
button is a floor, not a theory of consequence: an unfamiliar phrasing, or
another language, may fall through to the general rule instead of being flagged
as destructive. That general rule still catches anything that submits a form,
the dialog always names the page and the exact label, and the user can see the
real browser window.

**No shell, no arbitrary filesystem access, and no `fs.read`.** Reading files
was left out of this milestone on purpose. Combined with browser reach it makes
a clean exfiltration path — read a private key, type it into a form — and a
capability with that shape deserves its own milestone rather than a footnote in
this one.

**Login is manual, once, per site.** Axon cannot sign itself in and is not
supposed to be able to.

**The database is not encrypted at rest.** It is a file under your user profile
with the protection your Windows account gives it — which is real, and is not
the same as encryption. Anyone with your unlocked machine, or with an
unprotected backup of it, can read your conversations. Secrets are kept out of
it rather than encrypted inside it; encryption at rest needs a key, and a key
needs somewhere to live, which is its own milestone rather than a checkbox.

**Secret detection is pattern-based.** The known credential shapes are caught;
a private string with no recognisable form — an internal password, a passphrase
in prose — is not distinguishable from ordinary text and will be stored as
written. The redaction pass is a safety net for the obvious cases, not a
guarantee about everything you might type.

**Session summaries are mechanical.** A conversation's one-line summary is
derived from its first user message, not written by the model. It is cheap,
deterministic and offline, and it is sometimes a poor description of where the
conversation ended up.

**Axon cannot see the picture it captured.** The visual-observation abstraction
holds the pixels and expires them, but there is no consumer that can accept an
image: the voice provider's protocol carries text. What the model reasons about
is the accessibility reading, which is a good description of a well-behaved
application and says nothing at all about one that draws its own interface.

**Some applications expose nothing to act on.** Games, canvas-based editors and
anything that paints its own controls publish no accessibility tree, so Axon
sees a window with no controls in it. It reports that honestly rather than
returning an empty list a model would read as "the screen is empty" — but the
consequence is real: Axon cannot click inside those applications at all, and
adding coordinates to reach them would give up the entire safety argument.

**Reading the accessibility tree takes seconds.** A large window can hold
thousands of nodes, and the walk is bounded at six seconds so a look at the
screen fits inside the voice provider's tool timeout. A window that cannot be
walked in that time yields a partial reading, reported as partial.

**No `keyboard.press`, so nothing can be submitted with Enter.** See the
section above for why this was left out rather than approximated.

**Tool deadlines are tied to the voice protocol.** Every per-call deadline has
to fit inside the provider's tool timeout, or the provider abandons the call
and the model reports a failure for work that succeeded — which happened in a
live test, with Axon announcing that GitHub had not loaded while the page was
on screen. `voice-agent-timing.test.ts` now asserts the relationship, but the
underlying constraint is real: Axon cannot wait longer for a page than the
conversation will wait for Axon.

**The goal boundary trusts the provider's transcription.** The goal a
navigation is judged against comes from `transcript.user` — the voice
provider's transcription of what you said. Axon does not transcribe the
streamed audio itself, so a provider sending a fabricated transcript could set
a goal you never spoke. What that could achieve is bounded: the boundary only
ever ESCALATES, so a fabricated goal cannot make an action skip the risk
policy, the approval gate, the duplicate guard or the budget, and it can name
no tool, path or URL. What it could do is stop Axon asking about a
consequential navigation it would otherwise have asked about. Fixing it needs a
local transcription of the same audio to compare against, which is a milestone
rather than a patch.

**A very slow action costs an extra sentence.** Anything past the inline budget
is acknowledged first and answered second, so you hear "One moment." and then
the result. The budget is set just under the provider's tool timeout precisely
so this is rare — in live testing every ordinary request answers in one
sentence — but a navigation to a slow site can still take two utterances. That
is the price of never hearing a guess, and it is the right trade.

**Cancellation matching is strict, and English-only.** The phrase list is
literal and short. Saying "stop" in another language, or phrasing it unusually,
will not cancel — you will have to say it again in a way the list recognises,
or close the session.

**Reference resolution is the model's, not Axon's.** Axon supplies the facts —
which page it read, what it acted on — and the model decides that "it" means
YouTube. That is the right split (language is the model's job, and a component
that resolved references could resolve one wrongly with no gate in between),
but it means a reference can be resolved wrongly by a confused model. What
bounds the damage is that the resulting action is validated like any other: a
wrong reference produces a refused or approved action, never a silent one.

**A clarifying answer is whatever you say next.** Axon treats the next
utterance after a question as the answer to it. If you ask something unrelated
instead, that sentence is absorbed as the answer and the task carries on with
it — one utterance clears the state, so the one after that starts fresh, but
the first one is misread.

**Searching asks for approval.** Submitting anything — including a search box —
sends data to somebody else's server, so it goes through the approval gate.
That is correct and it is one dialog in the middle of the YouTube demo. It is
not special-cased away, because "it is only a search" is exactly the reasoning
that would eventually wave through something that is not.

**A synthesised voice is not a person.** `wake-integration.test.ts` runs the
real Windows engine on a synthesised voice and passes "Hey / Hello / Hi Axon"
while refusing thirteen negatives, including "I was talking about Axon
yesterday", "Axon is a company", "action", "exon", "song", and the phrases a
human microphone test produced under the old design ("But who", "And who",
"New song"). That is not a measurement of your voice: the design that passed
synthesised speech before failed a person. The wake phrase is only proven by
`npm run wake:live` with repeated runs, spoken by you. Acoustic loopback (the
laptop speaking into its own microphone) does not work on hardware whose
microphone driver cancels echo, which includes the machine this was built on.

**Act III of the demo needs a real, hosted page.** The rehearsed application
form lives at `careers.example.com`, which exists only inside the test suite.
The same page is in `demo-site/` as static files; host it on any public https
address (Axon refuses localhost and private addresses, and that is not relaxed
for a demo), and say its address on stage — Axon cannot know where "my
internship application" is. `verify-agent.cjs` runs Act III against those exact
files in the real browser.

**The live web is not the rehearsal.** On real YouTube, Axon asks "which one?"
only if two results are genuinely indistinguishable, which is uncommon, and a
search asks for approval only if the model types into the search box and
submits — opening a results address directly is a page load and asks nothing.
A third path was seen live too: the model typed the query and then clicked
YouTube's search icon, which is a script-driven button rather than a form
submission, so Axon classified it as an ordinary click and asked nothing.
Axon asks before real form submissions and consequential destinations; it
cannot tell that an arbitrary script button sends what was typed. The approval
that is guaranteed is the one that matters: submitting the application.

**On a slow network the model can speak before the outcome.** A navigation
that runs past the inline budget is answered "in progress", with an explicit
instruction not to claim success or failure. In one live run an 11.5-second
navigation still drew "GitHub is open." from the model before Axon's verified
outcome — "GitHub did not load, so I stopped." — followed. The last word is
Axon's and it is true; the first sentence was the model guessing. The live
smoke test checks for exactly this and reports it as a failure when it happens.

**A slow page load can occasionally go unannounced.** When a navigation takes
longer than the inline budget, the agent is told "Opening YouTube." and the
outcome follows as a separate reply. In live runs that second reply was
sometimes not spoken — the page was open and nothing was said. A change that
held the outcome until the acknowledgement finished was tried and made live
runs worse, so it was reverted rather than tuned blind.

**A rehearsal is not a live run.** `npm run rehearse` proves the pipeline holds
for the stage sequence; it does not prove the model proposes that sequence.
`npm run smoke:assemblyai` is that evidence, against the real provider, and the
two are never reported as one.

## Licence

UNLICENSED — private.
