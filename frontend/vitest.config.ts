import { defineConfig } from 'vitest/config';
import path from 'path';

// Kept separate from vite.config.ts on purpose: that config loads the VitePWA
// plugin, which is irrelevant to unit tests and would try to generate a service
// worker on every run.
//
// Default environment is `node`: the decision-logic modules inject their browser
// side effects at a seam, so they need no DOM. The one defaults-wiring test that
// must exercise the real window/sessionStorage opts into happy-dom per-file via
// a `// @vitest-environment happy-dom` directive.
//
// The `@admin`/`@public`/`@shared` aliases mirror vite.config.ts so tests can
// import modules by their alias the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      '@admin': path.resolve(__dirname, './src/admin'),
      '@public': path.resolve(__dirname, './src/public'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
