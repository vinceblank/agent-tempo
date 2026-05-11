/**
 * Dev-only route shim for the dashboard overflow Playwright suite (#492).
 *
 * ## Why this exists
 *
 * Walk A's overflow tests in `tests-overflow/cards-headers-wizards.overflow.spec.ts`
 * navigate to the live SPA (`/dashboard`, `/dashboard/create-ensemble`,
 * `/dashboard/player-types`), then inject fixture text into rendered DOM
 * elements via `page.evaluate()`. That assumes the screens are rendered
 * with ENOUGH baseline data for selectors like
 * `[data-testid^="ensemble-card-"]`, `.picker-row`, `.types-grid .display`
 * to resolve — which in turn assumes the SPA can reach a daemon at
 * `127.0.0.1:8473` for the `/v1/*` calls behind those screens.
 *
 * In CI the `dashboard-overflow` job doesn't spawn a daemon. Pre-#492
 * the suite punted via `ensureDaemonOrSkip()` — tests skip when the
 * daemon is unavailable, which means they don't actually run in CI.
 *
 * This shim swaps the dashboard's singleton `DashboardTempoClient` for
 * a fixture-only one (`createOverflowFixtureClient`) before the target
 * screen mounts. Components fetch via the singleton, hit the fixture
 * client, and get regime-keyed seed data back — no `/v1/*` traffic,
 * no daemon required, AND every refetch / SSE re-subscription returns
 * the same fixture (so the cache can't drift mid-test).
 *
 * Replacing the client (rather than `queryClient.setQueryData` alone)
 * matters because the catalog queries in `lib/queries.ts` carry
 * `staleTime: 5s` + `refetchInterval: 30s` + `refetchOnWindowFocus:
 * true`. Pre-seeded data gets refreshed against the real singleton —
 * which on a developer's laptop with a live daemon at `8473` yields
 * a different ensemble list than the fixture intends. Swapping the
 * client makes the source-of-truth identity stable.
 *
 * ## Production safety
 *
 * The `/__overflow/:component` route is registered in `router.tsx`
 * only when `import.meta.env.DEV === true` OR
 * `import.meta.env.VITE_OVERFLOW === '1'`. The vite production build
 * (`npm run build`, neither flag set) compiles both to `false`,
 * dead-code-eliminating the route entry; the bundler then tree-shakes
 * the unreachable shim + fixture-client modules. A normal production
 * bundle ships zero bytes of overflow code.
 *
 * If a future regression compiled this into production, the worst
 * outcome is "navigating to `/dashboard/__overflow/Overview` shows a
 * fixture-seeded Overview" — not a security issue, but visually
 * confusing. The dual gate is the right belt-and-braces.
 *
 * ## Components supported
 *
 * Per Walk A's helper inventory:
 *
 *   - `Overview` — seeds ensembles + hosts + per-ensemble snapshots
 *   - `CreateEnsemble` — seeds lineups + hosts
 *   - `PlayerTypes` — seeds the agent-type catalog
 *
 * Unknown components render an honest error message so the test fails
 * with a useful diagnostic rather than a blank page.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ENSEMBLES_QUERY_KEY,
  HOSTS_QUERY_KEY,
  AGENT_TYPES_QUERY_KEY,
  LINEUPS_QUERY_KEY,
  ensembleQueryKey,
} from '../lib/queries';
import {
  fixtureEnsembleList,
  fixtureEnsembleSnapshot,
  fixtureHosts,
  fixtureLineups,
  fixtureAgentTypes,
  isOverflowRegime,
  type OverflowRegime,
} from '../lib/overflow-fixtures';
import { createOverflowFixtureClient } from '../lib/overflow-fixture-client';
import { __setDashboardClientForTests } from '../lib/client-singleton';
import { Overview } from './Overview';
import { CreateEnsemble } from './CreateEnsemble';
import { PlayerTypes } from './PlayerTypes';

/** Components the shim knows how to render. Add new entries here as Walk A grows. */
const KNOWN_COMPONENTS = {
  Overview,
  CreateEnsemble,
  PlayerTypes,
} as const;

type KnownComponent = keyof typeof KNOWN_COMPONENTS;

