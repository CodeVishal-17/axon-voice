/**
 * Database errors.
 *
 * In a module of their own, deliberately, and with no engine import: an error
 * type is not engine-specific, and putting it beside the engine made every
 * file that merely wanted to *classify* a failure — the migration runner, the
 * service, the tests — transitively import `node:sqlite`.
 *
 * That mattered concretely. `node:sqlite` ships inside Electron's Node but not
 * inside the Node the unit-test runner uses, so the migration logic could not
 * be tested at all until this file existed. Keeping the error here means the
 * migration runner depends on the database only as a TYPE, which erases at
 * compile time and leaves the whole module importable anywhere.
 */

export class DatabaseError extends Error {
  readonly kind: 'OPEN_FAILED' | 'MIGRATION_FAILED' | 'CORRUPT' | 'LOCKED' | 'QUERY_FAILED' | 'CLOSED';

  constructor(kind: DatabaseError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
    this.kind = kind;
  }
}
