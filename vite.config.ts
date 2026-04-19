import { defineConfig } from 'vite';

// For GitHub Pages, BASE_URL is injected by the deploy workflow as "/<repo-name>/".
// Locally (dev / `vite build` without env var), default to root.
export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  worker: { format: 'es' },
  server: { port: 5173 }
});
