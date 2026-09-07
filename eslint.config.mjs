// @ts-check
/**
 * ESLint configuration.
 *
 * Beyond the usual correctness rules, this file encodes Axon's architectural
 * boundaries as lint errors. They are enforced twice on purpose: here, where a
 * violation is caught the moment it is typed, and in
 * `apps/desktop/tests/architecture.test.ts`, which scans the source tree and
 * therefore still holds if someone disables a rule or edits this file.
 *
 * A NOTE ON FLAT-CONFIG SEMANTICS — read before adding a boundary.
 *
 * When two config objects both match a file, the later one's options for a
 * given rule REPLACE the earlier one's; they are not merged. `no-restricted-
 * imports` is therefore stated exactly once per file group, and each group
 * below restates every pattern that applies to it rather than relying on an
 * earlier block still being in force. Splitting one file group's restrictions
 * across two blocks would silently disable the first.
 *
 * Type-aware linting is deliberately not enabled. `tsc --noEmit` already
 * checks types across both tsconfig projects, and running the type checker a
 * second time inside ESLint would double the cost of `npm run lint` for no
 * additional signal.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const EXECUTOR_PATTERNS = ['**/tools/executors/*', '**/tools/executors/**'];

/**
 * The model vendor SDK.
 *
 * Permitted under `src/main/brain/` and refused everywhere else. Reachable
 * from the renderer it would put an API key one bundling mistake away from a
 * sandboxed page; reachable from an executor it would let a tool talk to a
 * model behind the dispatcher's back.
 */
const VENDOR_SDK_PATTERNS = ['@anthropic-ai/sdk', '@anthropic-ai/sdk/**'];

const VENDOR_SDK_MESSAGE =
  'The Anthropic SDK may only be imported under src/main/brain/. Everything else ' +
  'receives ToolSchema[], a dispatch callback, and events.';

const EXECUTOR_MESSAGE =
  'Executors may only be imported by src/main/tools/registry.ts. Everything else goes through the Dispatcher.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.vite/**',
      'packages/core/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --- BOUNDARY: the desktop tree, by default -----------------------------
  // No executor imports, no vendor SDK. The three groups below carve out the
  // files that legitimately need one of those, and each restates the rest.
  {
    files: ['apps/desktop/src/**/*.ts', 'apps/desktop/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: EXECUTOR_PATTERNS, message: EXECUTOR_MESSAGE },
            { group: VENDOR_SDK_PATTERNS, message: VENDOR_SDK_MESSAGE },
          ],
        },
      ],
    },
  },

  // --- CARVE-OUT: the tool registry ---------------------------------------
  // The one module permitted to import an executor. Still refused the SDK.
  {
    files: ['apps/desktop/src/main/tools/registry.ts', 'apps/desktop/src/main/tools/executors/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: VENDOR_SDK_PATTERNS, message: VENDOR_SDK_MESSAGE }],
        },
      ],
    },
  },

  // --- CARVE-OUT: the voice subsystem --------------------------------------
  // Permitted `node:child_process` — it spawns the synthesiser and, since
  // Step 4, the recognizer — and nothing else it could use to act. Notably
  // still refused the filesystem: speech audio is synthesised to a buffer and
  // microphone audio is forwarded over a pipe. Neither ever touches disk, so
  // Axon has no recording to leave behind.
  {
    files: ['apps/desktop/src/main/voice/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: EXECUTOR_PATTERNS, message: EXECUTOR_MESSAGE },
            { group: VENDOR_SDK_PATTERNS, message: VENDOR_SDK_MESSAGE },
            {
              group: ['**/tools/registry', '**/tools/registry.js', '**/safety/**', '**/brain/**'],
              message:
                'The voice layer turns text into audio. It must not reach the tool registry, ' +
                'the safety layer, or the brain.',
            },
          ],
          paths: [
            { name: 'node:fs', message: 'Speech audio is delivered as bytes and never written to disk.' },
            { name: 'node:fs/promises', message: 'Speech audio is delivered as bytes and never written to disk.' },
          ],
        },
      ],
    },
  },

  // --- CARVE-OUT: the brain -----------------------------------------------
  // Permitted the vendor SDK, and nothing else it could use to act directly.
  // It receives its tool surface and its dispatch callback as arguments; that
  // argument passing IS the boundary.
  {
    files: ['apps/desktop/src/main/brain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...EXECUTOR_PATTERNS, '**/tools/registry', '**/tools/registry.js', '**/safety/**'],
              message:
                'The brain must not import executors, the tool registry, or the safety layer. ' +
                'It receives ToolSchema[] and a dispatch callback as arguments.',
            },
          ],
          paths: [
            { name: 'electron', message: 'The brain must not touch Electron APIs.' },
            { name: 'node:fs', message: 'The brain must not touch the filesystem directly.' },
            { name: 'node:fs/promises', message: 'The brain must not touch the filesystem directly.' },
            { name: 'node:child_process', message: 'The brain must not spawn processes.' },
          ],
        },
      ],
    },
  },

  // --- CARVE-OUT: the renderer --------------------------------------------
  // Sandboxed. Importing Node or Electron there would not even run, but
  // failing at lint time explains why far better than a blank window.
  {
    files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: EXECUTOR_PATTERNS, message: EXECUTOR_MESSAGE },
            { group: VENDOR_SDK_PATTERNS, message: VENDOR_SDK_MESSAGE },
            {
              group: ['node:*', '**/main/**', '**/preload/**'],
              message:
                'The renderer is sandboxed and has no Node access. Reach the main process ' +
                'through window.axon (see packages/core/src/ipc.ts).',
            },
          ],
          paths: [{ name: 'electron', message: 'The renderer has no direct Electron access.' }],
        },
      ],
    },
  },

  // Core must stay pure: no Node, no Electron, no React, no vendor SDK.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: VENDOR_SDK_PATTERNS, message: VENDOR_SDK_MESSAGE },
            {
              group: ['node:*', 'electron', 'react', 'react-dom'],
              message: '@axon/core must stay pure. Its only permitted dependency is Zod.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // Verification harnesses and build scripts are CommonJS Node programs run by
  // Electron or Node directly, not part of the app bundle. `no-undef` is the
  // wrong check for them (TypeScript covers the app; these have no type
  // context) and printing to stdout is their entire job.
  {
    files: ['**/scripts/**/*.{js,cjs,mjs}'],
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
