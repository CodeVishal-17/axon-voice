# Drawing

Two tools, one principle: **the model supplies words; Axon supplies everything else.**

| Tool | What it does | State |
|---|---|---|
| `draw.paint` | Opens a **new** Paint window and builds the drawing up in it, step by step, on Paint's real canvas | **Working** — verified live through AssemblyAI, 2026-09-30 |
| `draw.generate` | Creates an image of anything from a description | **Not configured** — there is no image service in this repository, and it says so |

## What you can say

| You say | Axon does |
|---|---|
| "Open Paint and draw a house." | Asks to open Paint → a new blank Paint window opens → sky and ground, walls, roof, door, windows, sun, chimney, smoke, a cloud and a tree appear one after another → *"I've finished drawing a house in Paint."* |
| "Draw a cat in Paint." / "Open Paint and draw a simple sunset." / "…a tree" | The same, with that subject's own fixed plan. |
| "…at sunset" / "…at night" | House, cat and tree take a sunset or night sky. |
| "Draw a dragon in Paint." | Refused before any dialog: Axon can draw a house, a sunset, a cat or a tree. |
| "Draw me a cyberpunk city." | `draw.generate` → *"Image generation isn't configured yet."* Nothing is created or claimed. |

## Is it stroke-by-stroke? No — and why

**Measured with Axon's own UI Automation engine:** every Paint tool, shape and colour is exposed as a control
and can be *selected* — but the canvas itself is a `Group` ("Using Brush tool on Canvas") with **no actions
and no patterns**. Putting a line or a shape onto it needs a pointer drag at screen coordinates, i.e.
synthetic mouse input. Axon has none anywhere (`security-audit.test.ts` sweeps for `SendInput`,
`SetCursorPos`, `mouse_event`, `keybd_event`) and this feature does not add any.

**Paint's canvas does not expose a safe semantic drawing interface.** The one canvas-changing operation it
exposes as a control is **Edit ▸ Paste**. So Axon draws the way it safely can: each step of a fixed plan is
rendered by Axon to a whole picture, placed on the clipboard, and pasted by pressing Paint's own Paste item
through UI Automation. The audience watches Paint's actual canvas change step by step — it is progressive
drawing on the real Paint canvas, not brush strokes.

### Real brush / pointer movement — investigated, not implemented

Every Windows mechanism that moves a visible pointer or makes a brush stroke on Paint's canvas is
**synthetic input delivered to whatever is under the pointer at that instant**, not to a chosen window:

| Mechanism | Why it is not safe here |
|---|---|
| `SetCursorPos` + `SendInput` (mouse down / move / up) | Input goes to the window under the cursor when it is delivered. A toast, a dialog, or the user's own hand between Axon's check and the event turns a drag into a drag in *another* application. There is no "only into this window" form of it. |
| Synthetic pointer injection (`InjectSyntheticPointerInput`) | Same: screen-coordinate input, delivered to whatever is there. |
| Posting `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` to Paint's window | Cross-process message injection (the engine's security test forbids `SendMessage` / `PostMessage`); it would not move a visible pointer either, and Store Paint's canvas is a composition surface that does not promise to honour posted mouse messages. |
| UI Automation on the canvas | The canvas exposes no pattern at all (measured). |
| `ClipCursor` to confine the pointer | Confines where the pointer goes, not which window receives the click — a window that appears over the canvas still receives it. |

Clamping the coordinates to a verified canvas and re-checking the target between events narrows the race
but cannot close it, and closing it is the security property. So Axon keeps its rule: **no coordinate
input anywhere** (`SendInput`, `SetCursorPos`, `mouse_event`, `keybd_event` remain absent and tested
absent), and draws with Paint's own Paste, which acts only on the window Axon launched.

## How it works

```
voice ─▶ AssemblyAI Voice Agent ─▶ tool.call draw.paint { subject: "a house" }
                                         │
                   Axon dispatcher (the one door every tool uses)
                     schema (strict) ─ precheck ─ risk ─ APPROVAL ─ execute
                                                                     │
   plan: the scene's FIXED steps, each rendered to a picture (step N = steps 1..N)
   open: Paint, the way the Start menu opens it; wait for a NEW window owned by Paint's package
   ready: Paint's Edit menu readable in that window
   for each step:  clipboard ← picture ; Edit ▸ expand ; Paste ▸ invoke ; pause ~180 ms
   verify: Edit ▸ Copy visible layers ; read the clipboard back ; compare with the plan
   restore: the user's clipboard, as it was
```

