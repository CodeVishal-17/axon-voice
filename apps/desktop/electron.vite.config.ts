import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * `@axon/core` is a workspace package that ships ESM, and `zod` is its only
 * dependency. Both are excluded from externalization so they are bundled into
 * the CommonJS main/preload output rather than being `require`d at runtime,
 * where an ESM package would fail to load.
 */
const bundleWorkspaceDeps = externalizeDepsPlugin({ exclude: ['@axon/core', 'zod'] });

export default defineConfig({
  main: {
    plugins: [bundleWorkspaceDeps],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Second entry so `scripts/verify-tools.cjs` can build the real
          // runtime graph inside Electron without launching a window.
          runtime: resolve(__dirname, 'src/main/runtime.ts'),
          // The keyword spotter runs as a CHILD PROCESS, not as part of main,
          // so it needs its own entry point rather than being pulled into the
          // main bundle. See the header of `kws-host.ts` for why the process
          // boundary is the point.
          'kws-host': resolve(__dirname, 'src/main/wake/kws-host.ts'),
          // Fourth entry so `scripts/fetch-wake-model.cjs` checks the SAME wake
          // phrase constants the product runs on, rather than a copy of them
          // that could drift and leave Axon deaf with no error anywhere.
          'wake-keywords': resolve(__dirname, 'src/main/wake/wake-keywords.ts'),
          // So `scripts/voice-live.cjs` scores transcripts with the tested
          // matcher rather than a copy of it.
          'transcript-match': resolve(__dirname, 'src/main/voice/transcript-match.ts'),
          // So `scripts/wake-focus.cjs` classifies with the tested module.
          'focus-report': resolve(__dirname, 'src/main/wake/focus-report.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [bundleWorkspaceDeps],
    build: {
      sourcemap: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer') },
    },
    build: {
      sourcemap: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
