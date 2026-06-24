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
    // Absolute path so this always resolves to dashboard/tests/setup.ts
    // regardless of Vite's server root. The `agent-tempo → ../src` alias causes
    // Vite to treat the repo root as its module-serve root; a relative
    // './tests/setup.ts' then resolves to the ROOT's tests/setup.ts (added by
    // #885), not this file — and that URL-based load races intermittently under
    // worker-thread parallelism (#894). An absolute path bypasses the URL
    // transformer entirely: Node loads the file directly, no race possible.
    setupFiles: [fileURLToPath(new URL('./tests/setup.ts', import.meta.url))],
    css: true,
    // Exclude Playwright specs — they boot a real HTTP server + spawn
    // chromium and don't run under jsdom. Two suites:
    //   - `e2e/*.spec.ts` runs via `npm run test:e2e`
    //   - `tests-overflow/*.overflow.spec.ts` runs via `npm run test:overflow`
    //     (PR-v0 of #461 — see `dashboard/tests-overflow/README.md`)
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'tests-overflow/**'],
    // Belt-and-suspenders: cap concurrent workers too, so even if a future
    // Vitest version reverts to URL-resolution for absolute paths, the burst
    // doesn't recreate the race. 4 threads ≫ dashboard's small test count.
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
  },
});
