/**
 * Dashboard e2e smoke pack — PR-8 of #340.
 *
 * Four scenarios, each driven against an isolated test daemon
 * (see `./test-daemon.ts`):
 *
 *   1. **Overview renders + ensemble list shows up.** The dashboard
 *      navigates to `/`, fetches `/v1/ensembles` (mocked), and the
 *      Overview screen ships an EnsembleCard per row.
 *   2. **Workspace + cue placeholder.** Navigate into an ensemble,
 *      type into the message input, submit. The PR-5 placeholder
 *      logs `chat.message.placeholder-send` (real wire-up lands in
 *      PR-7 — the test asserts the placeholder is reachable + the
 *      log fires, which is what the conductor's autonomous
 *      validator can grep).
 *   3. **Mobile viewport — sidebar collapses to a sheet.** 375x667
 *      viewport. The artboard's `@container artboard (max-width: 520px)`
 *      rules collapse the sidebar; the layout still exposes the
 *      brandmark + roster.
 *   4. **Pair-token flow — risk #16 ordering.** Mint via
 *      `POST /dashboard/api/pair` against the real daemon, navigate
 *      to `/dashboard/?pair=<token>`. Assert the token is dropped
 *      from the URL BEFORE the bearer lands in localStorage —
 *      lock the contract that `dashboard/src/lib/pair.ts` enforces.
 */
import { test, expect } from '@playwright/test';
import { bootTestDaemon, type TestDaemonHandle } from './test-daemon';
import type { EnsembleStateV1 } from '../../src/http/event-types';

let daemon: TestDaemonHandle;

test.beforeAll(async () => {
  daemon = await bootTestDaemon();
});

test.afterAll(async () => {
  await daemon.close();
});

const DEMO_ENSEMBLE = 'demo';

function makeEnsembleSnapshot(): EnsembleStateV1 {
  return {
    v: 1,
    ensemble: DEMO_ENSEMBLE,
    capturedAt: new Date().toISOString(),
    lastEventId: '1735000000000:0',
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players: [
      {
        playerId: 'tempo-conductor',
        ensemble: DEMO_ENSEMBLE,
        hostname: 'host',
        isConductor: true,
        agentType: 'claude',
        playerType: 'tempo-conductor',
        phase: 'attached',
        part: '',
        workDir: '/work',
      },
      {
        playerId: 'tempo-eng',
        ensemble: DEMO_ENSEMBLE,
        hostname: 'host',
        isConductor: false,
        agentType: 'claude',
        playerType: 'my-tempo-engineer',
        phase: 'attached',
        part: '',
        workDir: '/work',
      },
    ],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
  };
}

test('1. Overview renders the ensemble list with the right testids', async ({ page }) => {
  // Mock `/v1/ensembles` since the test daemon has no Temporal.
  await page.route(`${daemon.origin}/v1/ensembles`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { name: DEMO_ENSEMBLE, playerCount: 2, hasConductor: true, state: 'online' },
      ]),
    }),
  );
  await page.route(`${daemon.origin}/v1/state/${DEMO_ENSEMBLE}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeEnsembleSnapshot()),
    }),
  );
  // SSE endpoint — return an empty stream so the subscription hook
  // gets a "connection-end" rather than a 503.
  await page.route(`${daemon.origin}/v1/events/${DEMO_ENSEMBLE}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: '',
    }),
  );

  await page.goto(`${daemon.origin}/dashboard/`);
  await expect(page.getByTestId('screen-overview')).toBeVisible();
  await expect(page.getByTestId(`ensemble-card-${DEMO_ENSEMBLE}`)).toBeVisible();
  await expect(page.getByTestId(`ensemble-card-${DEMO_ENSEMBLE}-link`)).toBeVisible();
});

