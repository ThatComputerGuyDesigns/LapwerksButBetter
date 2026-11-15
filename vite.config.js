import { defineConfig } from 'vite';

// Relative base so the build works from any path (GitHub Pages project sites).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, sourcemap: false },
  server: { host: true },
});
