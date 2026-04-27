import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// claude-tempo dashboard — Vite config
//
// - Proxies `/v1/*` and `/dashboard/api/*` to the local daemon (port 8473) so
//   `npm --prefix dashboard run dev` can hit the running daemon during dev.
// - Build output lands in `dashboard/dist/` and is served by the daemon's
//   `src/http/dashboard.ts` static handler in production (see PR-1 of #340).
// - Browser support floor: Safari ≥16. The design tokens use `oklch()` which
//   requires Safari ≥15.4; we set the floor at 16 to align with the broader
//   ECMA target so transpilation and CSS compatibility move together.
//
// Vitest config lives in `vitest.config.ts` to avoid the Vite/Vitest plugin
// type duplication that surfaces when Vitest brings its own bundled `vite`.
//
// References:
//   - `docs/design/340-web-dashboard.md` §3 (stack), §10 (build & packaging)
//   - `docs/adr/0013-web-dashboard.md` browser-support decision

const DAEMON_ORIGIN = 'http://127.0.0.1:8473';

export default defineConfig({
  // The daemon routes `/dashboard/*` to the static handler, so the
  // built SPA's HTML must reference its assets at `/dashboard/assets/...`
  // rather than `/assets/...`. Without this, the browser loads
  // `index.html` from the daemon but every `<script src="/assets/...">`
  // and `<link href="/assets/...">` 404s because the daemon's route
  // table has no `/assets/*` handler. Caught surfacing in PR-8 of #340
  // when Playwright e2e couldn't reach the SPA at all.
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // `claude-tempo/*` resolves to the parent repo's TS sources so the
      // dashboard imports `TempoClient` types directly. PR-4 will start
      // exercising this; PR-2 just configures it. See ADR 0013 for the
      // path-alias-vs-workspaces decision.
      'claude-tempo': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: DAEMON_ORIGIN, changeOrigin: false },
      '/dashboard/api': { target: DAEMON_ORIGIN, changeOrigin: false },
    },
  },
  build: {
    target: 'safari16',
    sourcemap: true,
    rollupOptions: {
      // Belt-and-braces: any accidental `node:*` import (e.g. via the
      // `claude-tempo` alias pulling in node-only TempoClient code) should
      // fail the build rather than silently bundle a broken chunk. PR-4
      // will need to be careful which TempoClient surface it imports.
      external: [/^node:/],
    },
  },
});
