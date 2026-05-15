import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Vitest config kept separate from `vite.config.ts` because Vitest 2.x
// bundles a slightly-divergent copy of Vite's plugin types; sharing the
// config trips a deep-equality `Plugin<any>` check at compile time.
// Splitting the configs lets each tool see plugin types from its own
// dependency graph.
//
// We don't load `@tailwindcss/vite` here — Tailwind isn't needed for unit
// tests, and the test files don't render the full app's CSS pipeline.
// `oklch-tokens.test.tsx` injects `tokens.css` directly via a `<style>`
// element to keep `getComputedStyle()` deterministic without triggering
// Tailwind's resolver.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'agent-tempo': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: true,
    // Exclude Playwright specs — they boot a real HTTP server + spawn
    // chromium and don't run under jsdom. Two suites:
    //   - `e2e/*.spec.ts` runs via `npm run test:e2e`
    //   - `tests-overflow/*.overflow.spec.ts` runs via `npm run test:overflow`
    //     (PR-v0 of #461 — see `dashboard/tests-overflow/README.md`)
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'tests-overflow/**'],
  },
});
