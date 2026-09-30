# The wake word

Why Axon's wake detector was replaced, what replaced it, what was measured, and
what has not been measured yet.

---

## The failure that started this

The first wake word used the Windows `System.Speech.Recognition` engine with a
fixed grammar. It passed its unit tests. It passed a grammar test. It passed an
acoustic loopback test with a synthesised voice played through the speakers.

Then a person spoke into a real microphone:

| Prompt | Result |
|---|---|
| "Hey Axon" | 0/5 |
| "Hello Axon" | 0/5 |
| "Hi Axon" | 0/5 |
| **Positive recognition** | **0/15** |
| "I was talking about Axon yesterday" | 0/5 false activations |
| "Axon" | 0/5 false activations |
| "Hey" | 0/5 false activations |
| **False activation** | **0/15** |

The microphone pipeline was fine — 16 kHz, 16-bit, mono audio reached the
recognizer, which detected speech repeatedly. The engine simply did not hear
the phrase.

The available response was **not** to lower the confidence floor. That would
have traded the one property the measurement did establish — zero false
activations — for a chance at the one it did not. The response was to change
the engine, because a general-purpose dictation engine constrained by a grammar
is not a keyword detector, and asking it to be one is a category error.

---

## The engines that were weighed

| Engine | Local | Windows | Custom phrase | Licence | Verdict |
|---|---|---|---|---|---|
| **sherpa-onnx KWS** (zipformer-gigaspeech-3.3M) | yes | prebuilt N-API addon | **no training — word pieces at runtime** | Apache-2.0 (runtime and model) | **chosen** |
| Picovoice Porcupine | inference yes | yes | cloud console training | AccessKey required, metered free tier | rejected |
| openWakeWord | yes | Python runtime | GPU-hours of synthetic training | Apache-2.0 | rejected for this milestone |
| Vosk + phrase grammar | yes | `ffi-napi`, broken on Node 20 | yes, at runtime | Apache-2.0 | rejected |
| whisper.cpp | yes | native build | n/a — general ASR | MIT | rejected |
| Windows `System.Speech` | yes | built in | grammar | OS | kept as control arm, not default |

The deciding properties for the winner:

- **It is a detector, not a recognizer.** A transducer trained for keyword
  spotting, which emits nothing at all when the phrase is not said.
- **A custom phrase needs no training.** It is told which word pieces to watch
  for. `HEY AXON` tokenizes to `▁HE Y ▁A X ON` under the model's own
  tokenizer — exactly the shape of the published `HEY SIRI` example.
- **Nothing leaves the machine and nothing needs an account.** No access key, no
  telemetry, no endpoint, no metering.
- **It loads under Electron unmodified**, because `sherpa-onnx-node` is N-API
  and N-API is ABI-stable. No native rebuild on the demo machine.
- **Measured real-time factor 0.032** — about 3% of one core, affordable for a
  process that runs from sign-in to shutdown.

Rejecting Porcupine was a licensing call, not a quality one. Rejecting
openWakeWord was a schedule call: it is the right next move if the spotter's
recall on human voices turns out to be inadequate, and that is a measurement
away rather than a guess.

---

## How it is built

```
renderer (the one page that opens the microphone)
      │  16 kHz, 16-bit, mono Int16 frames
      ▼
orchestrator ──► WakeDetector.pushFrame()
                      │
                      ▼
            KeywordWakeDetector        pure: refractory window, span guard
                      │
                      ▼
            SherpaKeywordEngine        one child process, restart policy
                      │  raw PCM on stdin
                      ▼
            kws-host.js                the ONLY file that touches the model
                      │
                      ▼
              WAKE hey_axon 4200 5000 130
```

Two implementations behind one `WakeDetector` interface, so the lifecycle
exists once:

```
WakeDetector
 ├── WakeWordDetector          Windows System.Speech  (control arm)
 └── KeywordWakeDetector       dedicated local spotter (default)
```

