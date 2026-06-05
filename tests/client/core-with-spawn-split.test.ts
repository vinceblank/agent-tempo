/**
 * #308 follow-up — shape boundary tests for the `TempoClientCore` /
 * `TempoClientWithSpawn` split (ADR 0007).
 *
 * The split is the type system's enforcement layer for headless safety:
 * the daemon, MCP tools, and the SSE event source consume `Core`, while
 * only the TUI (and `ensure-conductor-spawned`) opts into `WithSpawn`.
 * These tests pin three invariants:
 *
 *   1. `createTempoClientCore` returns an object that does NOT carry
 *      `createEnsemble` or `spawnConductor` — a future maintainer can't
 *      accidentally smuggle a spawn into Core without breaking this.
 *   2. `createTempoClientCore` exposes every method documented as Core in
 *      `docs/design/tempoclient-core-spawn-split.md` §2.1.
 *   3. `createTempoClient` (the back-compat alias) keeps the WithSpawn
 *      shape — every existing import continues to compile and runtime-call
 *      the spawn methods.
 *
 * The CORE_METHOD_NAMES list doubles as a drift detector: adding a Core
 * method requires updating it; removing one fails the test.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from '@temporalio/client';
import {
  createTempoClient,
  createTempoClientCore,
  createTempoClientWithSpawn,
} from '../../src/client';

/**
 * Catalog from `docs/design/tempoclient-core-spawn-split.md` §2.1.
 * Order is irrelevant; presence is what matters.
 */
const CORE_METHOD_NAMES = [
  // Discovery
  'discoverEnsembles',
  'listEnsembles',
  'listEnsemblesBounded', // #336/#529 site 6 — bounded variant for AggregateRunner
  'listHosts',
  'listAllOrphans', // #579 — cluster-wide orphan listing for the dashboard's /orphans view
  'hasGlobalMaestro',
  'isConnected',
  // Per-ensemble reads
  'getPlayers',
  'getEnsembleMeta', // Issue #399 W1 — description / startedAt / currentBpm / tempoSeries fan-out
  'getMessages',
  'getConductorHistory',
  'getEnsembleChat',
  'getSchedules',
  'getGates',
  'getStages',
  'getWorktrees',
  'isMaestroPaused',
  'isAnySessionHeld',
  // Per-player reads
  'getPlayerMessages',
  'getPlayerMetadata',
  'getPlayerWireMeta', // Issue #399 W2 — runId / messaging / lease fan-out
  'attachmentInfo',
  'recall',
  // Outbox-routed mutations
  'recruit',
  'release',
  'restart',
  'reset', // H5b/#645 — D14 clean-wipe via maestro outbox (HTTP-route counterpart of the `reset` MCP tool)
  'detach',
  'destroy',
  'migrate',
  // Ensemble-scope coordination
  'pause',
  'play',
  'shutdown',
  'restore',
  'disbandEnsemble',
  // Direct workflow signals
  'sendCommand',
  'sendMessage',
  'terminatePlayer',
  'cancelSchedule',
  // Maestro session helpers
  'ensureMaestroSession',
  'sendAsMaestro',
  'getMaestroMessages',
  // SSE event-source subscription (PR-3 of #94/#95) — pure RPC, headless-safe
  'subscribe',
] as const;

const SPAWN_METHOD_NAMES = ['createEnsemble', 'spawnConductor'] as const;

// A bare Temporal Client cast is fine here — we never invoke any method,
// only inspect the returned object's shape. `createTempoClientCore`
// captures `client` in its closure but doesn't touch it during
// construction.
const FAKE_CLIENT = {} as Client;

describe('TempoClient surface boundary (#308 follow-up — ADR 0007)', () => {
  describe('createTempoClientCore', () => {
    it('does NOT expose createEnsemble or spawnConductor', () => {
      const core = createTempoClientCore(FAKE_CLIENT);
      for (const name of SPAWN_METHOD_NAMES) {
        expect(
          (core as Record<string, unknown>)[name],
          `Core must not expose ${name}`,
        ).toBeUndefined();
      }
    });

    it('DOES expose every method documented as Core in §2.1 of the design doc', () => {
      const core = createTempoClientCore(FAKE_CLIENT);
      for (const name of CORE_METHOD_NAMES) {
        expect(
          typeof (core as Record<string, unknown>)[name],
          `Core must expose ${name}`,
        ).toBe('function');
      }
    });

    it('exposes ONLY the documented Core method count (drift detector)', () => {
      const core = createTempoClientCore(FAKE_CLIENT);
      const actualKeys = Object.keys(core).sort();
      const expectedKeys = [...CORE_METHOD_NAMES].sort();
      expect(actualKeys).to.deep.equal(expectedKeys);
    });
  });

  describe('createTempoClientWithSpawn', () => {
    it('exposes every Core method PLUS the two spawn methods', () => {
      const withSpawn = createTempoClientWithSpawn(FAKE_CLIENT);
      for (const name of [...CORE_METHOD_NAMES, ...SPAWN_METHOD_NAMES]) {
        expect(
          typeof (withSpawn as Record<string, unknown>)[name],
          `WithSpawn must expose ${name}`,
        ).toBe('function');
      }
    });
  });

  describe('createTempoClient (back-compat alias)', () => {
    it('returns the WithSpawn shape — preserves every existing call site', () => {
      const tempo = createTempoClient(FAKE_CLIENT);
      // Spawn methods must be callable surface, even if we never invoke them.
      for (const name of SPAWN_METHOD_NAMES) {
        expect(
          typeof (tempo as Record<string, unknown>)[name],
          `createTempoClient must expose ${name} for back-compat`,
        ).toBe('function');
      }
    });
  });
});
