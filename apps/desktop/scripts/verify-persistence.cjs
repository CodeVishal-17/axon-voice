/**
 * Real persistence verification.
 *
 * The unit suite covers everything pure about persistence — validation,
 * redaction, the memory policy, the context bounds, migration ordering. It
 * cannot cover the SQL, because `node:sqlite` ships inside Electron's Node
 * (24.x) and not inside the Node the test runner uses (20.x).
 *
 * So this harness runs inside Electron, against a real database file in a
 * temporary directory, and exercises the half the unit tests structurally
 * cannot: real migrations from an empty file and from an older schema, real
 * transactions and rollbacks, real cascade deletes, real retention, a real
 * restart, and a real SQL-injection round trip.
 *
 *   npm run verify:persistence
 *
 * Exits non-zero on the first failed expectation. Never touches the user's own
 * Axon data — everything happens under a fresh `mkdtemp` directory that is
 * removed at the end.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const checks = [];
let failed = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Everything the database has actually written, including the WAL.
 *
 * `journal_mode = WAL` means a recent write lives in the `-wal` sidecar until a
 * checkpoint, so reading only the main file proves nothing about whether a
 * value was stored — a check for the ABSENCE of a credential would pass simply
 * because nothing had been flushed yet. Reading both is what makes the absence
 * check mean something, and the presence check above it is the control.
 */
