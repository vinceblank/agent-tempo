/**
 * Unit coverage for the snapshot projection — Issue #399 DB1a.
 *
 * Two surfaces under test:
 *
 *   1. **`toPlayerSummaryV1(p, wireMeta)`** — drops MaestroPlayerInfo
 *      fields not part of the v1 wire contract, passes through
 *      `activityCount` / `lastActivityAt` (Q5.6), and conditionally
 *      merges `runId` / `messaging` / `lease` from the wire-meta
 *      fan-out (Q5.2 / Q5.5 / Q5.7). When `wireMeta` is `null` the
 *      projection emits no wire-meta fields — the dashboard renders
 *      `—` placeholders.
 *
 *   2. **`buildEnsembleSnapshot(client, ensemble)`** — composes the
 *      TempoClient fan-out into an `EnsembleStateV1`. Verified with a
 *      hand-rolled mock TempoClient (no Temporal). Asserts:
 *      - `description` / `startedAt` / `currentBpm` / `tempoSeries`
 *        come straight from `client.getEnsembleMeta` (W1)
 *      - per-player `runId` / `messaging` / `lease` are merged from
 *        `client.getPlayerWireMeta` (W2)
 *      - per-player `activityCount` passes through from
 *        `MaestroPlayerInfo`; `lastActivityAt` projects to the wire-
 *        contract `lastHeartbeatAt` field (#389 R3.P1.4)
 *      - sentinel fallbacks when individual fan-out branches reject
 *      - `EnsembleNotFoundError` thrown when the ensemble isn't in
 *        `listEnsembles`
 */
import { expect } from 'chai';
import type { TempoClient } from '../src/client/interface';
import type { MaestroPlayerInfo, HostProfile } from '../src/types';
import {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
  toPlayerSummaryV1,
  type PlayerWireMeta,
} from '../src/http/snapshot';

// ────────────────────────────────────────────────────────────────────────
// toPlayerSummaryV1 projection
// ────────────────────────────────────────────────────────────────────────

