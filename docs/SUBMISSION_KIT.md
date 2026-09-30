# Submission kit — copy-paste fields

Everything the submission form asks for, written to be true of the code in this repository today.
Background and architecture detail: [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md). The recorded
demo: [GOLDEN_DEMO.md](GOLDEN_DEMO.md).

---

## Project title

**Axon Voice**

## Short description (one sentence)

Axon is a voice-first Windows assistant that understands what you say through AssemblyAI's realtime
Voice Agent, operates your applications through native Windows accessibility APIs, verifies what it did,
and asks for your approval before consequential actions.

*(Shorter, if there is a character limit:)* A voice-first Windows assistant that acts on your computer —
and asks before anything consequential.

## Long description

**The problem.** Voice assistants stop at answering. Ask one what's playing in Spotify or to open your
browser and it tells you how, or sets a timer. The assistants that *do* act on a computer usually get
there by handing a language model a shell, a mouse or a browser automation API — and then everything
the model gets wrong, or is tricked into by a web page it reads, becomes an action.

**Axon's approach: the model proposes, Axon decides.** Axon is a Windows desktop app. You say "Hey
Axon" — the wake word is detected by an on-device keyword spotter, so nothing is streamed until then —
and the conversation runs over **AssemblyAI's Voice Agent API**: streaming speech recognition, turn
detection, the reasoning model, tool calling and the spoken reply, over one WebSocket. The model never
touches the machine. It can only *propose* a named tool call. Every proposal lands in Axon's local
control plane, which validates it, classifies its risk from Axon's own reading of the world (never from
the model's description), asks a human where it matters, executes it, and then **verifies the result by
looking again**.

**Desktop control without per-app integrations.** Axon finds installed applications from the Start menu
and opens them by name. It confirms an app really opened by the process that owns its window, not by
its title. It reads applications through **native Windows UI Automation**, the same accessibility tree
a screen reader uses, so in the demo it describes what is on screen in Spotify with no Spotify
integration. It acts only on controls it has just read, by reference, never by screen coordinate.
References go stale the moment anything changes, and a stale reference is refused, not guessed. It opens
pages in **your own default browser**, identified from Windows' own record, and can read, search,
follow links in and scroll those pages the same accessible way — on any site, with no site-specific code.

**Security that is structural, not a prompt.** Opening an app Axon doesn't already trust, pressing a
button in another app, submitting a form or sending anything waits for a click on Axon's own approval
dialog. The dialog names the act and the target, and the approval is bound to those exact arguments, so
approving one action cannot authorise another. Passwords and credential-shaped text are refused outright
at every typing surface, and a secret visible in another app's text box is withheld from the model.
There is no shell tool, no arbitrary file read, no synthetic keystrokes and no auto-approve mode. Web
page text reaches the model marked as untrusted, and instructions inside it are quoted, never obeyed.

**Example.** "Open Spotify." → Axon asks → you allow → "Spotify is open," confirmed by Spotify's own
process. "What do you see in Spotify?" → it names artists in your library and what's playing, read
through UI Automation. "Open YouTube in my browser." → your default browser, verified. "Open WhatsApp."
→ you deny → nothing happens. "Type my API key into Notepad." → refused.

**Why AssemblyAI.** The Voice Agent API gives Axon a complete realtime conversational layer with
**client-side tools**: every action the model wants arrives on Axon's socket, which is what makes a
local control plane possible at all. Axon deliberately never registers a server-side tool, and a test
enforces that.

**Evidence.** 2,300+ automated tests, including a rehearsal of the stage script through the real
dispatcher, policy and approval broker, and a live smoke test against the real AssemblyAI service.

**What's next.** Packaging and signing, a vision-capable observation provider added as a provider rather
than a bypass, and broader verification of application actions.

**Honest limits.** Windows only. Axon can read and act in applications that expose their interface to
Windows UI Automation. There is no vision model, so it reads the accessibility tree, not pixels. It runs
from source; there is no installer yet.

