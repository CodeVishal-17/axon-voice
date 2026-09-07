/**
 * Seeing and moving desktop windows, on Windows.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * This is the only module that runs a program to inspect or move a window, and
 * it does so exactly the way the speech providers do: a CONSTANT script,
 * spawned without a shell, with every variable passed OUT OF BAND and nothing
 * interpolated into the program text. `architecture.test.ts` asserts that
 * shape, so the claim is checked rather than believed.
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
 * application's contents, memory, or input. It enumerates TOP-LEVEL VISIBLE
 * windows and reports a title and a handle; it can raise, minimise or maximise
 * one. There is no close, no kill, no move, no resize, and no way to send
 * anything to a window from this file.
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

/** One visible top-level window, as the operating system describes it. */
export interface DesktopWindow {
  /** The OS window handle, as a string. Opaque, and never shown to a model. */
  readonly handle: string;
  readonly title: string;
  /** True when it is currently the foreground window. */
  readonly foreground: boolean;
  readonly minimized: boolean;
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
'@

$mode = $env:AXON_WINDOW_MODE

if ($mode -eq 'list') {
  $foreground = [AxonNative.Win]::GetForegroundWindow()
  $found = New-Object System.Collections.ArrayList
  $callback = [AxonNative.Win+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([AxonNative.Win]::IsWindowVisible($hWnd)) {
      $length = [AxonNative.Win]::GetWindowTextLengthW($hWnd)
      if ($length -gt 0) {
        $builder = New-Object System.Text.StringBuilder ($length + 1)
        [void][AxonNative.Win]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
        $title = $builder.ToString()
        if ($title.Trim().Length -gt 0) {
          [void]$found.Add([pscustomobject]@{
            handle = $hWnd.ToString()
            title = $title
            foreground = ($hWnd -eq $foreground)
            minimized = [AxonNative.Win]::IsIconic($hWnd)
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

/** Handles are decimal integers. Anything else never reaches the script. */
const HANDLE_PATTERN = /^-?\d{1,19}$/;

const LIST_TIMEOUT_MS = 8_000;
const ACT_TIMEOUT_MS = 5_000;
/** Windows Axon will describe in one listing. A desktop has tens, not thousands. */
const MAX_WINDOWS = 60;
/** Characters of a window title Axon will carry. Titles are untrusted text. */
const MAX_TITLE = 160;

export interface WindowsDesktopOptions {
  readonly platform?: NodeJS.Platform;
  /** Injected in tests so the port is exercised without spawning anything. */
  readonly run?: (args: readonly string[], timeoutMs: number) => Promise<string>;
}

export class WindowsDesktop implements DesktopWindows {
  readonly available: boolean;
  private readonly run: (args: readonly string[], timeoutMs: number) => Promise<string>;

  constructor(options: WindowsDesktopOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.available = options.run !== undefined || platform === 'win32';
    this.run = options.run ?? runPowerShell;
  }

  async list(): Promise<readonly DesktopWindow[]> {
    if (!this.available) return [];

    let raw: string;
    try {
      raw = await this.run(['list'], LIST_TIMEOUT_MS);
    } catch {
      // A listing that failed is an empty listing, not a crash: the tool above
      // reports "Axon could not see any windows", which is true and useful.
      return [];
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
    });
  }

  return windows;
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
  return new Promise((resolve, reject) => {
    const [mode = '', handle = ''] = args;

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The two values the program reads, out of band. Both have already
        // been validated by the caller — `mode` is one of three literals from
        // a union type, `handle` has passed HANDLE_PATTERN — and neither is
        // ever concatenated into the program text.
        env: { ...process.env, AXON_WINDOW_MODE: mode, AXON_WINDOW_HANDLE: handle },
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

    const timer = setTimeout(() => finish(new Error('The desktop query did not finish in time.')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Bounded: a runaway script cannot become unbounded memory.
      if (out.length < 256 * 1024) out += chunk;
    });
    // stderr is drained and DISCARDED. A PowerShell error can quote the script
    // and the arguments back, and none of that belongs anywhere near a log or
    // a user-facing message.
    child.stderr.resume();

    child.on('error', () => finish(new Error('The desktop query could not be started.')));
    child.on('close', () => finish(null));
  });
}