describe('toPlayerSummaryV1 projection (#399 W2 + Q5.6)', function () {
  const baseInfo: MaestroPlayerInfo = {
    playerId: 'tempo-eng',
    ensemble: 'demo',
    hostname: 'studio.local',
    isConductor: false,
    agentType: 'claude',
    playerType: 'my-tempo-engineer',
    phase: 'attached',
    part: 'wiring up the snapshot',
    workDir: '/repos/claude-tempo',
    gitBranch: 'feat/snapshot-wire-extension-projection',
  };

  it('passes activityCount through and projects lastActivityAt → lastHeartbeatAt (Q5.6 + #389 R3.P1.4)', function () {
    const out = toPlayerSummaryV1({
      ...baseInfo,
      activityCount: 42,
      lastActivityAt: '2026-04-28T12:30:00.000Z',
    });
    expect(out.activityCount).to.equal(42);
    // The wire-contract field is `lastHeartbeatAt`; the source field on
    // `MaestroPlayerInfo` is `lastActivityAt`. The mapper renames at the
    // wire boundary so the dashboard's `heartbeat` KvRow + aggregate
    // diff both find the field under one canonical name (#389 R3.P1.4).
    expect(out.lastHeartbeatAt).to.equal('2026-04-28T12:30:00.000Z');
    expect(out).to.not.have.property('lastActivityAt');
  });

  it('omits activityCount + lastHeartbeatAt when absent on input', function () {
    const out = toPlayerSummaryV1(baseInfo);
    expect(out).to.not.have.property('activityCount');
    expect(out).to.not.have.property('lastHeartbeatAt');
    expect(out).to.not.have.property('lastActivityAt');
  });

  it('merges runId / messaging / lease from wireMeta when supplied', function () {
    const wireMeta: PlayerWireMeta = {
      runId: 'abc123-def456-7890',
      messaging: { received: 12, sent: 7, outbox: '2 pending' },
      lease: { expiresAt: 1735000000000, leaseMs: 60000 },
    };
    const out = toPlayerSummaryV1(baseInfo, wireMeta);
    expect(out.runId).to.equal('abc123-def456-7890');
    expect(out.messaging).to.deep.equal({ received: 12, sent: 7, outbox: '2 pending' });
    expect(out.lease).to.deep.equal({ expiresAt: 1735000000000, leaseMs: 60000 });
  });

  it('omits all wireMeta fields when wireMeta is null (session unreachable)', function () {
    const out = toPlayerSummaryV1(baseInfo, null);
    expect(out).to.not.have.property('runId');
    expect(out).to.not.have.property('messaging');
    expect(out).to.not.have.property('lease');
  });

  it('partial wireMeta — missing keys stay absent on the projection', function () {
    const out = toPlayerSummaryV1(baseInfo, { runId: 'r1' });
    expect(out.runId).to.equal('r1');
    expect(out).to.not.have.property('messaging');
    expect(out).to.not.have.property('lease');
  });

  it('preserves agentType="mock" through the projection (#434)', function () {
    // #434 widened the v1 wire union from `'claude' | 'copilot'` to
    // `'claude' | 'copilot' | 'mock'`. The dashboard's PlayerDetail now
    // shows `adapter: mock` for mock players instead of the misleading
    // `claude-code` coercion the closed union forced.
    const out = toPlayerSummaryV1({
      ...baseInfo,
      agentType: 'mock',
    });
    expect(out.agentType).to.equal('mock');
  });

  it('preserves agentType="copilot" through the projection', function () {
    const out = toPlayerSummaryV1({ ...baseInfo, agentType: 'copilot' });
    expect(out.agentType).to.equal('copilot');
  });

  it('coerces unknown agentType to claude per v1 contract', function () {
    // The wire union is closed at `'claude' | 'copilot' | 'mock'`. Anything
    // outside that set (e.g. a future `'gemini'` recruited from a forked
    // build connecting to this snapshot) defaults to `'claude'` so the
    // dashboard never sees a value the consumer isn't typed to handle.
    const out = toPlayerSummaryV1({
      ...baseInfo,
      agentType: 'gemini' as unknown as MaestroPlayerInfo['agentType'],
    });
    expect(out.agentType).to.equal('claude');
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildEnsembleSnapshot fan-out
// ────────────────────────────────────────────────────────────────────────

interface MockClientOpts {
  ensembles?: Array<{ name: string; state?: 'online' | 'paused' | 'offline'; hasConductor?: boolean; playerCount?: number }>;
  players?: MaestroPlayerInfo[];
  meta?: { description: string; startedAt: string; currentBpm: number; tempoSeries: number[] } | 'reject';
  wireMetaByPlayer?: Record<string, PlayerWireMeta | null | 'reject'>;
  hosts?: Array<{ hostname: string; profile?: HostProfile }>;
  paused?: boolean;
  held?: boolean;
}

/** Hand-rolled mock TempoClient that satisfies just the methods
 * `buildEnsembleSnapshot` calls. Throws when an unexpected method is
 * accessed so projection-side bugs (calling a method I forgot to mock)
 * surface loudly. */
function mockClient(opts: MockClientOpts): TempoClient {
  const stub = {
    listEnsembles: async () =>
      (opts.ensembles ?? [{ name: 'demo', state: 'online', hasConductor: true, playerCount: 0 }]).map((e) => ({
        name: e.name,
        playerCount: e.playerCount ?? 0,
        hasConductor: e.hasConductor ?? false,
        state: e.state ?? 'online',
      })),
    getPlayers: async () => opts.players ?? [],
    getEnsembleChat: async () => ({ messages: [], total: 0, hasMore: false, hasConductor: false }),
    getSchedules: async () => [],
    isMaestroPaused: async () => opts.paused === true,
    isAnySessionHeld: async () => opts.held === true,
    listHosts: async () => opts.hosts ?? [],
    getEnsembleMeta: async () => {
      if (opts.meta === 'reject') throw new Error('meta unavailable');
      return opts.meta ?? { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] };
    },
    getPlayerWireMeta: async (_e: string, playerId: string) => {
      const v = opts.wireMetaByPlayer?.[playerId];
      if (v === 'reject') throw new Error('session unreachable');
      return v ?? null;
    },
  };
  return new Proxy(stub as unknown as TempoClient, {
    get(target, prop) {
      const v = (target as unknown as Record<string, unknown>)[prop as string];
      if (v !== undefined) return v;
      throw new Error(`unexpected TempoClient method in snapshot test: ${String(prop)}`);
    },
  });
}

describe('buildEnsembleSnapshot fan-out (#399 DB1a)', function () {
  it('throws EnsembleNotFoundError when ensemble is not in listEnsembles', async function () {
    const client = mockClient({ ensembles: [{ name: 'other' }] });
    let threw: unknown;
    try {
      await buildEnsembleSnapshot(client, 'demo');
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(EnsembleNotFoundError);
  });

  it('projects ensemble-meta fields verbatim from getEnsembleMeta (W1)', async function () {
    const client = mockClient({
      meta: {
        description: 'building the v0.27 release',
        startedAt: '2026-04-27T13:30:00.000Z',
        currentBpm: 23,
        tempoSeries: [1, 2, 3, 4, 5],
      },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.description).to.equal('building the v0.27 release');
    expect(snap.startedAt).to.equal('2026-04-27T13:30:00.000Z');
    expect(snap.currentBpm).to.equal(23);
    expect(snap.tempoSeries).to.deep.equal([1, 2, 3, 4, 5]);
  });

  it('falls back to sentinel defaults when getEnsembleMeta rejects (snapshot must not 500)', async function () {
    const client = mockClient({ meta: 'reject' });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.description).to.equal('');
    expect(snap.startedAt).to.equal('');
    expect(snap.currentBpm).to.equal(0);
    expect(snap.tempoSeries).to.deep.equal([]);
  });

  it('merges wireMeta into each player (W2 fan-out)', async function () {
    const players: MaestroPlayerInfo[] = [
      {
        playerId: 'p1',
        ensemble: 'demo',
        hostname: 'h',
        isConductor: false,
        agentType: 'claude',
        part: '',
        workDir: '/r',
        activityCount: 5,
        lastActivityAt: '2026-04-28T12:00:00.000Z',
      },
      {
        playerId: 'p2',
        ensemble: 'demo',
        hostname: 'h',
        isConductor: false,
        agentType: 'claude',
        part: '',
        workDir: '/r',
      },
    ];
    const client = mockClient({
      players,
      wireMetaByPlayer: {
        p1: {
          runId: 'run-p1',
          messaging: { received: 1, sent: 2, outbox: 'empty' },
          lease: { expiresAt: 1, leaseMs: 60000 },
        },
        p2: null, // session unreachable
      },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.players).to.have.length(2);

    // p1 — has wireMeta; activityCount + lastActivityAt source field
    // projects through the mapper as `lastHeartbeatAt` (#389 R3.P1.4).
    expect(snap.players[0].runId).to.equal('run-p1');
    expect(snap.players[0].messaging).to.deep.equal({ received: 1, sent: 2, outbox: 'empty' });
    expect(snap.players[0].lease).to.deep.equal({ expiresAt: 1, leaseMs: 60000 });
    expect(snap.players[0].activityCount).to.equal(5);
    expect(snap.players[0].lastHeartbeatAt).to.equal('2026-04-28T12:00:00.000Z');

    // p2 — wireMeta null → no runId/messaging/lease keys.
    expect(snap.players[1]).to.not.have.property('runId');
    expect(snap.players[1]).to.not.have.property('messaging');
    expect(snap.players[1]).to.not.have.property('lease');
  });

  it('per-player wireMeta rejection is contained — other players still project cleanly', async function () {
    const players: MaestroPlayerInfo[] = [
      { playerId: 'good', ensemble: 'demo', hostname: 'h', isConductor: false, agentType: 'claude', part: '', workDir: '/r' },
      { playerId: 'bad', ensemble: 'demo', hostname: 'h', isConductor: false, agentType: 'claude', part: '', workDir: '/r' },
    ];
    const client = mockClient({
      players,
      wireMetaByPlayer: {
        good: { runId: 'run-good' },
        bad: 'reject',
      },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.players[0].runId).to.equal('run-good');
    expect(snap.players[1]).to.not.have.property('runId');
  });

  it('hostProfiles projects from listHosts when present', async function () {
    const profile: HostProfile = {
      hostname: 'studio.local',
      version: '0.28.0',
      defaultAgent: 'claude',
      daemonStartedAt: 1700000000000,
      adapterVersions: { 'claude-code': '1.2.4' },
    };
    const client = mockClient({
      hosts: [{ hostname: 'studio.local', profile }],
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.hostProfiles).to.have.property('studio.local');
    expect(snap.hostProfiles['studio.local'].daemonStartedAt).to.equal(1700000000000);
    expect(snap.hostProfiles['studio.local'].adapterVersions).to.deep.equal({ 'claude-code': '1.2.4' });
  });
});
