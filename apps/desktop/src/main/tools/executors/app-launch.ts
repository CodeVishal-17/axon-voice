/**
 * `app.launch` — open an application installed on this computer, by name.
 *
 * THE MODEL NEVER SUPPLIES WHAT RUNS. It supplies a NAME ("Spotify") or one of
 * Axon's own identifiers ("app_43f3dae580"), and that is a search key into
 * the catalog Axon built from the Start menu (`apps/app-catalog.ts`). What
 * actually starts is the catalog entry's AppID, which the model never sees.
 * A path or a command is refused before anything is looked up.
 *
 *   request   "Open Spotify."
 *   resolve   the built-in five first (their own table, their own risk) —
 *             then the discovered catalog: exactly one match, "which one?",
 *             or "not found"
 *   policy    built-in: as `app.open` always was
 *             discovered: ASKS FIRST. Discovered is not trusted.
 *             blocked (command lines, system tools): refused outright
 *   launch    the Start menu's own mechanism, by AppID
 *   verify    LOOK for the window (`app-launching.ts`) — by the process that
 *             owns it first (`window-identity.ts`), by its title only after
 *
 * "Not found" and "which one?" are answered by the PRECHECK — before anyone
 * is asked to approve anything — so the user is never shown a dialog asking
 * permission to open an application that is not there.
 *
 * The built-in five are not launched by a second implementation: they are
 * handed to the `app.open` tool itself, so there is one way to start Notepad
 * and one way to decide whether it opened.
 */

import { z } from 'zod';
import {
  ClarificationRequired,
  ToolError,
  defineTool,
  type JsonObject,
  type PrecheckVerdict,
  type RegisteredTool,
  type RiskAssessment,
  type SideEffectClass,
  type ToolSummary,
} from '@axon/core';
import type { AppLauncher } from '../../platform/ports.js';
import type { DesktopWindows } from '../../platform/windows-desktop.js';
import {
  clarificationFor,
  describeKind,
  looksLikeCommand,
  normalize,
  resolveApp as resolveDiscovered,
  viewOf,
  type AppCatalog,
  type DiscoveredApp,
  type Resolution,
} from '../../apps/app-catalog.js';
import { listApps, type AppEntry, type AppKey } from './app-registry.js';
import { createAppOpenTool } from './app-open.js';
import { describeSighting, snapshotWindows, watchForWindow } from './app-launching.js';
import { ownerOf, titleNames } from '../../apps/window-identity.js';

/** Store and Electron applications start slower than Notepad; measured cold starts were 2–5 s. */
const DISCOVERED_VERIFY_TIMEOUT_MS = 8_000;
const VERIFY_INTERVAL_MS = 400;

export interface AppLaunchToolOptions {
  readonly catalog: AppCatalog;
  readonly desktop?: DesktopWindows | null;
  readonly verifyTimeoutMs?: number;
  readonly verifyIntervalMs?: number;
  /**
   * Warm the accessibility tree of the window a launch just verified.
   *
   * Chromium-based applications (Spotify, WhatsApp, VS Code) build that tree
   * only when a client first asks, and the first read of a fresh Spotify was
   * measured at ~13 s — past the voice provider's tool timeout, so the user
   * was told Axon "could not read" an application it then read. Fire and
   * forget: whatever it returns is discarded, and it mints no references.
   */
  readonly prime?: (windowHandle: string) => void;
}

const inputSchema = z.object({
  app: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('The application\'s NAME as the user said it ("Spotify", "VS Code"), or an id Axon gave you. Never a path or a command.'),
});
type Input = z.infer<typeof inputSchema>;

const BY_NAME_ONLY = 'Axon opens applications by name, never by a path, a program file or a command.';

/** One of the five built-in applications, by key or by label. */
export function builtInFor(request: string): (AppEntry & { readonly key: AppKey }) | null {
  const wanted = normalize(request);
  return listApps().find((entry) => normalize(entry.key) === wanted || normalize(entry.label) === wanted) ?? null;
}

/** Every candidate is blocked: the answer is a refusal, not a question. */
function allBlocked(resolution: Resolution): string | null {
  if (resolution.kind === 'match') return resolution.app.blocked;
  if (resolution.kind === 'ambiguous' && resolution.candidates.every((app) => app.blocked)) {
    return resolution.candidates[0]?.blocked ?? null;
  }
  return null;
}

