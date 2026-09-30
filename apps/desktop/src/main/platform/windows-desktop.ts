/**
 * Seeing and acting on the desktop, on Windows.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * This is the only module that runs a program to inspect, move or act on a
 * window, and it does so exactly the way the speech providers do: a CONSTANT
 * script, spawned without a shell, with every variable passed OUT OF BAND and
 * nothing interpolated into the program text. `architecture.test.ts` asserts
 * that shape for both programs here, so the claim is checked rather than
 * believed.
 *
 * WHY THAT SHAPE, SPECIFICALLY.
 *
 * A window title is attacker-controlled: any application on the machine can
 * name its window anything, including something that looks like PowerShell. If
 * titles were interpolated into a script, a hostile window title would be code
 * execution — a shell built out of the one thing Axon must read to be useful.
 * Because the program is a module constant and titles only ever travel back
 * as JSON on stdout, there is no string concatenation for a title to
 * participate in.
 *
 * WHAT THIS DELIBERATELY CANNOT DO.
 *
 * It cannot start, stop, or inspect a process. It cannot read another
 * application's memory. It enumerates TOP-LEVEL VISIBLE windows and reports a
 * title and a handle; it can raise, minimise or maximise one. There is no
 * close, no kill, no move and no resize.
 *
 * WHAT PHASE 2 ADDED, AND WHAT IT POINTEDLY DID NOT.
 *
 * A second program that reads the ACCESSIBILITY TREE of one window and can
 * activate one control in it: enumerate the buttons, links and fields an
 * application publishes for a screen reader, and invoke, toggle, select, focus
 * or set the text of exactly one of them.
 *
 * It does that through UI Automation, and NOT through synthetic input. There
 * is no `SendInput`, no `mouse_event`, no `keybd_event`, no `SetCursorPos` and
 * no `SendKeys` in this file or anywhere else in Axon, and
 * `architecture.test.ts` still asserts their absence. The difference is not
 * cosmetic:
 *
 *   Coordinate injection acts on WHATEVER IS UNDER THE POINTER at the instant
 *   the event is delivered. Between deciding and clicking, a window can move,
 *   a dialog can appear, and the user can alt-tab — so the thing that receives
 *   the click is not necessarily the thing that was reasoned about, and there
 *   is no way afterwards to know which it was.
 *
 *   UI Automation acts on AN ELEMENT. The control is re-found by identity at
 *   the moment of acting, the act targets that element and nothing else, and
 *   an element that is gone or that now matches two candidates produces a
 *   refusal instead of an action. There is no pointer to race.
 *
 * That is why this shape was chosen over the obvious one, and it is why
 * `mouse.click(x, y)` does not exist: a coordinate is a target nobody can
 * check, and a target nobody can check is a target a model can invent.
 *
 * A password field is refused here as well as in the tool layer. The
 * accessibility tree reports `IsPassword` directly, which makes that evidence
 * from the application itself rather than a guess about a field's name.
 *
 * A LIMITATION WORTH STATING, because it shows up in practice. Windows only
 * lets a process call `SetForegroundWindow` under conditions that a background
 * application usually does not meet, so a focus request can be accepted by the
 * API and simply not happen — the window flashes in the taskbar instead. There
 * is a well-known workaround involving `AttachThreadInput` and a synthetic
 * keypress, and Axon deliberately does not use it: stealing the foreground is
 * a restriction the operating system imposes on the user's behalf, and quietly
 * defeating it is not something a control plane should do. What Axon does
 * instead is verify against a fresh listing and report honestly that the
 * window did not come forward.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { UiaHost, type HostProcess } from './uia-host.js';
import { UIA_HOST_SCRIPT } from './uia-program.js';
import {
  OBSERVATION_LIMITS,
  TARGET_ACTIONS,
  TARGET_ROLES,
  ToolError,
  declaredFailureKind,
  isSecretText,
  type TargetAction,
  type TargetRole,
  type ToolFailureKind,
} from '@axon/core';

/** One visible top-level window, as the operating system describes it. */
export interface DesktopWindow {
  /** The OS window handle, as a string. Opaque, and never shown to a model. */
  readonly handle: string;
  readonly title: string;
  /** True when it is currently the foreground window. */
  readonly foreground: boolean;
  readonly minimized: boolean;
  /**
   * WHO OWNS IT, as the operating system reports it (Phase 4A). All three are
   * INTERNAL: they identify the application behind a window so Axon does not
   * have to guess from a title, and none of them is ever shown to a model or
   * accepted from one. Absent when the listing could not obtain them — an
   * elevated process, say — and absence means "unknown", never "nobody".
   */
  readonly processId?: number;
  /** The owning process's image path, lowercased. Never leaves the main process. */
  readonly executable?: string;
  /** The owning process's package identity (`Family!App`), for packaged applications. */
  readonly appUserModelId?: string;
}

export type WindowAction = 'focus' | 'minimize' | 'maximize';

export interface DesktopWindows {
  readonly available: boolean;
  /** Visible top-level windows, newest-first as the OS enumerates them. */
  list(): Promise<readonly DesktopWindow[]>;
  /** Raise, minimise or maximise one window by handle. */
  act(handle: string, action: WindowAction): Promise<boolean>;
}

/**
 * One control an application publishes to the accessibility layer.
 *
 * The fields split cleanly in two, and the split is the security model:
 *
 *   DESCRIPTIVE — `role`, `name`, `sensitive`, `actions`, `value`. These
 *   describe the control to a person and to the risk policy, and the tool
 *   layer projects them to the model.
 *
 *   IDENTIFYING — `nativeRole` and `automationId`. These are how the main
 *   process finds this control again a moment later, and they never leave the
 *   main process. A model that received them could name a control Axon had not
 *   looked at.
 */
