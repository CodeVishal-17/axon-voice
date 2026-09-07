/**
 * Minimal `.env` loading.
 *
 * `.env.example` has told people to "copy to .env and fill in" since Step 1,
 * but nothing read the file — harmless while no key was used, and wrong the
 * moment one was. This closes that gap.
 *
 * Deliberately hand-written rather than a dependency. The parser needs to
 * handle `KEY=value`, comments, blank lines and surrounding quotes, which is
 * twenty lines; adding a package to the main process — the one process holding
 * the API key — is a worse trade than owning those twenty lines.
 *
 * Two rules that matter:
 *
 * - A real environment variable always wins. A key exported into the shell, or
 *   set inline on the `npm run dev` command, must not be silently overridden
 *   by a stale `.env` left on disk.
 * - Nothing here logs a value. It reports which file it read and how many keys
 *   it set, never what they were.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EnvFileResult {
  /** The file that was read, or null when none was found. */
  readonly path: string | null;
  /** How many variables were set. Never the names' values. */
  readonly applied: number;
}

/** Parse `.env` text into key/value pairs. Malformed lines are skipped. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `export FOO=bar` is common in files people also source from a shell.
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;

    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();

    // Strip one matching pair of quotes. Unquoted values keep everything up to
    // the end of the line, including '#', because a key can legitimately
    // contain one and guessing at inline comments loses real characters.
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Load the first `.env` found among `candidates` into `env`.
 *
 * Existing values are never replaced — see the file header.
 */
export function loadEnvFile(candidates: readonly string[], env: NodeJS.ProcessEnv): EnvFileResult {
  for (const candidate of candidates) {
    let contents: string;
    try {
      if (!fs.existsSync(candidate)) continue;
      contents = fs.readFileSync(candidate, 'utf8');
    } catch {
      // Unreadable is the same as absent: a permissions problem on an optional
      // config file must not stop the app from starting.
      continue;
    }

    let applied = 0;
    for (const [key, value] of Object.entries(parseEnvFile(contents))) {
      if (env[key] === undefined || env[key] === '') {
        env[key] = value;
        applied += 1;
      }
    }
    return { path: candidate, applied };
  }

  return { path: null, applied: 0 };
}

/**
 * Where a `.env` might reasonably live.
 *
 * The monorepo root first, since that is where `.env.example` sits, then the
 * working directory and the app directory, which differ between `npm run dev`
 * and a packaged build.
 */
export function envFileCandidates(appDir: string, cwd: string): string[] {
  // Every root is resolved, not just the relative ones: de-duplication is a
  // string comparison, and `/repo` and `C:\repo` are the same directory
  // written two ways.
  const roots = [
    path.resolve(appDir, '../..'),
    path.resolve(appDir, '..'),
    path.resolve(appDir),
    path.resolve(cwd),
  ];
  return Array.from(new Set(roots)).map((root) => path.join(root, '.env'));
}
