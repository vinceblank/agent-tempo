/**
 * Fixture-only `DashboardTempoClient` — the data backend behind the
 * `/__overflow/<Component>` route shim (#492).
 *
 * The shim installs this client via `__setDashboardClientForTests`
 * (ADR 0006 test escape hatch — used here because the shim itself is
 * dev/overflow-build-only test infrastructure; the production bundle
 * never reaches this code) BEFORE rendering the target screen.
 * Components fetch via the singleton, hit this client, and get the
 * regime-keyed fixture data back without any `/v1/*` network call.
 *
 * Why a full client replacement instead of `queryClient.setQueryData`:
 *
 *   The default TanStack Query config in `lib/queries.ts` sets
 *   `staleTime: 5_000` + `refetchInterval: 30_000` on every catalog
 *   query, AND `refetchOnWindowFocus: true`. Pre-seeding via
 *   `setQueryData` works for the initial render but gets clobbered
 *   when the query refetches against the singleton client — which
 *   on a developer's laptop with a live daemon at `127.0.0.1:8473`
 *   yields a different ensemble list than the regime's fixture
 *   intends. The Walk A overflow refutation tests are sensitive
 *   to baseline data shape (multi-ensemble seeds trigger narrow-
 *   viewport pill/action overlap that the audit refuted under
 *   single-ensemble walker conditions). Replacing the client
 *   ensures every refetch returns the fixture, full stop.
 *
 * SSE subscribe returns a never-yielding async iterable — the
 * `useSseSubscription` hook starts iterating it but never receives
 * an event, so the cache stays at the fixture value. The hook also
 * tolerates `signal.abort` cleanly, so unmounting doesn't leak.
 */
import type {
  DashboardTempoClient,
  EnsembleStateV1,
  HealthV1,
} from './client';
import type { TempoEvent, SubscribeOptions } from 'agent-tempo/http/event-types';
import {
  fixtureAgentTypes,
  fixtureEnsembleList,
  fixtureEnsembleSnapshot,
  fixtureHosts,
  fixtureLineups,
  type OverflowRegime,
} from './overflow-fixtures';

/**
 * Build a `DashboardTempoClient` whose every method returns
 * regime-keyed fixture data. Mutation endpoints (`cue`, `recruit`, …)
 * resolve to plausible "happy-path" results so the create-ensemble
 * wizard's submit-but-disabled state doesn't blow up if the test
 * accidentally clicks through.
 */
export function createOverflowFixtureClient(regime: OverflowRegime): DashboardTempoClient {
  const ensembles = fixtureEnsembleList(regime);
  const hosts = fixtureHosts(regime);
  const lineups = fixtureLineups(regime);
  const agentTypes = fixtureAgentTypes(regime);
  const snapshotByName = new Map<string, EnsembleStateV1>(
    ensembles.map((e) => [e.name, fixtureEnsembleSnapshot(regime, e.name)]),
  );

  const health: HealthV1 = {
    ok: true,
    namespace: 'default',
    taskQueue: 'agent-tempo-overflow',
    version: '0.0.0-overflow',
    uptimeMs: 60_000,
    ensembleCount: ensembles.length,
    subscriberCount: 0,
  };

  return {
    async health() { return health; },
    async listEnsembles() { return ensembles; },
    async state(ensemble: string) {
      const snap = snapshotByName.get(ensemble);
      if (snap) return snap;
      // Synthesize a fresh snapshot for any ensemble name the fixture
      // didn't pre-build — keeps the shim forgiving when a test
      // navigates to an ensemble it injected via URL alone.
      return fixtureEnsembleSnapshot(regime, ensemble);
    },
    async hosts() { return hosts; },
    async agentTypes() { return agentTypes; },
    async lineups() { return lineups; },
    subscribe(_ensemble: string, opts: SubscribeOptions = {}): AsyncIterable<TempoEvent> {
      // Never-yielding async iterable. The consumer (`useSseSubscription`)
      // awaits the next event indefinitely; when the route unmounts the
      // controller aborts the signal, the iterator's `next()` rejects,
      // and the catch in the hook logs `sse.disconnected` and returns.
      //
      // The rejection follows the WHATWG AbortController convention
      // (`error.name === 'AbortError'`) without referencing the
      // `DOMException` global directly — that global isn't in the
      // ESLint `env: browser` allowlist this repo uses, and the only
      // consumer (`useSseSubscription`) reads `err.message` not the
      // constructor identity, so a plain `Error` shaped like an
      // AbortError is functionally identical.
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<TempoEvent>> {
              return new Promise((_resolve, reject) => {
                const rejectAbort = (): void => {
                  const err = new Error('Aborted');
                  err.name = 'AbortError';
                  reject(err);
                };
                if (opts.signal) {
                  if (opts.signal.aborted) {
                    rejectAbort();
                    return;
                  }
                  opts.signal.addEventListener('abort', rejectAbort);
                }
                // Otherwise, never resolves. The shim's lifetime is
                // bounded by the test's page lifetime; Playwright tears
                // the page down at end-of-test which surfaces here as a
                // dropped promise — fine because nothing observes it.
              });
            },
          };
        },
      };
    },

    // ── Mutations — plausible happy-path returns ──
    async cue(ensemble, to) {
      return { ok: true as const, ensemble, to };
    },
    async pause() { /* no-op */ },
    async play() { /* no-op */ },
    async release() {
      return { released: [], errors: [] };
    },
    async recruit(_ensemble, opts) {
      return { playerId: opts.name, entryId: 'overflow-entry-1' };
    },
    async createEnsemble(opts) {
      return {
        ensemble: opts.name,
        lineup: opts.lineup ?? null,
        recruitedPlayers: 0,
        playerErrors: [],
      };
    },
    async restart(_ensemble, opts) {
      return { ok: true as const, playerId: opts.playerId };
    },
    async destroy(_ensemble, opts) {
      return { ok: true as const, playerId: opts.playerId };
    },
    async detach(_ensemble, opts) {
      return { ok: true as const, playerId: opts.playerId };
    },
    async recall(_ensemble, opts) {
      return { ok: true as const, playerId: opts.playerId, messages: 0 };
    },
  };
}
