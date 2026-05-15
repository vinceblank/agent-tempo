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

  // ── isMaestroPaused ──────────────────────────────────────────────────

  describe('isMaestroPaused', function () {
    it('returns false when the maestro paused-query hangs past timeoutMs', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const wfId = maestroWorkflowId(ensemble);
      const client = fakeTemporalClient({ [wfId]: 'hang' });
      const tempo = createTempoClientCore(client);

      const start = Date.now();
      const paused = await tempo.isMaestroPaused(ensemble);
      const elapsed = Date.now() - start;

      // Bounded by DEFAULT_QUERY_TIMEOUT_MS; existing catch maps any
      // failure (including `QueryTimeoutError`) to `false`.
      expect(paused).to.equal(false);
      expect(elapsed).to.be.lessThan(3_500);
    });
  });

  // ── isAnySessionHeld ─────────────────────────────────────────────────

  describe('isAnySessionHeld', function () {
    /**
     * Per-query-aware fake. Needed for `isAnySessionHeld` because
     * `scanEnsembleSessions` issues `getMetadata`/`getPart` against each
     * session before the call site we're testing reaches `outboxLockedQuery`.
     * If those metadata queries hang, the scan stalls before
     * `isAnySessionHeld` ever gets to the wrapped query — masking the
     * fix under test.
     */
    function fakePerQueryClient(opts: {
      sessions: Array<{ workflowId: string; ensemble: string; playerId: string; outboxBehavior: 'hang' | 'fast-locked' | 'fast-unlocked' }>;
    }): Client {
      return {
        workflow: {
          getHandle(workflowId: string): WorkflowHandle {
            const session = opts.sessions.find((s) => s.workflowId === workflowId);
            return {
              workflowId,
              async query(def: unknown): Promise<unknown> {
                const name = typeof def === 'string' ? def : (def as { name: string }).name;
                if (!session) throw new Error(`unknown workflow: ${workflowId}`);

                // Fast metadata so `scanEnsembleSessions` can build the row.
                if (name === 'getMetadata') {
                  return {
                    ensemble: session.ensemble,
                    playerId: session.playerId,
                    hostname: 'h',
                    workDir: '/r',
                    isConductor: false,
                    agentType: 'claude',
                  };
                }
                if (name === 'getPart') return '';
                // Skip the optional W2 activity query — `scanEnsembleSessions`
                // tolerates rejection so this contributes no rows to test.
                if (name === 'getActivityState') throw new Error('not supported');

                // The query the fix bounds.
                if (name === 'outboxLocked') {
                  if (session.outboxBehavior === 'hang') return new Promise(() => {});
                  return session.outboxBehavior === 'fast-locked';
                }
                throw new Error(`unhandled query: ${name}`);
              },
            } as unknown as WorkflowHandle;
          },
          async *list() {
            for (const s of opts.sessions) {
              yield {
                workflowId: s.workflowId,
                searchAttributes: {},
              };
            }
          },
        },
      } as unknown as Client;
    }

    it('returns false within bounded time when one session\'s outboxLocked query hangs', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const client = fakePerQueryClient({
        sessions: [
          {
            workflowId: sessionWorkflowId(ensemble, 'wedged'),
            ensemble,
            playerId: 'wedged',
            outboxBehavior: 'hang',
          },
        ],
      });
      const tempo = createTempoClientCore(client);

      const start = Date.now();
      const held = await tempo.isAnySessionHeld(ensemble);
      const elapsed = Date.now() - start;

      // Inner catch maps the per-session timeout to "skip"; outer return
      // is `false` since no session reported locked.
      expect(held).to.equal(false);
      expect(elapsed).to.be.lessThan(3_500);
    });

    it('a hung session does not block detection of a healthy held session that scans first', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const client = fakePerQueryClient({
        sessions: [
          {
            workflowId: sessionWorkflowId(ensemble, 'healthy-held'),
            ensemble,
            playerId: 'healthy-held',
            outboxBehavior: 'fast-locked',
          },
          {
            workflowId: sessionWorkflowId(ensemble, 'wedged'),
            ensemble,
            playerId: 'wedged',
            outboxBehavior: 'hang',
          },
        ],
      });
      const tempo = createTempoClientCore(client);
      const held = await tempo.isAnySessionHeld(ensemble);
      // Healthy held session is found in the first iteration → early return.
      expect(held).to.equal(true);
    });
  });

  // ── getPlayers (#433 wider audit) ────────────────────────────────────

  describe('getPlayers', function () {
    /**
     * `getPlayers` has 3 strategies. Strategy 1 hits the global maestro;
     * if that throws/times-out, Strategy 2 hits the per-ensemble maestro.
     * Tests that a hung global maestro doesn't block fall-through to
     * Strategy 2 — which is the behavior the snapshot fan-out depends on.
     */
    function fakePerWorkflowClient(behavior: Record<string, 'hang' | 'fast-empty'>): Client {
      return {
        workflow: {
          getHandle(workflowId: string): WorkflowHandle {
            const mode = behavior[workflowId] ?? 'fast-empty';
            return {
              workflowId,
              async query(def: unknown): Promise<unknown> {
                if (mode === 'hang') return new Promise(() => {});
                const name = typeof def === 'string' ? def : (def as { name: string }).name;
                if (name === 'maestroPlayersByEnsemble') return {};
                if (name === 'maestroPlayers') return [];
                throw new Error(`unhandled query: ${name}`);
              },
            } as unknown as WorkflowHandle;
          },
          async *list() {/* not used */},
        },
      } as unknown as Client;
    }

    it('Strategy 1 hung global maestro falls through to Strategy 2 within bounded time', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const client = fakePerWorkflowClient({
        'agent-maestro-global': 'hang',
        [maestroWorkflowId(ensemble)]: 'fast-empty',
      });
      const tempo = createTempoClientCore(client);
      const start = Date.now();
      const players = await tempo.getPlayers(ensemble);
      const elapsed = Date.now() - start;

      // Strategy 1 timed out (catch fired), Strategy 2 returned [].
      expect(players).to.deep.equal([]);
      expect(elapsed).to.be.lessThan(3_500);
    });
  });

  // ── getEnsembleChat (#433 wider audit) ──────────────────────────────

  describe('getEnsembleChat', function () {
    it('returns empty within bounded time when maestro chat query hangs', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      const wfId = maestroWorkflowId(ensemble);
      const client = fakeTemporalClient({ [wfId]: 'hang' });
      const tempo = createTempoClientCore(client);
      const start = Date.now();
      const chat = await tempo.getEnsembleChat(ensemble, 0, 50);
      const elapsed = Date.now() - start;

      // Existing catch maps any failure (incl. QueryTimeoutError) to
      // the empty-chat sentinel.
      expect(chat).to.deep.equal({ messages: [], total: 0, hasMore: false, hasConductor: false });
      expect(elapsed).to.be.lessThan(3_500);
    });
  });

  // ── getSchedules (#433 wider audit) ─────────────────────────────────

  describe('getSchedules', function () {
    it('returns empty within bounded time when scheduler query hangs', async function () {
      this.timeout(5_000);
      const ensemble = 'demo';
      // `getSchedules` queries `agent-scheduler-{ensemble}` not the maestro.
      const wfId = `agent-scheduler-${ensemble}`;
      const client = fakeTemporalClient({ [wfId]: 'hang' });
      const tempo = createTempoClientCore(client);
      const start = Date.now();
      const schedules = await tempo.getSchedules(ensemble);
      const elapsed = Date.now() - start;

      expect(schedules).to.deep.equal([]);
      expect(elapsed).to.be.lessThan(3_500);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// scanEnsembleSessions (#433 wider audit) — chain-bounded proof
// ────────────────────────────────────────────────────────────────────────

import { scanEnsembleSessions } from '../src/activities/resolve';

describe('scanEnsembleSessions chain-bounded (#433)', function () {
  beforeEach(() => __resetInflightQueriesForTests());

  /**
   * Two sessions in the ensemble: one healthy (returns metadata fast),
   * one wedged (`getMetadata` hangs forever). Without timeout-bounding,
   * `scanEnsembleSessions` would `await handle.query('getMetadata')` on
   * the wedged session and stall the whole scan — every downstream
   * caller (`isAnySessionHeld`, `release`, ensemble MCP tool, maestro
   * refresh activity) would inherit the hang.
   */
  function fakeClient(sessions: Array<{
    workflowId: string;
    ensemble: string;
    playerId: string;
    metadataMode: 'hang' | 'fast';
  }>): Client {
    return {
      workflow: {
        getHandle(workflowId: string): WorkflowHandle {
          const session = sessions.find((s) => s.workflowId === workflowId);
          return {
            workflowId,
            async query(def: unknown): Promise<unknown> {
              const name = typeof def === 'string' ? def : (def as { name: string }).name;
              if (!session) throw new Error(`unknown workflow: ${workflowId}`);
              if (session.metadataMode === 'hang' && name === 'getMetadata') {
                return new Promise(() => {});
              }
              if (name === 'getMetadata') {
                return {
                  ensemble: session.ensemble,
                  playerId: session.playerId,
                  hostname: 'h',
                  workDir: '/r',
                  isConductor: false,
                  agentType: 'claude',
                };
              }
              if (name === 'getPart') return '';
              // `getActivityState` is W2; throw → scanner contributes the
              // row without activity counters (existing behavior).
              if (name === 'getActivityState') throw new Error('not supported');
              throw new Error(`unhandled query: ${name}`);
            },
          } as unknown as WorkflowHandle;
        },
        async *list() {
          for (const s of sessions) {
            yield { workflowId: s.workflowId, searchAttributes: {} };
          }
        },
      },
    } as unknown as Client;
  }

  it('skips a hung session within bounded time and continues scan', async function () {
    this.timeout(5_000);
    const ensemble = 'demo';
    const client = fakeClient([
      {
        workflowId: sessionWorkflowId(ensemble, 'wedged'),
        ensemble,
        playerId: 'wedged',
        metadataMode: 'hang',
      },
      {
        workflowId: sessionWorkflowId(ensemble, 'healthy'),
        ensemble,
        playerId: 'healthy',
        metadataMode: 'fast',
      },
    ]);

    const start = Date.now();
    const sessions = await scanEnsembleSessions(client, ensemble);
    const elapsed = Date.now() - start;

    // Healthy session contributes a row; wedged session is skipped.
    expect(sessions).to.have.length(1);
    expect(sessions[0].playerId).to.equal('healthy');
    // Bounded by DEFAULT_QUERY_TIMEOUT_MS for the wedged-session
    // metadata query — proves the SCAN itself is bounded, not just
    // the downstream `isAnySessionHeld`/`release` per-session loop.
    expect(elapsed).to.be.lessThan(3_500);
  });
});
