import { defineConfig } from 'vite';
import { resolve } from 'path';

// For GitHub Pages, BASE_URL is injected by the deploy workflow as "/<repo-name>/".
// Locally (dev / `vite build` without env var), default to root.
export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  worker: { format: 'es' },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        sweep: resolve(__dirname, 'sweep.html'),
      },
    },
  },
});
