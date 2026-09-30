/**
 * `app.open` — launch one of a fixed set of desktop applications.
 *
 * The security design is the allowlist, and specifically its *shape*. The
 * input is not a program name that we then validate; it is an enum whose
 * members index a constant table. A caller cannot express "run this arbitrary
 * thing" at all — a value outside the enum fails schema validation in the
 * dispatcher and never reaches this file.
 *
 * The risk level comes from the registry rather than from this file, because
 * launching an application is not uniformly harmless: a text editor and Task
 * Manager are both "an application", and only one of them can end a running
 * program. `app-registry.ts` holds that judgement so every tool that can reach
 * an application reads the same answer.
 *
 * PHASE 3 ADDED VERIFICATION, AND IT MATTERS MORE THAN IT SOUNDS.
 *
 * `CreateProcess` returning a pid means the operating system agreed to start
 * something. It does not mean an application opened: the executable can exit
 * immediately, a policy can block it, an installer can be pending, another
 * instance can take the launch and do nothing visible. Reporting "Calculator
 * is open" from a pid is reporting Axon's own optimism, and it is the same
 * defect as claiming a page loaded because a navigation was requested.
 *
 * So the launch is followed by LOOKING: the window list is polled until a
 * window the registry recognises as that application appears, or until a
 * bounded deadline passes. The result says which happened, and the tool's own
 * description tells the model not to claim success without it.
 *
 * The polling is bounded twice over — a deadline and a fixed interval — and
 * failing to verify is never treated as failing to launch. Axon says what it
 * established, which is sometimes "I started it and did not see it appear".
 */

import { z } from 'zod';
import { ToolError, defineTool, type JsonObject, type RegisteredTool, type RiskAssessment, type ToolSummary } from '@axon/core';
import type { AppLauncher } from '../../platform/ports.js';
import type { DesktopWindows } from '../../platform/windows-desktop.js';
import { APP_KEYS, appForWindowTitle, listApps, resolveApp } from './app-registry.js';
import { watchForWindow } from './app-launching.js';

/**
 * How long Axon waits for an application's window to appear.
 *
 * Long enough for a cold start of the applications in the registry, short
 * enough to stay inside the voice provider's tool timeout with room to spare.
 * A launch that has not produced a window by then may still produce one — so
 * the report is "Axon did not see it open", never "it failed to open".
 */
const VERIFY_TIMEOUT_MS = 4_000;

/** How often the window list is retaken while waiting. */
const VERIFY_INTERVAL_MS = 400;

export interface AppOpenToolOptions {
  /**
   * Where Axon looks to confirm the window appeared.
   *
   * Absent off Windows, and absent in unit fixtures that only care about the
   * launch. Without it the tool still launches and still reports honestly —
   * it says it could not check, rather than claiming success it did not
   * establish.
   */
  readonly desktop?: DesktopWindows | null;
  /** Injected in tests so the wait is not a real four seconds. */
  readonly verifyTimeoutMs?: number;
  readonly verifyIntervalMs?: number;
}

const inputSchema = z.object({
  app: z.enum(APP_KEYS).describe('Which permitted application to open.'),
});

type Input = z.infer<typeof inputSchema>;

