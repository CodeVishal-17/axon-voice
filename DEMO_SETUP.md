# Demo setup

Everything needed to run the Axon demo on a Windows machine, in order. No secrets appear here or anywhere in the repository.

## 1. Install

- Windows 10 or 11, with **Calculator** and **Notepad** installed (they are by default).
- Node.js **20.19 or newer**.

```bash
npm install
```

## 2. Configure

Copy `.env.example` to `.env` in the repository root and set **one** value:

| Variable | Required | Notes |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | **yes** | The voice agent. Never printed, logged or sent to the window. |
| `AXON_VOICE_AGENT_PROVIDER` | no | Leave as `assemblyai`. |
| `AXON_STT_PROVIDER` | no | Leave as `windows` — this is the local wake-word recognizer. |
| `AXON_TTS_PROVIDER` | no | Leave as `sapi`. |
| `ANTHROPIC_API_KEY` | no | Only for typing to Axon. The spoken demo does not use it. |
| `AXON_APPROVAL_TIMEOUT_MS` | no | Default 60000. An unanswered approval becomes a denial. |

**Windows permissions**

- Settings → Privacy & security → Microphone: **Microphone access** on, and **Let desktop apps access your microphone** on.
- The Windows speech recognizer must have an installed English (US or UK) speech language. The wake word needs it; clicking the orb does not.
- Sound output on, and not muted.

**Network**

Outbound HTTPS (port 443) to:
- `agents.assemblyai.com` (the voice agent; a WebSocket)
- `www.youtube.com` (Act I)
- wherever you host the demo application page (Act III, below)

**Browser state**

Axon uses **its own browser window**, not Chrome or Edge, with its own profile. No sign-in is needed. If YouTube shows a cookie-consent screen in your region, open YouTube once in Axon's window before the demo and dismiss it by hand — Axon will not accept terms on your behalf.

**Demo application page (Act III)**

`careers.example.com` exists only inside the test suite. For the live demo, host the static folder `demo-site/` somewhere public over **https** — GitHub Pages is enough — so that this page loads:

```
https://<your-host>/<path>/internship/apply/
```

It has the same fields as the rehearsed page, a real password field, and no script. Axon refuses local and private addresses by design, so a `localhost` copy will not work and that is not relaxed for the demo.

Axon does not know where "my internship application" is. On stage, **say the address** as part of beat 9 — for example *"Open my internship application at <your-host>/internship."* — rather than relying on the model to guess.

## 3. Preflight

```bash
npm run preflight
```

You want the last line to read **READY FOR DEMO**. The line `Renderer — no window in preflight` is expected. Any ✗ is a real problem.

Optional, on the same machine:

```bash
npm run rehearse
```

```bash
npm run attacks
```

## 4. Launch

```bash
npm run dev
```

To also write a demo recording (timing, steps and approvals only — no audio, no arguments, no secrets) to `%USERPROFILE%\Axon\logs\demo-recording.jsonl` when you quit, launch from PowerShell with:

```powershell
$env:AXON_DEMO_RECORDING='1'; npm run dev
```

## 5. Wake-word check

In the room, a metre from the laptop, at normal volume: say **"Hey Axon."** The orb should open within about a second. Close the session and repeat with **"Hello Axon."** and **"Hi Axon."** Say "Hey Alex" — nothing should happen.

Say the name **on its own**, then the request: "Hey Axon." … "Open Calculator." Axon deliberately does not wake on "Hey Axon, open Calculator" in one breath, or on a sentence that mentions it.

For a guided check that also prints what Windows heard for each phrase, and totals over repeated attempts, with Axon started as it is at sign-in (no window):

```powershell
$env:AXON_WAKE_LIVE_RUNS='5'; $env:AXON_WAKE_LIVE_BACKGROUND='1'; npm run wake:live
```

It asks you to say the three wake phrases and three things that must not wake Axon, five times over. It reports "Hey Axon" recognition and false activations as X/Y, and whether the orb appeared each time. To see the same diagnostics while running the app normally, launch the development build with `$env:AXON_WAKE_DEBUG='1'; npm run dev`. Neither records audio.

**Background and startup.** Closing Axon's window does not stop it listening for its name; use **Quit Axon** in the tray. To have Axon ready after a reboot with nothing open, run `npm run build` once, then turn on **Settings → Wake word → Start Axon when I sign in** (or **Start with Windows** in the tray). It is a per-user entry, visible in Task Manager's Startup tab.

If the wake word will not fire in the room, **click the orb**. It is the same activation.

## 6. Canonical demo

The full script, with what you should hear and see, is [docs/DEMO.md](docs/DEMO.md). The twelve lines:

1. "Hey Axon."
2. "Open YouTube."
3. "Search for AssemblyAI Voice Agent."
4. "Open the first result."
5. "The first one."
6. "Open Calculator."
7. "Calculate 125 times 48."
8. "What time is it?"
9. "Open my internship application." *(say the address — see §2)*
10. "Tell me what I need."
11. "Fill in everything you safely can, but don't submit."
12. "Submit it." — **deny** the approval.

Three things that depend on the live service, stated plainly:
- **Beat 3** may or may not ask. Live runs saw all three: typing into YouTube's search box and submitting (asks); opening a results address directly (a page load — asks nothing); and typing the query then clicking YouTube's search icon, which is a script-driven button rather than a form submission, so Axon treats it as an ordinary click (asks nothing). The approval that is guaranteed is beat 12's.
- **Beats 4–5**: Axon asks "which one?" only when it genuinely cannot tell results apart. Real YouTube results usually have different titles, so it will often just open the first one — skip beat 5 when it does.
- **On a slow network** the model can say "GitHub is open." before the navigation has finished, even though Axon told it the outcome was not known yet; Axon's verified outcome then follows ("GitHub did not load, so I stopped."). Seen once, on an 11.5-second navigation. Trust the second sentence.
- **After a slow page load** Axon occasionally says nothing at all (seen once in four live runs on YouTube, and once more on GitHub, where it said only "Opening GitHub."). The page is open; glance at the browser window and carry on with the next line.

## 7. Recovery

See [DEMO_EMERGENCY_PLAYBOOK.md](DEMO_EMERGENCY_PLAYBOOK.md). The short version: **"Stop."** resets a task, **clicking the orb** starts a fresh session, and restarting the app is never the first move.
