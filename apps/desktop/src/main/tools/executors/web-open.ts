/**
 * `web.open` — hand a website to the user's OWN default browser.
 *
 * Not a second browser. Axon's own window (`browser.*`) is the one it can
 * read and click in; this one it cannot see into at all. `web.open` only
 * does what double-clicking a link does: Windows is given an address and
 * gives it to whichever browser the user chose as their default.
 *
 *   address   through the SAME URL policy every navigation passes — http and
 *             https only; no javascript:, file:, loopback, private network or
 *             cloud metadata. A refused address is a structured failure and
 *             is never opened. It is checked again right before it is handed
 *             over, so the address that leaves is the one that was judged.
 *   handing   the existing `openUri` port — the one `app.open` uses for
 *             Settings. No command line, no browser executable, no path.
 *   browser   named from Windows' own record of the default (the https
 *             UserChoice), never assumed to be Chrome or Edge.
 *   verify    LOOK for its window. Windows accepting the address proves only
 *             that it accepted it; the result says which of the two Axon
 *             actually knows.
 *
 * With no address it opens the default browser itself — but only as the
 * Start-menu application Axon discovered, found by Windows' record of which
 * one the default is. The registry never supplies a program to run.
 */

import { z } from 'zod';
import {
  ToolError,
  defineTool,
  type JsonObject,
  type RegisteredTool,
  type RiskAssessment,
  type SideEffectClass,
  type ToolSummary,
} from '@axon/core';
import type { AppLauncher } from '../../platform/ports.js';
import type { DefaultBrowser, DesktopApps, DesktopWindow, DesktopWindows } from '../../platform/windows-desktop.js';
import { assumeHttps, classifyUrl, isNavigable, navigationRisk } from '../../browser/url-policy.js';
import { siteName } from '../../safety/goal-boundary.js';
import type { AppCatalog } from '../../apps/app-catalog.js';
import { snapshotWindows, watchForWindow } from './app-launching.js';
import { ownerOf, titleNames } from '../../apps/window-identity.js';

const VERIFY_TIMEOUT_MS = 6_000;
const VERIFY_INTERVAL_MS = 400;

export interface WebOpenToolOptions {
  readonly apps?: DesktopApps | null;
  readonly catalog?: AppCatalog | null;
  readonly desktop?: DesktopWindows | null;
  readonly verifyTimeoutMs?: number;
  readonly verifyIntervalMs?: number;
}

const inputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .optional()
    .describe('The web address, e.g. "https://www.youtube.com". Leave it out to just open the browser.'),
});
type Input = z.infer<typeof inputSchema>;

/** Moved to the catalog, where it can be shared; re-exported for existing callers. */
export { browserEntry } from '../../apps/app-catalog.js';
import { browserEntry } from '../../apps/app-catalog.js';

