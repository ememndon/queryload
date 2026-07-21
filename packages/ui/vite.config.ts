import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the QueryLoad renderer.
 *
 * `base: './'` makes all asset URLs relative so the built bundle loads under
 * `file://` inside Electron with no server. The dev server is fixed to 5173
 * (the Electron main + CSP expect exactly that origin in dev).
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome128',
  },
});