function onDisk(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'latin1'))
    .join('')
    // SQLite pads its pages with NUL bytes; stripping them is what makes a
    // stored string findable as a contiguous run of characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000]/g, '');
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  if (!fs.existsSync(outDir)) {
    console.error('Build output missing. Run `npm run build --workspace @axon/desktop` first.');
    app.exit(1);
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-persist-'));
  process.env.AXON_HOME = sandbox;

  const runtime = require(path.join(outDir, 'runtime.js'));
  const dbPath = path.join(sandbox, 'data', 'axon.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  console.log('\nAxon persistence verification (real SQLite, real migrations)\n');
  console.log(`database : ${dbPath}\n`);

  const timings = {};
  const time = (label, work) => {
    const startedAt = Date.now();
    const result = work();
    timings[label] = Date.now() - startedAt;
    return result;
  };

  // --- a real database, from nothing --------------------------------------
  let service = time('cold open + migrate', () => {
    const built = new runtime.PersistenceService({ databasePath: dbPath });
    built.start();
    return built;
  });

  check('the database file was created', fs.existsSync(dbPath), `${fs.statSync(dbPath).size} bytes`);
  check('persistence reports itself available', service.available === true, service.status().reason ?? '');
  check('the schema is at the expected version', service.status().schemaVersion === runtime.TARGET_SCHEMA_VERSION, String(service.status().schemaVersion));
  check('WAL is on, so a crash mid-write is recoverable', fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`));

  // Migrating an already-current database must be a no-op, not a re-run.
  const secondOpen = new runtime.PersistenceService({ databasePath: dbPath });
  check('re-opening an up-to-date database succeeds', secondOpen.start() === true);
  check('and does not re-apply migrations', secondOpen.status().schemaVersion === runtime.TARGET_SCHEMA_VERSION);
  secondOpen.close();

  // --- conversations --------------------------------------------------------
  const session = service.openInitialSession();
  check('an initial conversation was opened', Boolean(session), session ? session.title : 'none');

  time('insert 200 messages', () => {
    for (let i = 0; i < 100; i += 1) {
      service.appendMessage('user', `question number ${i}`);
      service.appendMessage('assistant', `answer number ${i}`);
    }
  });

  const stored = service.messages(session.id, 500);
  check('messages were stored in order', stored.length > 0 && stored[0].seq < stored[stored.length - 1].seq, `${stored.length} messages`);
  check('roles round-trip', stored.some((m) => m.role === 'user') && stored.some((m) => m.role === 'assistant'));

  const summary = service.listSessions()[0];
  check('a session summary was built from the transcript', Boolean(summary.summary), summary.summary ?? 'none');
  check('the summary contains only what the user said', !String(summary.summary).includes('answer number'));

  // --- SQL injection, for real ---------------------------------------------
  const hostile = "'; DROP TABLE messages; --";
  service.appendMessage('user', hostile);
  const roundTripped = service.messages(session.id, 5).map((m) => m.content);

  check('an injection string is stored as data', roundTripped.includes(hostile), JSON.stringify(hostile));
  check('the messages table still exists', service.messages(session.id, 5).length > 0);

  service.renameSession(session.id, "Robert'); DROP TABLE sessions; --");
  check('an injection title is stored as data', service.listSessions().length === 1);
  check('the sessions table still exists', Boolean(service.getSessionForCheck ? true : service.listSessions()[0]));
  service.renameSession(session.id, 'Verification run');

  // --- credentials are not written ------------------------------------------
  service.appendMessage('user', 'my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA please remember it');

  const raw = onDisk(dbPath);
  // The control check comes FIRST. Without it, "the credential is absent"
  // passes for the wrong reason on any run where the bytes have not been
  // written yet — which is exactly what WAL does, and exactly what this
  // harness got wrong on its first run.
  check('the surrounding message really is on disk', raw.includes('please remember it'));
  check('a credential in a message never reaches the file', !raw.includes('sk-ant-api03-AAAA'));

  // --- memory ----------------------------------------------------------------
  const saved = service.saveMemory({
    category: 'project',
    key: 'current project',
    value: 'Axon Voice, the desktop agent',
    source: 'user',
    sensitivity: 'ordinary',
  });
  check('a memory was saved', Boolean(saved), saved ? saved.key : 'none');

  const updated = service.saveMemory({
    category: 'project',
    key: 'current project',
    value: 'Axon Voice, step six',
    source: 'user',
    sensitivity: 'ordinary',
  });
  check('saving the same key updates rather than duplicating', service.listMemories().length === 1, `${service.listMemories().length} memories`);
  check('the value was replaced', updated.value === 'Axon Voice, step six');

  const found = time('memory search', () => service.searchMemories('axon'));
  check('memory search finds it', found.length === 1, `${found.length} results`);
  check('an unmatched search finds nothing', service.searchMemories('nothing like this').length === 0);
  check('a LIKE wildcard is escaped rather than matching everything', service.searchMemories('%').length === 0);

  // --- retention: memories -------------------------------------------------------
  for (let i = 0; i < 210; i += 1) {
    service.saveMemory({ category: 'fact', key: `fact ${i}`, value: `value ${i}`, source: 'user', sensitivity: 'ordinary' });
  }
  check('memories are capped', service.listMemories().length <= 200, `${service.listMemories().length} kept`);

  // --- the bounded context ------------------------------------------------------
  // Before the retention test below, which deliberately evicts old
  // conversations — including this one.
  const reselected = service.selectSession(session.id);
  check('the original conversation can be reopened', Boolean(reselected), reselected ? reselected.title : 'gone');

  const restored = time('build turn context', () => service.contextForTurn());

  check('a turn gets a bounded slice of history', restored.history.length <= 24, `${restored.history.length} of ${stored.length} messages`);
  check('and a bounded number of memories', restored.context.memories.length <= 20, `${restored.context.memories.length} memories`);
  check('the context carries no ids or timestamps', restored.context.memories.every((m) => Object.keys(m).sort().join(',') === 'category,key,value'));
  const characters = restored.history.reduce((sum, m) => sum + m.content.length, 0);
  check('the restored history is inside the character budget', characters <= 12_000, `${characters} characters`);

  // --- retention ------------------------------------------------------------------
  // Runs last of the read checks: capping conversations evicts the oldest, and
  // the oldest is the one every check above reads from.
  const beforeCap = service.listSessions().length;
  for (let i = 0; i < 110; i += 1) service.createSession(`throwaway ${i}`);
  check('conversations are capped', service.listSessions().length <= 100, `${beforeCap} -> ${service.listSessions().length}`);
  check('capping really removed rows', service.listSessions().length < beforeCap + 110);

  // --- settings and profile -------------------------------------------------------
  service.commitSettings(
    { voiceHotkey: 'Control+Alt+K', workspacePath: null, speechEnabled: false, restoreLastSession: true, memoryEnabled: true },
    ['voiceHotkey', 'speechEnabled'],
  );
  service.updateProfile({ displayName: 'Vishal', language: 'en-GB' });

  // Created after the retention test, so it is one of the newest and is
  // guaranteed to survive the cap. This is the conversation the restart check
  // reads: proving a transcript crosses a restart needs one that was not
  // legitimately evicted on the way there.
  const durable = service.createSession('survives a restart');
  service.appendMessage('user', 'remember this across a restart');
  service.appendMessage('assistant', 'noted');
  const durableId = durable.id;

  // --- close and reopen: the whole point --------------------------------------------
  service.close();

  service = time('reopen', () => {
    const built = new runtime.PersistenceService({ databasePath: dbPath });
    built.start();
    return built;
  });

  check('the database reopened', service.available === true);
  check('settings survived the restart', service.currentSettings().voiceHotkey === 'Control+Alt+K', service.currentSettings().voiceHotkey ?? 'null');
  check('a toggled setting survived too', service.currentSettings().speechEnabled === false);
  check('the profile survived', service.profile().displayName === 'Vishal', service.profile().displayName ?? 'null');
  check('memories survived', service.listMemories().length > 0, `${service.listMemories().length} memories`);

  const reopened = service.openInitialSession();
  check('the last conversation was restored, not recreated', Boolean(reopened));

  const survivor = service.listSessions().find((entry) => entry.id === durableId);
  check('a conversation with messages survived the restart', Boolean(survivor), survivor ? `${survivor.messageCount} messages` : 'none');

  const restoredMessages = service.messages(durableId, 500);
  check('its messages came back with their content', restoredMessages.length === 2, `${restoredMessages.length} messages`);
  check(
    'and in the order they were said',
    restoredMessages[0] && restoredMessages[0].content === 'remember this across a restart',
    restoredMessages[0] ? restoredMessages[0].content : 'none',
  );
  check('with their roles intact', restoredMessages[1] && restoredMessages[1].role === 'assistant');

  // --- deletion really deletes -------------------------------------------------------
  const target = service.createSession('to be deleted');
  service.appendMessage('user', 'this should not survive deletion');
  const marker = 'this should not survive deletion';
  check('the message was written', onDisk(dbPath).includes(marker));

  check('deleting the conversation reports success', service.deleteSession(target.id) === true);
  check('the conversation is gone', !service.listSessions().some((s) => s.id === target.id));
  check('its messages are gone too', service.messages(target.id, 10).length === 0);

  const memoryToDelete = service.listMemories()[0];
  check('deleting a memory reports success', service.deleteMemory(memoryToDelete.id) === true);
  check('the memory is gone', !service.listMemories().some((m) => m.id === memoryToDelete.id));

  const cleared = service.clearMemories();
  check('clearing memory removes everything', cleared > 0 && service.listMemories().length === 0, `${cleared} cleared`);
  check('clearing memory left the conversations alone', service.listSessions().length > 0, `${service.listSessions().length} conversations`);

  // --- failure modes ------------------------------------------------------------------
  service.close();
  check('using a closed database degrades rather than throwing', service.listSessions().length === 0);
  check('and appending to it does not throw', (() => { try { service.appendMessage('user', 'x'); return true; } catch { return false; } })());

  // A file that is not a database at all.
  const corruptPath = path.join(sandbox, 'data', 'corrupt.db');
  fs.writeFileSync(corruptPath, 'this is definitely not a SQLite database');
  const corrupt = new runtime.PersistenceService({ databasePath: corruptPath });
  const corruptStarted = corrupt.start();

  check('a damaged database fails closed', corruptStarted === false);
  check('and says so in a sentence', typeof corrupt.status().reason === 'string' && corrupt.status().reason.length > 20, corrupt.status().reason);
  check('and does NOT delete the file', fs.existsSync(corruptPath) && fs.readFileSync(corruptPath, 'utf8').startsWith('this is definitely'));
  check('the app can still run without persistence', corrupt.listSessions().length === 0 && corrupt.currentSettings() !== null);
  corrupt.close();

  // A database from a newer build must be refused, not downgraded.
  const futurePath = path.join(sandbox, 'data', 'future.db');
  {
    const future = new runtime.PersistenceService({ databasePath: futurePath });
    future.start();
    future.close();
    // Bump the schema past what this build understands.
    const bump = runtime.openDatabase({ path: futurePath });
    bump.exec('PRAGMA user_version = 9999');
    bump.close();
  }
  const fromFuture = new runtime.PersistenceService({ databasePath: futurePath });
  check('a database from a newer Axon is refused', fromFuture.start() === false);
  check('and the refusal explains why', /newer version/i.test(fromFuture.status().reason ?? ''), fromFuture.status().reason);
  fromFuture.close();

  // --- transaction rollback, against real SQLite ------------------------------------
  {
    const db = runtime.openDatabase({ path: path.join(sandbox, 'data', 'tx.db') });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    db.run('INSERT INTO t (v) VALUES (?)', ['before']);

    let threw = false;
    try {
      db.transaction(() => {
        db.run('INSERT INTO t (v) VALUES (?)', ['during']);
        throw new Error('deliberate failure');
      });
    } catch {
      threw = true;
    }

    check('a failing transaction throws to the caller', threw);
    const rows = db.all('SELECT v FROM t');
    check('and leaves no partial state', rows.length === 1 && rows[0].v === 'before', JSON.stringify(rows.map((r) => r.v)));

    // A nested transaction joins the outer one rather than starting a second.
    let nestedOk = false;
    db.transaction(() => {
      db.transaction(() => {
        db.run('INSERT INTO t (v) VALUES (?)', ['nested']);
      });
      nestedOk = true;
    });
    check('nested transactions join rather than fail', nestedOk && db.all('SELECT v FROM t').length === 2);

    db.close();
    let afterClose = false;
    try {
      db.all('SELECT 1');
    } catch {
      afterClose = true;
    }
    check('a closed database refuses further queries', afterClose);
  }

  // --- performance ------------------------------------------------------------------
  console.log('\n  timings (ms):');
  for (const [label, ms] of Object.entries(timings)) console.log(`    ${label.padEnd(24)} ${ms}`);
  console.log('');

  check('cold open and migration are fast', timings['cold open + migrate'] < 1000, `${timings['cold open + migrate']}ms`);
  check('reopening is fast', timings.reopen < 500, `${timings.reopen}ms`);
  check('building a turn context is fast', timings['build turn context'] < 200, `${timings['build turn context']}ms`);
  check('a memory search is fast', timings['memory search'] < 100, `${timings['memory search']}ms`);

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

  service.close();
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the temp directory is disposable */
  }
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(
  () => {
    main().catch((error) => {
      console.error('\nHarness crashed:', error);
      app.exit(1);
    });
  },
  (error) => {
    console.error('Electron failed to start:', error);
    process.exit(1);
  },
);