export interface DesktopControl {
  /** The operating system's own control-type name. Used only for re-matching. */
  readonly nativeRole: string;
  readonly role: TargetRole;
  /** The accessible name. UNTRUSTED: the owning application writes it. */
  readonly name: string;
  /** The application's own id for the control, or empty when it has none. */
  readonly automationId: string;
  /** True for a protected-entry field. Reported by the application itself. */
  readonly sensitive: boolean;
  readonly actions: readonly TargetAction[];
  /** Current text of an editable control, bounded. Null for anything else. */
  readonly value: string | null;
  /**
   * The engine's id for the live element (Phase 4B). IDENTIFYING, like the
   * automation id: used to re-find exactly this control, never shown to a
   * model, never accepted from one. Absent from older readings and fakes.
   */
  readonly runtimeId?: string;
  /** The element's class name, as the application reports it. Internal. */
  readonly className?: string;
}

/** What one look at a window's accessibility tree found. */
export interface DesktopScreenReading {
  /** False when the accessibility layer could not be used at all. */
  readonly available: boolean;
  readonly windowHandle: string | null;
  /** The window's title. UNTRUSTED text. */
  readonly windowTitle: string;
  readonly controls: readonly DesktopControl[];
  readonly truncated: boolean;
  /**
   * Why the reading is empty or partial, when it is.
   *
   * Stated rather than silently returning nothing. A model told "no controls"
   * concludes the screen is empty; a model told "this application publishes
   * nothing to the accessibility layer" tells the user the truth.
   */
  readonly note: string | null;
  /**
   * The same reason as a failure kind, for code rather than for a person.
   *
   * A reading that came back empty is not a failed screenshot — the capture
   * worked — so this is a STATUS on a successful result, never a thrown
   * error. It is what lets the model say "that application doesn't expose its
   * controls" (UI_NOT_ACCESSIBLE) rather than "that didn't work", and tell a
   * slow read (TIMEOUT) from a closed window (WINDOW_NOT_FOUND).
   * Absent or null means the reading has nothing to report against it.
   */
  readonly problem?: ToolFailureKind | null;
  /**
   * PAGING (Phase 4A). True only when at least one more qualifying control
   * exists after this page — established by finding it, never inferred.
   */
  readonly hasMore?: boolean;
  /** Qualifying controls passed over before this page began. */
  readonly offset?: number;
}

/**
 * Which part of a window to read (Phase 4A). Both are optional; neither is
 * ever a raw automation handle, a coordinate or anything the model wrote.
 */
export interface ObserveOptions {
  /** Qualifying controls to pass over first: page N starts at (N-1) x page size. */
  readonly skip?: number;
  /**
   * Read only beneath this control — one Axon already described, identified
   * by the same fields `actOnControl` re-finds by. Resolved from an Axon
   * reference by the caller; the model never supplies it.
   */
  readonly scope?: { readonly nativeRole: string; readonly name: string; readonly automationId: string; readonly runtimeId?: string };
}

/** The furthest into one window a page may start. A bound, not a target: 20 pages of 60. */
export const MAX_OBSERVE_SKIP = 1_140;

/** What Axon was asked to do to one control, and to which one. */
export interface DesktopControlRequest {
  readonly windowHandle: string;
  readonly nativeRole: string;
  readonly name: string;
  readonly automationId: string;
  /** Axon's internal record of the live element, when it has one. Never from a model. */
  readonly runtimeId?: string;
  readonly action: TargetAction;
  /**
   * For `setText` only.
   *
   * NEVER LOGGED. It travels to the child process in an environment variable —
   * off the command line, so it is not visible to another process listing this
   * one — and it appears in no message, no event and no error this module
   * produces.
   */
  readonly text?: string;
}

/**
 * What happened, as a closed set.
 *
 * `gone` and `ambiguous` are the two that matter: they are what the identity
 * re-match produces when the screen changed under Axon, and both are refusals
 * rather than best guesses. Axon does not pick one of two matching controls.
 */