export function createWebOpenTool(launcher: AppLauncher, options: WebOpenToolOptions = {}): RegisteredTool {
  const apps = options.apps ?? null;
  const catalog = options.catalog ?? null;
  const desktop = options.desktop ?? null;
  const timeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  const intervalMs = options.verifyIntervalMs ?? VERIFY_INTERVAL_MS;

  /** Which browser is the default, as Windows records it. Null when unknown; never throws. */
  const defaultBrowser = async (): Promise<DefaultBrowser | null> => {
    if (!apps?.appsAvailable) return null;
    try {
      return await apps.defaultBrowser();
    } catch {
      return null;
    }
  };

  return defineTool<Input, JsonObject>({
    name: 'web.open',
    title: "Open a website in the user's browser",
    description:
      "Open a website in the user's OWN default browser — the one they use every day, signed in — or, with " +
      'no address, just open that browser. Axon cannot see or click inside that browser afterwards: use ' +
      'browser.open instead when you need to read the page or act on it. Only http and https addresses; ' +
      'local, private-network and file addresses are refused. A site the user did not name asks them first. ' +
      'The result says whether Axon saw the browser window; if it only says the address was handed over, ' +
      'say exactly that, and never name a browser the result does not name.',
    inputSchema,

    resolveRisk(input): RiskAssessment {
      if (input.url === undefined) {
        return {
          level: 'SAFE',
          reason: 'Opening the browser the user chose as their default shows it and does nothing else.',
        };
      }
      const address = assumeHttps(input.url);
      const verdict = classifyUrl(address);
      // An address that cannot even be read is refused here, not approved and
      // then failed: nobody should be asked to approve something unreadable.
      if (verdict.class === 'INVALID') return { level: 'FORBIDDEN', reason: verdict.reason };
      return navigationRisk(address);
    },

    summarize(input): ToolSummary {
      if (input.url === undefined) {
        return { title: 'Axon wants to open your web browser', parameters: [{ label: 'Browser', value: 'your default browser' }] };
      }
      const address = classifyUrl(assumeHttps(input.url)).normalized ?? input.url;
      return {
        title: `Axon wants to open ${siteName(address) ?? 'a website'} in your browser`,
        parameters: [
          { label: 'Address', value: address },
          { label: 'Opens in', value: 'your default browser' },
        ],
      };
    },

    sideEffect: (): SideEffectClass => 'LOCAL',

    async execute(input, ctx): Promise<JsonObject> {
      const browser = await defaultBrowser();
      const browserName = browser?.name.trim() ? browser.name.trim() : null;

      if (input.url === undefined) {
        // THE BROWSER ITSELF, as a Start-menu application Axon discovered.
        if (!browser || !catalog || !launcher.launchStartMenuApp) {
          throw new ToolError('UNSUPPORTED', 'Axon could not tell which browser is your default here. Give it a web address instead.');
        }
        const apps = await catalog.current();
        const entry = browserEntry(browser, apps);
        if (!entry) {
          throw new ToolError(
            'UNSUPPORTED',
            `Windows says your default browser is ${browserName ?? 'set'}, but Axon could not find it in the Start menu. Give it a web address instead.`,
          );
        }
        ctx.observe(`Opening ${entry.name}`, { app: entry.id, role: 'default-browser' });
        const before = await snapshotWindows(desktop);
        await launcher.launchStartMenuApp(entry.appId);
        const sighting = await watchForWindow({
          desktop,
          owns: (window) => ownerOf(window, apps)?.app.id === entry.id,
          matches: (title, window) => titleNames(title, entry.name) && ownerOf(window, apps) === null,
          before,
          timeoutMs,
          intervalMs,
        });
        const opened = sighting !== null;
        ctx.observe(opened ? `${entry.name} is open (${sighting.evidence})` : `Asked to open ${entry.name}, but no window was seen`, {
          verified: opened,
          evidence: sighting?.evidence ?? null,
        });
        return {
          browser: entry.name,
          url: null,
          verified: {
            opened,
            evidence: sighting?.evidence ?? null,
            window: sighting?.title ?? null,
            summary: opened
              ? sighting.evidence === 'identity'
                ? `${entry.name} is open — confirmed by its own process.`
                : `${entry.name} is open.`
              : `Axon started ${entry.name} but did not see its window. Do not say it is open — say it did not appear.`,
          },
        };
      }

      // THE LAST CHECK, on the exact string that leaves. The dispatcher judged
      // this address a moment ago; judging it again here is what makes "the
      // address that was approved is the address that was opened" true even
      // if the policy was bypassed on the way in.
      const verdict = classifyUrl(assumeHttps(input.url));
      const address = verdict.normalized;
      if (!address || !isNavigable(address)) {
        throw new ToolError('FORBIDDEN', verdict.reason);
      }

      const site = siteName(address);
      ctx.observe(`Opening ${site ?? 'a website'} in the default browser`, { host: verdict.host, browser: browserName });

      // WHICH WINDOWS ARE THE DEFAULT BROWSER'S, by the process that owns them
      // (Phase 4A): its Start-menu entry's package or program, or failing that
      // the package identity Windows records for the https handler. Never a
      // browser Axon assumed — whatever the user chose is what is compared.
      const apps = catalog ? await catalog.current().catch(() => null) : null;
      const entry = browser && apps ? browserEntry(browser, apps) : null;
      const handlerId = browser?.appUserModelId ? browser.appUserModelId.toLowerCase() : null;
      const isBrowser = (window: DesktopWindow): boolean =>
        entry && apps
          ? ownerOf(window, apps)?.app.id === entry.id
          : handlerId !== null && window.appUserModelId?.toLowerCase() === handlerId;

      const before = await snapshotWindows(desktop);
      const known = new Set((before ?? []).map((window) => window.handle));
      await launcher.openUri(address);

      // Strongest first: a window the BROWSER'S PROCESS owns that is new or now
      // in front — a browser window merely existing in the background proves
      // nothing about this address. Then a title naming the browser or the
      // site. Then a new window in front, said as "appears".
      const sighting = await watchForWindow({
        desktop,
        owns: (window) => isBrowser(window) && (window.foreground || !known.has(window.handle)),
        // The same rule for titles: an old "... - Dia" window sitting behind
        // the editor says nothing about this address, so a title counts only
        // on a window that is new or now in front.
        matches: (title, window) =>
          (window.foreground || !known.has(window.handle)) &&
          ((browserName !== null && titleNames(title, browserName)) || (site !== null && titleNames(title, site))),
        before,
        timeoutMs,
        intervalMs,
      });
      const checked = desktop?.available === true;
      const identified = sighting?.evidence === 'identity';
      // A browser is NAMED only when Axon established it: by its process, or
      // by a title that says so. Windows' record alone is "your default browser".
      const shownName = entry?.name ?? browserName;
      const namedBrowser =
        identified || (sighting !== null && browserName !== null && titleNames(sighting.title, browserName));
      const where = namedBrowser && shownName ? shownName : browserName ? `your default browser (${browserName})` : 'your default browser';
      const siteShown = sighting !== null && site !== null && titleNames(sighting.title, site);

      let summary: string;
      if (identified) {
        summary = siteShown
          ? `${site} is open in ${where} — confirmed by the browser's own process.`
          : `Windows handed the address to ${where}, and its window came to the front — confirmed by the browser's own process. ` +
            `Say you opened ${site ?? 'it'} in ${where}.`;
      } else if (sighting?.evidence === 'title') {
        summary = `${site ?? 'The page'} is open in ${where}.`;
      } else if (sighting) {
        summary =
          `Windows handed the address to ${where}, and a browser window came to the front. ` +
          `Say you opened ${site ?? 'it'} in the browser.`;
      } else if (checked) {
        summary =
          `Windows accepted the address and handed it to ${where}, but Axon did not see a browser window for it. ` +
          'Say you sent it to the browser — not that the page is open.';
      } else {
        summary = `Windows accepted the address and handed it to ${where}. Axon cannot check the desktop here; say you sent it to the browser.`;
      }

      ctx.observe(sighting ? `Browser window seen (${sighting.evidence})` : 'Address handed to the default browser; no window seen', {
        verified: sighting !== null,
        evidence: sighting?.evidence ?? null,
      });

      return {
        url: address,
        handedTo: 'default-browser',
        // Windows' record of the default; NOT proof that this browser is what opened.
        defaultBrowser: browserName,
        // Whether the browser's own process confirmed it. Only then may it be named as what opened.
        browserConfirmed: identified,
        verified: {
          opened: sighting !== null,
          evidence: sighting?.evidence ?? null,
          window: sighting?.title ?? null,
          summary,
        },
      };
    },
  });
}
