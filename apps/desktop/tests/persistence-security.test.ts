/**
 * Security properties of the persistence layer.
 *
 * Persistence is a security boundary in its own right: it is the first thing
 * Axon has that outlives the process, and the first place a mistake becomes
 * permanent. These are written as properties over the source and the
 * contracts, because the claims are all of the form "no run of this system can
 * ever do X".
 *
 * The claims:
 *
 *   1. Only one module touches a database engine, and every query is
 *      parameterized.
 *   2. The brain cannot reach the database except through the dispatcher.
 *   3. The renderer cannot reach the database, name a path, or write a memory
 *      directly.
 *   4. The model cannot choose where the database lives.
 *   5. Secrets, audio and reasoning have no table to go into.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, assertMigrationsAreSane, targetVersion } from '../src/main/persistence/migrations.js';
import { BROWSER_PARTITION, resolveRuntimeConfig } from '../src/main/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = path.resolve(HERE, '../src');
const CORE_SRC = path.resolve(HERE, '../../../packages/core/src');

const read = (relative: string): string => fs.readFileSync(path.resolve(DESKTOP_SRC, relative), 'utf8');

/** Source with comments removed. These files discuss SQL at length in prose. */
const code = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = walk(DESKTOP_SRC);

/**
 * Every `this.db.run/get/all(...)` call in a source file, with its arguments.
 *
 * Extracted by balancing parentheses so a call's text is exactly that call —
 * a length-bounded regex runs into the next one and produces assertions about
 * text that was never a single statement.
 */
function databaseCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /this\.db\.(?:run|get|all)(?:<[^>]*>)?\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    calls.push(source.slice(match.index, index));
  }
  return calls;
}
const relative = (file: string): string => path.relative(DESKTOP_SRC, file).replace(/\\/g, '/');

