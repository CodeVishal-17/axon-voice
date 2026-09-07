/**
 * Schema migrations.
 *
 * The list below is append-only and its order is its meaning. A migration that
 * has shipped is never edited — a user's database is already at that version,
 * and rewriting history would mean their schema and this file disagree while
 * both claim the same number.
 *
 * FAIL CLOSED. If a migration throws, the whole run is rolled back, the
 * database is left at the version it was already at, and the caller is told
 * persistence is unavailable. Axon then runs without it: conversations stay in
 * memory for the session and the UI says so. What it explicitly does NOT do is
 * delete the file and start again. A corrupt database is somebody's history,
 * and the recovery for it is a decision the user makes, not one taken silently
 * at startup.
 *
 * The version lives in SQLite's own `user_version` pragma rather than a table
 * of our own: it is atomic with the transaction that sets it, it exists before
 * any of our tables do, and it cannot itself be missing.
 */

import { DatabaseError } from './errors.js';
// Type-only, and that is load-bearing: it erases at compile time, so this
// module — and everything that tests it — never reaches the database engine.
import type { SqlDatabase } from './sqlite.js';

export interface Migration {
  /** Sequential from 1, with no gaps. Enforced by `assertMigrationsAreSane`. */
  readonly version: number;
  readonly name: string;
  /** DDL statements, run in order. Module constants — never built from input. */
  readonly statements: readonly string[];
}

/**
 * Every migration Axon has ever shipped.
 *
 * Notes on the shape of the schema itself:
 *
 * - Conversations and long-term memory are separate tables because they are
 *   separate things with separate delete buttons. A user clearing their chat
 *   history must not be silently clearing what Axon remembers about them, and
 *   vice versa.
 * - `messages` cascades from `sessions`, so deleting a conversation really
 *   deletes its messages. That only works because `PRAGMA foreign_keys = ON`
 *   is set on every connection.
 * - `settings` is a key/value table because settings genuinely are key/value.
 *   Its VALUES are still validated against a closed schema before use — the
 *   table stores rows, `settings-schema.ts` decides what a row may mean.
 * - There is deliberately no table for tool arguments, page content, audio, or
 *   anything a model produced beyond its visible reply.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'conversations, memory, settings',
    statements: [
      `CREATE TABLE sessions (
         id           TEXT PRIMARY KEY NOT NULL,
         title        TEXT NOT NULL,
         summary      TEXT,
         status       TEXT NOT NULL DEFAULT 'active',
         created_at   TEXT NOT NULL,
         updated_at   TEXT NOT NULL
       )`,

      `CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC)`,

      `CREATE TABLE messages (
         id           TEXT PRIMARY KEY NOT NULL,
         session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         role         TEXT NOT NULL,
         content      TEXT NOT NULL,
         seq          INTEGER NOT NULL,
         source       TEXT NOT NULL DEFAULT 'text',
         created_at   TEXT NOT NULL
       )`,

      // The order a conversation is read in, and the uniqueness that makes a
      // sequence number a real ordering rather than a hint.
      `CREATE UNIQUE INDEX idx_messages_session_seq ON messages (session_id, seq)`,

      `CREATE TABLE memories (
         id           TEXT PRIMARY KEY NOT NULL,
         category     TEXT NOT NULL,
         key          TEXT NOT NULL,
         value        TEXT NOT NULL,
         source       TEXT NOT NULL,
         sensitivity  TEXT NOT NULL DEFAULT 'ordinary',
         enabled      INTEGER NOT NULL DEFAULT 1,
         created_at   TEXT NOT NULL,
         updated_at   TEXT NOT NULL
       )`,

      // One memory per category+key. Remembering something twice should update
      // it, not accumulate contradictory copies the model then has to choose
      // between.
      `CREATE UNIQUE INDEX idx_memories_key ON memories (category, key)`,

      `CREATE TABLE settings (
         key          TEXT PRIMARY KEY NOT NULL,
         value        TEXT NOT NULL,
         updated_at   TEXT NOT NULL
       )`,
    ],
  },
];

/**
 * The version this build expects.
 *
 * Derived rather than declared, so it cannot fall out of step with the list.
 */
export function targetVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((highest, migration) => Math.max(highest, migration.version), 0);
}

/**
 * Check the migration list itself.
 *
 * Run before any of them touch a database. A duplicate or out-of-order version
 * is a programming error that would otherwise show up as a user's database
 * being migrated twice, or not at all, months later.
 */
export function assertMigrationsAreSane(migrations: readonly Migration[] = MIGRATIONS): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new DatabaseError(
        'MIGRATION_FAILED',
        `Migrations must be numbered from 1 with no gaps; found version ${migration.version} at position ${expected}.`,
      );
    }
    if (migration.statements.length === 0) {
      throw new DatabaseError('MIGRATION_FAILED', `Migration ${migration.version} has no statements.`);
    }
  });
}

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/**
 * Bring a database up to `targetVersion`.
 *
 * Every pending migration runs inside ONE transaction. Either the database
 * ends up at the target version with all of their statements applied, or it
 * ends up exactly where it started — there is no state in between for the rest
 * of the application to find and misinterpret as healthy.
 *
 * A database from a NEWER version of Axon is refused rather than downgraded.
 * Running an old build against a new schema would either fail confusingly on
 * the first query or, worse, succeed against columns it does not understand.
 */
export function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): MigrationOutcome {
  assertMigrationsAreSane(migrations);

  const target = targetVersion(migrations);
  const current = readVersion(db);

  if (current > target) {
    throw new DatabaseError(
      'MIGRATION_FAILED',
      `This database was written by a newer version of Axon (schema ${current}; this build understands ${target}). ` +
        'Update Axon to open it.',
    );
  }

  if (current === target) return { from: current, to: current, applied: [] };

  const pending = migrations.filter((migration) => migration.version > current);
  const applied: string[] = [];

  try {
    db.transaction(() => {
      for (const migration of pending) {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        applied.push(`${migration.version}: ${migration.name}`);
      }
      // Inside the transaction, so the version and the schema commit together.
      // A version recorded outside it could survive a rolled-back migration
      // and would then describe a schema that does not exist.
      writeVersion(db, target);
    });
  } catch (error) {
    throw new DatabaseError(
      'MIGRATION_FAILED',
      `The Axon database could not be upgraded from schema ${current} to ${target}. ` +
        'Your data has not been changed.',
      { cause: error },
    );
  }

  return { from: current, to: target, applied };
}

export function readVersion(db: SqlDatabase): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const value = row?.user_version;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Set the schema version.
 *
 * `PRAGMA user_version` does not accept a bound parameter — it is not that
 * kind of statement — so the value is interpolated. It is safe to do here, and
 * only here, because `version` is an integer this module derived from its own
 * constant list; it never came from a caller. The check is belt and braces
 * against a future edit that changes where it comes from.
 */
function writeVersion(db: SqlDatabase, version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 1_000_000) {
    throw new DatabaseError('MIGRATION_FAILED', `Refusing to write a schema version of ${String(version)}.`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}