function isKnownComponent(s: string | undefined): s is KnownComponent {
  return s !== undefined && s in KNOWN_COMPONENTS;
}

/**
 * Route element registered at `/__overflow/:component`. Installs a
 * regime-keyed fixture client, pre-warms the TanStack Query cache so
 * the very first render doesn't flash a loading state, then renders
 * the target screen.
 *
 * The `installed` boolean defers the screen render until AFTER the
 * client singleton has been swapped. Otherwise the target hook's
 * first `useQuery` could fire its fetcher against whatever production
 * singleton existed at module load — usually fine, but on a developer's
 * laptop with a live daemon it'd race the swap. `useEffect` +
 * `setState` reliably runs in two paint passes: paint 1 swaps the
 * client + seeds the cache, paint 2 renders the target. The cost is
 * one extra render that displays nothing (~ms), well within
 * Playwright's default 10s `waitForSelector` budget.
 *
 * **Cleanup**: the `useEffect` returns a teardown that restores the
 * production singleton on unmount (`__setDashboardClientForTests(null)`).
 * That matters when a test navigates from `/__overflow/...` to another
 * route mid-page — subsequent renders fall back to the real client.
 * In practice Playwright tears the page down between tests so the
 * teardown is belt-and-braces.
 */
export function OverflowShim() {
  const { component } = useParams<{ component: string }>();
  const [searchParams] = useSearchParams();
  const regimeParam = searchParams.get('regime');
  const regime: OverflowRegime = isOverflowRegime(regimeParam) ? regimeParam : 'short';

  const qc = useQueryClient();
  const [installed, setInstalled] = useState(false);

  const ensembles = useMemo(() => fixtureEnsembleList(regime), [regime]);
  const hosts = useMemo(() => fixtureHosts(regime), [regime]);
  const lineups = useMemo(() => fixtureLineups(regime), [regime]);
  const agentTypes = useMemo(() => fixtureAgentTypes(regime), [regime]);

  useEffect(() => {
    // 1. Swap the singleton client so every fetch (initial + refetch
    //    + SSE) returns the fixture. ADR 0006: the `__` prefix marks
    //    this as a test escape hatch — appropriate here because the
    //    route shim is itself dev-only test infrastructure, never
    //    reachable from a production bundle (see route gate in
    //    `router.tsx`).
    const fixtureClient = createOverflowFixtureClient(regime);
    __setDashboardClientForTests(fixtureClient);

    // 2. Pre-warm the cache so the target screen's first paint already
    //    has data — avoids a one-tick loading flash that some Walk A
    //    selectors don't tolerate (10s waitForSelector budget covers
    //    it, but pre-warming removes a subtle source of test latency).
    qc.setQueryData(ENSEMBLES_QUERY_KEY, ensembles);
    qc.setQueryData(HOSTS_QUERY_KEY, hosts);
    qc.setQueryData(LINEUPS_QUERY_KEY, lineups);
    qc.setQueryData(AGENT_TYPES_QUERY_KEY, agentTypes);
    for (const e of ensembles) {
      qc.setQueryData(ensembleQueryKey(e.name), fixtureEnsembleSnapshot(regime, e.name));
    }
    setInstalled(true);

    return () => {
      __setDashboardClientForTests(null);
    };
  }, [qc, regime, ensembles, hosts, lineups, agentTypes]);

  if (!isKnownComponent(component)) {
    return (
      <div
        data-testid="overflow-shim-error"
        role="alert"
        style={{ padding: 24, fontFamily: 'monospace' }}
      >
        Unknown overflow component: <code>{component ?? '(missing)'}</code>.
        <br />
        Known components:{' '}
        <code>{Object.keys(KNOWN_COMPONENTS).join(', ')}</code>
      </div>
    );
  }

  if (!installed) {
    // First paint — client not yet swapped. Render a hidden sentinel
    // with a stable `data-testid` so any accidentally-loaded test
    // has a marker to wait on without confusing the production
    // selectors.
    return <div data-testid="overflow-shim-seeding" style={{ display: 'none' }} />;
  }

  const Component = KNOWN_COMPONENTS[component];
  return <Component />;
}