describe('only one module touches a database engine', () => {
  it('imports node:sqlite from exactly one file', () => {
    const importers = ALL_SOURCES.filter((file) => /from ['"]node:sqlite['"]/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      // The type declaration describes the module; it does not import it.
      .filter((name) => !name.endsWith('.d.ts'));

    expect(importers).toEqual(['main/persistence/sqlite.ts']);
  });

  it('writes SQL only in the store and the migrations', () => {
    const writers = ALL_SOURCES.filter((file) =>
      // Anchored on shapes that only occur in real SQL. A bare `SELECT`
      // also matches `el.tagName === 'SELECT'` in the browser's page
      // program, which is an HTML tag name and not a query.
      /\b(?:SELECT \*|SELECT COUNT|INSERT INTO|DELETE FROM|CREATE TABLE|UPDATE \w+ SET)/.test(
        fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      ),
    ).map(relative);

    expect(writers.sort()).toEqual(['main/persistence/migrations.ts', 'main/persistence/store.ts']);
  });
});

describe('every query is parameterized', () => {
  const store = code('main/persistence/store.ts');

  it('never interpolates anything into a SQL string', () => {
    // The property, checked structurally: no template literal in this file
    // contains both a SQL keyword and an interpolation. A message, a memory
    // value, a URL and a model's tool argument all arrive as bound parameters.
    const templates = store.match(/`[^`]*`/g) ?? [];
    const sqlTemplates = templates.filter((template) =>
      /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES)\b/i.test(template),
    );

    expect(sqlTemplates.length).toBeGreaterThan(0);
    for (const template of sqlTemplates) {
      expect(template, 'SQL must not contain an interpolation').not.toMatch(/\$\{/);
    }
  });

  it('never concatenates a variable into SQL', () => {
    expect(store).not.toMatch(/['"]\s*\+\s*\w+\s*\+\s*['"]/);
    expect(store).not.toMatch(/(SELECT|INSERT|UPDATE|DELETE)[^;]*['"]\s*\+/i);
  });

  it('passes values as a parameter array on every call that has any', () => {
    // Each `db.run/get/all` either binds its values through a parameter array
    // or has no values at all (a bare COUNT, a PRAGMA). None builds them into
    // the string. Calls are extracted by balancing parentheses rather than by
    // a bounded regex, which would run into the next call and report nonsense.
    const calls = databaseCalls(store);
    expect(calls.length).toBeGreaterThan(10);

    for (const call of calls) {
      if (!call.includes('?')) continue;
      expect(call, 'a query with placeholders must bind a parameter array').toMatch(/,\s*\[/);
    }
  });

  it('escapes LIKE wildcards so a search means what it says', () => {
    expect(store).toMatch(/ESCAPE/);
    expect(store).toMatch(/function escapeLike/);
  });

  it('exposes no method that runs caller-supplied SQL', () => {
    const sqlite = code('main/persistence/sqlite.ts');
    // `exec` exists for DDL and is used only by the migration runner with
    // module constants. There is no `query(string)` escape hatch, and no way
    // to reach the underlying handle.
    expect(sqlite).not.toMatch(/getHandle|rawQuery|unsafeQuery/);
    // Anchored on the receiver: `.exec(` on its own also matches
    // `RegExp.prototype.exec`, which several modules use legitimately.
    const execCallers = ALL_SOURCES.filter((file) =>
      /\b(?:db|handle|database)\.exec\(/.test(fs.readFileSync(file, 'utf8')),
    ).map(relative);
    expect(execCallers.sort()).toEqual(['main/persistence/migrations.ts', 'main/persistence/sqlite.ts']);
  });
});

describe('the brain cannot reach the database', () => {
  const brainFiles = ALL_SOURCES.filter((file) => relative(file).startsWith('main/brain/'));

  it('has brain modules, so this is not vacuous', () => {
    expect(brainFiles.length).toBeGreaterThan(3);
  });

  it('imports no persistence module', () => {
    const offenders: string[] = [];
    for (const file of brainFiles) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [/from ['"].*persistence\//, /from ['"]node:sqlite['"]/, /from ['"].*\/store\.js['"]/, /from ['"].*settings\//]) {
        if (pattern.test(source)) offenders.push(`${relative(file)} -> ${pattern.source}`);
      }
    }
    expect(offenders, 'The brain receives context as an argument; it does not query for it').toEqual([]);
  });

  it('names no table, no SQL and no database', () => {
    for (const file of brainFiles) {
      const source = code(relative(file));
      for (const word of ['sqlite', 'SELECT ', 'INSERT ', 'PersistenceStore', 'PersistenceService', 'databasePath']) {
        expect(source, `${relative(file)} must not mention ${word}`).not.toContain(word);
      }
    }
  });

  it('receives its context as an argument on the turn input', () => {
    // The structural reason the rule above holds: the only route to stored
    // history is a field the orchestrator fills in and hands over.
    const contract = fs.readFileSync(path.resolve(CORE_SRC, 'interfaces/brain.ts'), 'utf8');
    expect(contract).toMatch(/readonly context\?: SessionContext \| null;/);

    const claude = code('main/brain/claude-brain.ts');
    expect(claude).toMatch(/context: input\.context/);
  });

  it('reaches memory only through a tool, which goes through the dispatcher', () => {
    const memoryTool = code('main/tools/executors/memory.ts');
    // The executor holds the persistence service; the brain holds a schema.
    expect(memoryTool).toMatch(/persistence: PersistenceService/);

    // And the schema view carries no callable — the property Step 1 set up.
    const surface = code('main/brain/tool-surface.ts');
    expect(surface).not.toContain('PersistenceService');
  });
});

describe('the renderer cannot reach the database', () => {
  const preload = read('preload/index.ts');
  const ipc = fs.readFileSync(path.resolve(CORE_SRC, 'ipc.ts'), 'utf8');

  it('has no channel that carries SQL, a table or a path', () => {
    // Comments stripped: the block explains at length that it carries no SQL,
    // and the property under test is about the channel names.
    const channels = ipc
      .slice(ipc.indexOf('IPC_CHANNELS'), ipc.indexOf('} as const;'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const word of ['sql', 'query', 'table', 'database', 'db:', 'path']) {
      expect(channels.toLowerCase(), `no channel may mention ${word}`).not.toContain(word);
    }
  });

  it('exposes no way to create a memory directly', () => {
    // A memory is written by the agent through the dispatcher with the user's
    // approval. A renderer-side create would be a second, ungated path to the
    // same table.
    expect(preload).not.toMatch(/\bsaveMemory\b|\bcreateMemory\b|\baddMemory\b/);
    expect(ipc).not.toMatch(/MEMORY_SAVE|MEMORY_CREATE/);
  });

  it('exposes no filesystem or database path setter', () => {
    for (const forbidden of ['databasePath', 'dbPath', 'profilePath', 'browserProfile', 'readFile', 'writeFile']) {
      expect(preload, `preload must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('sends settings as a closed patch, rebuilt field by field', () => {
    // Whatever else a caller attached to the object stays on the renderer's
    // side of the boundary, and main validates every field again regardless.
    expect(preload).toMatch(/voiceHotkey !== undefined/);
    expect(preload).toMatch(/workspacePath !== undefined/);
    expect(preload).not.toMatch(/\.\.\.patch[,\s}]/);
  });

  it('has every persistence payload validated in main', () => {
    const bridge = code('main/bus/renderer-bridge.ts');
    for (const channel of [
      'SESSION_SELECT',
      'SESSION_RENAME',
      'SESSION_DELETE',
      'MEMORY_SET_ENABLED',
      'MEMORY_DELETE',
      'SETTINGS_UPDATE',
      'PROFILE_UPDATE',
    ]) {
      const handler = bridge.slice(bridge.indexOf(`IPC_CHANNELS.${channel}`));
      const body = handler.slice(0, handler.indexOf('});'));
      expect(body, `${channel} must validate its payload`).toMatch(/safeParse/);
      expect(body, `${channel} must reject a bad payload`).toMatch(/invalidPayload/);
    }
  });
});

describe('nobody but the application chooses where the database lives', () => {
  /** Electron's own session-data path on Windows. */
  const SESSION_DATA = 'C:\\Users\\someone\\AppData\\Roaming\\axon-desktop';
  const config = resolveRuntimeConfig({
    home: 'C:\\Users\\someone',
    env: {},
    isDev: false,
    sessionData: SESSION_DATA,
  });

  it('derives the path from the Axon home and nothing else', () => {
    expect(config.databasePath).toBe(path.join('C:\\Users\\someone', 'Axon', 'data', 'axon.db'));
  });

  it('keeps it out of the workspace the agent may write to', () => {
    // Otherwise an approved `fs.write` could target the file holding the
    // user's conversation history.
    expect(config.databasePath.startsWith(config.workspaceRoot)).toBe(false);
  });

  it('puts the data directory on the forbidden-write list', () => {
    const dataDir = path.dirname(config.databasePath);
    expect(config.forbiddenRoots.some((root) => dataDir.startsWith(root))).toBe(true);
  });

  it('names the directory Chromium really uses for the browser profile', () => {
    // This one asserted the wrong thing until the Step 6 security sweep: it
    // checked that the profile sat beside the database, which was true of a
    // path Axon computed and never true of the profile itself. A `persist:`
    // partition is stored by Chromium under the session-data directory, so a
    // made-up path here would put a fictional directory on the forbidden list
    // and protect nothing.
    expect(config.browserProfileDir).toBe(
      path.join(SESSION_DATA, 'Partitions', 'axon-browser'),
    );
    expect(BROWSER_PARTITION).toBe('persist:axon-browser');
  });

  it('keeps the browser profile out of the Axon data directory', () => {
    // Two different kinds of secret, with two different lifetimes. Clearing
    // one must never be able to clear the other by accident.
    expect(config.browserProfileDir.startsWith(path.dirname(config.databasePath))).toBe(false);
  });

  it('puts the browser profile on the forbidden-write list', () => {
    // Load-bearing since the workspace became a user setting: a workspace
    // pointed at the profile directory would otherwise make the cookie store
    // writable by an approved `fs.write`.
    expect(config.forbiddenRoots).toContain(config.browserProfileDir);
  });

  it('offers no tool that takes a database or profile path', () => {
    const executors = ALL_SOURCES.filter((file) => relative(file).startsWith('main/tools/executors/'));
    for (const file of executors) {
      const source = code(relative(file));
      for (const forbidden of ['databasePath', 'dbPath', 'profileDir', 'browserProfile']) {
        expect(source, `${relative(file)} must not accept ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('lets the settings surface name a workspace, which is not the database', () => {
    // The one path a user can set. It is validated, normalized, and used for a
    // different purpose; there is no code path that makes it the database.
    const runtime = code('main/runtime.ts');
    expect(runtime).toMatch(/databasePath: config\.databasePath/);
    expect(runtime).not.toMatch(/databasePath:\s*(settings|workspace|inputs\.env)/);
  });
});

describe('what has nowhere to be stored', () => {
  const store = code('main/persistence/store.ts');
  const schema = MIGRATIONS.map((migration) => migration.statements.join('\n')).join('\n');

  it('has no table or column for audio', () => {
    for (const word of ['audio', 'pcm', 'samples', 'waveform', 'recording']) {
      expect(schema.toLowerCase(), `no column may be for ${word}`).not.toContain(word);
    }
  });

  it('has no table or column for reasoning', () => {
    for (const word of ['thinking', 'reasoning', 'chain_of_thought', 'scratchpad']) {
      expect(schema.toLowerCase()).not.toContain(word);
    }
  });

  it('has no table or column for credentials, cookies or tokens', () => {
    for (const word of ['token', 'cookie', 'password', 'credential', 'secret', 'api_key']) {
      expect(schema.toLowerCase()).not.toContain(word);
    }
  });

  it('has no table for tool calls, tool results or page content', () => {
    for (const word of ['tool_', 'page_', 'html', 'screenshot']) {
      expect(schema.toLowerCase()).not.toContain(word);
    }
  });

  it('stores exactly four tables', () => {
    const tables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]);
    expect(tables.sort()).toEqual(['memories', 'messages', 'sessions', 'settings']);
  });

  it('redacts credential-shaped spans out of a message before storing it', () => {
    expect(store).toMatch(/redactSecrets\(input\.content\)/);
  });
});

describe('migrations are sane before they touch anything', () => {
  it('are numbered from one with no gaps', () => {
    expect(() => assertMigrationsAreSane()).not.toThrow();
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_migration, index) => index + 1),
    );
  });

  it('derive the target version rather than declaring it', () => {
    expect(targetVersion()).toBe(MIGRATIONS.length);
  });

  it('reject a list with a gap, a duplicate, or an empty migration', () => {
    const cases = [
      [{ version: 1, name: 'a', statements: ['CREATE TABLE a (id TEXT)'] }, { version: 3, name: 'c', statements: ['x'] }],
      [{ version: 1, name: 'a', statements: ['x'] }, { version: 1, name: 'b', statements: ['x'] }],
      [{ version: 1, name: 'a', statements: [] }],
    ];
    for (const migrations of cases) {
      expect(() => assertMigrationsAreSane(migrations)).toThrow();
    }
  });

  it('build the schema from constants with no interpolation', () => {
    const source = code('main/persistence/migrations.ts');
    const list = source.slice(source.indexOf('export const MIGRATIONS'), source.indexOf('export function targetVersion'));
    expect(list).not.toMatch(/\$\{/);
  });

  it('write the version only from a checked integer', () => {
    // `PRAGMA user_version` cannot take a bound parameter, so the value is
    // interpolated — and is therefore checked to be an integer this module
    // derived from its own constant list.
    const source = code('main/persistence/migrations.ts');
    expect(source).toMatch(/Number\.isInteger\(version\)/);
    expect(source).toMatch(/PRAGMA user_version = \$\{version\}/);
  });
});