export function createAppLaunchTool(launcher: AppLauncher, options: AppLaunchToolOptions): RegisteredTool {
  const { catalog } = options;
  const desktop = options.desktop ?? null;
  const timeoutMs = options.verifyTimeoutMs ?? DISCOVERED_VERIFY_TIMEOUT_MS;
  const intervalMs = options.verifyIntervalMs ?? VERIFY_INTERVAL_MS;
  // The built-in five go through the real `app.open`, not a copy of it.
  const builtIn = createAppOpenTool(launcher, { desktop, verifyIntervalMs: intervalMs });

  /** Resolve against the catalog as it stands, synchronously; null if it has never been taken. */
  const resolveNow = (request: string): Resolution | null => {
    const apps = catalog.snapshot();
    return apps ? resolveDiscovered(apps, request) : null;
  };

  return defineTool<Input, JsonObject>({
    name: 'app.launch',
    title: 'Open an installed application by name',
    description:
      'Open an application installed on this computer, by NAME — "Spotify", "WhatsApp", "Visual Studio ' +
      'Code", "Claude". Axon looks the name up among the applications it found in the Start menu. You never ' +
      'give a path, a program file or a command, and Axon never runs one. The built-in applications ' +
      `(${listApps().map((entry) => entry.label).join(', ')}) work here too. ` +
      'Opening an application Axon found asks the user first. If the name matches more than one application ' +
      'you are told which: ask the user, then call again with the id you were given. If it is not installed, ' +
      'say so — do not open something similar. Command lines, terminals and system tools are never opened. ' +
      'A website is not an application: use web.open for that. The result carries a "verified" section; only ' +
      'say the application is open when that says so.',
    inputSchema,

    /**
     * "Not found" and "which one?", answered before anyone is asked to
     * approve anything. Only from a catalog Axon has actually taken: with
     * none yet, the call proceeds and `execute` looks.
     */
    precheck(input): PrecheckVerdict {
      if (looksLikeCommand(input.app) || builtInFor(input.app)) return { ok: true };
      const resolution = resolveNow(input.app);
      if (!resolution) return { ok: true };
      if (resolution.kind === 'none') {
        // The catalog may simply be older than the installation. Look again
        // in the background, so asking again finds it.
        void catalog.refresh().catch(() => {});
        return {
          ok: false,
          retryable: false,
          kind: 'NOT_FOUND',
          reason: `No application called "${input.app}" was found on this computer.`,
        };
      }
      if (resolution.kind === 'ambiguous' && !allBlocked(resolution)) {
        const choices = resolution.candidates.filter((app) => !app.blocked);
        return { ok: false, retryable: false, clarify: true, reason: clarificationFor(input.app, choices) };
      }
      return { ok: true };
    },

    resolveRisk(input): RiskAssessment {
      if (looksLikeCommand(input.app)) return { level: 'FORBIDDEN', reason: BY_NAME_ONLY };

      // The built-in five keep exactly the level `app.open` gives them.
      const trusted = builtInFor(input.app);
      if (trusted) return { level: trusted.risk, reason: trusted.reason };

      const resolution = resolveNow(input.app);
      const blocked = resolution ? allBlocked(resolution) : null;
      if (blocked) return { level: 'FORBIDDEN', reason: blocked };

      // DISCOVERED IS NOT TRUSTED. Whatever it is, a person says yes first.
      if (resolution?.kind === 'match') {
        return {
          level: 'REQUIRES_APPROVAL',
          reason: `${resolution.app.name} is installed on this computer but is not one of Axon's built-in applications, so Axon asks before opening it.`,
        };
      }
      return { level: 'REQUIRES_APPROVAL', reason: 'Axon asks before opening an application it found on this computer.' };
    },

    summarize(input): ToolSummary {
      const trusted = builtInFor(input.app);
      if (trusted) return { title: `Axon wants to open ${trusted.label}`, parameters: [{ label: 'Application', value: trusted.label }] };
      const resolution = resolveNow(input.app);
      const app = resolution?.kind === 'match' ? resolution.app : null;
      return {
        title: `Axon wants to open ${app?.name ?? input.app}`,
        parameters: [
          { label: 'Application', value: app?.name ?? input.app },
          ...(app ? [{ label: 'Kind', value: describeKind(app.kind) }] : []),
          { label: 'Found in', value: 'the Start menu on this computer' },
        ],
      };
    },

    sideEffect: (): SideEffectClass => 'LOCAL',

    async execute(input, ctx): Promise<JsonObject> {
      if (looksLikeCommand(input.app)) throw new ToolError('FORBIDDEN', BY_NAME_ONLY);

      const trusted = builtInFor(input.app);
      if (trusted) return (await builtIn.execute({ app: trusted.key }, ctx)) as JsonObject;

      // Taken again if stale. A failed listing throws, classified — "Axon
      // could not look" is never reported as "not installed".
      const apps = await catalog.current();
      const resolution = resolveDiscovered(apps, input.app);
      if (resolution.kind === 'none') {
        throw new ToolError('NOT_FOUND', `No application called "${input.app}" was found on this computer.`);
      }
      const blocked = allBlocked(resolution);
      if (blocked) throw new ToolError('FORBIDDEN', blocked);
      if (resolution.kind === 'ambiguous') {
        throw new ClarificationRequired(clarificationFor(input.app, resolution.candidates.filter((app) => !app.blocked)));
      }

      const app: DiscoveredApp = resolution.app;
      if (!launcher.launchStartMenuApp) {
        throw new ToolError('UNSUPPORTED', 'Starting applications Axon found is only available on Windows.');
      }

      ctx.observe(`Opening ${app.name}`, { app: app.id, kind: app.kind, source: app.source });
      const before = await snapshotWindows(desktop);
      await launcher.launchStartMenuApp(app.appId);

      // Identity first: a window whose owning process IS this application
      // (its package, or its program) proves it whatever the title says —
      // Spotify titles its window with the song. A title counts only on a
      // window the OS does not attribute to some other application, so
      // WhatsApp Beta's "WhatsApp" window is never taken for WhatsApp's.
      const sighting = await watchForWindow({
        desktop,
        owns: (window) => ownerOf(window, apps)?.app.id === app.id,
        matches: (title, window) => titleNames(title, app.name) && ownerOf(window, apps) === null,
        before,
        timeoutMs,
        intervalMs,
      });
      const checked = desktop?.available === true;
      const outcome = describeSighting(app.name, sighting, checked, timeoutMs);
      if (outcome.opened && sighting?.handle) options.prime?.(sighting.handle);

      ctx.observe(
        outcome.opened ? `${app.name} is open (${sighting?.evidence ?? 'seen'})` : `Asked to open ${app.name}, but no window was seen`,
        { app: app.id, verified: outcome.opened, evidence: sighting?.evidence ?? null },
      );

      return {
        app: { ...viewOf(app) },
        verified: {
          opened: outcome.opened,
          evidence: sighting?.evidence ?? null,
          // UNTRUSTED text: whatever owns the window named it.
          window: sighting?.title ?? null,
          summary: outcome.summary,
        },
      };
    },
  });
}
