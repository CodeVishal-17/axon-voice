/**
 * Types for `node:sqlite`.
 *
 * WHY THIS FILE EXISTS.
 *
 * The module ships inside Electron's Node (24.x in Electron 44) but is not
 * described by the `@types/node` version this repository compiles against
 * (20.x, matching the toolchain Node). Without a declaration, `sqlite.ts` does
 * not typecheck; with the wrong one, it typechecks against a fiction.
 *
 * So this declares only the surface Axon actually uses, and declares it
 * NARROWLY. Every member below is called somewhere in `sqlite.ts`; nothing is
 * declared speculatively. A narrow declaration cannot promise a method that
 * does not exist, and if the runtime shape ever changes underneath us, the
 * failure surfaces in `verify-persistence.cjs` — which runs the real module
 * against a real database — rather than being papered over here.
 *
 * The alternative, `@types/node@24`, would upgrade the types for the whole
 * repository to describe a Node the test runner does not have. That trades a
 * small, honest declaration for a large, wrong one.
 */

declare module 'node:sqlite' {
  /** A prepared statement. Values are bound, never interpolated. */
  export class StatementSync {
    run(...params: (string | number | bigint | null | Uint8Array)[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: (string | number | bigint | null | Uint8Array)[]): unknown;
    all(...params: (string | number | bigint | null | Uint8Array)[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readonly?: boolean; open?: boolean });
    /** DDL and pragmas. Axon passes module constants only. */
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
