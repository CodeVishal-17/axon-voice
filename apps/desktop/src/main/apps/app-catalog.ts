/**
 * The applications Axon DISCOVERED on this computer — and what it will and
 * will not do with them.
 *
 * WHY THIS EXISTS. Axon could launch exactly five programs (`app-registry.ts`)
 * and nothing else, so "open Spotify" failed on a machine where Spotify was
 * installed. The fix is not to let a model name a program: it is for Axon to
 * look, keep what it found, and let the model CHOOSE from that.
 *
 *   the OS lists       every entry in the Start menu's application namespace
 *                      (`windows-desktop.ts`, read-only)
 *   Axon keeps         the ones that are applications, each with an Axon-owned
 *                      ID; the AppID used to start it never leaves this side
 *   the model asks     for a NAME (or one of those IDs) — a search key into
 *                      this table, never something to run
 *   Axon resolves      to exactly one entry, or answers "which one?" or "not
 *                      found" — it never picks between duplicates
 *
 * DISCOVERED IS NOT TRUSTED. The five built-in applications keep their own
 * table and their own risk levels. Anything found here is asked about before
 * it is started (`app-launch.ts`), and some things are never started at all:
 * see BLOCKED below.
 *
 * Pure apart from the injected source and clock. No process is started here,
 * no path is opened, and nothing is read from disk.
 */

import type { DefaultBrowser, RawStartMenuApp } from '../platform/windows-desktop.js';

/** How an entry is started, which is also how it is described to a person. */
export type AppKind = 'packaged' | 'registered' | 'program';

export interface DiscoveredApp {
  /** Axon's own identifier: `app_` and ten hex digits of the AppID's hash. Stable. */
  readonly id: string;
  /** What the Start menu calls it. Written by the application: untrusted text. */
  readonly name: string;
  readonly kind: AppKind;
  readonly source: 'start-menu';
  /**
   * Why Axon will never start it, or null. Blocked entries stay in the
   * catalog so a request for one is answered "Axon won't open that", not "not
   * found" — a refusal is a different fact from an absence.
   */
  readonly blocked: string | null;
  /**
   * The Start-menu AppID. INTERNAL: handed to the launcher and to nothing
   * else — never to a model, never into a tool result, never into a log.
   */
  readonly appId: string;
  /**
   * The program its windows run as, lowercased, when Axon can tell (Phase 4A):
   * the Start-menu shortcut's target, or the AppID itself for a program listed
   * by path. INTERNAL, like the AppID, and used for one thing only —
   * recognising which windows belong to this application. Never launched,
   * never shown. Null for packaged apps, which are recognised by package
   * identity instead.
   */
  readonly executable: string | null;
}

/** What a model may see of an entry. No AppID, no path. */
export interface DiscoveredAppView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export function viewOf(app: DiscoveredApp): DiscoveredAppView {
  return { id: app.id, name: app.name, kind: describeKind(app.kind) };
}

export function describeKind(kind: AppKind): string {
  return kind === 'packaged' ? 'Microsoft Store app' : kind === 'program' ? 'desktop program' : 'desktop app';
}

// ---------------------------------------------------------------------------
// What an AppID may look like
// ---------------------------------------------------------------------------

/**
 * The only AppIDs that may ever reach the launcher.
 *
 * Start-menu AppIDs are package identities (`Publisher.App_hash!App`),
 * registered identities (`Microsoft.VisualStudioCode`) or paths to a program
 * (`C:\...\app.exe`, `{known-folder-guid}\...\app.exe`). This admits those
 * shapes and nothing that could change what the launcher's host process does
 * with its argument: no leading switch or separator, no quotes, no percent
 * signs, no control characters, no parent-directory steps, bounded length.
 * Checked here AND again in the launcher, which is the last line before a
 * process starts.
 */
