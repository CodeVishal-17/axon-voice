import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The website's build.
 *
 * Deliberately plain. The one thing worth saying about it: this app is a
 * SEPARATE SURFACE from the desktop app. It imports nothing from
 * `apps/desktop` or `@axon/core`, so there is no path by which a desktop
 * module — or anything a desktop module reads, such as an API key — can be
 * pulled into a public bundle. Vite only inlines environment variables that
 * begin with `VITE_`, and the only one this site reads is a download URL.
 */
export default defineConfig({
  // Relative asset URLs, so the built site works from a subdirectory
  // (GitHub Pages) as well as from a domain root.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No sourcemap on a public site: it would publish this app's source, and it
    // makes an automated secret scan harder to read for no benefit.
    sourcemap: false,
  },
  server: {
    // 5174, not 5173: the desktop app's renderer dev server already uses that
    // one, and the two should be able to run at the same time.
    port: 5174,
    strictPort: true,
  },
});
