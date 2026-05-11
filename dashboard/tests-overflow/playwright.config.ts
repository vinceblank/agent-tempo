/**
 * Playwright config — dashboard overflow CI guardrail (PR-v0 of #461).
 *
 * Audit: `docs/design/dashboard-overflow-audit-v0.28.10.md` §10
 *
 * Separate from `dashboard/playwright.config.ts` (which owns the PR-8 of
 * #340 e2e smoke pack on `./e2e`) so the overflow suite can:
 *   - Run independently in its own CI job (`dashboard-overflow`)
 *   - Use a `webServer` to serve `dashboard/dist/` so the specs' CSS
 *     imports (`/dashboard/assets/components.css`) resolve
 *   - Apply `toHaveScreenshot` defaults tuned for layout-stress sampling
 *     without affecting the e2e suite's screenshot semantics
 *
 * The spec files in this directory:
 *   - `cards-headers-wizards.overflow.spec.ts` (Walk A graduated)
 *   - `tables-sidebar-chat.overflow.spec.ts` (Walk B graduated)
 *
 * **v0 staging note**: this config sets up `toHaveScreenshot` defaults
 * per audit §10.3 step 2, but the v0 specs themselves do not yet add
 * `toHaveScreenshot()` calls. Those land in the v1 follow-up alongside
 * the `/__overflow/<Component>?regime=…` test route shim (§10.3 step 4)
 * and the initial baseline PNG commit (§10.3 step 6). See
 * `tests-overflow/README.md` for the staged rollout.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.OVERFLOW_DASHBOARD_PORT ?? 5174);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.overflow.spec.ts',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    // Per audit §10.3 step 2 — tolerance tuned for sub-pixel rendering
    // noise between different `ubuntu-latest` GitHub Actions runners.
    // `caret: 'hide'` + `animations: 'disabled'` suppress two
    // non-deterministic factors that otherwise produce false positives.
    //
    // **#493 tuning rationale** (was `maxDiffPixels: 50`, bumped after
    // the first dispatched CI run rejected every baseline with 80-699
    // pixel diffs at ratio 0.01-0.02): baseline-generation runs and
    // assertion runs land on different physical `ubuntu-latest`
    // machines. The runner images carry slightly-different font-hinting
    // libraries / anti-aliasing settings, producing sub-percent diffs
    // that aren't real layout regressions. Real regressions move WAY
    // more pixels — a layout shift relocates an entire element
    // (thousands of px); a color/theme swap changes most pixels; a
    // text-content change perturbs 5-30%. The 3% ratio + 1500-pixel
    // cap absorbs runner noise while keeping enough headroom that
    // every observed-in-practice regression class still trips the
    // diff.
    //
    // **Both bounds apply** — Playwright fails the test if either is
    // exceeded. The ratio gracefully scales with locator-screenshot
    // size; the absolute cap protects against tiny screenshots where
    // even 3% is only a handful of pixels.
    toHaveScreenshot: {
      maxDiffPixels: 1500,
      maxDiffPixelRatio: 0.03,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  // Force serial — most overflow tests reset viewport + inject DOM, so
  // parallelism would race shared browser state. Wall-clock cost is
  // bounded (~30 tests × ~1s each ≈ 30s).
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Spawn `vite preview` so `/dashboard/assets/components.css` resolves
  // for both Walk A's live-nav specs and Walk B's setContent shell. The
  // built dashboard ships at `dashboard/dist/dashboard/`; vite's `base:
  // '/dashboard/'` config (see `dashboard/vite.config.ts`) ensures asset
  // URLs match the production layout.
  //
  // #492 — `VITE_OVERFLOW=1` lights up the dev-only `/__overflow/:component`
  // route shim that the Walk A specs depend on. The route is dead-code-
  // eliminated by vite when the flag is absent, so a normal
  // `npm run build` still produces a flag-free production bundle.
  //
  // CI provides the flag-on build via the `Build dashboard (overflow)`
  // step; locally, `VITE_OVERFLOW=1 npm --prefix dashboard run build`
  // produces a `dashboard/dist/` with the shim route registered, then
  // `npm --prefix dashboard run preview` serves it.
  webServer: {
    command:
      'npm run build:overflow && ' +
      'npm run preview -- --port ' + String(PORT) + ' --host ' + HOST + ' --strictPort',
    url: BASE_URL + '/dashboard/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
