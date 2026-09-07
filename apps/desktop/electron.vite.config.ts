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
