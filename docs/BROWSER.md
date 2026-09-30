# The browser control plane — your own browser, as a semantic surface

Axon can open a page in **your default browser** and then read it, find things on it, follow links, fill
fields and scroll — generically, on any site, with no site-specific code:

| Tool | What it does | Needs approval |
|---|---|---|
| `web.open` | Opens an address in your default browser (existing) | no — URL policy applies |
| `web.read` | The page's title, address, text (fenced as untrusted, in parts) and its links / buttons / fields as references `t12` | no |
| `web.find` | Lines of text and controls whose names contain some words | no |
| `web.click` | Follows a link / tab / row, or presses a button, by reference; then reads the page again, reports what changed, and returns the page it landed on (text + fresh references) | links: no · buttons and consequential labels: **yes** |
| `web.type` | Puts text into a field by reference; never submits | no — passwords and credential-shaped text are **refused** |
| `web.scroll` | Down or up by one screen | no |

Axon's own separate browser window (`browser.*`) is unchanged and is used for public pages and the rehearsed
stage demo.

## Investigation (2026-09-30, this machine)

| Question | Finding |
|---|---|
| Default browser | **Dia 0.28** (Chromium 154), a Microsoft Store package |
| How Axon opens it | `web.open` hands the address to Windows, which gives it to the default browser |
| CDP / DevTools / WebDriver | **Not available.** No Dia process runs with `--remote-debugging-port` or any automation flag, and none listens on a port. Enabling one means relaunching the user's browser, and Chromium 136+ refuses remote debugging on the default profile. Axon does not relaunch anybody's browser. |
| Accessibility | **Yes.** Chromium exposes each page to Windows UI Automation as a `Document` whose **Value** is the address and whose **Text** pattern is the page text, with **Scroll** support; links, buttons and fields are controls with Invoke / Value patterns. |
| Where the page lives | Sometimes beneath the browser window; on this machine usually only beneath Chromium's **render widget** (`Chrome_RenderWidgetHostHWND`, a child window). Asking the top window alone found no page; asking the render widget found the page and its iframes. |
| Attach to the existing browser | **Yes, through UIA** — the same native engine `ui.read` uses. No second browser, no profile, no relaunch. |
| Other browsers | Chrome and Edge are installed (not running). Not used: substituting a different browser would not be the user's browser. |

## Architecture

```
AssemblyAI tool.call (web.read / find / click / type / scroll)
  └─ dispatcher: strict schema → precheck → risk → APPROVAL if required → execute
       └─ WebSession: default browser (Windows' own record) → its front window
            └─ native UIA engine (constant program):
                 page  op   → the first http(s) Document, searched from the window and then from
                              Chromium's render surfaces: title, address, bounded text, scroll position
                 observe    → the page's controls (on the render surface; scoped to the Document when the
                              page lives in the browser window itself, so the sidebar is never read)
                 act        → invoke / setText / scrollDown / scrollUp on ONE element re-found by identity
       └─ read the page again → what changed (address, title, text) is the verification
```

Engine additions (`platform/uia-program.ts`, still one constant program, < 30 000 chars): TextPattern /
TextRange / ScrollPattern interfaces, a read-only `page` op, `scrollDown`/`scrollUp` actions, and a
child-window enumeration by the constant class name `Chrome_RenderWidgetHostHWND`.

## What the model receives — and never receives

**Receives:** browser name, page title, address, page text between `<<<UNTRUSTED_WEB_CONTENT>>>` markers,
controls as `{ ref, role, name, sensitive, actions, value }`, and each act's verification.

**Never:** a window handle, the render surface, a runtime id, an automation id, a process id, a DOM / CDP
node id, a selector, a coordinate, or any way to run script. The schemas are strict — `x`, `y`,
`selector`, `nodeId`, `script`, `javascript`, `cdp`, `hwnd`, `surface` are `INVALID_INPUT`, not dropped.

## Policy

- **Reading** any public page: no approval. Pages on local / private addresses (loopback, LAN, `file:`,
  metadata) are not read — the same URL policy as Axon's own browser.
- **Links, tabs, rows:** followed without asking, unless the label is consequential (send, delete, buy,
  submit…) — then the existing approval dialog asks: *Axon wants to click "…" on github.com*.
