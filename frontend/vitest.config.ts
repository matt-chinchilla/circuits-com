import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts on purpose: that config loads the VitePWA
// plugin, which is irrelevant to unit tests and would try to generate a service
// worker on every run.
//
// Default environment is `node`: the recovery module's decision-logic tests
// inject their browser side effects (sessionStorage, location.reload, the event
// target) at a seam, so they need no DOM. The one defaults-wiring test that must
// exercise the real window/sessionStorage opts into happy-dom per-file via a
// `// @vitest-environment happy-dom` directive.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
