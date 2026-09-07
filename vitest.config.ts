import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tests run against source, not build output, so a failing test points at a
 * line you can edit. `@axon/core` is aliased to its entry module for the same
 * reason.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@axon\/core$/, replacement: path.resolve(root, 'packages/core/src/index.ts') },
      { find: /^@axon\/core\/ipc$/, replacement: path.resolve(root, 'packages/core/src/ipc.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
