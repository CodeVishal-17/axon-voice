/**
 * Architectural boundary tests.
 *
 * These assert properties of the source tree itself rather than of any
 * runtime behaviour. The safety layer's guarantees are only guarantees while
 * there is exactly one way into an executor; a stray import is not untidiness,
 * it is a second door.
 *
 * The same rules exist in `eslint.config.js`, where they fail faster. They are
 * repeated here because lint rules can be disabled inline or edited away,
 * whereas a failing test blocks the build and says why.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DESKTOP_SRC = path.resolve(HERE, '../src');
const CORE_SRC = path.resolve(REPO_ROOT, 'packages/core/src');

interface SourceFile {
  /** Repo-relative, forward-slashed, for readable failure messages. */
  readonly rel: string;
  readonly abs: string;
  readonly imports: readonly string[];
}

function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Every module specifier in a file: static imports, side-effect imports,
 *  `export ... from`, dynamic `import()` and `require()`. */
function extractImports(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function load(root: string): SourceFile[] {
  return listSourceFiles(root).map((abs) => ({
    abs,
    rel: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'),
    imports: extractImports(fs.readFileSync(abs, 'utf8')),
  }));
}

const DESKTOP_FILES = load(DESKTOP_SRC);
const CORE_FILES = load(CORE_SRC);

const filesUnder = (files: readonly SourceFile[], prefix: string): SourceFile[] =>
  files.filter((file) => file.rel.startsWith(prefix));

const importsMatching = (file: SourceFile, test: (specifier: string) => boolean): string[] =>
  file.imports.filter(test);

const isExecutorImport = (specifier: string): boolean => /(^|\/)executors\//.test(specifier);

/**
 * The model vendor SDK.
 *
 * Named once so the rules below and the brain's own allowlist cannot drift
 * apart, and so adding a second vendor is a visible edit here rather than a
 * quiet exception somewhere in the tree.
 */
const VENDOR_SDK = '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------

describe('the test itself is not vacuous', () => {
  it('found the desktop source tree', () => {
    expect(DESKTOP_FILES.length).toBeGreaterThan(15);
  });

  it('found the core source tree', () => {
    expect(CORE_FILES.length).toBeGreaterThan(5);
  });

  it('extracts imports correctly', () => {
    const sample = [
      "import { a } from 'alpha';",
      "import type { B } from './beta.js';",
      "import 'side-effect';",
      "export { c } from './gamma.js';",
      "const d = await import('delta');",
      "const e = require('epsilon');",
    ].join('\n');

    expect(extractImports(sample).sort()).toEqual(
      ['./beta.js', './gamma.js', 'alpha', 'delta', 'epsilon', 'side-effect'].sort(),
    );
  });

  it('has a brain directory with real modules, so the brain rules bite', () => {
    // If the brain directory were empty, the boundary tests below would pass
    // trivially and would stop meaning anything the moment Step 2 lands.
    expect(filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/').length).toBeGreaterThan(0);
  });

  it('has executors to protect', () => {
    expect(filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/tools/executors/').length).toBeGreaterThanOrEqual(3);
  });
});

describe('BOUNDARY: only the registry may import an executor', () => {
  it('holds across the whole desktop source tree', () => {
    const offenders = DESKTOP_FILES.filter(
      (file) =>
        !file.rel.startsWith('apps/desktop/src/main/tools/executors/') &&
        file.rel !== 'apps/desktop/src/main/tools/registry.ts' &&
        importsMatching(file, isExecutorImport).length > 0,
    ).map((file) => `${file.rel} -> ${importsMatching(file, isExecutorImport).join(', ')}`);

    expect(offenders, 'Executors may only be imported by tools/registry.ts').toEqual([]);
  });

  it('confirms the registry really is the one importer', () => {
    const registry = DESKTOP_FILES.find((f) => f.rel === 'apps/desktop/src/main/tools/registry.ts');
    expect(registry).toBeDefined();
    expect(importsMatching(registry!, isExecutorImport).length).toBeGreaterThanOrEqual(3);
  });
});

describe('BOUNDARY: the brain cannot reach past the dispatcher', () => {
  const brainFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/');

  const FORBIDDEN: ReadonlyArray<{ label: string; test: (specifier: string) => boolean }> = [
    { label: 'an executor', test: isExecutorImport },
    { label: 'the tool registry', test: (s) => /(^|\/)tools\/registry(\.js)?$/.test(s) },
    { label: 'the safety layer', test: (s) => /(^|\/)safety\//.test(s) },
    { label: 'Electron', test: (s) => s === 'electron' },
    { label: 'the filesystem', test: (s) => s === 'node:fs' || s === 'node:fs/promises' || s === 'fs' },
    { label: 'child processes', test: (s) => s === 'node:child_process' || s === 'child_process' },
  ];

  it.each(FORBIDDEN.map((rule) => [rule.label, rule] as const))('never imports %s', (_label, rule) => {
    const offenders = brainFiles
      .filter((file) => importsMatching(file, rule.test).length > 0)
      .map((file) => `${file.rel} -> ${importsMatching(file, rule.test).join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('imports nothing beyond @axon/core, the model SDK, and its own directory', () => {
    // The brain receives its tool surface and its dispatch callback as
    // arguments. That argument passing IS the boundary; anything else it could
    // import would be a way around it.
    //
    // The Anthropic SDK is the one addition Step 2 makes to this list, and it
    // is admitted here and nowhere else — see the vendor-SDK block below,
    // which asserts the other half of that rule.
    const offenders: string[] = [];
    for (const file of brainFiles) {
      for (const specifier of file.imports) {
        const allowed =
          specifier === '@axon/core' ||
          specifier.startsWith('@axon/core/') ||
          specifier === VENDOR_SDK ||
          specifier.startsWith(`${VENDOR_SDK}/`) ||
          specifier.startsWith('./');
        if (!allowed) offenders.push(`${file.rel} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The vendor SDK boundary.
 *
 * A model SDK reachable from the renderer would put an API key one bundling
 * mistake away from a sandboxed web page. Reachable from an executor, it would
 * mean a tool could talk to a model behind the dispatcher's back. Confining it
 * to the brain keeps both impossible by construction rather than by convention.
 */
describe('BOUNDARY: only the brain may import a model vendor SDK', () => {
  const isVendorImport = (specifier: string): boolean =>
    specifier === VENDOR_SDK || specifier.startsWith(`${VENDOR_SDK}/`);

  it('is actually used by the brain, so this suite is not vacuous', () => {
    const brainFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/');
    const importers = brainFiles.filter((file) => importsMatching(file, isVendorImport).length > 0);
    expect(importers.length).toBeGreaterThan(0);
  });

  it('appears nowhere else in the desktop source tree', () => {
    const offenders = DESKTOP_FILES.filter(
      (file) =>
        !file.rel.startsWith('apps/desktop/src/main/brain/') && importsMatching(file, isVendorImport).length > 0,
    ).map((file) => `${file.rel} -> ${importsMatching(file, isVendorImport).join(', ')}`);

    expect(offenders, 'The model SDK may only be imported under src/main/brain/').toEqual([]);
  });

  it.each([
    ['the renderer', 'apps/desktop/src/renderer/'],
    ['the preload bridge', 'apps/desktop/src/preload/'],
    ['the tool layer', 'apps/desktop/src/main/tools/'],
    ['the safety layer', 'apps/desktop/src/main/safety/'],
  ])('is unreachable from %s', (_label, prefix) => {
    const offenders = filesUnder(DESKTOP_FILES, prefix)
      .filter((file) => importsMatching(file, isVendorImport).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('never appears in @axon/core, which the renderer imports', () => {
    const offenders = CORE_FILES.filter((file) => importsMatching(file, isVendorImport).length > 0).map(
      (file) => file.rel,
    );
    expect(offenders).toEqual([]);
  });

  it('is declared as a dependency of the desktop app, not of core', () => {
    const desktopPkg = JSON.parse(
      fs.readFileSync(path.resolve(REPO_ROOT, 'apps/desktop/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const corePkg = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, 'packages/core/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(desktopPkg.dependencies ?? {})).toContain(VENDOR_SDK);
    expect(Object.keys(corePkg.dependencies ?? {})).not.toContain(VENDOR_SDK);
  });
});

/**
 * The voice subsystem's boundaries.
 *
 * Speech introduces a subprocess, untrusted text arriving at it, and audio
 * heading for the renderer. Each of those gets a rule here.
 */
describe('BOUNDARY: the voice subsystem', () => {
  const voiceFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/voice/');

  /**
   * Matches the MAIN-PROCESS voice layer specifically.
   *
   * Step 4 adds `src/renderer/components/voice/`, which holds the push-to-talk
   * button — a React component with no relationship to this subsystem beyond
   * the word. Anchoring on `main/voice/` is what the rule always meant, and it
   * is strictly narrower than the directory name alone: a relative import
   * reaching from the renderer into the real voice layer still spells
   * `../../main/voice/...` and is still caught.
   */
  const isVoiceLayerImport = (specifier: string): boolean => /(^|\/)main\/voice\//.test(specifier);

  it('exists, so these rules are not vacuous', () => {
    expect(voiceFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('is unreachable from the renderer', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/')
      .filter((file) => importsMatching(file, isVoiceLayerImport).length > 0)
      .map((file) => file.rel);
    expect(offenders, 'The renderer plays audio it is given; it does not reach into the voice layer').toEqual([]);
  });

  it('is unreachable from the preload bridge', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/preload/')
      .filter((file) => importsMatching(file, isVoiceLayerImport).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('is not imported by the brain', () => {
    // The brain produces text. It must not be able to reach the thing that
    // turns text into a subprocess — nor, since Step 4, the thing that holds
    // the microphone. Audio reaches the brain in neither direction.
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/')
      .filter((file) => importsMatching(file, isVoiceLayerImport).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('never imports an executor, the registry, or the safety layer', () => {
    const forbidden = (s: string): boolean =>
      isExecutorImport(s) || /(^|\/)tools\/registry(\.js)?$/.test(s) || /(^|\/)safety\//.test(s);
    const offenders = voiceFiles
      .filter((file) => importsMatching(file, forbidden).length > 0)
      .map((file) => `${file.rel} -> ${importsMatching(file, forbidden).join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('never imports the model SDK', () => {
    const offenders = voiceFiles
      .filter((file) => importsMatching(file, (s) => s.startsWith(VENDOR_SDK)).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('spawns a process from exactly two modules, both of them providers', () => {
    // An exact list, not a ceiling. Each entry is an adapter for one external
    // speech engine — out in `sapi-tts.ts`, in in `windows-stt.ts` — and both
    // pass a constant program with an argv array and no shell. A third name
    // appearing here is a new subprocess, and that should require editing this
    // line and explaining why.
    const spawners = voiceFiles
      .filter((file) => importsMatching(file, (s) => s === 'node:child_process' || s === 'child_process').length > 0)
      .map((file) => file.rel)
      .sort();
    expect(spawners).toEqual([
      'apps/desktop/src/main/voice/sapi-tts.ts',
      'apps/desktop/src/main/voice/windows-stt.ts',
    ]);
  });

  it('touches the filesystem from no module at all', () => {
    // Both directions of audio are buffers. Speech is synthesised to memory
    // and delivered as bytes; microphone frames are forwarded to a recognizer
    // over a pipe. There is no temporary WAV file anywhere in either path, so
    // there is nothing to traverse into, collide with, or leave behind — and
    // "Axon never records you to disk" is a property of the design rather than
    // a promise about cleanup.
    const offenders = voiceFiles
      .filter((file) => importsMatching(file, (s) => /^(node:)?fs(\/promises)?$/.test(s)).length > 0)
      .map((file) => file.rel);
    expect(offenders, 'Neither speech nor microphone audio ever touches disk').toEqual([]);
  });
});

/**
 * The persistence subsystem's boundaries.
 *
 * Persistence is the first thing in Axon that outlives the process, which
 * makes it the first place a mistake becomes permanent. A future developer
 * must not be able to make `ClaudeBrain -> sqlite.ts` without this failing.
 */
describe('BOUNDARY: the persistence subsystem', () => {
  const persistenceFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/persistence/');
  const isPersistenceImport = (specifier: string): boolean => /(^|\/)persistence\//.test(specifier);

  it('exists, so these rules are not vacuous', () => {
    expect(persistenceFiles.length).toBeGreaterThanOrEqual(6);
  });

  it('is unreachable from the renderer', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/')
      .filter((file) => importsMatching(file, isPersistenceImport).length > 0)
      .map((file) => file.rel);
    expect(offenders, 'The renderer asks main for conversations; it does not open a database').toEqual([]);
  });

  it('is unreachable from the preload bridge', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/preload/')
      .filter((file) => importsMatching(file, isPersistenceImport).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('is not imported by the brain', () => {
    // The load-bearing one. The brain receives bounded context as an argument;
    // an import here would let a future edit reach past that and query for
    // more — a whole session, every memory, another conversation.
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/')
      .filter((file) => importsMatching(file, isPersistenceImport).length > 0)
      .map((file) => `${file.rel} -> ${importsMatching(file, isPersistenceImport).join(', ')}`);
    expect(offenders, 'ClaudeBrain must never reach the persistence layer').toEqual([]);
  });

  it('is not imported by the browser or the voice subsystems', () => {
    // Neither has a reason to write to the database, and both handle content
    // from outside the machine. Keeping them away from it means a bug in
    // either cannot become a permanent one.
    for (const prefix of ['apps/desktop/src/main/browser/', 'apps/desktop/src/main/voice/']) {
      const offenders = filesUnder(DESKTOP_FILES, prefix)
        .filter((file) => importsMatching(file, isPersistenceImport).length > 0)
        .map((file) => file.rel);
      expect(offenders, `${prefix} must not reach persistence`).toEqual([]);
    }
  });

  it('never imports an executor, the registry, or the safety layer', () => {
    const forbidden = (s: string): boolean =>
      isExecutorImport(s) || /(^|\/)tools\/registry(\.js)?$/.test(s) || /(^|\/)safety\//.test(s);
    const offenders = persistenceFiles
      .filter((file) => importsMatching(file, forbidden).length > 0)
      .map((file) => `${file.rel} -> ${importsMatching(file, forbidden).join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('never imports the model SDK or Electron', () => {
    const offenders = persistenceFiles
      .filter((file) => importsMatching(file, (s) => s.startsWith(VENDOR_SDK) || s === 'electron').length > 0)
      .map((file) => file.rel);
    // No Electron: the database path arrives as a string from `config.ts`, so
    // persistence cannot reach for `app.getPath` and decide for itself where
    // to write.
    expect(offenders).toEqual([]);
  });

  it('spawns no process', () => {
    const offenders = persistenceFiles
      .filter((file) => importsMatching(file, (s) => /^(node:)?child_process$/.test(s)).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('touches the filesystem from exactly one module, for exactly one reason', () => {
    // SQLite owns the file. Persistence code that could also read and write it
    // directly would be a second, unaudited way to change a user's history.
    //
    // THE ONE EXCEPTION, and why it is narrow. SQLite creates the database
    // FILE and does not create its DIRECTORY, so `sqlite.ts` makes the folder
    // it is about to open into. Until Step 7 nothing did, `<axonHome>/data/`
    // never existed on a fresh profile, and persistence failed silently on
    // every real launch — the whole of Step 6, unreachable, behind a
    // degradation path designed to be quiet.
    //
    // So the rule is narrowed rather than dropped: one module, and one call.
    const importers = persistenceFiles
      .filter((file) => importsMatching(file, (s) => /^(node:)?fs(\/promises)?$/.test(s)).length > 0)
      .map((file) => file.rel);
    expect(importers).toEqual(['apps/desktop/src/main/persistence/sqlite.ts']);

    // And it may only create a directory. No read, no write, no delete, no
    // rename: none of the operations that could touch a user's history or
    // reach a file the database layer has no business reaching.
    const source = fs.readFileSync(
      persistenceFiles.find((file) => file.rel.endsWith('persistence/sqlite.ts'))!.abs,
      'utf8',
    );
    const calls = source.match(/\bfs\.[A-Za-z]+/g) ?? [];
    expect([...new Set(calls)]).toEqual(['fs.mkdirSync']);
  });

  it('reaches memory through the registry like any other tool', () => {
    const registry = DESKTOP_FILES.find((f) => f.rel === 'apps/desktop/src/main/tools/registry.ts');
    expect(importsMatching(registry!, (s) => /executors\/memory/.test(s)).length).toBe(1);
  });
});

/**
 * The browser subsystem's boundaries.
 *
 * Reaching the web is the largest privilege Axon holds, and the one whose
 * inputs are written by strangers. Each rule here is a way that privilege
 * could leak.
 */
describe('BOUNDARY: the browser subsystem', () => {
  const browserFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/browser/');
  it('exists, so these rules are not vacuous', () => {
    expect(browserFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('is unreachable from the renderer', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/')
      .filter((file) => importsMatching(file, (s) => /(^|\/)main\/browser\//.test(s)).length > 0)
      .map((file) => file.rel);
    expect(offenders, 'The renderer watches a window; it does not drive one').toEqual([]);
  });

  it('is unreachable from the preload bridge', () => {
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/preload/')
      .filter((file) => importsMatching(file, (s) => /(^|\/)main\/browser\//.test(s)).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('is not imported by the brain', () => {
    // The brain proposes navigations. It must not be able to reach the thing
    // that performs them.
    const offenders = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/')
      .filter((file) => importsMatching(file, (s) => /(^|\/)browser\//.test(s)).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('never imports an executor, the registry, or the safety layer', () => {
    const forbidden = (s: string): boolean =>
      isExecutorImport(s) || /(^|\/)tools\/registry(\.js)?$/.test(s) || /(^|\/)safety\//.test(s);
    const offenders = browserFiles
      .filter((file) => importsMatching(file, forbidden).length > 0)
      .map((file) => `${file.rel} -> ${importsMatching(file, forbidden).join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('never imports the model SDK', () => {
    const offenders = browserFiles
      .filter((file) => importsMatching(file, (s) => s.startsWith(VENDOR_SDK)).length > 0)
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('spawns no process and touches no filesystem', () => {
    // A browser that could write files or start programs would turn "read a
    // web page" into "download and run whatever the page says".
    const offenders = browserFiles
      .filter(
        (file) =>
          importsMatching(file, (s) => /^(node:)?child_process$/.test(s) || /^(node:)?fs(\/promises)?$/.test(s))
            .length > 0,
      )
      .map((file) => file.rel);
    expect(offenders, 'Browsing writes no files and starts no programs').toEqual([]);
  });
});

/**
 * The page-script boundary.
 *
 * The single most dangerous thing a browser-controlling agent can do is
 * evaluate code the model wrote. These rules say it cannot.
 */
describe('SECURITY: the model cannot run code in a page', () => {
  const scriptPath = path.resolve(DESKTOP_SRC, 'main/browser/page-script.ts');
  const scriptSource = fs.readFileSync(scriptPath, 'utf8');
  const browserPath = path.resolve(DESKTOP_SRC, 'main/browser/axon-browser.ts');
  const browserCode = fs
    .readFileSync(browserPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const toolCode = fs
    .readFileSync(path.resolve(DESKTOP_SRC, 'main/tools/executors/browser.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('evaluates JavaScript from exactly one module', () => {
    const evaluators = DESKTOP_FILES.filter((file) =>
      /executeJavaScript|insertCSS|\bexecuteJavaScriptInIsolatedWorld\b/.test(
        fs.readFileSync(file.abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      ),
    ).map((file) => file.rel);

    expect(evaluators).toEqual(['apps/desktop/src/main/browser/axon-browser.ts']);
  });

  it('builds every page program from a module constant', () => {
    // Each program is a template literal assigned to a const. If one were
    // built from a variable, the "read this file to see everything that runs"
    // claim would stop being true.
    for (const name of ['OBSERVE', 'CLICK', 'TYPE', 'SCROLL']) {
      expect(scriptSource).toMatch(new RegExp(`export const ${name} = \``));
    }
  });

  it('combines a program with its arguments in exactly one place', () => {
    const builders = scriptSource.match(/export function buildProgram/g) ?? [];
    expect(builders).toHaveLength(1);
    // And that place puts the arguments in argument position, not into code.
    expect(scriptSource).toMatch(/\(function \(ARGS\) \{ return \(\$\{body\}\); \}\)\(\$\{literal\(args\)\}\)/);
  });

  it('passes only the constant programs to the evaluator', () => {
    // Every executeJavaScript call site takes a `buildProgram(...)` result.
    const calls = browserCode.match(/executeJavaScript\(([^,)]*)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/executeJavaScript\(\s*program/);
    }
    expect(browserCode).toMatch(/const program = buildProgram\(body, args\)/);
  });

  it('exposes no tool that accepts a script, a selector or a URL scheme', () => {
    for (const forbidden of ['executeJavaScript', 'eval(', 'new Function', 'querySelector(input', 'selector:']) {
      expect(toolCode).not.toContain(forbidden);
    }
  });

  it('constrains an element reference at the schema', () => {
    // The value that reaches a page program is known to be a short token.
    expect(toolCode).toMatch(/\.regex\(\/\^e\\d\{1,5\}\$\//);
  });
});

/**
 * The voice INPUT path's own boundaries.
 *
 * The microphone introduces three things the rest of Axon does not have: a
 * privileged capability in the renderer, raw audio crossing a process
 * boundary, and a transcript that will be read by a model. Each gets a rule.
 */
describe('BOUNDARY: microphone audio', () => {
  const rendererFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/');
  const mainFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/');

  const readSource = (file: SourceFile): string => fs.readFileSync(file.abs, 'utf8');

  /**
   * Source with comments removed.
   *
   * These files *discuss* recording, cameras and audio buffers at length —
   * explaining what they deliberately do not do is most of what their comments
   * are for. The properties under test are about code, not prose, so the prose
   * is stripped before scanning.
   */
  const readCode = (file: SourceFile): string =>
    readSource(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('has a capture module, so these rules are not vacuous', () => {
    expect(rendererFiles.some((f) => f.rel === 'apps/desktop/src/renderer/audio/microphone.ts')).toBe(true);
  });

  it('is captured in exactly one renderer module', () => {
    // `getUserMedia` is the one privileged call available to the sandboxed
    // page. Confining it to a single file is what makes "audit the microphone"
    // a realistic instruction, and it is why the constraints below can be
    // asserted at all.
    const callers = rendererFiles.filter((file) => /getUserMedia/.test(readCode(file))).map((file) => file.rel);
    expect(callers).toEqual(['apps/desktop/src/renderer/audio/microphone.ts']);
  });

  it('never asks for video', () => {
    // Asserted against the source rather than trusted to the constraint
    // object: `video: true` anywhere in the capture path would request a
    // camera, and the main process's refusal should be the second line of
    // defence, not the first.
    const microphone = rendererFiles.find((f) => f.rel === 'apps/desktop/src/renderer/audio/microphone.ts');
    expect(microphone).toBeDefined();
    const source = readCode(microphone!);
    expect(source).not.toMatch(/video\s*:/);
    expect(source).toMatch(/audio\s*:/);
  });

  it('is never recorded in the renderer', () => {
    // MediaRecorder, a Blob of samples or an object URL would each be a way to
    // accumulate audio in the page — and from there, a way to hand it to
    // something that could persist or exfiltrate it.
    const offenders: string[] = [];
    for (const file of rendererFiles) {
      const source = readCode(file);
      for (const pattern of [/\bMediaRecorder\b/, /createObjectURL/, /\bnew Blob\b/]) {
        if (pattern.test(source)) offenders.push(`${file.rel} -> ${pattern.source}`);
      }
    }
    expect(offenders, 'The renderer streams microphone frames; it never records them').toEqual([]);
  });

  it('reaches the brain only as text', () => {
    // The structural version of "the brain never receives audio": no module
    // under brain/ so much as names a sample buffer, a frame or a microphone.
    const brainFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/');
    const offenders: string[] = [];
    for (const file of brainFiles) {
      const source = readCode(file);
      for (const pattern of [/Int16Array/, /Float32Array/, /getUserMedia/, /MediaStream/, /\bpushFrame\b/]) {
        if (pattern.test(source)) offenders.push(`${file.rel} -> ${pattern.source}`);
      }
    }
    expect(offenders, 'Microphone -> STT -> text -> brain. The brain is not on the audio path').toEqual([]);
  });

  it('is never written to the event stream', () => {
    // Every AxonEvent is validated as a JsonValue and appended to the JSONL
    // log. A typed array cannot be a JsonValue, so this could not happen
    // silently — but the rule is worth stating where someone will read it.
    const eventEmitters = mainFiles.filter((file) => /bus\.emit\(/.test(readCode(file)));
    expect(eventEmitters.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of eventEmitters) {
      const source = readCode(file);
      // An emit whose payload mentions samples or frames.
      const emits = source.match(/bus\.emit\(\{[\s\S]{0,600}?\}\)/g) ?? [];
      for (const emit of emits) {
        if (/Int16Array|samples|frames|audioBytes|\bpcm\b/i.test(emit)) offenders.push(`${file.rel}`);
      }
    }
    expect(offenders, 'Audio never travels on the event stream, in either direction').toEqual([]);
  });

  it('crosses IPC on exactly one channel, which carries nothing else', () => {
    const ipc = fs.readFileSync(path.resolve(CORE_SRC, 'ipc.ts'), 'utf8');
    // One channel constant for audio frames.
    const audioChannels = ipc.match(/^\s*LISTEN_AUDIO:\s*'[^']+',$/gm) ?? [];
    expect(audioChannels).toHaveLength(1);

    // And exactly one bridge member that can carry samples. If a second
    // appears, the "one auditable door for audio" claim stops being true.
    const carriers = (ipc.match(/Int16Array/g) ?? []).length;
    expect(carriers).toBeGreaterThan(0);
    expect(ipc).toMatch(/sendAudioFrame\(captureId: string, samples: Int16Array\): void;/);
  });
});

/**
 * The recognizer must never be handed a program built from anything variable.
 *
 * The mirror of the synthesiser's injection boundary below, and asserted the
 * same way: against the source of the one module that spawns it.
 */
describe('SECURITY: the speech recognizer runs a constant program', () => {
  const sttPath = path.resolve(DESKTOP_SRC, 'main/voice/windows-stt.ts');
  const source = fs.readFileSync(sttPath, 'utf8');
  // Comments stripped: this file explains at length what it does not do, and
  // the properties below are about code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never spawns with a shell', () => {
    expect(code).toMatch(/shell:\s*false/);
    expect(code).not.toMatch(/shell:\s*true/);
    expect(code).not.toMatch(/\bexec\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(/);
  });

  it('passes arguments as an array, never as a command string', () => {
    expect(code).toMatch(/spawn\(\s*[\s\S]{0,80}?,\s*\[/);
  });

  it('builds that array from constants, with nothing interpolated', () => {
    // The argv is overridable so the protocol can be tested against a stand-in
    // child; this asserts the DEFAULT — what the product actually spawns — is
    // string literals and the constant program, and nothing computed.
    const argv = code.slice(code.indexOf('const DEFAULT_ARGS'));
    const declaration = argv.slice(0, argv.indexOf('];') + 2);

    expect(declaration).toMatch(/\[\s*'-NoProfile'/);
    expect(declaration).not.toMatch(/\$\{/);
    expect(declaration).not.toMatch(/\+|process\.|env\./);
  });

  it('builds the child program from a constant, with no interpolation', () => {
    const scriptBlock = code.slice(code.indexOf('const SCRIPT'), code.indexOf('const POWERSHELL'));
    expect(scriptBlock.length).toBeGreaterThan(100);
    // A template placeholder inside the program would mean something was
    // interpolated into code that then runs.
    expect(scriptBlock).not.toMatch(/\$\{/);
  });

  it('reads audio from stdin and never from a file', () => {
    expect(code).toMatch(/OpenStandardInput/);
    // No path, no temporary file, no wave file API anywhere in the recognizer.
    expect(code).not.toMatch(/SetInputToWaveFile/);
    expect(code).not.toMatch(/tmpdir|writeFile|createWriteStream/);
  });
});

/**
 * The synthesiser must never be handed a command built from model output.
 *
 * This is the injection boundary in the voice path, and it is a property of
 * how the child is invoked rather than of how the text is cleaned — so it is
 * asserted against the source of the one module that spawns anything.
 */
describe('SECURITY: model output cannot reach a shell', () => {
  const sapiPath = path.resolve(DESKTOP_SRC, 'main/voice/sapi-tts.ts');
  const source = fs.readFileSync(sapiPath, 'utf8');

  it('never spawns with a shell', () => {
    expect(source).toMatch(/shell:\s*false/);
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/\bexec\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(/);
  });

  it('passes arguments as an array, never as a command string', () => {
    // `spawn(cmd, [args], opts)` — the second argument must be an array
    // literal, which is what makes quoting irrelevant.
    expect(source).toMatch(/spawn\(\s*[\s\S]{0,80}?,\s*\[/);
  });

  it('builds the child program from a constant, with no interpolation', () => {
    const scriptBlock = source.slice(source.indexOf('const SCRIPT'), source.indexOf('const POWERSHELL'));
    expect(scriptBlock.length).toBeGreaterThan(100);
    // A template placeholder inside the program would mean something was
    // interpolated into code that then runs.
    expect(scriptBlock).not.toMatch(/\$\{/);
  });

  it('sends the text on stdin and nowhere else', () => {
    expect(source).toMatch(/child\.stdin\.end\(\s*text/);
    // The text must never be concatenated into the argv array.
    expect(source).not.toMatch(/\[[^\]]*\btext\b[^\]]*\]\s*,\s*$/m);
  });
});

/**
 * The API key must not be reachable from the renderer.
 *
 * Two halves: nothing outside the designated readers may name the environment
 * variable, and the IPC surface must not carry it. The runtime test in
 * `brain-security.test.ts` checks the same property dynamically, by running a
 * turn with a sentinel key and scanning the events.
 */
describe('SECURITY: the API key stays in the main process', () => {
  const KEY_NAME = 'ANTHROPIC_API_KEY';

  const mentions = (file: SourceFile): boolean => fs.readFileSync(file.abs, 'utf8').includes(KEY_NAME);

  it('is named only where it is read or explained', () => {
    // `runtime.ts` reads it; `create-brain.ts` receives it; both name it in
    // prose. `brain-errors.ts` names it in the message shown when auth fails.
    const permitted = new Set([
      'apps/desktop/src/main/runtime.ts',
      'apps/desktop/src/main/brain/create-brain.ts',
      'apps/desktop/src/main/brain/anthropic-client.ts',
      'apps/desktop/src/main/brain/brain-errors.ts',
    ]);

    const offenders = DESKTOP_FILES.filter((file) => mentions(file) && !permitted.has(file.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('is never named in the renderer or the preload bridge', () => {
    const exposed = [
      ...filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/'),
      ...filesUnder(DESKTOP_FILES, 'apps/desktop/src/preload/'),
    ];
    expect(exposed.filter(mentions).map((f) => f.rel)).toEqual([]);
  });

  it('is never named in @axon/core, which crosses to the renderer', () => {
    expect(CORE_FILES.filter(mentions).map((f) => f.rel)).toEqual([]);
  });

  it('has no IPC channel or bridge member that could carry a credential', () => {
    // Comments are stripped first: the file *discusses* credentials at length,
    // and the property under test is about declarations, not prose.
    const ipc = fs
      .readFileSync(path.resolve(CORE_SRC, 'ipc.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // Any interface member or channel constant whose name suggests a secret.
    expect(ipc).not.toMatch(/^\s*(readonly\s+)?\w*(apiKey|api_key|secret|credential|token|password)\w*\s*[?:(]/im);
  });
});

describe('BOUNDARY: the renderer has no Node access', () => {
  const rendererFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/');

  it('has renderer files to check', () => {
    expect(rendererFiles.length).toBeGreaterThan(5);
  });

  it('never imports Electron or a Node builtin', () => {
    const offenders: string[] = [];
    for (const file of rendererFiles) {
      for (const specifier of file.imports) {
        if (specifier === 'electron' || specifier.startsWith('node:')) {
          offenders.push(`${file.rel} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never imports from the main or preload trees', () => {
    const offenders: string[] = [];
    for (const file of rendererFiles) {
      for (const specifier of file.imports) {
        if (/(^|\/)(main|preload)\//.test(specifier)) offenders.push(`${file.rel} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('BOUNDARY: the preload bridge stays minimal', () => {
  const preload = DESKTOP_FILES.find((f) => f.rel === 'apps/desktop/src/preload/index.ts');

  it('exists', () => {
    expect(preload).toBeDefined();
  });

  it('imports only Electron and the core IPC contract', () => {
    // Everything reachable from the sandboxed page passes through this file,
    // so its dependency list is the size of the attack surface.
    const allowed = new Set(['electron', '@axon/core', '@axon/core/ipc']);
    expect(preload!.imports.filter((s) => !allowed.has(s))).toEqual([]);
  });

  it('exposes exactly one object on the window', () => {
    const source = fs.readFileSync(preload!.abs, 'utf8');
    const exposures = source.match(/exposeInMainWorld\s*\(/g) ?? [];
    expect(exposures).toHaveLength(1);
    expect(source).toContain("exposeInMainWorld('axon'");
  });

  it('never hands the raw ipcRenderer to the page', () => {
    const source = fs.readFileSync(preload!.abs, 'utf8');
    expect(source).not.toMatch(/exposeInMainWorld\s*\([^)]*,\s*ipcRenderer\s*\)/);
  });
});

describe('BOUNDARY: @axon/core stays pure', () => {
  it('imports no Node builtin, Electron, or React', () => {
    const offenders: string[] = [];
    for (const file of CORE_FILES) {
      for (const specifier of file.imports) {
        if (specifier.startsWith('node:') || ['electron', 'react', 'react-dom'].includes(specifier)) {
          offenders.push(`${file.rel} -> ${specifier}`);
        }
      }
    }
    expect(offenders, '@axon/core is imported by the sandboxed renderer and must stay pure').toEqual([]);
  });

  it('depends on nothing but Zod', () => {
    const external = new Set<string>();
    for (const file of CORE_FILES) {
      for (const specifier of file.imports) {
        if (!specifier.startsWith('.')) external.add(specifier);
      }
    }
    expect([...external]).toEqual(['zod']);
  });
});

describe('the window security posture is not silently weakened', () => {
  const windowSource = fs.readFileSync(path.join(DESKTOP_SRC, 'main/window.ts'), 'utf8');

  it.each([
    ['sandbox', /sandbox:\s*true/],
    ['contextIsolation', /contextIsolation:\s*true/],
    ['nodeIntegration', /nodeIntegration:\s*false/],
    ['nodeIntegrationInWorker', /nodeIntegrationInWorker:\s*false/],
    ['webSecurity', /webSecurity:\s*true/],
    ['webviewTag', /webviewTag:\s*false/],
  ])('keeps %s at its safe value', (_label, pattern) => {
    expect(windowSource).toMatch(pattern);
  });
});

// ---------------------------------------------------------------------------
// Step 7: the trusted agent loop.
// ---------------------------------------------------------------------------

/**
 * The safety layer's Step 7 additions.
 *
 * The agent loop's guarantees rest on there being exactly one place each of
 * these decisions is made. A second budget, a second fingerprint function or a
 * second duplicate check would not be untidy — it would be a second answer to
 * a question that must have one answer.
 */
describe('BOUNDARY: the turn budget is enforced where effects happen', () => {
  const dispatcher = DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/safety/dispatcher.ts'));
  const budget = DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/safety/turn-budget.ts'));

  it('exists, so these rules are not vacuous', () => {
    expect(dispatcher).toBeTruthy();
    expect(budget).toBeTruthy();
  });

  it('is spent by the dispatcher and by nothing else', () => {
    // If the brain spent its own budget, a brain that ignored it would be
    // unbounded — which is the arrangement Step 7 exists to invert.
    const spenders = DESKTOP_FILES.filter((file) => /\.spend\s*\(/.test(fs.readFileSync(file.abs, 'utf8')))
      .map((file) => file.rel)
      .filter((rel) => !rel.endsWith('src/main/safety/turn-budget.ts'));

    expect(spenders).toEqual(['apps/desktop/src/main/safety/dispatcher.ts']);
  });

  it('is never imported by the brain', () => {
    for (const file of filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/brain/')) {
      expect(
        importsMatching(file, (specifier) => specifier.includes('turn-budget') || specifier.includes('/safety/')),
        `${file.rel} must not reach the safety layer`,
      ).toEqual([]);
    }
  });

  it('takes its numbers from the shared contract, not from a local literal', () => {
    // The loop's polite stop and the dispatcher's hard stop must be the same
    // numbers, or a brain would be cut off before or after the wall.
    const source = fs.readFileSync(budget!.abs, 'utf8');
    expect(source).toMatch(/AGENT_LOOP_LIMITS/);

    const brain = DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/brain/claude-brain.ts'));
    expect(fs.readFileSync(brain!.abs, 'utf8')).toMatch(/AGENT_LOOP_LIMITS/);
  });
});

describe('BOUNDARY: an approval is bound in exactly one place', () => {
  it('computes a fingerprint from one function', () => {
    const definers = DESKTOP_FILES.filter((file) =>
      /function fingerprintCall|createHash\(/.test(fs.readFileSync(file.abs, 'utf8')),
    ).map((file) => file.rel);

    expect(definers).toEqual(['apps/desktop/src/main/safety/approval-binding.ts']);
  });

  it('normalizes arguments the same way everywhere', () => {
    // The repeat bound, the duplicate guard and the binding must agree about
    // when two calls are the same call. One implementation, in core.
    const definers = [...DESKTOP_FILES, ...CORE_FILES]
      .filter((file) => /function stableStringify/.test(fs.readFileSync(file.abs, 'utf8')))
      .map((file) => file.rel);

    expect(definers).toEqual(['packages/core/src/agent.ts']);
  });

  it('is re-checked by the dispatcher before execution', () => {
    const source = fs.readFileSync(
      DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/safety/dispatcher.ts'))!.abs,
      'utf8',
    );
    expect(source).toMatch(/APPROVAL_MISMATCH/);
    // The comparison happens after the await on the human, not before it.
    const approvalIndex = source.indexOf('const gate = await this.requestApproval');
    const checkIndex = source.indexOf('executingFingerprint');
    expect(approvalIndex).toBeGreaterThan(0);
    expect(checkIndex).toBeGreaterThan(approvalIndex);
  });

  it('grants nothing standing: there is no scope, site or blanket allowance', () => {
    // Step 7 deliberately ships per-action approval only. A standing
    // permission is a real feature with a real revocation problem, and adding
    // one as a side effect of a demo is how approval becomes theatre.
    for (const file of filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/safety/')) {
      const source = fs.readFileSync(file.abs, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, `${file.rel} must not grant a standing approval`).not.toMatch(
        /alwaysAllow|allowList|rememberApproval|trustedSites/i,
      );
    }
  });
});

describe('BOUNDARY: verification reads the page rather than the model', () => {
  const verification = DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/browser/verification.ts'));

  it('exists, so these rules are not vacuous', () => {
    expect(verification).toBeTruthy();
  });

  it('is pure: no Electron, no filesystem, no process, no SDK', () => {
    for (const specifier of verification!.imports) {
      expect(specifier === '@axon/core', `verification imported ${specifier}`).toBe(true);
    }
  });

  it('is the only place a change verdict is produced', () => {
    const definers = DESKTOP_FILES.filter((file) => /function verifyChange/.test(fs.readFileSync(file.abs, 'utf8'))).map(
      (file) => file.rel,
    );
    expect(definers).toEqual(['apps/desktop/src/main/browser/verification.ts']);
  });
});

describe('BOUNDARY: a precheck can only ever refuse', () => {
  const dispatcherSource = (): string =>
    fs.readFileSync(DESKTOP_FILES.find((file) => file.rel.endsWith('src/main/safety/dispatcher.ts'))!.abs, 'utf8');

  it('has no branch that grants, skips or downgrades anything', () => {
    // The hook runs before risk resolution, so a `precheck` that could ALLOW
    // would be a way past the policy. Its return type has no such member;
    // this asserts the dispatcher does not invent one.
    const code = dispatcherSource().replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    // A passing precheck falls through to the existing pipeline. It never
    // returns a success and never short-circuits to execution.
    expect(code).toMatch(/const precheck = this\.precheck\(tool, input\);/);
    expect(code).toMatch(/if \(!precheck\.ok\)/);
    expect(code).not.toMatch(/precheck\.ok\s*\)\s*\{?\s*(return \{ *ok: true|await tool\.execute)/);
  });

  it('runs before the human is asked', () => {
    const source = dispatcherSource();
    expect(source.indexOf('this.precheck(tool, input)')).toBeLessThan(source.indexOf('await this.requestApproval'));
  });

  it('runs before the risk policy, so a stale reference is not an approval', () => {
    const source = dispatcherSource();
    expect(source.indexOf('this.precheck(tool, input)')).toBeLessThan(source.indexOf('this.assessRisk(tool, input)'));
  });
});

describe('BOUNDARY: the deterministic test brain stays in the tests', () => {
  it('is not reachable from the shipping application', () => {
    // A scripted brain wired into the product would be a demo mode with a
    // security boundary attached to it, which Step 7 forbids outright.
    for (const file of DESKTOP_FILES) {
      expect(
        importsMatching(file, (specifier) => /scripted-brain|fake-site|agent-harness/.test(specifier)),
        `${file.rel} must not import a test double`,
      ).toEqual([]);
    }
  });

  it('does not exist in the source tree at all', () => {
    const strays = DESKTOP_FILES.filter((file) => /scripted-brain|fake-site|agent-harness|demo-mode/.test(file.rel));
    expect(strays.map((file) => file.rel)).toEqual([]);
  });
});

/**
 * The voice-agent subsystem's boundaries.
 *
 * It is the only part of Axon that holds a network socket and a credential at
 * the same time, which makes it the highest-value target in the tree. Each
 * rule here is a way that value could leak.
 */
describe('BOUNDARY: the voice-agent subsystem', () => {
  const agentFiles = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/agent/');

  it('exists, so these rules are not vacuous', () => {
    expect(agentFiles.length).toBeGreaterThan(3);
  });

  it('is unreachable from the renderer', () => {
    for (const file of filesUnder(DESKTOP_FILES, 'apps/desktop/src/renderer/')) {
      expect(
        importsMatching(file, (specifier) => /(^|\/)agent\//.test(specifier)),
        `${file.rel} must not reach the voice agent`,
      ).toEqual([]);
    }
  });

  it('is unreachable from the preload bridge', () => {
    const preload = DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/preload/index.ts');
    expect(importsMatching(preload!, (specifier) => /(^|\/)agent\//.test(specifier))).toEqual([]);
  });

  it('never imports an executor, the registry, or the safety layer', () => {
    // It proposes. The dispatcher decides. A voice agent that could reach an
    // executor would be a second path to an effect, and there is exactly one.
    for (const file of agentFiles) {
      expect(
        importsMatching(
          file,
          (specifier) => isExecutorImport(specifier) || /tools\/registry|(^|\/)safety\//.test(specifier),
        ),
        `${file.rel} must not reach the tool layer`,
      ).toEqual([]);
    }
  });

  it('never imports the model SDK', () => {
    // The whole point of this milestone is that Axon reasons through the voice
    // provider's managed model. An Anthropic import here would be a second
    // brain, and a runtime dependency the product does not have.
    for (const file of agentFiles) {
      expect(importsMatching(file, (specifier) => specifier.startsWith(VENDOR_SDK))).toEqual([]);
    }
  });

  it('never imports Electron, spawns a process, or touches the filesystem', () => {
    for (const file of agentFiles) {
      expect(
        importsMatching(file, (specifier) =>
          /^electron$|^(node:)?child_process$|^(node:)?fs(\/promises)?$/.test(specifier),
        ),
        `${file.rel} must hold no OS privilege`,
      ).toEqual([]);
    }
  });

  it('reaches the browser and persistence layers not at all', () => {
    // It gets tool SCHEMAS and a dispatch callback. Everything it can affect,
    // it affects through those two arguments.
    for (const file of agentFiles) {
      expect(
        importsMatching(file, (specifier) => /(^|\/)(browser|persistence|voice)\//.test(specifier)),
        `${file.rel} must not reach another subsystem directly`,
      ).toEqual([]);
    }
  });

  it('holds the socket in exactly one module', () => {
    const holders = agentFiles
      .filter((file) => importsMatching(file, (specifier) => specifier === 'ws').length > 0)
      .map((file) => file.rel);

    expect(holders).toEqual(['apps/desktop/src/main/agent/assemblyai-client.ts']);
  });
});

describe('BOUNDARY: the wake word runs before anything can send audio', () => {
  const wake = DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/main/wake/wake-word.ts');

  it('exists, so these rules are not vacuous', () => {
    expect(wake).toBeDefined();
  });

  it('imports nothing that could send audio anywhere', () => {
    // The mechanism behind "before activation, audio stays local": while the
    // wake word is the reason the microphone is open, there is no code path
    // from it to a socket.
    for (const specifier of wake!.imports) {
      expect(specifier === '@axon/core', `the wake word imported ${specifier}`).toBe(true);
    }
  });

  it('is not imported by the agent subsystem, and does not import it', () => {
    // The two must stay separable: one is the local half of the guarantee and
    // one is the remote half, and a dependency either way would make "which
    // one is running?" harder to answer than it needs to be.
    expect(importsMatching(wake!, (specifier) => /(^|\/)agent\//.test(specifier))).toEqual([]);
    for (const file of filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/agent/')) {
      expect(importsMatching(file, (specifier) => /wake/.test(specifier))).toEqual([]);
    }
  });
});

/**
 * The desktop-control boundary.
 *
 * These tools reach outside Axon's own windows, which makes them the widest
 * privilege in the product. Each rule below is a way that privilege could
 * become something other than "look at the desktop and move a window".
 */
describe('BOUNDARY: desktop control', () => {
  const desktopPort = DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/main/platform/windows-desktop.ts');
  const registryFile = DESKTOP_FILES.find(
    (file) => file.rel === 'apps/desktop/src/main/tools/executors/app-registry.ts',
  );

  it('exists, so these rules are not vacuous', () => {
    expect(desktopPort).toBeDefined();
    expect(registryFile).toBeDefined();
  });

  it('spawns a process from exactly two platform modules, both of them providers', () => {
    // `electron-platform.ts` launches an allowlisted application; this one
    // queries and moves windows. Two, both named, and no third.
    const spawners = filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/platform/')
      .filter((file) => importsMatching(file, (specifier) => /^(node:)?child_process$/.test(specifier)).length > 0)
      .map((file) => file.rel)
      .sort();

    expect(spawners).toEqual([
      'apps/desktop/src/main/platform/electron-platform.ts',
      'apps/desktop/src/main/platform/windows-desktop.ts',
    ]);
  });

  it('never spawns with a shell', () => {
    // Comments stripped first. The module's own header explains why there is
    // no `Invoke-Expression` in it, and a rule that matched its own
    // explanation would fail for the best possible reason and still be
    // useless.
    const source = fs
      .readFileSync(desktopPort!.abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(source).not.toMatch(/shell\s*:\s*true/);
    expect(source).not.toMatch(/\bexec\s*\(|execSync|Invoke-Expression|\biex\b/);
  });

  it('builds the desktop program from a constant, with nothing interpolated', () => {
    // A window title is attacker-controlled — any application can name its
    // window anything. If titles were interpolated into a script, a hostile
    // title would be code execution.
    const source = fs.readFileSync(desktopPort!.abs, 'utf8');
    const script = /const SCRIPT = String\.raw`([\s\S]*?)`;/.exec(source);
    expect(script, 'the program must be a module constant').toBeTruthy();
    expect(script?.[1] ?? '').not.toMatch(/\$\{/);
  });

  it('passes every variable out of band, never into the program text', () => {
    const source = fs.readFileSync(desktopPort!.abs, 'utf8');
    // An array argv, never a command line we assembled.
    expect(source).toMatch(/spawn\(\s*'powershell\.exe',\s*\[/);
    // The two values the program reads arrive in the child's environment,
    // which keeps them off the command line entirely — invisible to other
    // processes listing this one, and with no quoting to participate in.
    expect(source).toMatch(/AXON_WINDOW_MODE/);
    expect(source).toMatch(/AXON_WINDOW_HANDLE/);
    expect(source).toMatch(/\$env:AXON_WINDOW_MODE/);
  });

  it('validates a window handle before it can become an argument', () => {
    const source = fs.readFileSync(desktopPort!.abs, 'utf8');
    expect(source).toMatch(/HANDLE_PATTERN\s*=\s*\/\^/);
    expect(source).toMatch(/if \(!HANDLE_PATTERN\.test\(handle\)\) return false;/);
  });

  it('never reads or writes a file, and never reaches the network', () => {
    for (const file of [desktopPort!, registryFile!]) {
      expect(
        importsMatching(file, (specifier) => /^(node:)?fs(\/promises)?$/.test(specifier)),
        `${file.rel} must not touch the filesystem`,
      ).toEqual([]);
      const source = fs.readFileSync(file.abs, 'utf8');
      expect(source, `${file.rel} must not reach the network`).not.toMatch(/fetch\(|WebSocket|node:https?/);
    }
  });

  it('exposes no process control anywhere in the desktop path', () => {
    // Enumerate and move a window. Not start, stop, inspect or read one.
    const source = fs.readFileSync(desktopPort!.abs, 'utf8');
    for (const forbidden of ['TerminateProcess', 'Stop-Process', 'OpenProcess', 'ReadProcessMemory', 'DestroyWindow', 'CloseWindow']) {
      expect(source, `the desktop port must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never lets a raw window handle reach the model', () => {
    // The model gets `w1` and a title. A handle it never receives is a handle
    // it cannot invent a resolving value for.
    const tools = fs.readFileSync(
      DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/main/tools/executors/windows.ts')!.abs,
      'utf8',
    );
    const output = tools.slice(tools.indexOf('function toWindowOutput'), tools.indexOf('// window.list'));
    expect(output).not.toMatch(/handle/);
  });

  it('resolves an application through the registry and nowhere else', () => {
    const openTool = fs.readFileSync(
      DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/main/tools/executors/app-open.ts')!.abs,
      'utf8',
    );
    // No table of its own, and no path or command anywhere in the tool.
    expect(openTool).toMatch(/resolveApp\(/);
    expect(openTool).not.toMatch(/\.exe'|C:\\|powershell|cmd\b/i);
  });

  it('is registered like every other tool, through the one registry', () => {
    const registry = DESKTOP_FILES.find((file) => file.rel === 'apps/desktop/src/main/tools/registry.ts');
    expect(importsMatching(registry!, (specifier) => /executors\/windows/.test(specifier)).length).toBe(1);

    // And nothing else imports the window executors directly.
    for (const file of DESKTOP_FILES) {
      if (file.rel === 'apps/desktop/src/main/tools/registry.ts') continue;
      expect(
        importsMatching(file, (specifier) => /executors\/windows/.test(specifier)),
        `${file.rel} must not import a window executor`,
      ).toEqual([]);
    }
  });

  it('is unreachable from the renderer and the preload bridge', () => {
    for (const surface of ['apps/desktop/src/renderer/', 'apps/desktop/src/preload/']) {
      for (const file of filesUnder(DESKTOP_FILES, surface)) {
        expect(
          importsMatching(file, (specifier) => /windows-desktop|executors\/windows|app-registry/.test(specifier)),
          `${file.rel} must not reach desktop control`,
        ).toEqual([]);
      }
    }
  });

  it('is not reachable from the voice agent, which only proposes', () => {
    for (const file of filesUnder(DESKTOP_FILES, 'apps/desktop/src/main/agent/')) {
      expect(
        importsMatching(file, (specifier) => /windows-desktop|executors\//.test(specifier)),
        `${file.rel} must not reach an executor`,
      ).toEqual([]);
    }
  });

  it('adds no keyboard or mouse injection, which this phase did not build', () => {
    // Recorded as an assertion rather than a note, so the day somebody adds
    // synthetic input it is a deliberate edit to this rule and not a quiet
    // one. Sending keystrokes to whatever window happens to be focused is a
    // materially larger privilege than moving a window, and it needs its own
    // design rather than arriving as a fifth window tool.
    for (const file of DESKTOP_FILES) {
      const source = fs.readFileSync(file.abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of ['SendKeys', 'keybd_event', 'SetCursorPos', 'mouse_event', 'SendInput']) {
        expect(source, `${file.rel} must not inject input`).not.toContain(forbidden);
      }
    }
  });
});