- **Buttons:** always ask. In a signed-in browser an unknown button can change anything.
- **Typing:** ordinary text goes in; a password field, and anything shaped like a password, key or token,
  is refused before anything is typed. Nothing is ever submitted by typing — there is no Enter key.
- **One approval architecture:** the dispatcher's broker, unchanged.

## Verification

Every act re-reads the page: `navigated` (address changed), `changed` (title or text changed), or — if
nothing changed — *"Nothing on the page changed that Axon could see. Do not say it worked."* A reference is
refused if it expired (15 s), if Axon has acted since it was read, if it came from a non-web read, or if the
browser has moved to a different page since.

## Voice timing

A page read takes 2–9 s (first read of a tab is slowest). Browsing is a chain the model can only continue
from a result it holds, so the five page tools wait up to **11 s inline** (`TASK_LIMITS.pageInlineBudgetMs`,
inside the provider's 15 s tool timeout) instead of the 2.5 s other tools get. Without this, live runs
stopped after the first read.

## One tab, one operation at a time

The model sometimes sends page calls together (seen live: a read alongside a click). The five page tools
therefore run **in arrival order** on a per-session queue — a read never races a click. And a page read
again while its references are still live gets the **same** references, so a redundant read cannot make
the references the model was just given stale. `web.click` returns the landed page itself, which saves the
chain a round trip per step.

## Live results (real AssemblyAI voice path, Dia 0.28, 2026-09-30)

**"Open GitHub and check my latest PR."**

- **Final build — opened the PR.** `web.open github.com` → `web.read` (Dashboard, signed in) →
  `web.click` "All pull requests" (verified navigation to `/pulls/inbox`) → `web.click` the newest PR's
  title (verified navigation to `github.com/kubeflow/kale/pull/970`, page returned) → *"Your latest pull
  request is "feat: improve local KFP development workflow" in the kubeflow/kale repository, which is
  currently awaiting approval."* The page read showed: **Open**, *1 pending check* (tide), *2 pending
  reviews*, *5 workflows awaiting approval*, *NOT APPROVED* (bot). Axon spoke title, repository and state;
  it did not read out checks or reviews in that run.
- **Same line, two other runs on the final build:** the model answered from the list row instead of opening
  the PR — accurately (title, repository, "awaiting approval", "2/3 checks passing", all visible on the
  list), but without the PR page. Model behaviour; the PR link was offered as a reference each time.
- **"Open my latest pull request on GitHub and read its checks."** — opened `pull/970` and said *"…two of
  the three checks are passing, but one check is still pending."* — matches the list (2/3) and the PR page
  (1 pending check).
- **Earlier — safely interrupted.** The user switched Dia to another tab mid-task: the click was refused
  (*"the browser has moved to a different page"*), and Axon reported the actual page instead of acting.
- **Found and fixed during these runs:** parallel page calls racing (now queued); a redundant read making
  fresh references stale (now reused); the model reaching for `browser.click` with a `web.read` reference
  and then using Axon's own signed-out browser (descriptions now say which browser is which; the model
  said "please sign in" to GitHub, which was wrong for the user's browser).

**Generic, not GitHub:** *"Open Wikipedia in my browser and open today's featured article."* → `web.open
wikipedia.org` (Dia) → `web.read` → `web.click` "English" (verified navigation to `en.wikipedia.org/wiki/
Main_Page`) → `web.read` → *"Today's featured article is about Takato Dam, a gravity dam in Japan."*
(it answered from the Main Page rather than opening the article). No site-specific code exists for either
site.

## Known limitations

- Only the **front tab** is visible to UI Automation; background tabs cannot be read.
- Only **on-screen** controls are listed; `web.scroll` reveals more. Page *text* is complete (bounded).
- The browser is the user's: if they switch tabs mid-task, Axon stops and says where it is.
- No Enter key: a search box is filled but submitted only by pressing the page's own button (approval), or
  by opening the results address with `web.open`.
- Chromium-based default browsers (Dia, Chrome, Edge, Brave, Arc) expose pages this way. Firefox exposes
  UIA differently and is untested.
- Reading a page takes seconds; the model announces slow steps.
- Right after a Paint drawing (Paint in front), Dia's window did not come forward within `web.open`'s
  verification window once: Axon said *"I sent GitHub to your browser."* truthfully and stopped. Do the
  GitHub beat before the Paint beat.
