/**
 * Playwright config — dashboard e2e smoke pack (PR-8 of #340).
 *
 * Single browser (chromium) keeps the CI cost addition reasonable
 * — Firefox/WebKit added later if browser-specific bugs surface.
 * Phone viewport is exercised inline in the relevant spec rather
 * than as a separate project so the wall-clock stays small.
 *
 * Server lifecycle: tests spawn the test daemon themselves
 * (via `e2e/test-daemon.ts`) so each test file owns its own
 * port + lifecycle. No Playwright-managed `webServer` block — the
 * dashboard speaks to a real HTTP layer, and we want the daemon
 * up well before the SPA loads.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Force serial — each test file already spawns its own daemon, but
  // serial keeps stdout readable when something fails locally.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
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
});
