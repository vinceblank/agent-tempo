/**
 * Integration-ish test for PR-E `reconcileOnBoot`.
 *
 * Mocks `Client.workflow.list` + `getHandle().query()` so we can exercise
 * the full restorePolicy decision tree (auto / prompt / never) without a
 * running Temporal server. `TempoClient.restart` is the boundary we care
 * about — we assert when it's called, with what args, and when it's NOT.
 *
 * `createTempoClient` is monkey-patched on the module namespace to return a
 * stub. No sinon dependency.
 */
import { expect } from 'chai';
import * as clientModule from '../src/client';
import { reconcileOnBoot } from '../src/daemon';
import type { DaemonConfig } from '../src/config';
import type { AttachmentInfo, OrphanSummary } from '../src/types';

const asName = (n: unknown) => typeof n === 'string' ? n : (n as any).name;

interface Fixture {
  workflowId: string;
  info: AttachmentInfo;
  summary: OrphanSummary;
  metadata: { ensemble: string; playerId: string };
}

function makeFakeClient(fixtures: Fixture[]): any {
  const byId: Record<string, Fixture> = {};
  for (const f of fixtures) byId[f.workflowId] = f;
  return {
    workflow: {
      getHandle(workflowId: string) {
        const f = byId[workflowId];
        return {
          workflowId,
          async query(name: unknown) {
            const n = asName(name);
            if (n === 'attachmentInfo') return f?.info;
            if (n === 'orphanSummary') return f?.summary;
            if (n === 'getMetadata') return f?.metadata ?? { ensemble: 'unknown', playerId: 'unknown' };
            return undefined;
          },
        };
      },
      async *list() {
        for (const f of fixtures) yield { workflowId: f.workflowId };
      },
    },
  };
}

const HOSTNAME = 'host-1';
const NOW = Date.parse('2026-04-13T12:00:00Z');

function defaults(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    restorePolicy: 'auto',
    autoRestoreMaxAgeHours: 24,
    autoRestoreEnsembles: [],
    cleanupPolicy: { detachedMaxAgeDays: 7, destroyedMaxAgeDays: 30 },
    ...overrides,
  };
}

function fixture(opts: {
  id?: string;
  ensemble: string;
  playerId: string;
  phase?: AttachmentInfo['phase'];
  detachedSince?: string;
  preferredHost?: string;
}): Fixture {
  return {
    workflowId: opts.id ?? `claude-session-${opts.ensemble}-${opts.playerId}`,
    info: {
      phase: opts.phase ?? 'detached',
      inFlightCount: 0,
    },
    summary: {
      ensemble: opts.ensemble,
      playerId: opts.playerId,
      ...(opts.detachedSince !== undefined ? { detachedSince: opts.detachedSince } : {}),
      ...(opts.preferredHost !== undefined ? { preferredHost: opts.preferredHost } : {}),
    },
    metadata: { ensemble: opts.ensemble, playerId: opts.playerId },
  };
}

/**
 * Swap `createTempoClient` on the module namespace for the test scope.
 * Returns a `calls` array that records each `restart()` invocation + a
 * `rejectWith(err)` helper for testing error paths.
 */
function stubTempoClient(): {
  calls: Array<{ ensemble: string; playerId: string; opts: any }>;
  rejectWith(err: Error | null): void;
  restore(): void;
} {
  const calls: Array<{ ensemble: string; playerId: string; opts: any }> = [];
  let rejection: Error | null = null;
  const original = (clientModule as any).createTempoClient;
  (clientModule as any).createTempoClient = () => ({
    restart: async (ensemble: string, playerId: string, opts: any) => {
      calls.push({ ensemble, playerId, opts });
      if (rejection) throw rejection;
      return { playerId, entryId: `entry-${calls.length}` };
    },
  });
  return {
    calls,
    rejectWith(err) { rejection = err; },
    restore() { (clientModule as any).createTempoClient = original; },
  };
}