`create-wake-detector.ts` is the only place an engine is named.
`AXON_WAKE_ENGINE` selects between `keyword` (default), `windows` and `none`.
A spotter that cannot run reports itself unavailable and says why — it does
**not** silently fall back to the engine that already failed a human test,
because that would leave Axon looking as though it were listening.

### Why the spotter is a separate process

Three reasons, and the third decided it.

- **Credentials.** Main holds the AssemblyAI and Anthropic keys. The spotter
  runs for hours with a microphone open, so it is the process that should hold
  nothing worth taking. It is spawned with a six-name environment allowlist and
  neither key is on it.
- **Capability.** In-process, "the wake detector cannot execute tools" would be
  a promise about code review. Here it is a promise about an operating system:
  the program's entire vocabulary is "read bytes from stdin, write one of three
  line shapes to stdout".
- **Crashes.** The spotter is a native ONNX runtime. A native fault in main
  takes Axon down with it; a native fault in a child is an exit code the parent
  restarts with bounded backoff.

### What crosses the boundary

```
in   raw 16-bit little-endian mono PCM at 16 kHz, on stdin, and nothing else
out  READY <runtime> <threshold>
     WAKE <keywordId> <startMs> <endMs> <behindMs>
     ERR <code> <message>
```

`behindMs` is how far behind live audio the spotter was when it fired — zero
when it is keeping up. It is deliberately not end-of-phrase latency: that was
tried and produced an eighteen-second "latency" for a phrase spotted
immediately, because the spotter's `start_time` and timestamps are relative to
an origin the host cannot observe. `startMs` and `endMs` are used only as a
span, which is origin-independent.

`WAKE` is the whole wake event. It carries no transcript, because a keyword
spotter produces none.

### Why "Axon" alone cannot wake Axon

Not a rule applied to text afterwards — a property of what the model watches
for:

| Phrase | Word pieces |
|---|---|
| Hey Axon | `▁HE Y ▁A X ON` |
| Hello Axon | `▁HE LL O ▁A X ON` |
| Hi Axon | `▁HI ▁A X ON` |
| *Axon* (the bare name) | `▁A X ON` — **a prefix of none of the above** |

Every keyword begins with a greeting piece. There is no path through the
detector that fires on the name by itself. `keyword-wake.test.ts` asserts this
as a property of the constants rather than as a behaviour of the model.

---

## Threshold calibration

### The first measurement, and why it was wrong

A first pass fed each phrase to the spotter once and reported 6/6 positives and
0/22 false activations at every threshold from 0.15 to 0.50, which suggested a
comfortable default around 0.25.

It was wrong. It tested each utterance at **one alignment**. The encoder
consumes audio in fixed chunks, so where a phrase lands relative to a chunk
boundary changes whether it is detected — and on a live microphone that
alignment is arbitrary. Re-running each utterance at eight offsets across one
chunk turned "6/6" at threshold 0.25 into **13/16**.

### The honest table

Two synthesised voices × three speaking rates × eight audio alignments, against
the brief's thirteen negatives and a set of adversarial greeting-plus-name near
misses.

| threshold | "Hey Axon" | all phrases | brief negatives | near misses |
|---|---|---|---|---|
| 0.02 | 48/48 · 100% | 131/144 · 91% | 0/624 | 1/624 |
| **0.05** | **48/48 · 100%** | **131/144 · 91%** | **0/624** | **1/624** |
| 0.10 | 47/48 · 98% | 127/144 · 88% | 0/624 | 1/624 |
| 0.15 | 47/48 · 98% | 123/144 · 85% | 0/624 | 1/624 |
| 0.20 | 44/48 · 92% | 119/144 · 83% | 0/624 | 1/624 |

Read the last two columns first, because they are the surprise: **precision is
flat**. Raising the threshold across this whole range buys nothing against
false activation and costs recall monotonically. So the default sits at the
bottom, where recall is perfect — 0.05 rather than 0.02 only because a floor of
nearly nothing is not a floor.

