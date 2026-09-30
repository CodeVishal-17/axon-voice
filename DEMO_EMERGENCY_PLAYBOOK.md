# Demo emergency playbook

You are never trapped. Every row below is a thing you can do in under five seconds.

| If… | Do this |
|---|---|
| "Hey Axon" doesn't open the orb | **Click the orb.** Same activation, different trigger. Don't repeat the phrase more than once. |
| Axon is doing the wrong thing | Say **"Stop."** It aborts, closes any dialog, and forgets the task. Then say the request again. |
| Axon says a page is open, then says it didn't load | **Believe the second sentence** and look at the window. On a slow network the model can speak before the outcome is known; Axon's own check comes after. Say the line again or move on. |
| Axon goes quiet after opening a page | Look at the browser window. If the page is open, **say the next line** — the action worked; only the sentence was lost. |
| Axon is silent for more than ~5 s and nothing happened | Say **"Stop."**, then repeat the request once. If still nothing, click the orb to end and start a new session. |
| YouTube won't load or search | Skip to **"Open Calculator."** The desktop act doesn't need the web. |
| The results page has no clear "first result" | Say **"Open the first result."** once; if Axon asks, answer; if it just opens one, move on. Don't force the question. |
| An approval dialog appears | Say out loud *why* it appeared (it's about to send something or act on your behalf), then **click Allow or Deny deliberately**. It expires into Deny if ignored. |
| The submit dialog appears | **Deny it.** Point at the page: nothing was submitted. That is the demo. |
| The orb turns red | Click the orb (or say "Hey Axon") to start a fresh session. The error clears. |
| The wifi drops briefly | Keep talking. Axon reconnects and resumes the same conversation. |
| The network is gone | Say "Open Calculator." and "What time is it?" — both are local. |
| The window looks frozen or you reloaded it | Wait two seconds; microphone sessions are ended cleanly and the wake word re-arms. Click the orb. |
| The orb closes by itself mid-demo | A misheard "bye" ends the conversation by design. Say **"Hey Axon"** again (or click the orb) and repeat the line. |
| "Open Spotify" is heard wrong | Say **"Open the Spotify app."** — a longer phrase survives transcription better. |
| Axon says it can't see anything in Spotify | Spotify hasn't rendered (low memory, or the display slept). **Don't retry on camera** — say "What time is it?" and move on. |
| Notepad opens showing `.env` | **Stop recording.** Close that tab. It contains your API key. (Check this before you start — see `docs/GOLDEN_DEMO.md`.) |
| Anything else | Click the orb to end the session, click it again to start a new one. Restarting the app is never the first move. |

Before walking on: `npm run preflight` must say **READY FOR DEMO**.