- **Plans** (`apps/desktop/src/main/draw/drawing.ts`): four subjects, each an ordered list of named steps
  (house: 10; sunset: 6; cat: 8–9; tree: 5–6), every coordinate a constant, at most `MAX_DRAW_STEPS` (12).
  Frames are rendered before Paint is touched.
- **Paint** is found in the Start-menu catalog (exact name "Paint" first; two exact matches is a refusal, not
  a guess) and started through the existing launcher. Axon draws only in the window that **appeared after**
  it launched Paint and is owned by Paint's package — never in a Paint window you already had open.
- **The only controls touched**, only inside that window: the `Edit` menu item (expand), `Paste` (invoke),
  and once, `Copy visible layers` (invoke). If something else takes the foreground, Paint's menu closes
  itself; Axon brings its own Paint window forward once and retries that step.

## Timing (live)

About 25 s from **Allow** to the spoken result: ~6 s for Paint to open, ~6 s until its menu answers,
**~13 s of visible drawing** (10 steps, ~1.2–1.3 s each — Paint's Paste itself takes ~1 s), ~2 s to verify.
The visible drawing is longer than a 5–10 s target because each Paste is Paint's own speed; it is not padded.

## Verification — nothing is claimed that was not checked

Success requires **all** of:

- every step's Paste pressed successfully;
- Paint's own **Copy visible layers**, read back from the clipboard, matching Axon's plan at ≥ 90 % of 340
  fixed sample points (live: 340/340);
- the window still existing and still owned by Paint's package.

Otherwise: *"I started drawing, but I couldn't verify that Paint finished it."* (with how many steps
landed). The result also reports whether Paint was in the foreground at the end.

## Security model

- **Strict schemas.** `draw.paint` accepts `subject` and `style` only. Coordinates, points, steps, handles,
  process ids, paths or applications are `INVALID_INPUT` — rejected, not dropped. Path- or program-shaped
  text in the subject is `FORBIDDEN`.
- **No mouse, no keyboard, no coordinates.** Only UI Automation expand/invoke on three named menu items, by
  Axon's own identity for them, through the existing native engine.
- **The existing approval**, through the one dispatcher and broker. The dialog says Paint, the drawing, and
  that each step goes through the clipboard. Denied means: no Paint, no clipboard write, no paste.
- **Your clipboard** is saved before the first step and restored afterwards — on success and on failure. It
  is held in memory only and never read, logged or sent. If it cannot be put back, the clipboard is left
  **empty** — never holding Axon's drawing — and the result says so (`clipboard: "restored"` or
  `"emptied: …"`).
  *Found live on 2026-09-30:* Electron 44's `clipboard.write` refuses the very items `clipboard.read`
  returned, the failure was swallowed, and Paint's copy of the drawing stayed on the clipboard. Fixed: the
  snapshot now copies the data and restore builds new items (all formats, else the standard ones, else
  empty); tests cover a refused and a failed restore.
- **What the model is told:** the drawing, its step names, and the verification. Never a window handle,
  runtime id, process id or AppID.

## Image generation

`draw.generate` has a provider interface (`apps/desktop/src/main/draw/image-provider.ts`) and no provider.
With one configured, it would ask first (the description leaves the machine), never repeat the provider's
error text, and save only real PNG bytes through `DrawingStore` (`AXON_HOME/drawings`, names Axon chooses,
never overwriting).

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `AXON_DRAW_ENABLED` | on | `false` / `0` / `off` removes both drawing tools. |

## Known limitations

- Progressive layered pasting, not strokes (see above). Four subjects only.
- English Paint menu labels (`Edit`, `Paste`, `Copy visible layers`); another display language is refused
  as "menu not readable" rather than guessed.
- Store Paint (Windows 11) only.
- The last pasted step stays as Paint's active selection until you click the canvas.
- During drawing Axon owns the clipboard for ~15 s; anything you copy in that window is replaced when your
  earlier clipboard is restored.

## Manual demo

```bash
npm run dev
```

Say "Hey Axon", then **"Open Paint and draw a house."** Click **Allow**, and keep your hands off the
keyboard and mouse while it draws (switching windows makes Paint's menu close; Axon recovers once per step).