## Technology / category tags

AssemblyAI · Voice Agent API · Realtime speech · Voice AI · AI agents · Tool calling · Desktop automation
· Windows UI Automation · Accessibility · Electron · TypeScript · React · AI safety · Human-in-the-loop

## Demo application platform

Windows 10 / 11 desktop (Electron). Runs from source (`npm install`, `npm run dev`).

## Application URL / repository

- Repository: https://github.com/CodeVishal-17/axon-voice — **⚠ currently contains only the first
  commit; push the current work before submitting.**
- Website: `apps/web` (static Vite build in `apps/web/dist`) — not deployed yet. Set
  `VITE_AXON_SOURCE_URL` if the repo URL changes. The download button stays disabled until
  `VITE_AXON_DOWNLOAD_URL` points at a real release.

---

## Video (target 3:00, hard max 4:00)

Record the real app. No mock-ups. Cut dead air between beats; never cut *inside* a beat.

| Time | Picture | Voice-over / what you say |
|---|---|---|
| 0:00–0:15 | Title card: "Axon Voice" + orb | "Most AI assistants can answer questions about your computer. They can't safely operate it." |
| 0:15–0:30 | Desktop, orb idle | "Axon is a voice-first Windows assistant. It listens, acts, and verifies — and consequential actions wait for you." |
| 0:30–0:45 | **"Hey Axon."** orb opens → **"Who are you?"** | (Axon answers.) "The wake word runs on this machine; the conversation runs on AssemblyAI's Voice Agent." |
| 0:45–1:20 | **"Open Spotify."** → approval dialog → click **Allow** → "Spotify is open." | "Spotify isn't one of Axon's built-in apps, so it asks. Then it checks the window really belongs to Spotify before it says so." |
| 1:20–1:50 | **"What do you see in Spotify?"** | "There's no Spotify integration. Axon read Spotify's accessibility tree through Windows UI Automation — the same path works for other apps." |
| 1:50–2:10 | **"Open YouTube in my browser."** → Dia opens | "That's my default browser — Axon asked Windows, it didn't assume Chrome." |
| 2:10–2:35 | **"Open WhatsApp."** → dialog → click **Deny** → "I'll skip that then." | "I said no, so nothing ran. The approval is a click on Axon's own dialog — the model can't answer it for me." |
| 2:35–2:50 | **"Type my API key into Notepad…"** → refused | "Credentials are refused outright — at every surface Axon can type into." |
| 2:50–3:15 | Architecture slide | "AssemblyAI does the realtime voice: recognition, turn-taking, reasoning, speech. Axon does everything that has to be trustworthy: tools, policy, approvals, native UI Automation, and verification." |
| 3:15–3:30 | Orb, repo URL | "Axon isn't a voice chatbot. It's a voice interface to your computer." |

## Slides (6–8)

1. **Axon Voice** — "A voice interface to your computer." Orb image.
2. **The problem** — Assistants answer; they don't act. The ones that act hand a model a shell or a mouse.
3. **The idea** — Voice → Understand → Act → Verify. The model *proposes*; Axon *decides*.
4. **Architecture** — Mic → local wake word → AssemblyAI Voice Agent (STT, turns, LLM, TTS, client-side
   tool calls) → Axon control plane: schema → policy/risk → approval → execute → verify → spoken answer.
5. **Works across apps** — Start-menu discovery, process-identity verification, native UI Automation
   reading, default browser. No per-app integrations.
6. **Safety** — approvals bound to exact arguments; credentials refused; secrets on screen withheld; no
   shell, no coordinates, no auto-approve; untrusted page text.
7. **Evidence** — 2,300+ tests; live AssemblyAI runs; what's intentionally unsupported.
8. **Next** — installer, vision provider, broader verification.

## Cover image

A dark frame with the orb (the site hero at `apps/web`, `npm run web:dev`, is the cleanest source —
screenshot at 1920×1080) and the line **"Talk to your computer."**