Two other knobs were tried and left alone, because measurement said to:

- **Boost score 3.0** made recall *worse* (16/16 → 15/16 at threshold 0.10;
  13/16 → 10/16 at 0.25) with no precision gain. Stays at 2.0.
- **Two trailing blanks** changed nothing at all at any threshold. Stays at 1.

### The one false activation

The same utterance every time: **"Hey Jackson"**, said quickly by one voice. It
survives every threshold from 0.02 to 0.20, so it is not a threshold problem —
it is what an acoustic near-miss looks like. It is reported here rather than
buried, it is **not** on the brief's negative list, and it is now a permanent
prompt in both the live test and the calibration set so that no future change
can quietly make it worse.

The honest alternative to reporting it would have been to raise the threshold
until that row read zero, at which point the recall column would have quietly
collapsed. That is exactly the move the brief forbids.

### Calibrating on a real microphone without recording anybody

The natural way to sweep a threshold is to record the phrase and replay it at
each setting. Axon does not record anybody, and that rule has no exception for
measurement.

So the sweep runs sideways. `npm run wake:calibrate` starts **several spotters
at once**, at different thresholds, and hands every one of them the same live
microphone frames as they arrive. One utterance produces one row of the table
rather than one cell of it. Nothing is stored, and at the end of the session
there is no recording to delete because there never was one. Only the first arm
— the shipping default — can actually wake Axon; the rest are observers.

Cost: one speech model per threshold, ~3% of one core each. It is a session a
developer starts, never something Axon does on its own.

---

## Security properties

The wake detector:

- runs entirely locally, and `architecture.test.ts` holds a **per-file import
  allowlist** for every file in `main/wake/` — in both directions, so a new
  file with no rule fails rather than inheriting none;
- has no network module on any of those allowlists (`ws`, `node:net`,
  `node:http`, `node:https`, `node:tls`, `node:dgram`, `node:dns`);
- persists no raw audio, writes no raw audio to disk, and logs no raw audio —
  the only file the spotter process ever writes is a three-line keywords list
  in a `mkdtemp` directory it deletes before it starts listening;
- holds no AssemblyAI or Anthropic credential: six environment names, and
  neither key is among them;
- has no tool execution, no shell, no browser, no filesystem tool, no
  privileged OS handle, and no IPC to the renderer;
- makes no policy decision — it emits one bounded event and the orchestrator
  decides everything that follows;
- is not imported by the agent subsystem, and does not import it.

The keywords file is written into a private temporary directory rather than
kept beside the model on purpose: a wake phrase that lives in a file on disk is
a wake phrase an installer could edit. The only place the phrase exists is
`wake-keywords.ts`.

### Failure behaviour

| What happens | What Axon does |
|---|---|
| The spotter process dies | Restarted with backoff (0.5s → 8s), five attempts; the counter is forgiven after a minute of health |
| The budget is exhausted | Reports "Axon could not keep the wake-word engine running", disarms, and says so in the tray — it does not respawn forever |
| The model is not installed | `available: false` with "Run `npm run wake:model`"; Axon runs normally and does not pretend to listen |
| The microphone stops arriving | `starvedOfAudio: true` in the status. The detector does not own the microphone, so it says so rather than pretending to recover something it does not hold |
| The native runtime faults | An exit code in a child process. Main is untouched |

---

## "3629 ms behind live audio" — what it really was

A human `wake:live` run reported the spotter 3.6 s behind and 39 frames dropped.
It was measured hop by hop before anything changed (`AXON_WAKE_DEBUG=1` now
prints all of these):

| Hop | Before | After |
|---|---|---|
| Capture page | real time for ~30 s, then the AudioContext's own clock ran at **66 %** (1344 ms audio per 2040 ms) | `track-processor`, 48 kHz → 16 kHz, real time for 75 s straight |
| Main | ~650 ms of audio per second | ~1000 ms/s |
| Spotter decode | ~4 ms per 100 ms block — never the bottleneck | unchanged |
| Spotter queue | decoded inside the stdin handler; parent dropped the NEWEST frames when the pipe filled | bounded 500 ms queue, drops the OLDEST; 0 dropped |

