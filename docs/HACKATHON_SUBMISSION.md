# Axon Voice — hackathon submission notes

*Developer-only. Accurate to the code in this repository; nothing here describes a feature that is not implemented.*

## 1. One-sentence pitch

Axon is a Windows voice agent that moves from conversation to **verified** action on your computer, where AssemblyAI provides the realtime voice and Axon provides a control plane that decides, for every single action, whether it is allowed.

## 2. Problem

Voice assistants either can't do much — they set timers and read the weather — or they are being given real control of a computer by handing a language model a shell, a mouse or a browser automation API. The second kind is powerful and untrustworthy in the same breath: the model can be wrong, can be confused by what it reads, and can be instructed by a web page it opens. A model with direct control of the machine turns every one of those failures into an action.

## 3. Solution

Separate **proposing** from **deciding**.

The model, reached through AssemblyAI's Voice Agent API, only ever *proposes* a named tool call with arguments. Axon, running locally, treats every proposal as an untrusted request and runs it through one dispatcher that validates, classifies, asks a human where it matters, re-checks, executes, and then verifies the result by looking at the world rather than trusting the executor. The model never holds a capability Axon did not grant for that one call.

## 4. Why voice

Voice is the natural interface for *delegating* — "open the application and fill in what you can" — and the worst interface for *supervising*, because you cannot see what an assistant is doing while it talks. Axon is built around that tension: it talks in short, true sentences ("Calculator is open."), says what it is doing when a step is slow ("Opening YouTube."), asks one short question when it cannot tell two things apart ("Which one do you mean?"), and when an action is consequential, it says **what** and **where** out loud *and* shows the same sentence in a dialog.

## 5. Why AssemblyAI

AssemblyAI's Voice Agent API supplies the whole realtime conversational layer over **one WebSocket**: streaming speech recognition, turn detection, the reasoning model, client-side tool calling, and the synthesised voice. That lets Axon own no speech model and no LLM integration on the spoken path, and concentrate entirely on the part that has to be trustworthy: what happens between a `tool.call` arriving and a `tool.result` going back.

Two properties of the API matter to the security model:
- Tools are declared **client-side**. Axon never registers a server-side HTTP tool, so every action the model proposes arrives on Axon's socket and goes through Axon's dispatcher. A test asserts no such tool can be emitted.
- The key stays in Axon's main process. It is never sent to the renderer, logged, or placed in an event.

## 6. Architecture

- **Electron + TypeScript**, Windows-first. `packages/core` holds pure contracts (zod schemas, the state machine, risk levels, task limits). `apps/desktop` holds the main process, a minimal preload bridge, and a sandboxed React renderer with the orb.
- **Voice**: a local wake word ("Hey / Hello / Hi Axon") runs in a dedicated on-device keyword spotter (sherpa-onnx, in a child process); no audio leaves the machine until a session is activated. An activated session streams microphone audio to AssemblyAI and plays reply audio back.
- **Tool bridge**: turns a `tool.call` into a dispatcher call, answers slow work truthfully as "in progress", defers approvals rather than holding the socket open, and delivers a result only if the task that asked for it still exists.
- **Task ledger**: one task per request, steps inside it, clarification that continues the same task, cancellation that ends it and prevents it resuming.
- **Tools (about two dozen)**: applications — a small trusted set, plus **any application discovered in the Start menu**, opened by name and always asked about first; windows (list, focus, minimise, maximise); the user's **own default browser** (identified from Windows' record, never assumed); Axon's own browser window (open, navigate, read, click, type, scroll, close); **reading any application's controls** through native Windows UI Automation, a page at a time or inside one control; accessibility-layer press and fill of an on-screen control; screen capture; the system clock; workspace file writes; approved memory; and **drawing** — after approval Axon opens a new Paint window and builds a simple scene up in it step by step through Paint's own Edit ▸ Paste, then reads the canvas back to verify it — no mouse automation, because Paint's canvas exposes no drawing interface to UI Automation ([DRAWING.md](DRAWING.md)). Image generation from any description has an interface but no configured provider, and says so.
- **State machine**: seven states — IDLE, LISTENING, THINKING, EXECUTING, WAITING_FOR_APPROVAL, SPEAKING, ERROR — with an explicit transition table the orb renders.

## 7. Security model

**Nothing outside Axon's control plane is authority.** Not the model, not AssemblyAI, not a web page, not the renderer.

Every proposal passes, in order:
1. **Schema** validation of the arguments.
2. **Preconditions** — including that any element or on-screen control reference comes from a fresh observation.
3. **Budget** — bounded actions per conversation and per task.
4. **Goal boundary** — a consequential destination the user did not ask for (a signup, a checkout) is escalated to a human.
5. **Sensitivity and risk** — credential-shaped text and password fields are refused outright, at every typing surface; the rest is classified SAFE, REQUIRES_APPROVAL, HIGH_RISK or FORBIDDEN.
6. **Policy** decision.
7. **Duplicate ledger** — a consequential action cannot run twice.
8. **Approval** — a human decides, on a dialog stating what, where, and the exact content; unanswered means denied.
9. **Re-bind** — the approval carries a fingerprint of the exact arguments, re-checked immediately before execution. Approving A cannot authorise A + B.
10. **Execution**, then **verification** from a fresh reading of the world.