test('2. Workspace renders MessageInput + interacts with the cue mutation surface', async ({ page }) => {
  // PR-7b wired the real cue mutation in MessageInput, so the
  // placeholder-send log from PR-5/8 is gone. This test now verifies
  // that the input + submit testids are reachable and that a typed
  // message + click reaches eng's POST `/v1/ensembles/:e/cue`
  // endpoint (route-mocked here so the test daemon doesn't need
  // Temporal). Validates that the autonomous-validation surface is
  // intact end-to-end across PR-7 + PR-8.
  await page.route(`${daemon.origin}/v1/state/${DEMO_ENSEMBLE}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeEnsembleSnapshot()),
    }),
  );
  await page.route(`${daemon.origin}/v1/events/${DEMO_ENSEMBLE}*`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  // Mock the cue endpoint that PR-7b's mutation calls. Capture the
  // request to assert the message body round-trips through the SPA's
  // body builder.
  let capturedCue: { to?: string; message?: string } | null = null;
  await page.route(`${daemon.origin}/v1/ensembles/${DEMO_ENSEMBLE}/cue`, async (route) => {
    const body = route.request().postDataJSON();
    capturedCue = body as { to?: string; message?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(`${daemon.origin}/dashboard/ensemble/${DEMO_ENSEMBLE}`);
  await expect(page.getByTestId(`workspace-${DEMO_ENSEMBLE}`)).toBeVisible();
  // PR-C2 (#389) replaced MessageInput with the Composer primitive —
  // the testid surface moved from `message-input` / `message-submit`
  // to `composer-input` / `composer-send`. The mutation contract is
  // identical (useCueMutation underneath), so the round-trip
  // assertions below work the same way.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('composer-send')).toBeVisible();

  await page.getByTestId('composer-input').fill('hello from playwright');
  await page.getByTestId('composer-send').click();

  await expect.poll(() => capturedCue !== null, { timeout: 2000 }).toBe(true);
  expect(capturedCue).toMatchObject({ message: 'hello from playwright' });
});

test('3. Mobile viewport renders the sidebar + roster (375x667)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route(`${daemon.origin}/v1/state/${DEMO_ENSEMBLE}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeEnsembleSnapshot()),
    }),
  );
  await page.route(`${daemon.origin}/v1/events/${DEMO_ENSEMBLE}*`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );

  await page.goto(`${daemon.origin}/dashboard/ensemble/${DEMO_ENSEMBLE}`);
  // Both shell + workspace surfaces are reachable at this viewport.
  // PlayerDetail's Radix Dialog only renders when its nested route is
  // active, so the smoke just asserts roster visibility — the dialog
  // contract is locked by the unit tests in `player-detail.test.tsx`.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('roster')).toBeVisible();

  // PR-A1m mobile shell: at this viewport the container-query rules
  // expose PhoneAppBar + PhoneTabBar; sidebar is hidden.
  await expect(page.getByTestId('phone-appbar')).toBeVisible();
  await expect(page.getByTestId('phone-tabbar')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toBeHidden();

  // The "Now" tab is active inside `/ensemble/:id` per the navToTab map.
  await expect(page.getByTestId('phone-tab-workspace')).toHaveClass(/\bis-active\b/);

  // Tapping the hamburger opens the EnsembleSwitcher; clicking the
  // scrim closes it again. (Container-query mode renders the bottom-
  // sheet variant at this viewport.)
  await page.getByTestId('phone-appbar-menu').click();
  await expect(page.getByTestId('ensemble-switcher')).toBeVisible();
  await page.getByTestId('ensemble-switcher-close').click();
  await expect(page.getByTestId('ensemble-switcher')).toBeHidden();

  // PR-C3: Workspace pushes a PhoneAppBar override — the action button
  // (right-side icon) toggles the side-panel slide-in. Default state
  // `showSide=true`, so the action button lands `is-active`. Tapping
  // hides the side panel; tapping again reopens it.
  const action = page.getByTestId('phone-appbar-action');
  await expect(action).toHaveClass(/\bis-active\b/);
  await expect(page.getByTestId('workspace-side')).toBeVisible();
  await action.click();
  await expect(action).not.toHaveClass(/\bis-active\b/);
  await expect(page.getByTestId('workspace-side')).toBeHidden();
  await action.click();
  await expect(page.getByTestId('workspace-side')).toBeVisible();

  // The scrim element is rendered (its onClick → setShowSide(false) is
  // unit-tested in `tests/workspace.test.tsx`); skipping the click here
  // because Playwright's actionability is brittle when the bottom-sheet
  // overlaps the scrim's centre point.
  await expect(page.getByTestId('workspace-side-scrim')).toBeVisible();

  // Re-open the side via the action button so the next assertion sees
  // the in-active state of the right button.
  if (!(await page.getByTestId('workspace-side').isVisible())) {
    await page.getByTestId('phone-appbar-action').click();
  }

  // Status row shows the lineup kicker + 4-pill row. Two mock-snapshot
  // players are both `attached` → "2 active". Idle/detached zero.
  const status = page.getByTestId('phone-appbar-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('2 active');
});

test('4. Pair-token flow drops ?pair= BEFORE the bearer lands (risk #16)', async ({ page }) => {
  // The test daemon serves the real `/dashboard/api/pair` endpoints
  // — no mock — so this test exercises mint + consume end-to-end.
  // Mint via direct HTTP (bypasses the SPA so we don't need a UI
  // for it; the operator-CLI is the production caller).
  const mint = await page.request.post(`${daemon.origin}/dashboard/api/pair`, {
    headers: { Authorization: 'Bearer e2e-bearer' },
  });
  expect(mint.status()).toBe(201);
  const minted = (await mint.json()) as { token: string; expiresAt: number };
  expect(minted.token).toMatch(/^[A-Za-z0-9_-]+$/);

  // Capture the URL state at the moment the bearer write happens.
  // The consume hook drops the token via `history.replaceState`
  // BEFORE the daemon returns the bearer (it's the first thing in
  // the useEffect). If the order is correct, by the time
  // localStorage receives the bearer the URL should be clean.
  await page.addInitScript(() => {
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    const recorded: { search: string }[] = [];
    Object.defineProperty(window, '__pairProbeRecord', { value: recorded });
    window.localStorage.setItem = function (key: string, value: string) {
      if (key === 'claude-tempo:bearer') recorded.push({ search: window.location.search });
      return realSetItem(key, value);
    };
  });

  await page.goto(`${daemon.origin}/dashboard/?pair=${minted.token}`);

  // Wait for the bearer to land + the URL to settle.
  await expect.poll(async () =>
    await page.evaluate(() => window.localStorage.getItem('claude-tempo:bearer')),
    { timeout: 5000 },
  ).toBeTruthy();

  // Risk #16 — the URL was empty at bearer-write time.
  const recorded = await page.evaluate(
    () => (window as unknown as { __pairProbeRecord: { search: string }[] }).__pairProbeRecord,
  );
  expect(recorded.length).toBeGreaterThan(0);
  expect(recorded[0].search).toBe('');

  // The URL stays clean after the flow settles.
  await expect.poll(async () => new URL(page.url()).search).toBe('');

  // Re-consuming the same token is a 410 — single-use is enforced.
  const second = await page.request.get(`${daemon.origin}/dashboard/api/pair/${minted.token}`);
  expect(second.status()).toBe(410);
});