The cause was upstream of the detector. Capture ran through a
`ScriptProcessorNode`, which must be connected to the speakers, so it was wired
at zero gain — an output that is always silent. After 30 s of silent output
Chromium suspends the sink and drives rendering from a coarse fallback timer,
which on this machine ran a third slow; the microphone FIFO overflowed and a
third of the audio was lost. The old backlog metric (wall time since the model
loaded minus audio consumed) booked that missing audio as "behind".

Capture now reads the track with `MediaStreamTrackProcessor` (no output sink in
the path) and converts once, in `resampler.ts`, with a windowed-sinc low-pass.
`behindMs` is now the age of the audio block that completed the phrase. It
reads a steady ~140 ms: a 100 ms model block waiting for its last 64 ms capture
frame. That is framing, and it does not grow.

The same capture code feeds AssemblyAI, so the fix applies to active voice too.

## Acoustic loopback does not work on this machine, and that was isolated

`npm run wake:live -- --loopback` plays each phrase through the speakers and
lets the microphone hear it. On this machine the keyword spotter scored **0/3**
on the three wake phrases in loopback, with zero false activations, while the
microphone reported healthy peak levels (0.05-0.19, against 0.02 idle) and the
spotter process sat at 4% of one core with no restarts.

That is an alarming-looking number, so it was isolated before being believed.
The same loopback was run again with `AXON_WAKE_ENGINE=windows` - the original
Windows recognizer, same app, same window, same capture path:

| Engine | Loopback positives | Microphone levels |
|---|---|---|
| Keyword spotter | 0/3 | healthy |
| Windows recognizer (control) | 0/3 | healthy |

**Both detectors score zero.** The variable is not the detector; it is the
channel. Axon opens the microphone with `echoCancellation`,
`noiseSuppression` and `autoGainControl` enabled, and echo cancellation exists
precisely to remove audio that this machine is playing. A laptop speaking to
itself is the exact case it is built to suppress.

Those flags stay on. They are why Axon can hear you interrupt it while it is
speaking, and for a human voice there is no reference signal to cancel, so the
human test is unaffected. What changed instead is the harness: loopback is now
reported as a **smoke test** - it proves the app starts, arms, captures and
reports - and it refuses to print a target line or to let its recall column
decide an exit code. A number that measures an echo canceller must not be
presented next to the word "target".

---

## Isolating the human miss: the focus diagnostic

A human test after the real-time fix scored "Hey Axon" 0/3, "Hello Axon" 0/3,
"Hi Axon" 0/3, with 0/60 false wakes, on a pipeline measured healthy. The
remaining failure is at the model/detection boundary, and it is measured, not
tuned:

```powershell
$env:AXON_WAKE_FOCUS='hey_axon'; $env:AXON_WAKE_DEBUG='1'; npm run wake:live
```

### The spotter exposes no score

sherpa-onnx's `KeywordResult` holds `keyword`, `tokens`, `timestamps` and
`start_time` — no score, and nothing at all below threshold. "Candidate at 0.31"
cannot be read out of it. So a **second** local spotter process runs beside the
untouched production one, on the same live frames, recording nothing:

| Instrument | What it answers |
|---|---|
| **Threshold ladder** — 8 spotters at 0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.40, 0.50 | Is there a candidate at all; which score bracket |
| **Alignment fan** — 4 streams at the production threshold, offset 0/80/160/240 ms | Does the phrase's position inside the model's **320 ms** decode chunk decide detection (chunk length measured: `isReady` every 5120 samples) |
| **Free decode** — the same acoustic model as a streaming recognizer, greedy search | Which word pieces the model actually emits, with a log-probability each |