Web page text reaches the model marked as untrusted content; instructions in it change nothing. There is no shell, no PowerShell tool, no synthetic keyboard or mouse input, no arbitrary file read, no demo mode and no auto-approve. A repository-wide audit test sweeps the source for all of these and for any path that skips the dispatcher.

`npm run attacks` runs nine attacks through the real pipeline — a shell, a private file read, a write outside the workspace, an invented tool, a password typed into a form, the page's own password field, a page announcing that approval is disabled, a detour to a signup page, and an approval answered for a different act than the one shown. None is allowed.

## 8. Demo flow

**The recorded demo** is [GOLDEN_DEMO.md](GOLDEN_DEMO.md): "Hey Axon." → "Who are you?" → "Open Spotify." (asks; allowed; verified by the owning process) → "What do you see in Spotify?" (read through UI Automation — no Spotify integration) → "Open YouTube in my browser." (the user's default browser) → "Open WhatsApp." (asks; **denied**; nothing runs) → an API key Axon refuses to type. Each beat was run end-to-end against the real AssemblyAI Voice Agent.

The longer, test-enforced stage script — three acts, twelve spoken lines (full script: [DEMO.md](DEMO.md)):

- **Capability** — "Open YouTube." "Search for AssemblyAI Voice Agent." Several verified steps from speech.
- **Context** — "Open the first result." If Axon cannot tell results apart it asks, and "The first one." continues the *same* task.
- **Desktop** — "Open Calculator." (launched and verified by looking for its window), "Calculate 125 times 48." (answered, not acted out), "What time is it?" (the machine's clock).
- **Safety** — "Open my internship application." "Tell me what I need." "Fill in everything you safely can, but don't submit." Name, email and university go in; the password field is refused outright. "Submit it." stops at *"Axon wants to click "Submit application" on …"*, is denied, and nothing is submitted.

## 9. Technical implementation

- AssemblyAI Voice Agent protocol over `wss://agents.assemblyai.com/v1/ws`: `session.update` with client-side tools, `tool.call` / `tool.result` flushed at `reply.done`, reconnect-and-resume on a dropped connection.
- Windows UI Automation through constant PowerShell programs with values passed out of band; the model never supplies code or selectors — only references Axon minted from its own observation.
- The browser is an Electron window with a hardened session; localhost and private addresses are refused.
- Evidence, not assertions:
  - 2,300+ automated tests, including a rehearsal of the exact stage script through the real orchestrator, bridge, dispatcher, policy and approval broker.
  - Real-Electron harnesses for tools, the desktop, the browser, the agent loop, persistence, voice input and the voice agent.
  - A live AssemblyAI smoke test with real synthesised speech over the real socket.
  - A preflight command, and a demo recording mode that stores decisions and timings, never content.

## 10. What makes Axon different

- **The model has no authority.** Capability comes from Axon, one call at a time.
- **Every result is verified** from a fresh reading — an app is "open" only when its window is on screen; a page is "loaded" only when Axon read it.
- **Honest about in-between states** — "in progress" is a real state, not a guess.
- **Approvals mean something** because they are rare and exact: filling a visible field asks nothing; submitting asks, with the destination named, and the approval is bound to those exact arguments.
- **Truthful about its limits**, in the product and in this document.

## 11. Current limitations

- **Wake word:** synthesised or loopback audio is not evidence for a human voice (both were measured to mislead), so the wake word is verified by a person at the microphone (`npm run wake:live`). Clicking the orb is the same activation.
- **Applications Axon can read** are those that expose their interface to Windows UI Automation. Chromium-based apps (Spotify) expose nothing while they have not rendered — a minimised, blank or display-asleep window reads as nearly empty, and Axon says so rather than guessing.
- **No vision:** screenshots are captured, but there is no vision model and the voice protocol has no image channel. Axon reads the screen through the accessibility tree.
- **No `keyboard.press`:** no keys, shortcuts or Enter. There is no synthetic input anywhere, so a form is submitted only by pressing its button, with approval.
- **Windows only.**
- **Reference resolution belongs to the model:** "it" and "the first one" are resolved by the model against facts Axon supplies; a wrong resolution produces a refused or approved action, never a silent one.
- **Live-web variability:** whether Axon asks "which one?" depends on whether real results are genuinely indistinguishable. Whether a search asks depends on the route the model takes: a form submission asks; opening a results address, or clicking a script-driven search button like YouTube's, is treated as an ordinary page action and does not.
- **The model can speak before the outcome on a slow network:** told an action is still in progress, it occasionally claims success anyway; Axon's verified outcome follows and corrects it.
- **An occasionally unannounced slow action:** when a page takes longer than the inline budget, the spoken outcome that should follow the acknowledgement is sometimes not spoken, although the action succeeded.

## 12. Future roadmap

- Packaging, signing and auto-update.
- A vision-capable observation provider, once a model that can receive images is on the path — added as a provider, not a bypass.
- Broader application registry and richer, still-bounded desktop verification.
- Multi-language cancellation phrases and wake word.