export function isLaunchableAppId(appId: unknown): appId is string {
  if (typeof appId !== 'string' || appId.length === 0 || appId.length > 512) return false;
  if (!/^[A-Za-z0-9{]/.test(appId)) return false;
  if (!/^[A-Za-z0-9 ._!{}()\-\\:+&,']+$/.test(appId)) return false;
  if (appId.includes('..')) return false;
  return true;
}

const PACKAGED = /^[A-Za-z0-9.\-_]+![A-Za-z0-9.\-_]+$/;
const REGISTERED = /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/;
/** A program by path: a drive or a known-folder GUID, ending in `.exe`. */
const PROGRAM = /^(?:[A-Za-z]:\\|\{[0-9A-Fa-f-]{36}\}\\).+\.exe$/i;

/** Which kind of application an AppID names, or null if it is not an application at all. */
export function kindOf(appId: string): AppKind | null {
  if (!isLaunchableAppId(appId)) return null;
  if (PACKAGED.test(appId)) return 'packaged';
  if (PROGRAM.test(appId)) return 'program';
  // A path that is not a program — a manual, a web page, a shortcut to a
  // document — is an entry in the Start menu, not an application.
  if (/[\\:]/.test(appId)) return null;
  if (REGISTERED.test(appId)) return 'registered';
  return null;
}

// ---------------------------------------------------------------------------
// What is never started
// ---------------------------------------------------------------------------

/**
 * Entries that are in the Start menu but are not applications a person means
 * when they say "open X": uninstallers, manuals, release notes, web links.
 * Dropped from the catalog entirely.
 */
const NOT_AN_APPLICATION = /\b(?:uninstall|uninstaller|readme|release notes|documentation|manuals?|help|website|homepage|license)\b/;

/**
 * BLOCKED: applications whose purpose is to run typed commands, or to change
 * the system's configuration. Axon's rule is that it has no shell — no tool
 * takes a command, and none ever will — and launching one of these would put
 * a command line one `keyboard.type` away. So they are refused outright, and
 * "cannot be approved by anyone" is the right answer, not an approval dialog.
 *
 * Matched against the display name AND the AppID, both normalised, on whole
 * words. Deliberately a list of PURPOSES, not of products: "prompt" catches
 * "Anaconda Prompt", "Developer Command Prompt" and "Node.js command prompt"
 * alike. Everything NOT on this list is still only launched after a person
 * says yes, so the list does not have to be complete to be safe — it has to
 * catch the ones where a "yes" would be a mistake nobody should be asked to
 * make.
 *
 * Integrated development environments are NOT blocked: an editor is a
 * reasonable thing to open, and it is approval-gated like everything else
 * discovered.
 */
const BLOCKED_PURPOSES =
  /\b(?:powershell|pwsh|cmd|cmdexe|command prompt|command line|terminal|prompt|bash|zsh|wsl|windows subsystem for linux|ubuntu|debian|kali|opensuse|fedora|alpine|script host|wscript|cscript|mshta|python|pythonw|idle|jupyter|node js|nodejs|irb|jshell|sqlcmd|regedit|registry editor|group policy|gpedit|computer management|task scheduler|local security policy|system configuration|msconfig|mmc)\b/;

/** Program files that are interpreters or consoles, whatever the entry is called. */
const BLOCKED_PROGRAMS =
  /\\(?:cmd|powershell|powershell_ise|pwsh|wt|conhost|bash|wsl|wslhost|python|pythonw|py|node|wscript|cscript|mshta|regedit|mmc|msconfig)\.exe$/i;

export function blockedReason(name: string, appId: string): string | null {
  if (BLOCKED_PROGRAMS.test(appId)) {
    return `"${name}" runs typed commands, and Axon never opens a command line.`;
  }
  // A program's DIRECTORIES say nothing about its purpose, so only its file
  // name is read: measured on a real machine, "Git GUI" lives under
  // `...\Git\cmd\git-gui.exe` and was blocked for the folder's name.
  const identity = /[\\]/.test(appId) ? (appId.split('\\').pop() ?? '') : appId;
  const words = `${normalize(name)} ${normalize(identity)}`;
  const hit = BLOCKED_PURPOSES.exec(words);
  if (!hit) return null;
  return `"${name}" is for running commands or changing system configuration, which Axon never opens.`;
}

// ---------------------------------------------------------------------------
// Building the catalog
// ---------------------------------------------------------------------------

/**
 * Axon's identifier for an AppID. Stable across refreshes and restarts.
 *
 * NOT `createHash`, on purpose: the architecture tests allow exactly one
 * module to hash — the approval binding — so there is one fingerprint
 * function Axon's approvals can depend on, and that rule is worth more than
 * a convenience here. An identifier needs to be stable and distinct, not
 * unforgeable (it only ever looks something up in Axon's own table), so two
 * independent 32-bit FNV-1a hashes give ten hex digits: across a few hundred
 * entries a collision is on the order of one in a hundred million, and
 * `buildCatalog` keeps the first entry if one ever happens.
 */
export function appIdentifier(appId: string): string {
  const fnv = (seed: number): number => {
    let hash = seed >>> 0;
    for (let i = 0; i < appId.length; i += 1) {
      hash ^= appId.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  const high = fnv(0x811c9dc5).toString(16).padStart(8, '0');
  const low = fnv(0x050c5d1f).toString(16).padStart(8, '0');
  return `app_${(high + low).slice(0, 10)}`;
}

/**
 * Control, zero-width and bidirectional-override characters. Built from an
 * escape string, as `url-policy.ts` does, so the source holds no control
 * characters of its own.
 */
// Finding control characters is the point of this pattern; see url-policy.ts.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARACTERS = new RegExp('[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]', 'g');

/** Display names are written by applications. Bounded, and stripped of control characters. */
function cleanName(name: string): string {
  return name
    .replace(UNSAFE_NAME_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * The catalog, from the OS's raw listing.
 *
 * Every record is validated, never trusted: an entry whose AppID is not the
 * shape of an application is dropped, and so is one that is not an
 * application at all. Two entries with the same AppID are one entry. Two
 * entries with the same NAME are both kept — they are different programs,
 * and choosing between them is the user's decision, not Axon's.
 */
export function buildCatalog(raw: readonly RawStartMenuApp[]): readonly DiscoveredApp[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const apps: DiscoveredApp[] = [];
  for (const entry of raw) {
    if (typeof entry?.name !== 'string' || typeof entry?.appId !== 'string') continue;
    const name = cleanName(entry.name);
    const appId = entry.appId.trim();
    if (name === '' || seen.has(appId)) continue;
    const kind = kindOf(appId);
    if (!kind) continue;
    if (NOT_AN_APPLICATION.test(normalize(name))) continue;
    const id = appIdentifier(appId);
    // A collision would make one identifier name two programs. Vanishingly
    // unlikely (see `appIdentifier`), and if it happens the first one stays
    // reachable and the second is not silently reachable under its ID.
    if (ids.has(id)) continue;
    seen.add(appId);
    ids.add(id);
    apps.push({
      id,
      name,
      kind,
      source: 'start-menu',
      blocked: blockedReason(name, appId),
      appId,
      executable: executableOf(appId, entry.target),
    });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** An absolute path to a program on a drive. Anything else identifies nothing. */
const EXECUTABLE = /^[a-z]:\\[^<>"|?*]{1,500}\.exe$/i;

/**
 * Which program an entry's windows run as. The shortcut target first, then a
 * program AppID given as a plain path; otherwise unknown. Lowercased, because
 * Windows paths are case-insensitive and the window listing lowercases too.
 */
export function executableOf(appId: string, target: unknown): string | null {
  for (const candidate of [target, appId]) {
    if (typeof candidate === 'string' && EXECUTABLE.test(candidate) && !/\p{Cc}/u.test(candidate)) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolving a request
// ---------------------------------------------------------------------------

/** Lowercase words, no punctuation. "Visual Studio Code" and "visual-studio code" are equal. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Is this a path or a command rather than a name?
 *
 * Refused before anything is looked up, so "C:\Windows\System32\cmd.exe" is
 * answered "Axon opens applications by name" — not "not found", which would
 * invite a retry with a different path. Names may contain ':' and '&'
 * ("Minecraft: Java Edition", "Hearts & Spades"); paths and commands need
 * separators, drive letters, program extensions or shell punctuation.
 */
export function looksLikeCommand(request: string): boolean {
  if (/[\\/|<>;`$%"]/.test(request)) return true;
  if (/^[A-Za-z]:/.test(request.trim())) return true;
  if (/\.(?:exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msc|scr|lnk|cpl|hta)\b/i.test(request)) return true;
  if (/(?:^|\s)--?[A-Za-z]/.test(request)) return true;
  return false;
}

/** A few spoken names that are not the Start menu's. Short on purpose. */
const ALIASES: Readonly<Record<string, string>> = {
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
};

export type Resolution =
  | { readonly kind: 'match'; readonly app: DiscoveredApp }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly DiscoveredApp[] }
  | { readonly kind: 'none' };

/**
 * One request, one answer — never a guess.
 *
 * Tried in order, and the first tier with any candidate decides:
 *
 *   an Axon ID            "app_0123456789" — what a clarification offers
 *   the exact name        "WhatsApp" is WhatsApp, not "WhatsApp Beta"
 *   a spoken alias        "VS Code" is "Visual Studio Code"
 *   the start of a name   "Visual Studio" is "Visual Studio Code"
 *   every word present    "studio code" is "Visual Studio Code"
 *
 * One candidate in a tier is a match. More than one is AMBIGUOUS, and the
 * caller asks the user: two entries called "Claude" (a desktop install and a
 * Store package, on the machine this was written on) are two programs, and
 * picking one would be Axon deciding for the user. None anywhere is NONE.
 */
export function resolveApp(catalog: readonly DiscoveredApp[], request: string): Resolution {
  const trimmed = request.trim();
  if (/^app_[0-9a-f]{10}$/.test(trimmed)) {
    const app = catalog.find((entry) => entry.id === trimmed);
    return app ? { kind: 'match', app } : { kind: 'none' };
  }

  const query = normalize(trimmed);
  if (query === '') return { kind: 'none' };
  const aliased = ALIASES[query] ?? null;
  const words = query.split(' ');

  const tiers: readonly ((name: string) => boolean)[] = [
    (name) => name === query,
    (name) => aliased !== null && name === aliased,
    (name) => name.startsWith(`${query} `),
    (name) => {
      const tokens = new Set(name.split(' '));
      return words.every((word) => tokens.has(word));
    },
  ];

  for (const tier of tiers) {
    const hits = catalog.filter((app) => tier(normalize(app.name)));
    if (hits.length === 1) return { kind: 'match', app: hits[0]! };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  }
  return { kind: 'none' };
}

/**
 * The question to ask when a name matches more than one entry.
 *
 * Offers each entry by what distinguishes it to a person, and carries the ID
 * the model should pass back — marked as not for reading aloud.
 */
export function clarificationFor(request: string, candidates: readonly DiscoveredApp[]): string {
  const shown = candidates.slice(0, 5);
  const options = shown.map((app) => `${app.name} (${describeKind(app.kind)})`).join(', or ');
  const ids = shown.map((app) => `"${app.name}" as a ${describeKind(app.kind)} is ${app.id}`).join('; ');
  return (
    `I found ${candidates.length} applications matching "${request}": ${options}. Which one do you mean? ` +
    `[For you, not to be read out: ${ids}. Pass that id as "app".]`
  );
}

// ---------------------------------------------------------------------------
// The catalog over time
// ---------------------------------------------------------------------------

/** How long a listing is trusted before it is taken again. */
export const CATALOG_TTL_MS = 10 * 60_000;

/**
 * The live catalog: the latest listing, refreshed when stale.
 *
 * The listing costs a second or so, so it is taken once at startup, kept for
 * ten minutes, and retaken on demand after that. Refreshes are single-flight:
 * two requests arriving together share one listing. A refresh that FAILS
 * keeps the previous catalog and throws — "Axon could not look" is never
 * turned into "nothing is installed".
 */
export class AppCatalog {
  private apps: readonly DiscoveredApp[] | null = null;
  private takenAt = 0;
  private inflight: Promise<readonly DiscoveredApp[]> | null = null;

  constructor(
    private readonly source: () => Promise<readonly RawStartMenuApp[]>,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = CATALOG_TTL_MS,
  ) {}

  /** The current catalog, or null if it has never been taken. Synchronous. */
  snapshot(): readonly DiscoveredApp[] | null {
    return this.apps;
  }

  get stale(): boolean {
    return this.apps === null || this.now() - this.takenAt > this.ttlMs;
  }

  refresh(): Promise<readonly DiscoveredApp[]> {
    this.inflight ??= this.source()
      .then((raw) => {
        this.apps = buildCatalog(raw);
        this.takenAt = this.now();
        return this.apps;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** The catalog, taken again first if it is stale. */
  async current(): Promise<readonly DiscoveredApp[]> {
    return this.stale ? this.refresh() : (this.apps ?? []);
  }
}

/** The Start-menu entry that IS the default browser — by its AppID first, then by its exact name. */
export function browserEntry(browser: DefaultBrowser, apps: readonly DiscoveredApp[]): DiscoveredApp | null {
  const usable = apps.filter((app) => !app.blocked);
  const byId = browser.appUserModelId ? usable.find((app) => app.appId.toLowerCase() === browser.appUserModelId.toLowerCase()) : undefined;
  if (byId) return byId;
  const wanted = normalize(browser.name);
  if (wanted === '') return null;
  const byName = usable.filter((app) => normalize(app.name) === wanted);
  // Two Start-menu entries with the browser's exact name: Axon does not pick.
  return byName.length === 1 ? (byName[0] ?? null) : null;
}