Each utterance is classified `DETECTED`, `BELOW_THRESHOLD`,
`MISSED_BY_ALIGNMENT`, `NO_CANDIDATE`, or `INVALID` (the diagnostic dropped
audio). The diagnostic runs at RTF ~0.4 (8 alignment offsets was ~0.5 with p95 at
real time, and two inference threads were *slower*, so the fan is 4).

It also silently measures the room first — decoded **word count** and level,
never the words — and flags utterances with extra speech as confounded. With
default processing that check hears what the detector hears, so noise
suppression can hide background speech from it.

### Runtime configuration: verified

From the running spotter, not from the constants: runtime 1.13.8, onnxruntime
1.28.2, 16 kHz, 80-dim features, 320 ms decode chunk, boost 2.0, 1 trailing
blank, beam 4; model files by byte size; pieces
`▁HE=49 Y=17 ▁A=6 X=193 ON=78` all present in `tokens.txt`; every ladder
keywords file written, read back, and byte-identical in its pieces.

### Measured without a human voice

| Condition | "Hey Axon" | Notes |
|---|---|---|
| Synthetic, digital 16 kHz, 2 voices × 3 rates | **6/6**, 4/4 offsets | scores 0.2 – ≥0.5; free decode often "HEY XAN" / "PAY AXON" — pieces missing yet the keyword path still found |
| Same, synthesised at 48 kHz → `StreamingResampler` → 16 kHz | **6/6**, 4/4 offsets | resampler cleared |
| Hard negatives, digital | 0 candidates at 0.01 | "Hey Jackson" decoded as "HAY JACKSON"; offline at another alignment as "HAJAXON" |
| Speakers → real mic, `ec=off`, full volume | 2/4 | **clipping** (peak 1.0); fired at only 1–3 of 4 offsets |
| Speakers → real mic, `ec=off`, volume 35, no clipping | **0/8**, no candidate at any rung or offset | `▁HE`/`Y` missing from the free decode 8/8 |
| Speakers → real mic, `ec=off,ns=off` | 1/8 | **confounded**: free decode full of unrelated speech in the room |

What this does and does not show. Digital input — including the real
resampler — is detected robustly. The same speech through the speakers, the
room and the laptop microphone mostly is not, and the model stops hearing
"HEY". But the acoustic runs were not controlled: clipping in one, competing
room speech (revealed only when noise suppression was off) in another, and
laptop speakers are not a mouth. The `agc=off` variant was not run under those
conditions. **None of this establishes the cause for a human speaker.**

---

## What is NOT established

**Human microphone performance is the source of truth, and it has not been
measured yet** — by the focus diagnostic in a quiet room, per preprocessing
variant:

```powershell
$env:AXON_WAKE_FOCUS='hey_axon'; $env:AXON_WAKE_DEBUG='1'
npm run wake:live                                    # default
$env:AXON_CAPTURE_PROCESSING='ec=off';  npm run wake:live
$env:AXON_CAPTURE_PROCESSING='ns=off';  npm run wake:live
$env:AXON_CAPTURE_PROCESSING='agc=off'; npm run wake:live
```

Earlier, before any of the fixes above:

Everything in this document was measured on synthesised speech and on unit
tests. The engine this replaced passed exactly that kind of evidence and then
scored 0/15 on a person. So none of the following counts:

- unit tests passing
- synthetic speech passing
- generated audio passing
- a mocked microphone passing
- a grammar or tokenizer test passing

The wake word is proven when, and only when, this reports the targets:

```bash
npm run wake:live
```

with, for a real result:

```powershell
$env:AXON_WAKE_LIVE_RUNS='10'
$env:AXON_WAKE_LIVE_BACKGROUND='1'
npm run wake:live
```

Targets: **≥ 90% recall on "Hey Axon"**, and **0 false activations**. The
harness prints both against the target, plus detector latency, CPU, memory,
microphone format, engine and threshold, and it refuses to let a loopback run
be mistaken for a human one — a synthesised run says so in its own report.