export type DesktopControlOutcome =
  | { readonly kind: 'ok'; readonly value: string | null }
  | { readonly kind: 'gone' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'sensitive' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Reading and activating on-screen controls.
 *
 * Separate from `DesktopWindows` because it is a materially larger privilege:
 * moving a window changes what is on screen, and activating a control makes an
 * application do something. Keeping them as two interfaces means a caller that
 * only needs to raise a window cannot reach the half that acts.
 */
export interface DesktopUi {
  /** False where the accessibility layer is unavailable. Tools are then absent. */
  readonly uiAvailable: boolean;
  /** Read one window's controls. A null handle means the foreground window. */
  observeControls(windowHandle: string | null, options?: ObserveOptions): Promise<DesktopScreenReading>;
  /** Act on exactly one control, re-found by identity. */
  actOnControl(request: DesktopControlRequest): Promise<DesktopControlOutcome>;
}

/**
 * The program.
 *
 * A module constant. Note what it reads: two ENVIRONMENT VARIABLES, which the
 * spawn below sets on the child process and PowerShell never parses as code.
 *
 * Environment rather than `$args`, for two reasons. The mechanical one is that
 * `-Command <script>` consumes everything after it as part of the command
 * string, so trailing arguments never become `$args` at all — the first
 * version of this file did that and silently enumerated nothing. The better
 * one is that an environment variable is not on the command line, so the value
 * is not visible to other processes listing this one, and there is no
 * command-line quoting for it to participate in.
 *
 * Either way the property that matters is unchanged: the program is a
 * constant, values travel out of band, and there is no `Invoke-Expression`,
 * no `iex`, no `&` on a string, and no place a caller's value is concatenated
 * into a statement.
 *
 * `EnumWindows` with `IsWindowVisible` and a non-empty title is the standard
 * way to get the windows a person would say they can see — it excludes tool
 * windows, tray hosts and the invisible message-only windows that make a raw
 * enumeration useless.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -Namespace AxonNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder name, ref uint size);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetApplicationUserModelId(IntPtr process, ref uint length, System.Text.StringBuilder id);
public static uint OwnerOf(IntPtr hWnd) { uint pid; GetWindowThreadProcessId(hWnd, out pid); return pid; }
public static uint HostedBy(IntPtr frame, uint framePid) {
  uint hosted = 0;
  EnumChildWindows(frame, delegate (IntPtr child, IntPtr unused) { uint pid = OwnerOf(child); if (pid != 0 && pid != framePid) { hosted = pid; return false; } return true; }, IntPtr.Zero);
  return hosted;
}
public static string[] Identity(uint pid) {
  string[] result = new string[] { "", "" };
  IntPtr process = OpenProcess(0x1000, false, pid);
  if (process == IntPtr.Zero) return result;
  try {
    uint size = 1024; System.Text.StringBuilder image = new System.Text.StringBuilder(1024);
    if (QueryFullProcessImageNameW(process, 0, image, ref size)) result[0] = image.ToString();
    uint length = 512; System.Text.StringBuilder id = new System.Text.StringBuilder(512);
    if (GetApplicationUserModelId(process, ref length, id) == 0) result[1] = id.ToString();
  } finally { CloseHandle(process); }
  return result;
}
'@

$mode = $env:AXON_WINDOW_MODE

if ($mode -eq 'list') {
  $foreground = [AxonNative.Win]::GetForegroundWindow()
  $found = New-Object System.Collections.ArrayList
  $identities = @{}
  $callback = [AxonNative.Win+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([AxonNative.Win]::IsWindowVisible($hWnd)) {
      $length = [AxonNative.Win]::GetWindowTextLengthW($hWnd)
      if ($length -gt 0) {
        $builder = New-Object System.Text.StringBuilder ($length + 1)
        [void][AxonNative.Win]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
        $title = $builder.ToString()
        if ($title.Trim().Length -gt 0) {
          # WHO OWNS IT, from the operating system rather than the title: the
          # process, its image, and its package identity where it has one. A
          # Store app's frame belongs to ApplicationFrameHost, so the process it
          # hosts is used instead. Read-only queries; nothing is started.
          $processId = [AxonNative.Win]::OwnerOf($hWnd)
          if (-not $identities.ContainsKey($processId)) { $identities[$processId] = [AxonNative.Win]::Identity($processId) }
          $identity = $identities[$processId]
          if ($identity[0] -like '*\ApplicationFrameHost.exe') {
            $hosted = [AxonNative.Win]::HostedBy($hWnd, $processId)
            if ($hosted -ne 0) {
              $processId = $hosted
              if (-not $identities.ContainsKey($processId)) { $identities[$processId] = [AxonNative.Win]::Identity($processId) }
              $identity = $identities[$processId]
            }
          }
          [void]$found.Add([pscustomobject]@{
            handle = $hWnd.ToString()
            title = $title
            foreground = ($hWnd -eq $foreground)
            minimized = [AxonNative.Win]::IsIconic($hWnd)
            processId = $processId
            executable = $identity[0]
            appUserModelId = $identity[1]
          })
        }
      }
    }
    return $true
  }
  [void][AxonNative.Win]::EnumWindows($callback, [IntPtr]::Zero)
  $found | ConvertTo-Json -Compress -Depth 3
  exit 0
}

# Every other mode acts on one window, named by a handle the caller validated.
$handle = [IntPtr]::new([int64]$env:AXON_WINDOW_HANDLE)
if (-not [AxonNative.Win]::IsWindow($handle)) { Write-Output 'gone'; exit 0 }

switch ($mode) {
  'focus'    { [void][AxonNative.Win]::ShowWindow($handle, 9); [void][AxonNative.Win]::SetForegroundWindow($handle) }
  'minimize' { [void][AxonNative.Win]::ShowWindow($handle, 6) }
  'maximize' { [void][AxonNative.Win]::ShowWindow($handle, 3); [void][AxonNative.Win]::SetForegroundWindow($handle) }
  default    { Write-Output 'unknown'; exit 0 }
}
Write-Output 'ok'
`;

/**
 * THE ACCESSIBILITY ENGINE lives in `uia-program.ts` (Phase 4B): a persistent,
 * constant program that talks to the operating system's native UI Automation
 * (`IUIAutomation`) instead of .NET's managed client, which could not see
 * WinUI 3 applications. It is started by `startUiaEngine` below and spoken to
 * through `uia-host.ts`; this module still owns every request it is sent.
 */

/**
 * The third program: what is installed, and what the default browser is.
 *
 * READ-ONLY, and the same shape as the two above — a module constant, spawned
 * without a shell, reading its one input (the mode) from the environment.
 *
 *   list             every entry in the Start menu's application namespace
 *                    (`shell:AppsFolder`): its display name and its AppID.
 *                    ONE source, chosen by measurement: it is what the Start
 *                    menu itself enumerates, so it covers desktop programs and
 *                    Store packages alike (WhatsApp and Spotify are packages
 *                    on the machine this was written on; VS Code is not), in
 *                    about 1.3 s for 232 entries. `Get-StartApps` reads the
 *                    same namespace but is missing on some editions; Start
 *                    menu shortcut files miss packaged apps entirely.
 *   default-browser  the https handler the user chose (UserChoice ProgId),
 *                    its display name, and its AppUserModelID — which is also
 *                    an AppsFolder entry, so the browser is started exactly as
 *                    any other discovered application is.
 *
 * It returns data and does nothing else. It does not start, stop or inspect a
 * process, and nothing it returns is ever given to a model as something to
 * run: the catalog (`apps/app-catalog.ts`) validates every record and keeps
 * the AppID on Axon's side of the boundary.
 */
const APPS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$mode = $env:AXON_APPS_MODE
if ($mode -eq 'list') {
  $items = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items()
  $apps = @($items | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; appId = [string]$_.Path; target = [string]$_.ExtendedProperty('System.Link.TargetParsingPath') } })
  Write-Output (ConvertTo-Json -InputObject $apps -Compress -Depth 2)
  exit 0
}
if ($mode -eq 'default-browser') {
  $choice = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue
  if ($null -eq $choice -or [string]::IsNullOrWhiteSpace($choice.ProgId)) { Write-Output '{"error":"none"}'; exit 0 }
  $application = Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $choice.ProgId + '\Application') -ErrorAction SilentlyContinue
  $result = [pscustomobject]@{
    progId = [string]$choice.ProgId
    name = if ($null -ne $application) { [string]$application.ApplicationName } else { '' }
    appUserModelId = if ($null -ne $application) { [string]$application.AppUserModelID } else { '' }
  }
  Write-Output (ConvertTo-Json -InputObject $result -Compress)
  exit 0
}
Write-Output '{"error":"mode"}'
`;

/** A UI Automation runtime id, as the engine renders it: dot-separated integers. Internal only. */
const RUNTIME_ID_PATTERN = /^-?\d{1,11}(?:\.-?\d{1,11}){0,15}$/;

/** Handles are decimal integers. Anything else never reaches the script. */
const HANDLE_PATTERN = /^-?\d{1,19}$/;

const LIST_TIMEOUT_MS = 8_000;
/** Measured at 1.3 s for 232 entries; generous for a slower machine or a cold COM start. */
const APPS_TIMEOUT_MS = 10_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 5_000;
/** Entries Axon will accept from one listing. A Start menu has hundreds, not tens of thousands. */
const MAX_START_MENU_APPS = 2_000;
const ACT_TIMEOUT_MS = 5_000;
/** Windows Axon will describe in one listing. A desktop has tens, not thousands. */
const MAX_WINDOWS = 60;
/** Characters of a window title Axon will carry. Titles are untrusted text. */
const MAX_TITLE = 160;

/** What the accessibility program is asked, out of band. */
export interface UiInvocation {
  readonly mode: 'observe' | 'act';
  /** Empty means the foreground window. */
  readonly windowHandle: string;
  readonly maxElements: number;
  /** For `observe`: qualifying controls to pass over first — a page offset. */
  readonly skip?: number;
  /** The JSON request document, for `act`. Empty for `observe`. */
  readonly target: string;
}

export interface WindowsDesktopOptions {
  readonly platform?: NodeJS.Platform;
  /** Injected in tests so the port is exercised without spawning anything. */
  readonly run?: (args: readonly string[], timeoutMs: number) => Promise<string>;
  /** Injected in tests, for the accessibility program specifically. */
  readonly runUi?: (invocation: UiInvocation, timeoutMs: number) => Promise<string>;
  /** Injected in tests: the native engine process, faked. Used only when `runUi` is not given. */
  readonly startEngine?: () => HostProcess;
  /** Injected in tests, for the application-discovery program. */
  readonly runApps?: (mode: AppsMode, timeoutMs: number) => Promise<string>;
}

/** What the discovery program is asked. */
export type AppsMode = 'list' | 'default-browser';

/** One raw Start-menu entry, exactly as the OS listed it. Validated by the catalog, not here. */
export interface RawStartMenuApp {
  readonly name: string;
  readonly appId: string;
  /**
   * What the Start-menu shortcut points at, when it is a shortcut (Phase 4A).
   * Used ONLY to recognise the application's windows by their owning process
   * — never to start anything, and never shown to a model.
   */
  readonly target?: string;
}

/** The user's default browser, as Windows records it. */
export interface DefaultBrowser {
  readonly progId: string;
  /** Its display name, e.g. "Dia" or "Google Chrome". Possibly empty. */
  readonly name: string;
  /** How to start it through the Start menu namespace. Possibly empty. */
  readonly appUserModelId: string;
}

/** Discovery of installed applications. Read-only. */
export interface DesktopApps {
  readonly appsAvailable: boolean;
  /** Every Start-menu entry. Throws a classified error on failure. */
  listStartMenuApps(): Promise<readonly RawStartMenuApp[]>;
  /** The default browser, or null when none is recorded. */
  defaultBrowser(): Promise<DefaultBrowser | null>;
}

export class WindowsDesktop implements DesktopWindows, DesktopUi, DesktopApps {
  readonly available: boolean;
  readonly uiAvailable: boolean;
  readonly appsAvailable: boolean;
  private readonly run: (args: readonly string[], timeoutMs: number) => Promise<string>;
  private readonly runUi: (invocation: UiInvocation, timeoutMs: number) => Promise<string>;
  private readonly startEngine: () => HostProcess;
  private uiaHost: UiaHost | null = null;
  private readonly runApps: (mode: AppsMode, timeoutMs: number) => Promise<string>;

  constructor(options: WindowsDesktopOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.available = options.run !== undefined || platform === 'win32';
    // Tracked separately from `available`: the two capabilities are different
    // sizes, and a future platform could plausibly support one and not the
    // other. Today they coincide.
    this.uiAvailable = options.runUi !== undefined || platform === 'win32';
    this.run = options.run ?? runPowerShell;
    this.startEngine = options.startEngine ?? startUiaEngine;
    this.runUi = options.runUi ?? ((invocation, timeoutMs) => this.runNative(invocation, timeoutMs));
    this.appsAvailable = options.runApps !== undefined || platform === 'win32';
    this.runApps = options.runApps ?? runAppsProgram;
  }

  /**
   * Every entry in the Start menu's application namespace.
   *
   * A failed listing THROWS, for the reason `list()` does: an empty catalog
   * would read as "that application is not installed", which is a false
   * statement when the truth is that Axon could not look.
   */
  async listStartMenuApps(): Promise<readonly RawStartMenuApp[]> {
    if (!this.appsAvailable) throw new ToolError('UNSUPPORTED', 'Finding installed applications is only available on Windows.');
    let raw: string;
    try {
      raw = await this.runApps('list', APPS_TIMEOUT_MS);
    } catch (error) {
      if (declaredFailureKind(error)) throw error;
      throw new Error('Axon could not read the list of installed applications.');
    }
    return parseStartMenuApps(raw);
  }

  /** The default browser, or null when Windows records none. */
  async defaultBrowser(): Promise<DefaultBrowser | null> {
    if (!this.appsAvailable) return null;
    let raw: string;
    try {
      raw = await this.runApps('default-browser', DEFAULT_BROWSER_TIMEOUT_MS);
    } catch (error) {
      if (declaredFailureKind(error)) throw error;
      throw new Error('Axon could not work out which browser is your default.');
    }
    return parseDefaultBrowser(raw);
  }

  /**
   * Read one window's controls.
   *
   * A failure is an EMPTY reading with a reason, not an exception. The tool
   * above turns that into "Axon could not read the controls in that window",
   * which is true and actionable; a crash would be neither.
   */
  async observeControls(windowHandle: string | null, options: ObserveOptions = {}): Promise<DesktopScreenReading> {
    if (!this.uiAvailable) {
      return emptyReading(windowHandle, 'Reading on-screen controls is only available on Windows.', 'UNSUPPORTED');
    }
    // Validated here as well as at the tool's schema. The value is about to
    // reach a child process, and a check at only one layer is a check a future
    // caller can skip.
    if (windowHandle !== null && !HANDLE_PATTERN.test(windowHandle)) {
      return emptyReading(null, 'That window reference is not one Axon can use.', 'WINDOW_NOT_FOUND');
    }
    // A page offset is a bounded integer or nothing; a scope is exactly the
    // three identity fields, serialised here as data. Neither is text a
    // model wrote: the caller resolved both from Axon's own records.
    const skip = options.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0 || skip > MAX_OBSERVE_SKIP) {
      return emptyReading(windowHandle, 'That page is not one Axon can read.', 'EXECUTION_ERROR');
    }
    const scope = options.scope
      ? JSON.stringify({
          role: options.scope.nativeRole,
          name: options.scope.name,
          automationId: options.scope.automationId,
          ...(options.scope.runtimeId && RUNTIME_ID_PATTERN.test(options.scope.runtimeId) ? { runtimeId: options.scope.runtimeId } : {}),
        })
      : '';

    let raw: string;
    try {
      raw = await this.runUi(
        {
          mode: 'observe',
          windowHandle: windowHandle ?? '',
          maxElements: OBSERVATION_LIMITS.maxTargets,
          skip,
          target: scope,
        },
        OBSERVATION_LIMITS.enumerateTimeoutMs,
      );
    } catch (error) {
      // "In time" only when it WAS time. The note used to say so for every
      // failure, which is the same blurring this change exists to undo.
      const kind = declaredFailureKind(error);
      if (kind === 'UNSUPPORTED') {
        // The engine itself could not start (COM unavailable, or paused after
        // repeated failures): a fact about this computer, not about the window.
        return emptyReading(windowHandle, error instanceof Error ? error.message : 'Reading controls is unavailable here.', 'UNSUPPORTED');
      }
      return kind === 'TIMEOUT'
        ? emptyReading(windowHandle, 'Axon could not read the controls in that window in time.', 'TIMEOUT')
        : emptyReading(windowHandle, 'Axon could not read the controls in that window.', 'EXECUTION_ERROR');
    }

    return parseReading(raw, windowHandle);
  }

  /**
   * Act on exactly one control.
   *
   * Every refusal path is a value rather than a throw, for the same reason:
   * "the control is gone" and "there are now two of them" are things the model
   * has to be able to read and react to.
   */
  /**
   * One request to the native engine, in the shape the readers below parse.
   *
   * The invocation is Axon's own: a validated handle, a bounded page, and an
   * identity document built by this module from Axon's records. The engine's
   * answer comes back as the same JSON the one-shot programs used to print,
   * so reading it is unchanged. Refusals the engine reports (gone, ambiguous,
   * sensitive…) pass through as answers; a request the engine calls invalid
   * is a bug on this side and is thrown as one.
   */
  private async runNative(invocation: UiInvocation, timeoutMs: number): Promise<string> {
    this.uiaHost ??= new UiaHost({ start: this.startEngine });
    const document = invocation.target === '' ? null : (JSON.parse(invocation.target) as Record<string, string>);
    const answer = await this.uiaHost.request(
      invocation.mode === 'observe'
        ? {
            op: 'observe',
            window: invocation.windowHandle,
            skip: invocation.skip ?? 0,
            max: invocation.maxElements,
            ...(document ? { scope: document } : {}),
          }
        : { op: 'act', window: invocation.windowHandle, target: document ?? {} },
      timeoutMs,
    );
    const { id: _id, ...result } = answer;
    if (result.error === 'com') throw new ToolError('UNSUPPORTED', 'The Windows accessibility engine could not start on this computer.');
    if (typeof result.error === 'string' && ['invalid', 'malformed', 'unknown-op', 'too-large', 'failed'].includes(result.error)) {
      throw new Error('The accessibility engine refused the request.');
    }
    return JSON.stringify(result);
  }

  /** End the accessibility engine, if it is running. Called when Axon shuts down. */
  dispose(): void {
    this.uiaHost?.dispose();
    this.uiaHost = null;
  }

  async actOnControl(request: DesktopControlRequest): Promise<DesktopControlOutcome> {
    if (!this.uiAvailable) return { kind: 'failed', reason: 'not-available' };
    if (!HANDLE_PATTERN.test(request.windowHandle)) return { kind: 'failed', reason: 'bad-window' };
    if (!(TARGET_ACTIONS as readonly string[]).includes(request.action)) {
      return { kind: 'failed', reason: 'bad-action' };
    }

    // Built here, as data, and handed over as one environment value. Note the
    // text is included in the document rather than sent as its own variable:
    // an empty string in a Windows environment variable is indistinguishable
    // from an unset one, and "type nothing" is a legitimate request.
    const target = JSON.stringify({
      role: request.nativeRole,
      name: request.name,
      automationId: request.automationId,
      // The engine's own id for the live element: an exact re-find where two
      // controls share a name. Internal, from Axon's record, never a model's.
      ...(request.runtimeId && RUNTIME_ID_PATTERN.test(request.runtimeId) ? { runtimeId: request.runtimeId } : {}),
      action: request.action,
      text: request.text ?? '',
    });

    let raw: string;
    try {
      raw = await this.runUi(
        {
          mode: 'act',
          windowHandle: request.windowHandle,
          maxElements: OBSERVATION_LIMITS.maxTargets,
          target,
        },
        OBSERVATION_LIMITS.actTimeoutMs,
      );
    } catch {
      return { kind: 'failed', reason: 'timeout' };
    }

    return parseOutcome(raw);
  }

  async list(): Promise<readonly DesktopWindow[]> {
    if (!this.available) return [];

    let raw: string;
    try {
      raw = await this.run(['list'], LIST_TIMEOUT_MS);
    } catch (error) {
      // A FAILED LISTING IS NOT AN EMPTY DESKTOP.
      //
      // This used to return [] on the grounds that the tool above would say
      // "Axon could not see any windows". One of them did. Another, `app.focus`,
      // read the empty list as "that application is not running" — so a slow
      // PowerShell start was reported to the user as a fact about their
      // desktop that was false. A listing that failed has established
      // nothing, and now says so: a timeout as TIMEOUT, anything else as a
      // plain failure. Callers that can tolerate a missing listing (launch
      // verification, the post-act re-check) catch it and say "not confirmed".
      if (declaredFailureKind(error)) throw error;
      throw new Error('Axon could not read the list of open windows.');
    }
    return parseWindows(raw);
  }

  async act(handle: string, action: WindowAction): Promise<boolean> {
    if (!this.available) return false;
    // Validated HERE as well as at the tool's schema. The value is about to
    // become a process argument, and a check at only one layer is a check that
    // a future caller can skip.
    if (!HANDLE_PATTERN.test(handle)) return false;

    try {
      const raw = await this.run([action, handle], ACT_TIMEOUT_MS);
      return raw.trim() === 'ok';
    } catch {
      return false;
    }
  }
}

/**
 * Reshape whatever the script printed.
 *
 * Field by field, with every bound reapplied on this side — the same posture
 * `toObservation` takes toward the browser's page program. The script is ours;
 * the TITLES in it are written by other applications, and a title is exactly
 * the kind of thing that is interesting to make hostile.
 */
/**
 * Reshape the discovery program's listing. Shape only: every string is
 * bounded here, and the catalog decides what is an application at all.
 */
export function parseStartMenuApps(raw: string): readonly RawStartMenuApp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    throw new Error('The list of installed applications could not be read.');
  }
  // PowerShell renders a one-element array as the bare object.
  const entries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? [parsed] : [];
  const apps: RawStartMenuApp[] = [];
  for (const entry of entries.slice(0, MAX_START_MENU_APPS)) {
    if (entry === null || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.appId !== 'string') continue;
    apps.push({
      name: value.name.slice(0, 256),
      appId: value.appId.slice(0, 1024),
      ...(typeof value.target === 'string' && value.target !== '' ? { target: value.target.slice(0, 1024) } : {}),
    });
  }
  return apps;
}

export function parseDefaultBrowser(raw: string): DefaultBrowser | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.error === 'string' || typeof value.progId !== 'string' || value.progId === '') return null;
  return {
    progId: value.progId.slice(0, 128),
    name: typeof value.name === 'string' ? sanitizeText(value.name, 80) : '',
    appUserModelId: typeof value.appUserModelId === 'string' ? value.appUserModelId.slice(0, 512) : '',
  };
}

export function parseWindows(raw: string): readonly DesktopWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    return [];
  }

  // A single window comes back as an object rather than an array.
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const windows: DesktopWindow[] = [];

  for (const entry of entries.slice(0, MAX_WINDOWS)) {
    if (entry === null || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;

    const handle = typeof value.handle === 'string' ? value.handle : String(value.handle ?? '');
    if (!HANDLE_PATTERN.test(handle)) continue;

    const title = typeof value.title === 'string' ? sanitizeTitle(value.title) : '';
    if (title === '') continue;

    windows.push({
      handle,
      title,
      foreground: value.foreground === true,
      minimized: value.minimized === true,
      ...parseOwner(value),
    });
  }

  return windows;
}

/** Package identities are `Family_publisherhash!AppId`. Nothing else is accepted as one. */
const APP_USER_MODEL_ID_PATTERN = /^[A-Za-z0-9.\-_]{1,200}![A-Za-z0-9.\-_]{1,100}$/;
/** An absolute Windows path to a program. Anything else is dropped rather than half-trusted. */
const EXECUTABLE_PATTERN = /^[a-z]:\\[^<>"|?*]{1,500}\.exe$/i;
/** Control characters, which no real path contains. Unicode property, so no raw control bytes in the source. */
const CONTROL = /\p{Cc}/u;

/**
 * The owner fields of one listed window, validated. Each is kept only if it
 * has exactly the shape the operating system gives it, so a malformed value
 * becomes "unknown" — which falls back to the title — never a wrong owner.
 */
function parseOwner(value: Record<string, unknown>): Pick<DesktopWindow, 'processId' | 'executable' | 'appUserModelId'> {
  const owner: { processId?: number; executable?: string; appUserModelId?: string } = {};
  const pid = value.processId;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff) owner.processId = pid;
  if (typeof value.executable === 'string' && EXECUTABLE_PATTERN.test(value.executable) && !CONTROL.test(value.executable)) {
    owner.executable = value.executable.toLowerCase();
  }
  if (typeof value.appUserModelId === 'string' && APP_USER_MODEL_ID_PATTERN.test(value.appUserModelId)) {
    owner.appUserModelId = value.appUserModelId;
  }
  return owner;
}

/** An empty reading with a reason. Never an exception: see `observeControls`. */
function emptyReading(windowHandle: string | null, note: string, problem: ToolFailureKind): DesktopScreenReading {
  return { available: false, windowHandle, windowTitle: '', controls: [], truncated: false, note, problem };
}

/**
 * Reshape whatever the accessibility program printed.
 *
 * Field by field, with every bound reapplied on this side — the same posture
 * `parseWindows` and the browser's `toObservation` take. The program is ours;
 * the NAMES and VALUES in it are written by other applications, and a control
 * name is exactly the kind of thing that is interesting to make hostile.
 */
export function parseReading(raw: string, requestedHandle: string | null): DesktopScreenReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
  } catch {
    return emptyReading(requestedHandle, 'Axon could not read the controls in that window.', 'EXECUTION_ERROR');
  }

  if (parsed === null || typeof parsed !== 'object') {
    return emptyReading(requestedHandle, 'Axon could not read the controls in that window.', 'EXECUTION_ERROR');
  }
  const value = parsed as Record<string, unknown>;

  if (typeof value.error === 'string') {
    // The control a scoped read was asked to look beneath is not there any
    // more, or is now two: a stale reference, refused — never a guess.
    if (value.error === 'scope-gone' || value.error === 'scope-ambiguous') {
      return emptyReading(
        requestedHandle,
        value.error === 'scope-gone'
          ? 'The control Axon was asked to read inside is no longer there. Look again.'
          : 'More than one control now matches the one Axon was asked to read inside. Look again.',
        'STALE_REFERENCE',
      );
    }
    return emptyReading(
      requestedHandle,
      value.error === 'gone'
        ? 'That window is no longer open.'
        : 'Axon could not read the controls in that window.',
      value.error === 'gone' ? 'WINDOW_NOT_FOUND' : 'EXECUTION_ERROR',
    );
  }

  const handle = typeof value.handle === 'string' && HANDLE_PATTERN.test(value.handle) ? value.handle : requestedHandle;
  const offset = typeof value.offset === 'number' && Number.isInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
  const entries = Array.isArray(value.elements) ? value.elements : [];
  const controls: DesktopControl[] = [];

  for (const entry of entries.slice(0, OBSERVATION_LIMITS.maxTargets)) {
    if (entry === null || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;

    const name = sanitizeText(raw.name, OBSERVATION_LIMITS.maxNameCharacters);
    if (name === '') continue;

    const role = (TARGET_ROLES as readonly string[]).includes(raw.role as string) ? (raw.role as TargetRole) : 'other';
    if (role === 'other') continue;

    const actions = (Array.isArray(raw.actions) ? raw.actions : []).filter((action): action is TargetAction =>
      (TARGET_ACTIONS as readonly string[]).includes(action as string),
    );
    // A control Axon cannot do anything with is a control the model would plan
    // around and then discover is inert — EXCEPT a container (Phase 4B): a
    // named list, group, document or pane, described so a read can be scoped
    // beneath it, and never acted on. It carries no actions, whatever the
    // engine said.
    const container = role === 'container';
    if (actions.length === 0 && !container) continue;

    // A secret on screen is still a secret: an editor showing a .env file, a
    // field holding a token. Judged on more text than is ever sent, so a key
    // just past the cut-off cannot be half-sent. Withheld, and marked, so the
    // model knows there is something it was not shown.
    const secret = !container && raw.value != null && isSecretText(sanitizeText(raw.value, 4_000));

    controls.push({
      nativeRole: typeof raw.nativeRole === 'string' ? raw.nativeRole.slice(0, 64) : '',
      role,
      name,
      automationId: typeof raw.automationId === 'string' ? raw.automationId.slice(0, 120) : '',
      sensitive: raw.sensitive === true || secret,
      actions: container ? [] : actions,
      value: container || secret || raw.value == null ? null : sanitizeText(raw.value, OBSERVATION_LIMITS.maxNameCharacters),
      ...(typeof raw.runtimeId === 'string' && RUNTIME_ID_PATTERN.test(raw.runtimeId) ? { runtimeId: raw.runtimeId } : {}),
      ...(typeof raw.className === 'string' && raw.className !== '' ? { className: raw.className.slice(0, 120) } : {}),
    });
  }

  return {
    available: true,
    windowHandle: handle,
    windowTitle: sanitizeText(value.window, MAX_TITLE),
    controls,
    truncated: value.truncated === true || entries.length > OBSERVATION_LIMITS.maxTargets,
    hasMore: value.hasMore === true || entries.length > OBSERVATION_LIMITS.maxTargets,
    offset,
    note:
      value.incomplete === true
        ? // The engine stopped at its bound, not at the end of the window: said, never hidden.
          'This window is very large; Axon stopped reading at its limit. There may be more — read the next page, ' +
          'or read inside one part of it.'
        : controls.length === 0
        ? offset > 0
          ? // A page past the end is the end of the list, not an inaccessible window.
            `There are no more controls after the first ${offset}.`
          : 'That window publishes no controls Axon can act on. Some applications draw their own interface and ' +
            'expose nothing to the accessibility layer; Axon cannot click inside those.'
        : null,
    // The capture worked and the window answered, with nothing Axon can use.
    problem: controls.length === 0 && offset === 0 ? 'UI_NOT_ACCESSIBLE' : null,
  };
}

/** Reshape the accessibility program's answer to an action. */
export function parseOutcome(raw: string): DesktopControlOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
  } catch {
    return { kind: 'failed', reason: 'unreadable' };
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'failed', reason: 'unreadable' };
  const value = parsed as Record<string, unknown>;

  if (value.ok === true) {
    return { kind: 'ok', value: value.value == null ? null : sanitizeText(value.value, OBSERVATION_LIMITS.maxNameCharacters) };
  }

  switch (value.error) {
    case 'gone':
      return { kind: 'gone' };
    case 'ambiguous':
      return { kind: 'ambiguous' };
    case 'sensitive':
      return { kind: 'sensitive' };
    case 'unsupported':
      return { kind: 'unsupported' };
    default:
      return { kind: 'failed', reason: 'unknown' };
  }
}

/**
 * Text from another application, made safe to display and to speak.
 *
 * The same treatment a window title gets, and for the same reason: what the
 * user reads in an approval dialog and what Axon acted on must be the same
 * string, in the same order. An embedded right-to-left override makes those
 * two things differ while looking identical.
 */
function sanitizeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * A window title, made safe to display and to speak.
 *
 * Control characters and bidirectional overrides are stripped for the same
 * reason they are stripped from a transcript and from text about to be typed:
 * what the user reads in an approval dialog and what Axon acted on must be the
 * same string, in the same order.
 */
function sanitizeTitle(title: string): string {
  return title
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

// The point of this pattern is to STRIP control characters out of a window
// title before it is shown or spoken. Matching them is the job.
/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);
/* eslint-enable no-control-regex */

/**
 * Run the constant script.
 *
 * `shell: false` is the default for `spawn` and is relied upon: the argument
 * vector is an array and is never assembled into a command line by us. The
 * program is the last element of that array — a constant — and the two values
 * it reads arrive in the child's environment.
 */
function runPowerShell(args: readonly string[], timeoutMs: number): Promise<string> {
  return runProgram(
    SCRIPT,
    { AXON_WINDOW_MODE: args[0] ?? '', AXON_WINDOW_HANDLE: args[1] ?? '' },
    timeoutMs,
    'The desktop query',
  );
}

/** Run the discovery program. The mode is one of two fixed words, out of band. */
function runAppsProgram(mode: AppsMode, timeoutMs: number): Promise<string> {
  return runProgram(APPS_SCRIPT, { AXON_APPS_MODE: mode }, timeoutMs, 'Finding installed applications');
}

/**
 * The environment the accessibility engine starts with: what PowerShell and
 * the .NET compiler need, and nothing else. The engine runs for minutes at a
 * time next to other applications' content, so it is not handed Axon's
 * environment — no API key, no token, nothing it does not use.
 */
const UIA_ENVIRONMENT_NAMES = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'PATH', 'USERPROFILE', 'LOCALAPPDATA'] as const;

/**
 * Start the native accessibility engine (`uia-program.ts`).
 *
 * The same audited shape as `runProgram`: `shell: false`, a constant program
 * as the last argument, no window. Different in two ways, both deliberate:
 * it stays up and speaks line-delimited JSON over its own stdin and stdout —
 * the anonymous pipes of this one child, which no other process can open — and
 * it runs `-MTA`, the COM apartment Microsoft recommends for UI Automation
 * clients. Text on its way into a field travels on that pipe: never on a
 * command line, never in an environment variable, never in a log.
 */
export function startUiaEngine(): HostProcess {
  const environment: Record<string, string> = {};
  for (const name of UIA_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string') environment[name] = value;
  }
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-MTA', '-Command', UIA_HOST_SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment },
  );
  // stderr is drained and discarded, as for every program here: it can quote
  // a request back, and a request may carry text on its way into a field.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: (() => void)[] = [];
  lines.on('line', (line) => {
    for (const listener of lineListeners) listener(line);
  });
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener();
  };
  child.on('exit', exit);
  child.on('error', exit);
  return {
    write: (line) => {
      if (!exited) child.stdin.write(line);
    },
    onLine: (listener) => lineListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Spawn PowerShell with a constant program and an out-of-band environment.
 *
 * One implementation for both programs, so there is one place where the
 * spawn's shape can be audited and one place a future edit could weaken.
 */
function runProgram(
  program: string,
  variables: Readonly<Record<string, string>>,
  timeoutMs: number,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The values the program reads, out of band. Every one has already
        // been validated by its caller, and none is ever concatenated into the
        // program text.
        env: { ...process.env, ...variables },
      },
    );

    let out = '';
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (error) reject(error);
      else resolve(out);
    };

    // Declared as a TIMEOUT, because it is one — and only this is. Every
    // other way the program can fail stays a plain error.
    const timer = setTimeout(() => finish(new ToolError('TIMEOUT', `${label} did not finish in time.`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // UTF-8 on BOTH ends. Every program sets `[Console]::OutputEncoding` to
    // UTF-8 as its second line; without it Windows PowerShell writes
    // redirected output in the OEM code page, and MEASURED in Phase 3: a
    // Spotify control named "... • ..." arrived as a raw 0x07 (CP437's
    // bullet), the JSON failed to parse, and the whole window read as
    // "could not read the controls". Any non-ASCII title or name was wrong.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Bounded: a runaway script cannot become unbounded memory.
      if (out.length < 256 * 1024) out += chunk;
    });
    // stderr is drained and DISCARDED. A PowerShell error can quote the script
    // and the arguments back — including, for the accessibility program, text
    // on its way into a field — and none of that belongs anywhere near a log
    // or a user-facing message.
    child.stderr.resume();

    child.on('error', () => finish(new Error(`${label} could not be started.`)));
    child.on('close', () => finish(null));
  });
}