describe('reconcileOnBoot', function () {
  let stub: ReturnType<typeof stubTempoClient>;

  beforeEach(function () {
    stub = stubTempoClient();
  });

  afterEach(function () {
    stub.restore();
  });

  it('restorePolicy "never" — skips entirely, no restart', async function () {
    const client = makeFakeClient([
      fixture({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 1000).toISOString() }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'never' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(0);
  });

  it('restorePolicy "prompt" — logs orphans, does NOT call restart', async function () {
    const client = makeFakeClient([
      fixture({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 1000).toISOString() }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'prompt' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(0);
  });

  it('restorePolicy "auto" — calls restart on fresh orphan within age window', async function () {
    // Orphan preferredHost matches local: the PR-F cross-host filter is a
    // pass-through, and the normal age-window + ensemble-allowlist +
    // restart enqueue path runs. If preferredHost were elsewhere, the
    // new filter would skip (covered by the cross-host-filter case below).
    const client = makeFakeClient([
      fixture({
        ensemble: 'e1',
        playerId: 'alice',
        detachedSince: new Date(NOW - 60_000).toISOString(),
        preferredHost: HOSTNAME,
      }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(1);
    expect(stub.calls[0].ensemble).to.equal('e1');
    expect(stub.calls[0].playerId).to.equal('alice');
    expect(stub.calls[0].opts.host).to.equal(HOSTNAME);
    expect(stub.calls[0].opts.invokerPlayerId).to.equal('daemon');
  });

  it('restorePolicy "auto" — PR-F cross-host filter skips orphan preferring a remote host', async function () {
    const client = makeFakeClient([
      fixture({
        ensemble: 'e1',
        playerId: 'alice',
        detachedSince: new Date(NOW - 60_000).toISOString(),
        preferredHost: 'host-2', // ← different from HOSTNAME
      }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto' }), HOSTNAME, NOW);
    // Filter fires before any policy logic — restart is never called on
    // this daemon. The remote host's daemon is the authoritative restorer.
    expect(stub.calls).to.have.length(0);
  });

  it('restorePolicy "prompt" — PR-F cross-host filter also applies (no log, no action)', async function () {
    const client = makeFakeClient([
      fixture({
        ensemble: 'e1',
        playerId: 'alice',
        detachedSince: new Date(NOW - 60_000).toISOString(),
        preferredHost: 'host-2',
      }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'prompt' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(0);
  });

  it('restorePolicy "auto" — skips orphan older than autoRestoreMaxAgeHours', async function () {
    const client = makeFakeClient([
      fixture({ ensemble: 'e1', playerId: 'stale', detachedSince: '2020-01-01T00:00:00Z' }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto', autoRestoreMaxAgeHours: 24 }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(0);
  });

  it('restorePolicy "auto" — ensemble allowlist filters non-matching', async function () {
    const client = makeFakeClient([
      fixture({ ensemble: 'my-team', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fixture({ ensemble: 'other-team', playerId: 'bob', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    await reconcileOnBoot(
      client,
      defaults({ restorePolicy: 'auto', autoRestoreEnsembles: ['my-*'] }),
      HOSTNAME,
      NOW,
    );
    expect(stub.calls).to.have.length(1);
    expect(stub.calls[0].ensemble).to.equal('my-team');
  });

  it('restorePolicy "auto" — uses local hostname when preferredHost is unset', async function () {
    const client = makeFakeClient([
      fixture({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(1);
    expect(stub.calls[0].opts.host).to.equal(HOSTNAME);
  });

  it('restorePolicy "auto" — catches AttachmentConflict without propagating', async function () {
    stub.rejectWith(new Error('AttachmentConflict: host-2 holds lease'));
    const client = makeFakeClient([
      fixture({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    // Must not throw.
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(1);
  });

  it('restorePolicy "auto" — no orphans → no-op', async function () {
    const client = makeFakeClient([]);
    await reconcileOnBoot(client, defaults({ restorePolicy: 'auto' }), HOSTNAME, NOW);
    expect(stub.calls).to.have.length(0);
  });
});
