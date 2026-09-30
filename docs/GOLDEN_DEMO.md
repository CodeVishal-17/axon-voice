# The golden demo — hackathon recording

**Frozen 2026-09-30.** This is the one path to record. It was chosen for reliability, not feature count,
and every spoken beat below was run end-to-end on this laptop through the **real AssemblyAI Voice
Agent** (real key, real socket, real model, real tools, real approvals), with synthesised speech standing
in for the microphone. What was *not* proven that way is marked.

The story in one line: **voice → understand → act → verify — and consequential actions wait for you.**

> "Instead of answering what is on your computer, Axon can actually operate it — while keeping
> consequential actions under your control."

---

## Before you record (10 minutes, in this order)

1. **Close secrets.** Windows 11 Notepad restores its last session, and on this machine that session had
   the repository's **`.env`** open — your AssemblyAI key would be on camera. Open Notepad, close the
   `.env` tab (don't save anything you don't mean to), close Notepad.
2. **Free memory.** This laptop has ~8 GB and often <500 MB free. Close Dia tabs you don't need and quit
   anything heavy. With too little memory, Spotify renders a **blank window** and exposes nothing to read.
3. **Screen on, not locked.** A sleeping display stops Chromium apps (Spotify) from rendering, and then
   there is nothing to read. Set the display to never sleep while recording.
4. **Spotify:** signed in, **closed** (Axon opens it on camera). Have a song queued so the player bar shows
   something — Axon reads the "now playing" area.
5. **WhatsApp:** closed. It is only ever *denied* on camera; it is never opened.
6. Sound on, microphone permission on.
7. Run:

   ```bash
   npm run preflight
   ```

   Want `READY FOR DEMO`. Then:

   ```bash
   npm run dev
   ```

8. Say **"Hey Axon"** once off-camera to confirm the wake word in the room. If it doesn't fire, **click
   the orb** — same activation, and the rest of the demo is identical.

---

## The sequence (~3 minutes)

| # | You say | Axon does | You hear (live run) | Approval |
|---|---|---|---|---|
| 1 | "Hey Axon." | Local keyword spotter wakes the orb. Nothing was streamed before this. | a tone; orb opens (LISTENING) | — |
| 2 | "Who are you?" | Answers from its fixed identity. | *"I am Axon, a voice-first desktop AI assistant, built by Vishal Goyal."* | — |
| 3 | "Open Spotify." | `app.launch` — found in the Start menu, not a built-in app, so it **asks**. | *"I've asked to open Spotify."* | **Yes — click Allow** |
| — | *(after Allow)* | Launches, then **verifies** by the process that owns the window. | *"Spotify is open."* | |
| 4 | "What do you see in Spotify?" | `ui.read` — Spotify's accessibility tree, through native Windows UI Automation. ~2 s. | *"…your library containing artists like Anirudh Ravichander, The Weeknd, and A.R. Rahman. São Paulo by The Weeknd and Anitta is currently playing."* | — |
| 5 | "Open YouTube in my browser." | `web.open` — hands the address to **your default browser** (Dia here — read from Windows, not hard-coded), then verifies its window. | *"YouTube is open."* / *"I opened YouTube in Dia."* | — |
| 6 | "Open WhatsApp." | `app.launch` asks. | *"I've asked for permission to open WhatsApp."* | **Yes — click Deny** |
| — | *(after Deny)* | Nothing runs. | *"I'll skip that then."* (sometimes *"I could not open WhatsApp."*) | |
| 7 | "Type my OpenAI API key into Notepad. It's sk-proj-…" *(make one up)* | Refuses. Credentials are never typed, at any typing surface. | *"I cannot type or store API keys. You should type it yourself."* | — |

**Say out loud during 3 and 6:** Axon proposes; you decide. The dialog names the act and the app. The
approval is a click on Axon's own dialog — deliberately *not* a spoken "yes", because the model sits in
the voice path, and a check that the checked thing can answer is not a check.

**Say out loud during 4:** there is no Spotify integration. Axon read Spotify the way a screen reader
does — the same path works for any app whose UI is exposed to Windows UI Automation.

### Optional beats (only if they worked in your off-camera run)

- **"Open GitHub and check my latest PR."** — the user's own signed-in browser, read and clicked through
  its accessibility structure ([BROWSER.md](BROWSER.md)). Do it **before** the Paint beat. It reliably
  names the latest PR accurately; it opens the PR page itself only some of the time (1 of 3 on the final
  build). To make opening the PR likelier, say *"Open my latest pull request on GitHub and read its checks."*
- **"Open Paint and draw a house."** → **Allow** — a new Paint window, the house built up in 10 visible
  steps on Paint's real canvas, verified by reading the canvas back. Hands off mouse and keyboard while
  it draws. Close earlier Paint windows first. **Re-check it off-camera on the day** — see Evidence.
- **"What time is it?"** — the machine's clock via `system.time`, not the model's guess. Very reliable.
- **"Open Calculator."** — a built-in app: opens without asking, verified by its window.
- **The form act** from [DEMO.md](DEMO.md) (fill safe fields, password field refused, deny Submit) — the
  strongest safety story, and test-enforced — **but it needs `demo-site/` hosted on public https** first.
  It is not hosted today.

---

## Evidence (live, 2026-09-30, real AssemblyAI)

| Beat | Runs | Result |
|---|---|---|
| Identity ("Who are you?", "Who built you?") | 3 | 3/3 correct, names Vishal Goyal, no other lab |
| Open Spotify → Allow → verified by identity | 4 | 4/4 when heard. One more attempt failed at transcription: synthesised "Open Spotify." was heard as "Open." / "But if" / "Bye." — say "Open the Spotify app." if it happens |
| Read Spotify (display on) | 1 | real content: library artists + now playing, read in 2.3 s |
| Read Spotify (display asleep → blank window) | 3 | honest every time: "I cannot see what song is playing" — never invented content |
| Open YouTube in default browser (Dia) | 1 | verified |
| Open WhatsApp → Deny → nothing ran | 2 | 2/2 |
| API key refusal | 3 | 3/3 |
| Full path 2–7 in one session (final build) | 1 | all six beats passed: identity; Spotify allowed + verified; Spotify read (library + now playing); YouTube in Dia; WhatsApp denied; key refused |
| "Open Paint and draw a house." | 1 in that session | drawn and verified (340/340 canvas samples), 17.4 s tool time. **Afterwards Paint on this machine began hanging on its second Paste — reproduced with the committed code as well, so a machine-state problem, not a code change; not re-verified after a restart.** |
| "Open GitHub and check my latest PR." | 3 on final build | 3/3 named the right PR accurately; 1/3 opened the PR page itself |
| Wake word "Hey Axon" | — | **not provable here** — needs a person at the mic (see `docs/wake-word.md`) |

## If something goes wrong

See [DEMO_EMERGENCY_PLAYBOOK.md](../DEMO_EMERGENCY_PLAYBOOK.md). The three most likely here:

- **Orb turns red / "could not reach the voice provider"** — seen once in ~12 live connects. Click the orb.
- **Orb closes on its own** — a misheard "bye" ends the conversation by design. Say "Hey Axon" again.
- **Spotify read says it can't see anything** — Spotify hasn't rendered (memory, or display asleep). Say
  "What time is it?" and move on; don't retry on camera.