export function createAppOpenTool(launcher: AppLauncher, options: AppOpenToolOptions = {}): RegisteredTool {
  const desktop = options.desktop ?? null;
  const timeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  const intervalMs = options.verifyIntervalMs ?? VERIFY_INTERVAL_MS;

  /**
   * Wait for a window the registry recognises as this application.
   *
   * Matched through `appForWindowTitle`, which is the same function
   * `window.list` and `app.focus` use — so "is Notepad open?" has one answer
   * across every tool that can ask it, rather than one per tool.
   */
  const waitForWindow = async (app: string): Promise<string | null> => {
    // The shared watcher (`app-launching.ts`), given no "before" snapshot, so
    // only a title is evidence — exactly how this tool has always verified.
    // A listing that fails is retried until the deadline, never read as "no
    // window".
    const sighting = await watchForWindow({
      desktop,
      matches: (title) => appForWindowTitle(title)?.key === app,
      before: null,
      timeoutMs,
      intervalMs,
    });
    return sighting?.title ?? null;
  };

  return defineTool<Input, JsonObject>({
    name: 'app.open',
    title: 'Open an application',
    description:
      'Open one of a fixed set of permitted desktop applications. ' +
      `Permitted values: ${listApps().map((entry) => `${entry.key} (${entry.label})`).join(', ')}. ` +
      'This is the complete list; there is no way to name any other program, path or command, and ' +
      'nothing here will open something merely similar to what was asked for. ' +
      'This tool is for INSTALLED PROGRAMS only — a website (GitHub, YouTube, any address) is not an ' +
      'application and is opened with the browser instead. ' +
      'For any OTHER application installed on this computer — Spotify, WhatsApp, VS Code and the rest — ' +
      'use app.launch, which finds it by name. ' +
      'The result carries a "verified" section saying whether the window actually appeared. ' +
      'Only say the application is open when that says so.',
    inputSchema,

    resolveRisk(input): RiskAssessment {
      const entry = resolveApp(input.app);
      // Unreachable through the dispatcher (the enum guarantees membership),
      // but the tool must not assume its only caller is the one we wrote.
      if (!entry) {
        return { level: 'FORBIDDEN', reason: `"${String(input.app)}" is not a permitted application.` };
      }
      // The level comes from the REGISTRY, not from this tool. Not every
      // application is a Notepad: Settings and Task Manager can change or end
      // things, and the table is where that judgement lives so one edit
      // governs every tool that can launch or focus them.
      return { level: entry.risk, reason: entry.reason };
    },

    summarize(input): ToolSummary {
      const entry = resolveApp(input.app);
      return {
        title: `Axon wants to open ${entry?.label ?? input.app}`,
        parameters: [{ label: 'Application', value: entry?.label ?? input.app }],
      };
    },

    async execute(input, ctx): Promise<JsonObject> {
      const entry = resolveApp(input.app);
      if (!entry) {
        // Not "missing" — NOT PERMITTED. The schema already refuses anything
        // outside the table, so this is the backstop, and a policy refusal is
        // labelled as one.
        throw new ToolError('FORBIDDEN', `"${String(input.app)}" is not a permitted application.`);
      }

      ctx.observe(`Opening ${entry.label}`);

      let pid: number | null = null;
      try {
        if (entry.target.kind === 'uri') {
          await launcher.openUri(entry.target.uri);
        } else {
          pid = (await launcher.launchExecutable(entry.target.file)).pid;
        }
      } catch (error) {
        // The one launch failure with a precise name: the executable is not
        // on this machine. Said as such — "Calculator could not be found" —
        // rather than as a generic failure the model might call a timeout.
        // Everything else is rethrown untouched and stays EXECUTION_ERROR.
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
          throw new ToolError('NOT_FOUND', `${entry.label} could not be found on this computer.`);
        }
        throw error;
      }

      // LAUNCH, THEN LOOK. A pid is the operating system agreeing to start
      // something; a window is the application having started.
      const window = await waitForWindow(input.app);
      const checked = desktop?.available === true;

      ctx.observe(
        window
          ? `${entry.label} is open — "${window}" is on the desktop`
          : checked
            ? `Asked to open ${entry.label}, but no window appeared`
            : `Asked to open ${entry.label}; Axon cannot check the desktop here`,
        { verified: window !== null },
      );

      return {
        app: input.app,
        label: entry.label,
        method: entry.target.kind,
        pid,
        verified: {
          opened: window !== null,
          // UNTRUSTED text: the application named its own window. Carried so a
          // person can see which one Axon found.
          window,
          summary: window
            ? `${entry.label} is open.`
            : checked
              ? `Axon started ${entry.label} but no window appeared within ${Math.round(timeoutMs / 1000)} seconds. ` +
                'Do not say it is open — say it did not open and stop.'
              : `Axon started ${entry.label} but cannot check the desktop on this platform. ` +
                'Do not claim it is open; say you started it.',
        },
      };
    },
  });
}
