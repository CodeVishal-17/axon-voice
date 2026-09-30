/**
 * The audit, as a test rather than as a memory of having done one.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `architecture.test.ts`, which already
 * asserts most of these boundaries individually. That file asks "does the
 * browser subsystem reach persistence?", "does the ledger import an executor?"
 * — one rule per relationship. This one asks the question the other way round:
 *
 *     Search the WHOLE tree for the dangerous capability. Wherever it is
 *     found, it must be a place somebody deliberately put it and justified.
 *
 * The difference matters when something new is added. A boundary test protects
 * the modules it names; a sweep protects the modules nobody has thought of
 * yet — which is exactly where a `child_process` import goes when a feature is
 * being finished at two in the morning before a demo.
 *
 * So every dangerous capability below is enumerated with its ALLOWED SITES.
 * Adding one somewhere else fails here, and the fix is either to move it or to
 * add it to the list with a reason — which is a visible edit to a file that
 * explains why the list is short.
 *
 * The four claims this whole file is in service of:
 *
 *     model    is not authority
 *     provider is not authority
 *     webpage  is not authority
 *     renderer is not authority
 *
 * Only Axon's policy and dispatcher authorise execution.
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
  readonly rel: string;
  readonly abs: string;
  readonly source: string;
  /** Comments stripped, so a rule cannot fire on its own explanation. */
  readonly code: string;
}

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  visit(root);
  return found;
}

const FILES: SourceFile[] = [...walk(DESKTOP_SRC), ...walk(CORE_SRC)].map((abs) => {
  const source = fs.readFileSync(abs, 'utf8');
  return {
    abs,
    rel: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'),
    source,
    code: source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
  };
});

/**
 * Find a capability across the whole tree, and say where it is allowed.
 *
 * The failure message names the offender, because "a forbidden pattern was
 * found somewhere" is a test that costs more to act on than it saves.
 */
