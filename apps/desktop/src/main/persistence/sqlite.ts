/**
 * The SQLite connection.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * This is the ONLY module in Axon that imports a database engine. Everything
 * above it — the store, the tools, the orchestrator, the brain — depends on
 * the small interface at the bottom of this file, so replacing the engine is a
 * change here and nowhere else. `tests/architecture.test.ts` fails the build if
 * another module imports `node:sqlite`.
 *
 * WHY `node:sqlite`.
 *
 * It ships inside Electron's own Node (24.x in Electron 44) and is maintained
 * by Node core. That means: no new dependency, no native compilation, no
 * `electron-rebuild` step, no prebuilt-binary mismatch on somebody else's
 * machine, and real SQLite rather than a WASM approximation of it. Given a
 * choice between a well-known package and no package at all, for the same
 * engine, the smallest reliable dependency is none.
 *
 * The cost, stated plainly: `node:sqlite` does not exist in Node 20, which is
 * what the unit-test runner uses. So the SQL itself is verified against real
 * SQLite in `scripts/verify-persistence.cjs`, which runs inside Electron, and
 * the pure logic around it — validation, redaction, memory policy, context
 * bounding, migration ordering — is unit-tested in the normal suite. Neither
 * half is pretend.
 *
 * SECURITY — every query is parameterized.
 *
 * There is no method here that takes a string and runs it as a query with
 * values in it. `run`, `get` and `all` take SQL and a separate parameter
 * array; `exec` takes DDL only and is used solely by the migration runner with
 * module-constant strings. A message, a URL, a page's text or a model's tool
 * argument can therefore only ever arrive as a bound parameter — as data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DatabaseError } from './errors.js';

// Re-exported so callers that already import from here keep working, and so
// there is one obvious name for a database failure.
export { DatabaseError } from './errors.js';

/** Values SQLite can bind. Anything else is a programming error. */
export type SqlValue = string | number | null;

export type SqlRow = Record<string, unknown>;


/**
 * What the store is allowed to do to a database.
 *
 * Deliberately four methods. There is no "query with this string I built", no
 * escape hatch, and no way to reach the underlying handle.
 */
export interface SqlDatabase {
  /** DDL only, from a module constant. Never built from input. */
  exec(ddl: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  get<T extends SqlRow>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T extends SqlRow>(sql: string, params?: readonly SqlValue[]): T[];
  /**
   * Run `work` inside a transaction, rolling back if it throws.
   *
   * Nested calls join the outer transaction rather than starting a second one,
   * which SQLite does not support — so a store method that opens a transaction
   * can safely call another that does.
   */
  transaction<T>(work: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** Absolute path. Comes from trusted configuration, never from input. */
  readonly path: string;
}

/**
 * Open (or create) the database at `path`.
 *
 * Pragmas are set before anything else touches it:
 *
 *   journal_mode = WAL   a crash mid-write leaves a recoverable database
 *                        rather than a truncated one, and a reader does not
 *                        block a writer.
 *   foreign_keys = ON    SQLite defaults this OFF. Without it the `ON DELETE
 *                        CASCADE` on messages is decoration, and deleting a
 *                        conversation would leave its messages behind — a
 *                        privacy bug wearing the costume of a referential one.
 *   busy_timeout         a second instance briefly holding the file makes a
 *                        writer wait rather than fail.
 */
export function openDatabase(options: OpenOptions): SqlDatabase {
  let handle: DatabaseSync;

  try {
    // SQLite will create the FILE and will not create its DIRECTORY, and the
    // database lives in `<axonHome>/data/`, which nothing else writes to. On a
    // fresh profile that directory does not exist, so every open failed — and
    // failed in the quietest possible way, because persistence is designed to
    // degrade rather than crash. The result was an application that reported
    // "your conversation will not be saved" on first launch, forever, on every
    // machine that had not run the verification harness (which creates the
    // directory itself, which is why no test caught it).
    //
    // The path comes from `RuntimeConfig`, derived from AXON_HOME. No tool
    // takes a database path and the renderer cannot name one, so there is no
    // input here that could aim this at somewhere it should not create.
    fs.mkdirSync(path.dirname(path.resolve(options.path)), { recursive: true });
  } catch (error) {
    throw new DatabaseError('OPEN_FAILED', 'The folder for the Axon database could not be created.', { cause: error });
  }

  try {
    handle = new DatabaseSync(options.path);
  } catch (error) {
    throw new DatabaseError('OPEN_FAILED', `The Axon database could not be opened.`, { cause: error });
  }

  try {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA synchronous = NORMAL');
  } catch (error) {
    handle.close();
    throw new DatabaseError('OPEN_FAILED', 'The Axon database could not be prepared for use.', { cause: error });
  }

  // Prepared statements are cached: the hot paths (appending a message,
  // reading recent history) run the same handful of statements over and over,
  // and re-preparing each time is the difference between microseconds and
  // milliseconds per message.
  const cache = new Map<string, StatementSync>();
  let depth = 0;
  let closed = false;

  const prepare = (sql: string): StatementSync => {
    const cached = cache.get(sql);
    if (cached) return cached;
    const statement = handle.prepare(sql);
    cache.set(sql, statement);
    return statement;
  };

  const guard = (): void => {
    if (closed) throw new DatabaseError('CLOSED', 'The Axon database is closed.');
  };

  /** Classify an engine error into something a caller can act on. */
  const fail = (error: unknown, sql: string): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
      throw new DatabaseError('LOCKED', 'The Axon database is in use by another window.', { cause: error });
    }
    if (/malformed|not a database|corrupt/i.test(message)) {
      throw new DatabaseError('CORRUPT', 'The Axon database file is damaged.', { cause: error });
    }
    // The SQL text is included because it is a module constant written by us —
    // never a user's message, a page's text or a model's argument, all of
    // which travel as bound parameters and are not in this string.
    throw new DatabaseError('QUERY_FAILED', `A database operation failed: ${sql.slice(0, 120)}`, { cause: error });
  };

  return {
    exec(ddl: string): void {
      guard();
      try {
        handle.exec(ddl);
      } catch (error) {
        fail(error, ddl);
      }
    },

    run(sql, params = []): { changes: number } {
      guard();
      try {
        const result = prepare(sql).run(...(params as SqlValue[]));
        return { changes: Number(result.changes) };
      } catch (error) {
        return fail(error, sql);
      }
    },

    get<T extends SqlRow>(sql: string, params: readonly SqlValue[] = []): T | undefined {
      guard();
      try {
        return prepare(sql).get(...(params as SqlValue[])) as T | undefined;
      } catch (error) {
        return fail(error, sql);
      }
    },

    all<T extends SqlRow>(sql: string, params: readonly SqlValue[] = []): T[] {
      guard();
      try {
        return prepare(sql).all(...(params as SqlValue[])) as T[];
      } catch (error) {
        return fail(error, sql);
      }
    },

    transaction<T>(work: () => T): T {
      guard();

      // Joining rather than nesting. SQLite has no nested transactions, and
      // SAVEPOINTs would add a second failure mode for no benefit here: every
      // caller wants "all of this, or none of it", and the outermost scope
      // delivers exactly that.
      if (depth > 0) return work();

      depth += 1;
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          // A rollback that itself fails means the connection is unusable.
          // The original error is the one worth reporting.
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      cache.clear();
      try {
        handle.close();
      } catch {
        // Closing an already-closed or crashed handle throws; there is nothing
        // left to clean up if it does.
      }
    },
  };
}
