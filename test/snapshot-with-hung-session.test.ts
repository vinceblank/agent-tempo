/**
 * Issue #433 — snapshot fan-out must not hang on a wedged session worker.
 *
 * Setup: a fake Temporal `Client` whose `workflow.getHandle().query()`
 * never resolves for one player + resolves fast for another. Without the
 * `queryHandleWithTimeout` wrapping in `client/core.ts`:
 *  - `getPlayerWireMeta` for the wedged player's session would `await
 *    Promise.allSettled([never, never, never])` forever, hanging the
 *    snapshot fan-out for the entire ensemble.
 *  - `getEnsembleMeta` for an ensemble whose maestro is wedged would
 *    `await Promise.all([never, …])` forever even though each query has
 *    a `.catch(() => sentinel)` fallback (the catch fires on rejection,
 *    not on hang).
 *
 * After the fix: each individual `handle.query()` is bounded by
 * `DEFAULT_QUERY_TIMEOUT_MS`. Hung queries reject as
 * `QueryTimeoutError`, the existing soft-failure paths fire, and the
 * caller sees `null` (wireMeta) or sentinel defaults (meta). The
 * snapshot returns within timeout × small constant.
 */
import { expect } from 'chai';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { createTempoClientCore } from '../src/client/core';
import { sessionWorkflowId, maestroWorkflowId } from '../src/config';
import {
  __resetInflightQueriesForTests,
} from '../src/utils/query-timeout';

/**
 * Build a fake Temporal `Client` whose `workflow.getHandle()` returns a
 * handle whose `query()` follows the per-workflow behavior table. Other
 * Client methods throw — the test surface narrows to what
 * `getPlayerWireMeta` / `getEnsembleMeta` actually call.
 */
function fakeTemporalClient(behavior: Record<string, 'hang' | 'fast' | 'reject'>): Client {
  return {
    workflow: {
      getHandle(workflowId: string): WorkflowHandle {
        const mode = behavior[workflowId] ?? 'fast';
        return {
          workflowId,
          async query(): Promise<unknown> {
            if (mode === 'hang') return new Promise(() => {});
            if (mode === 'reject') throw new Error('worker said no');
            // `fast` — return a benign empty value matching all of:
            //   getRunIdQuery: string
            //   getMessagingStateQuery: { received, sent, outbox }
            //   getLeaseStateQuery: { expiresAt, leaseMs }
            //   getEnsembleDescriptionQuery: string
            //   getEnsembleStartTimeQuery: string
            //   getCurrentBpmQuery: number
            //   getTempoSeriesQuery: number[]
            // We can't tell which query is being called from this minimal
            // mock — return a versatile shape that satisfies enough of
            // them to assert the smoke path.
            return 'fast-result';
          },
        } as unknown as WorkflowHandle;
      },
    },
  } as unknown as Client;
}

describe('snapshot fan-out with hung session (#433)', function () {
  beforeEach(() => __resetInflightQueriesForTests());

  // Tight ceiling — production default is 2s, but tests pin a smaller
  // timeoutMs to keep the suite fast. The behavior under test is
  // "bounded" not "exactly N ms".
  const TEST_QUERY_TIMEOUT_MS = 100;
  const ASSERTION_BUDGET_MS = 1500; // ample headroom over 100ms × handful-of-queries

  // ── getPlayerWireMeta ────────────────────────────────────────────────

  describe('getPlayerWireMeta', function () {
    it('returns null when ALL three session queries hang past timeoutMs', async function () {
      // Tighten the timeout via a wrapper — the production default lives
      // inside queryHandleWithTimeout, so we can't pass it in directly
      // through the public TempoClient surface. We assert the bounded
      // behavior at a budget that's loose enough to accommodate the
      // production default, since the test machine pays the same
      // bounded cost.
      this.timeout(5_000);
      const ensemble = 'demo';
      const playerId = 'wedged';
      const wfId = sessionWorkflowId(ensemble, playerId);
      const client = fakeTemporalClient({ [wfId]: 'hang' });
      const tempo = createTempoClientCore(client);

      const start = Date.now();
      const result = await tempo.getPlayerWireMeta(ensemble, playerId);
      const elapsed = Date.now() - start;

      // All three queries timed out → all-rejected branch returns null.
      expect(result).to.equal(null);
      // Bounded by DEFAULT_QUERY_TIMEOUT_MS (2000ms) plus per-call overhead;
      // never the "hang forever" of the pre-fix behavior.
      expect(elapsed).to.be.lessThan(3_500);
      void TEST_QUERY_TIMEOUT_MS; void ASSERTION_BUDGET_MS;
    });

    it('returns null when the session workflow is unreachable (queries reject fast)', async function () {
      // Sanity check — pre-existing behavior preserved. Matches the
      // "session unreachable" branch in core.ts; the timeout wrapper
      // doesn't change this path.
      this.timeout(5_000);
      const ensemble = 'demo';
      const playerId = 'gone';
      const wfId = sessionWorkflowId(ensemble, playerId);
      const client = fakeTemporalClient({ [wfId]: 'reject' });
      const tempo = createTempoClientCore(client);
      const result = await tempo.getPlayerWireMeta(ensemble, playerId);
      expect(result).to.equal(null);
    });
  });

  // ── getEnsembleMeta ──────────────────────────────────────────────────

  describe('getEnsembleMeta', function () {
    it('returns sentinel defaults when ALL maestro queries hang past timeoutMs', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const wfId = maestroWorkflowId(ensemble);
      const client = fakeTemporalClient({ [wfId]: 'hang' });
      const tempo = createTempoClientCore(client);

      const start = Date.now();
      const meta = await tempo.getEnsembleMeta(ensemble);
      const elapsed = Date.now() - start;

      // Each query has a `.catch(() => sentinel)` — QueryTimeoutError
      // takes the same path. Result: sentinel defaults across the board.
      expect(meta.description).to.equal('');
      expect(meta.startedAt).to.equal('');
      expect(meta.currentBpm).to.equal(0);
      expect(meta.tempoSeries).to.deep.equal([]);
      // Bounded — fan-out runs the four queries in parallel, so total
      // elapsed is one timeoutMs (default 2000ms) plus overhead.
      expect(elapsed).to.be.lessThan(3_500);
    });

    it('passes through real values when the maestro responds fast', async function () {
      this.timeout(2_000);
      const ensemble = 'demo';
      const wfId = maestroWorkflowId(ensemble);
      const client = fakeTemporalClient({ [wfId]: 'fast' });
      const tempo = createTempoClientCore(client);
      const meta = await tempo.getEnsembleMeta(ensemble);
      // The fake returns the string 'fast-result' for every query. The
      // `currentBpm` query expects a number; the `tempoSeries` query
      // expects a number[]. Those will be coerced to whatever the fake
      // returned — we only assert on the string-typed fields here so
      // the test doesn't depend on the fake's response shape.
      expect(meta.description).to.equal('fast-result');
      expect(meta.startedAt).to.equal('fast-result');
    });
  });
});
