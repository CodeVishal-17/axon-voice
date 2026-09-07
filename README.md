# Axon Voice

A voice-first desktop AI agent for Windows. Axon understands a goal, plans the
steps, acts on your computer where you can see it happening, and asks before it
does anything sensitive.

**Status: v0.6.0 — Step 6, persistence and identity.** The loop is closed. Press
`Ctrl+Shift+Space` (or click **Talk to Axon**) and say "open Notepad": Axon
hears you through your microphone, decides for itself when you have finished
speaking, transcribes offline on your own machine, reasons about it with
Claude, calls real tools through the dispatcher, asks before anything
sensitive, and reads the answer back aloud. The orb reacts to your real voice
on the way in and to Axon's real voice on the way out — one signal each
direction, never a simulation.

Axon now also **reaches the web**, in a real browser window you can watch. It
opens pages, reads them, follows links and fills in fields — and anything that
sends, posts, buys or deletes stops and asks you first, naming the page and the
exact content. Page text is treated as what it is: content a stranger wrote,
which can inform Axon and cannot instruct it. Shell access is not implemented,
deliberately. See [Roadmap](#roadmap).

And you can now **talk to it**. Say "Hey Axon" and hold a real conversation:
AssemblyAI's Voice Agent API supplies the recognition, the reasoning and the
voice over a single WebSocket held by the main process, and every action it
proposes goes through the same dispatcher, the same risk policy and the same
approval dialog as everything else. The model changed; the security boundary
did not.

And Axon now **remembers**. Conversations survive a restart, a short bounded
slice of the one you were having is handed back to the model on the next turn,
and Axon can be asked to remember a durable fact about you or your work — with
your approval, one fact at a time, in words you can read back and delete. It
all lives in a single SQLite file under your own profile. Nothing is uploaded,
and anything shaped like a credential is refused outright rather than stored.
See [What Axon remembers](#what-axon-remembers).

---

## Requirements

| | |
|---|---|
| OS | Windows 10/11 |
| Node | 20.19+ (22 LTS recommended — Electron 44 declares `node >= 22.12`, which is advisory; 20.20 works) |
| Keys | `ASSEMBLYAI_API_KEY` for spoken conversation — recognition, reasoning and voice all come from it. `ANTHROPIC_API_KEY` is optional and only powers the typed path. Without either, Axon still runs: the orb, the timeline, the browser, the tools and the Tool Console all work. |
| Voice out | Windows SAPI. **No key, no account, no network.** Set `AXON_TTS_PROVIDER=none` to keep Axon silent. |
| Wake word | Windows `System.Speech.Recognition`, entirely local. Listens for "Hey Axon" / "Hello Axon" / "Hi Axon" and nothing else leaves the machine until you say one of them. Needs an English (United States) speech language installed, which Windows 10/11 has by default. Set `AXON_STT_PROVIDER=none` to disable. |
| Voice conversation | AssemblyAI Voice Agent API, over one WebSocket held by the main process. Active-session audio is streamed to AssemblyAI; see [Privacy](#privacy-what-leaves-this-machine). |
| Microphone | Any input device. Axon opens it only while it is listening, and Windows shows its own recording indicator throughout. |

## Getting started

```bash
npm install
```

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
| `npm run typecheck` | `tsc --noEmit` across core, main/preload and renderer |
| `npm run lint` | ESLint, including the architectural boundary rules |
| `npm test` | Vitest — 1014 tests, no API key and no network required |
| `npm run verify:tools` | Build, then exercise the real tools, real speech and real recognition inside Electron |
| `npm run verify:voice` | Build, then start the real app and drive a real microphone through a real window |
| `npm run verify:browser` | Build, then open the real browser on real pages and drive it through the real dispatcher |
| `npm run verify:persistence` | Build, then open a real SQLite database and restart it, on real files |
| `npm run verify:all` | typecheck → lint → test → the four harnesses above (227 checks) |

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
└─ apps/desktop/
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
   ├─ src/preload/index.ts     the audited bridge (~1.5 kB built)
   ├─ src/renderer/            React UI; consumes events, owns nothing
   └─ tests/
```

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

**The wake-word recognizer is local.** `System.Speech.Recognition` ships with
Windows. No API key, no account, no model download, no network. The trade is
accuracy on long free-form dictation, which is
worth making for an assistant whose input is short instructions and whose
interpretation is done by a model. Swapping in Whisper or a cloud recognizer is
a new file beside `windows-stt.ts` and one arm in `create-stt.ts`.

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
| 7 | Product: packaging, signing, updates |

Voice deliberately comes after the brain: a voice loop with nothing behind it
is a demo of a microphone.

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

## Licence

UNLICENSED — private.