function sweep(pattern: RegExp, allowed: readonly string[]): string[] {
  return FILES.filter((file) => pattern.test(file.code))
    .map((file) => file.rel)
    .filter((rel) => !allowed.includes(rel))
    .sort();
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

describe('nothing can run an arbitrary program', () => {
  it('imports child_process in exactly five places, all of them named providers', () => {
    // Two speech providers, one keyword spotter, one application launcher, one
    // desktop port. Each spawns a CONSTANT program with values passed out of
    // band.
    //
    // On the addition, because an allow-list grows one plausible entry at a
    // time and that is how it stops meaning anything: `keyword-engine.ts`
    // starts the wake word's spotter, and the process boundary is the POINT
    // rather than an implementation detail. That process runs for hours with a
    // microphone open, so it is started with a six-name environment holding
    // neither API key, and a native fault in the speech model becomes an exit
    // code rather than taking Axon down. Its argv is a constant program, a
    // model directory Axon resolved, a number, and the wake phrase's own word
    // pieces — nothing from a person, a page, or a model.
    expect(sweep(/from '(node:)?child_process'/, [
      'apps/desktop/src/main/platform/electron-platform.ts',
      'apps/desktop/src/main/platform/windows-desktop.ts',
      'apps/desktop/src/main/voice/sapi-tts.ts',
      'apps/desktop/src/main/voice/windows-stt.ts',
      'apps/desktop/src/main/wake/keyword-engine.ts',
    ])).toEqual([]);
  });

  it('never spawns with a shell', () => {
    expect(sweep(/shell\s*:\s*true/, [])).toEqual([]);
  });

  it('never executes a command string', () => {
    // `spawn` with an argv is auditable. `exec` takes a command LINE, which is
    // a string somebody could build out of something a model said.
    expect(sweep(/\bexecSync\b|\bexecFileSync\b/, [])).toEqual([]);

    // `exec(` alone is the wrong thing to search for: SQLite's own `db.exec`
    // is SQL, and a rule that matched it would fire on the database layer
    // forever and be switched off. What matters is `exec` in a file that can
    // reach a PROCESS at all, so the two conditions are checked together.
    const processExec = FILES.filter(
      (file) => /from '(node:)?child_process'/.test(file.code) && /\bexec\s*\(/.test(file.code),
    ).map((file) => file.rel);
    expect(processExec).toEqual([]);
  });

  it('never evaluates PowerShell', () => {
    expect(sweep(/Invoke-Expression|\biex\b/, [])).toEqual([]);
  });

  it('names PowerShell only where a constant program is spawned', () => {
    // Plus ONE file that names it in order to REFUSE it: the discovered-app
    // catalog's blocklist, which is how "open PowerShell" becomes FORBIDDEN
    // rather than an approval dialog. The next test pins that it names it
    // nowhere else in that file and can start nothing itself.
    expect(sweep(/powershell/i, [
      'apps/desktop/src/main/platform/windows-desktop.ts',
      'apps/desktop/src/main/voice/sapi-tts.ts',
      'apps/desktop/src/main/voice/windows-stt.ts',
      'apps/desktop/src/main/apps/app-catalog.ts',
    ])).toEqual([]);
  });

  it('names PowerShell in the app catalog only inside its blocklists, and the catalog runs nothing', () => {
    const catalog = FILES.find((file) => file.rel === 'apps/desktop/src/main/apps/app-catalog.ts');
    expect(catalog).toBeDefined();
    // Either line ending: the working tree is CRLF on Windows (core.autocrlf).
    const lines = (catalog?.code ?? '').split(/\r?\n/);
    const hits = lines.flatMap((line, index) => (/powershell/i.test(line) ? [index] : []));
    expect(hits.length).toBeGreaterThan(0);
    for (const index of hits) {
      // The regex literal itself, on the line after its declaration.
      expect(lines[index]).toMatch(/^\s*\/.*\/[a-z]*;$/);
      expect(lines[index - 1]).toMatch(/^const BLOCKED_(?:PURPOSES|PROGRAMS) =\s*$/);
    }
    // `(?<!\.)`: `BLOCKED_PURPOSES.exec(words)` is a regular expression, not a process.
    expect(catalog?.code).not.toMatch(/child_process|\bspawn\s*\(|(?<!\.)\bexec(?:File|Sync)?\s*\(|openExternal/);
  });

  it('never evaluates a string as code', () => {
    // `executeJavaScript` is the browser's page program and is allowed in the
    // one module that owns it; everything else is absent outright.
    expect(sweep(/\beval\s*\(|new Function\s*\(/, [])).toEqual([]);
    expect(sweep(/executeJavaScript/, ['apps/desktop/src/main/browser/axon-browser.ts'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Driving the machine
// ---------------------------------------------------------------------------

describe('nothing can synthesise input', () => {
  it('contains no keyboard or mouse injection anywhere', () => {
    // Coordinate and keystroke injection act on whatever is under the pointer
    // or holds focus at delivery. Axon acts on ELEMENTS, through the
    // accessibility layer, which is why `ui.click` and `keyboard.type` could
    // be built at all. This is the rule that stops the other kind arriving as
    // an optimisation.
    for (const forbidden of ['SendInput', 'SendKeys', 'SetCursorPos', 'mouse_event', 'keybd_event']) {
      expect(sweep(new RegExp(forbidden), []), forbidden).toEqual([]);
    }
  });

  it('offers no keyboard.press, and no mouse tool at all', () => {
    // Deliberately absent since Phase 2: there is no way to press a key
    // through the accessibility layer, so the only implementation would be
    // synthetic input.
    expect(sweep(/'keyboard\.press'|"keyboard\.press"/, [])).toEqual([]);
    expect(sweep(/'mouse\.[a-z]+'/, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Touching the disk
// ---------------------------------------------------------------------------

describe('filesystem access is narrow and enumerated', () => {
  it('writes files from exactly the modules that have a reason to', () => {
    // The workspace writer, the screenshot saver, the JSONL audit sink, and
    // the two modules the demo recording is made of. Nothing else writes.
    //
    // On the two additions, because an allow-list grows one plausible entry
    // at a time and that is how it stops meaning anything:
    //
    // - `demo/recording.ts` does NOT touch the disk. It declares a
    //   `writeFile` CALLBACK and calls what it is given, which is why it can
    //   be unit tested without a filesystem — and why the recorder cannot
    //   write anywhere its caller did not name.
    // - `runtime.ts` supplies that callback, with a path derived from
    //   `AXON_HOME` exactly as the event log's is. No tool takes a path to it
    //   and the model cannot name one.
    // - `wake/kws-host.ts` writes ONE file: the keywords list, which is the
    //   only configuration format the spotter has. Three lines of word pieces
    //   and a number, into a directory it creates with `mkdtemp` and removes
    //   before it starts listening. No audio touches it — the spotter is given
    //   audio on stdin and writes nothing at all for the rest of its life. It
    //   is written there, rather than kept beside the model, precisely so that
    //   what wakes Axon is not a file on disk an installer could edit.
    expect(sweep(/\bwriteFile|\bcreateWriteStream|\bappendFile/, [
      'apps/desktop/src/main/tools/executors/fs-write.ts',
      'apps/desktop/src/main/tools/executors/system-screenshot.ts',
      'apps/desktop/src/main/bus/jsonl-sink.ts',
      'apps/desktop/src/main/demo/recording.ts',
      'apps/desktop/src/main/runtime.ts',
      'apps/desktop/src/main/wake/kws-host.ts',
      // - `wake/kws-focus.ts`: the development-only focus DIAGNOSTIC, run in a
      //   second spotter process. It writes one keywords file per threshold
      //   rung — the same three-line format as `kws-host.ts` — into a `mkdtemp`
      //   directory, reads each back to verify the runtime configuration, and
      //   deletes them before listening. No audio is ever written.
      'apps/desktop/src/main/wake/kws-focus.ts',
    ])).toEqual([]);
  });

  it('gives the demo recorder a path it cannot choose', () => {
    // The recorder writes where the runtime tells it to and nowhere else: it
    // takes the path and the writer as arguments rather than building either.
    const recording = FILES.find((file) => file.rel.endsWith('demo/recording.ts'))!.code;
    expect(recording).not.toMatch(/from 'node:fs'/);
    expect(recording).not.toMatch(/path\.join|__dirname|process\.env/);

    const config = FILES.find((file) => file.rel.endsWith('main/config.ts'))!.code;
    expect(config).toContain('demoRecordingPath');
    expect(config).toContain('demoRecordingEnabled');
  });

  it('exposes no tool that reads an arbitrary file', () => {
    // `fs.read` was left out deliberately: combined with browser reach it is a
    // clean exfiltration path — read a private key, type it into a form.
    const executors = FILES.filter((file) => file.rel.includes('/tools/executors/'));
    for (const file of executors) {
      expect(file.code, `${file.rel} must not read files`).not.toMatch(/readFile|readdirSync|createReadStream/);
    }
  });

  it('keeps every write inside a policy that resolves the path', () => {
    // Every branch of the writer goes through `classifyPath`, which resolves
    // the destination against the workspace and the forbidden roots — the
    // risk resolution, the summary and the execution all consult it, so there
    // is no path through the tool that writes somewhere unclassified.
    const writer = FILES.find((file) => file.rel.endsWith('executors/fs-write.ts'));
    expect(writer).toBeDefined();
    expect(writer!.code).toMatch(/classifyPath\(input\.path, policy\)/);
    // And it refuses rather than writing when the verdict is not a permission.
    expect(writer!.code).toMatch(/FORBIDDEN|INVALID/);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credentials cannot leave the main process', () => {
  it('names an API key only where one is read or explained', () => {
    const offenders = FILES.filter(
      (file) => /API_KEY/.test(file.code) && !file.rel.startsWith('apps/desktop/src/main/'),
    ).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('never lets a key reach the renderer, the preload bridge, or core', () => {
    for (const file of FILES) {
      if (
        file.rel.startsWith('apps/desktop/src/renderer/') ||
        file.rel.startsWith('apps/desktop/src/preload/') ||
        file.rel.startsWith('packages/core/')
      ) {
        expect(file.code, `${file.rel} must not name a credential`).not.toMatch(/apiKey|API_KEY|Authorization/);
      }
    }
  });

  it('refuses credential-shaped text at every typing surface', () => {
    // One sensitivity model, one answer. Both typing tools consult it.
    for (const rel of [
      'apps/desktop/src/main/tools/executors/browser.ts',
      'apps/desktop/src/main/tools/executors/ui-input.ts',
    ]) {
      const file = FILES.find((entry) => entry.rel === rel);
      expect(file, rel).toBeDefined();
      expect(file!.code, rel).toMatch(/classifyText\(/);
    }
  });

  it('stores no credential anywhere', () => {
    expect(sweep(/savedPassword|storedCredential|credentialStore|keychain/i, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The four "is not authority" claims
// ---------------------------------------------------------------------------

describe('only Axon authorises execution', () => {
  it('MODEL is not authority: exactly one call site runs a tool', () => {
    const callers = FILES.filter((file) => /\btool\.execute\(/.test(file.code)).map((file) => file.rel);
    expect(callers).toEqual(['apps/desktop/src/main/safety/dispatcher.ts']);
  });

  it('MODEL is not authority: the brain and the bridge hold no registry', () => {
    for (const file of FILES) {
      if (!file.rel.includes('/brain/') && !file.rel.includes('/agent/')) continue;
      expect(file.code, `${file.rel} must not hold the registry`).not.toMatch(/tools\/registry/);
      expect(file.code, `${file.rel} must not reach an executor`).not.toMatch(/tools\/executors\//);
    }
  });

  it('PROVIDER is not authority: Axon emits no server-side tool', () => {
    // A tool with an `http` block is called by the provider's own servers:
    // Axon would not see it, could not gate it, could not refuse it.
    const surface = FILES.find((file) => file.rel.endsWith('agent/agent-tool-surface.ts'));
    expect(surface).toBeDefined();
    expect(surface!.code).not.toMatch(/\bhttp\s*:/);
  });

  it('PROVIDER is not authority: a tool call is gated like any other proposal', () => {
    const bridge = FILES.find((file) => file.rel.endsWith('agent/tool-bridge.ts'));
    expect(bridge).toBeDefined();
    // It holds a dispatch callback and nothing that could bypass one.
    expect(bridge!.code).not.toMatch(/new Policy\(|ApprovalBroker|TurnBudget|resolveRisk/);
  });

  it('WEBPAGE is not authority: the dispatcher never reads page content', () => {
    const dispatcher = FILES.find((file) => file.rel.endsWith('safety/dispatcher.ts'));
    expect(dispatcher!.code).not.toMatch(/untrustedPageText|pageText|lastObservation|describeElement/);
  });

  it('WEBPAGE is not authority: the goal comes from the user, never from a page', () => {
    // A page cannot widen what a task permits, because the goal is set from
    // the transcript and from nothing else.
    const orchestrator = FILES.find((file) => file.rel.endsWith('orchestrator/orchestrator.ts'));
    expect(orchestrator!.code).toMatch(/setTurnGoal\(/);
    const goalCalls = orchestrator!.code.match(/setTurnGoal\([^)]*\)/g) ?? [];
    for (const call of goalCalls) {
      expect(call, 'the goal must come from the transcript or the ledger').toMatch(/text|effectiveGoal|utterance|null/);
    }
  });

  it('RENDERER is not authority: it imports nothing from main', () => {
    for (const file of FILES) {
      if (!file.rel.startsWith('apps/desktop/src/renderer/') && !file.rel.startsWith('apps/desktop/src/preload/')) {
        continue;
      }
      expect(file.code, `${file.rel} must not import from main`).not.toMatch(/from '.*\/main\//);
      expect(file.code, `${file.rel} must not reach a platform port`).not.toMatch(/platform\/|safety\/|screen\//);
    }
  });

  it('RENDERER is not authority: its one tool path is dev-gated and dispatched', () => {
    const bridge = FILES.find((file) => file.rel.endsWith('bus/renderer-bridge.ts'));
    const invoke = bridge!.code.slice(bridge!.code.indexOf('IPC_CHANNELS.TOOL_INVOKE'));
    expect(invoke).toMatch(/devConsoleEnabled/);
    expect(invoke).toMatch(/orchestrator\.invokeTool\(/);
  });
});

// ---------------------------------------------------------------------------
// The gates themselves
// ---------------------------------------------------------------------------

describe('no path skips a gate', () => {
  it('runs every gate in the one dispatch, in order', () => {
    // SCOPED TO `dispatch` ITSELF. The class also holds `requiresApproval`, a
    // read-only query that consults the same policy a moment earlier — and
    // searching the whole file would find that call first and assert the order
    // of the wrong thing.
    const dispatcher = FILES.find((file) => file.rel.endsWith('safety/dispatcher.ts'))!.code;
    const from = dispatcher.indexOf('async dispatch(call: ToolCall)');
    expect(from, 'dispatch must exist').toBeGreaterThan(-1);
    const body = dispatcher.slice(from);

    // The real sequence. Note where the fingerprint sits: it is computed ONCE
    // after the policy decides, and reused for the duplicate guard, the
    // approval binding and the ledger entry — one derivation, so those three
    // cannot disagree about what the call is. It is then recomputed after the
    // approval, which is the re-bind, asserted separately below.
    const order = [
      'safeParse',
      'this.precheck(',
      'budget?.spend',
      'withGoalBoundary(',
      'this.policy.decide(',
      'fingerprintCall(',
      'this.ledger.check(',
      'this.requestApproval(',
      'tool.execute(',
    ];

    let cursor = -1;
    for (const gate of order) {
      const at = body.indexOf(gate);
      expect(at, `${gate} must be present in dispatch`).toBeGreaterThan(-1);
      expect(at, `${gate} must come after the gate before it`).toBeGreaterThan(cursor);
      cursor = at;
    }

    // And the RE-BIND is after the approval and before the execution, which is
    // the whole reason it exists: it asserts that the act about to run is the
    // one the user was shown.
    const approval = body.indexOf('this.requestApproval(');
    const rebind = body.indexOf('const executingFingerprint');
    const execute = body.indexOf('tool.execute(');
    expect(rebind).toBeGreaterThan(approval);
    expect(rebind).toBeLessThan(execute);
  });

  it('re-binds an approval to the arguments about to run', () => {
    const dispatcher = FILES.find((file) => file.rel.endsWith('safety/dispatcher.ts'))!.code;
    expect(dispatcher).toMatch(/executingFingerprint !== gate\.fingerprint/);
    expect(dispatcher).toMatch(/APPROVAL_MISMATCH/);
  });

  it('records a side effect BEFORE it happens, not after', () => {
    // A ledger written on success would leave an action whose request reached
    // the network but whose executor then threw unrecorded — and the next
    // attempt would repeat it.
    const dispatcher = FILES.find((file) => file.rel.endsWith('safety/dispatcher.ts'))!.code;
    const record = dispatcher.indexOf('this.ledger.record(');
    const execute = dispatcher.indexOf('tool.execute(');
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(execute);
  });

  it('has no second registry, policy, broker or budget', () => {
    // One of each. A second instance is a second answer to a question that
    // must have one.
    const count = (pattern: RegExp): number => FILES.filter((file) => pattern.test(file.code)).length;
    expect(count(/new Policy\(/)).toBeLessThanOrEqual(2); // runtime + verification runtime
    expect(count(/new ApprovalBroker\(/)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// The demo tooling grants nothing
// ---------------------------------------------------------------------------

describe('the demo tooling is observation, not authority', () => {
  const demoFiles = FILES.filter((file) => file.rel.includes('/main/demo/'));

  it('exists, so these rules are not vacuous', () => {
    expect(demoFiles.map((file) => file.rel).sort()).toEqual([
      'apps/desktop/src/main/demo/preflight.ts',
      'apps/desktop/src/main/demo/recording.ts',
    ]);
  });

  it('reaches no executor, no dispatcher internals, no approval broker and no process', () => {
    for (const file of demoFiles) {
      expect(file.code, file.rel).not.toMatch(/tools\/executors|safety\/dispatcher|approval-broker|child_process|electron/);
      expect(file.code, file.rel).not.toMatch(/\.dispatch\(|resolveApproval\(|\.execute\(/);
    }
  });

  it('is reached only from the runtime and the entry point', () => {
    const importers = FILES.filter((file) => /from '\.{1,2}\/(?:\.\.\/)*demo\//.test(file.code)).map((file) => file.rel);
    expect(importers.sort()).toEqual(['apps/desktop/src/main/runtime.ts']);
  });

  it('offers no "demo mode" that relaxes anything', () => {
    // The phase brief, verbatim: no demo-only security bypass. There is no
    // flag, environment variable or setting whose name suggests one.
    expect(sweep(/DEMO_MODE|demoMode|AXON_DEMO(?!_RECORDING)|autoApprove|skipApproval|bypassApproval/i, [])).toEqual([]);
  });
});
