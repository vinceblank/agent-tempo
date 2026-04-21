/**
 * Unit tests for `restoreOrphansOnce` (#93).
 *
 * The helper is the shared body of daemon `reconcileOnBoot` and the CLI
 * resume flow (`up` option 2, `conduct --resume`). It takes a Temporal
 * `Client`, queries orphan candidates, runs policy-appropriate filters,
 * and (for `policy: 'auto'`) calls `TempoClient.restart` per candidate.
 *
 * These tests inject the `tempoClientFactory` directly, so we don't touch
 * the `src/client` module namespace — a cleaner wiring than the old
 * `rebuild-reboot.test.ts` pattern. `Client.workflow.list` + `getHandle`
 * are stubbed in the same way so we never reach a live Temporal server.
 */
import { expect } from 'chai';
import { restoreOrphansOnce, formatRestoreOutcome } from '../src/reconcile/orphans';
import type { AttachmentInfo, OrphanSummary } from '../src/types';

const asName = (n: unknown) => typeof n === 'string' ? n : (n as any).name;

interface Fixture {
  workflowId: string;
  info: AttachmentInfo;
  summary: OrphanSummary;
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

/**
 * Build a tracked `tempoClientFactory` stub. `restart` records its args
 * into `calls` and returns a fake `{ entryId }`. `rejectWith(err)` flips
 * the stub into failure mode so we can test the `AttachmentConflict` +
 * non-conflict-error branches.
 */
function stubTempo() {
  const calls: Array<{ ensemble: string; playerId: string; opts: any }> = [];
  let rejection: Error | null = null;
  const factory = () => ({
    restart: async (ensemble: string, playerId: string, opts: any) => {
      calls.push({ ensemble, playerId, opts });
      if (rejection) throw rejection;
      return { playerId, entryId: `entry-${calls.length}` };
    },
  });
  return {
    factory,
    calls,
    rejectWith(err: Error | null) { rejection = err; },
  };
}

const HOST = 'host-1';
const NOW = Date.parse('2026-04-21T12:00:00Z');

function fx(opts: {
  id?: string;
  ensemble: string;
  playerId: string;
  phase?: AttachmentInfo['phase'];
  detachedSince?: string;
  preferredHost?: string;
}): Fixture {
  return {
    workflowId: opts.id ?? `claude-session-${opts.ensemble}-${opts.playerId}`,
    info: { phase: opts.phase ?? 'detached', inFlightCount: 0 },
    summary: {
      ensemble: opts.ensemble,
      playerId: opts.playerId,
      ...(opts.detachedSince !== undefined ? { detachedSince: opts.detachedSince } : {}),
      ...(opts.preferredHost !== undefined ? { preferredHost: opts.preferredHost } : {}),
    },
  };
}

describe('restoreOrphansOnce', function () {
  it('no orphans → zero counts, empty details', async function () {
    const client = makeFakeClient([]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(summary).to.deep.equal({ reattached: 0, skipped: 0, failed: 0, details: [] });
    expect(tempo.calls).to.have.length(0);
  });

  it("policy 'auto' — queues restart, increments reattached, records outbox id in detail", async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(summary.reattached).to.equal(1);
    expect(summary.skipped).to.equal(0);
    expect(summary.failed).to.equal(0);
    expect(summary.details).to.have.length(1);
    expect(summary.details[0].playerId).to.equal('alice');
    expect(summary.details[0].ensemble).to.equal('e1');
    expect(summary.details[0].outcome).to.deep.equal({ kind: 'queued', entryId: 'entry-1' });
    // invokerPlayerId passes through to restart
    expect(tempo.calls[0].opts.invokerPlayerId).to.equal('cli');
    expect(tempo.calls[0].opts.host).to.equal(HOST);
  });

  it("policy 'prompt' — never calls restart; details show outcome.reason='prompt'", async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fx({ ensemble: 'e2', playerId: 'bob', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'daemon',
      policy: 'prompt',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(0);
    expect(summary.reattached).to.equal(0);
    expect(summary.skipped).to.equal(2);
    expect(summary.details.every((d) => d.outcome.kind === 'skipped' && d.outcome.reason === 'prompt')).to.equal(true);
  });

  it('cross-host orphan — skipped with reason=preferredHost + detail, never reaches restart', async function () {
    const client = makeFakeClient([
      fx({
        ensemble: 'e1',
        playerId: 'remote',
        detachedSince: new Date(NOW - 60_000).toISOString(),
        preferredHost: 'other-host',
      }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(0);
    expect(summary.skipped).to.equal(1);
    expect(summary.details[0].outcome).to.deep.equal({
      kind: 'skipped',
      reason: 'preferredHost',
      detail: 'other-host',
    });
  });

  it('age filter — orphan detached beyond autoRestoreMaxAgeHours is skipped', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'stale', detachedSince: '2020-01-01T00:00:00Z' }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      autoRestoreMaxAgeHours: 24,
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(0);
    expect(summary.skipped).to.equal(1);
    expect(summary.details[0].outcome).to.deep.equal({ kind: 'skipped', reason: 'ageWindow' });
  });

  it('ensemble allowlist — glob match passes, mismatch skipped', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'my-team', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fx({ ensemble: 'other-team', playerId: 'bob', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      autoRestoreEnsembles: ['my-*'],
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(1);
    expect(tempo.calls[0].ensemble).to.equal('my-team');
    expect(summary.reattached).to.equal(1);
    expect(summary.skipped).to.equal(1);
    expect(summary.details.find((d) => d.playerId === 'bob')?.outcome).to.deep.equal({
      kind: 'skipped',
      reason: 'ensembleAllowlist',
    });
  });

  it('AttachmentConflict — counted as skipped, not failed', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    tempo.rejectWith(new Error('AttachmentConflict: host-2 holds lease'));
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(1);
    expect(summary.reattached).to.equal(0);
    expect(summary.skipped).to.equal(1);
    expect(summary.failed).to.equal(0);
    expect(summary.details[0].outcome).to.deep.equal({ kind: 'skipped', reason: 'attachmentConflict' });
  });

  it('non-conflict error — counted as failed; loop continues to next candidate', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fx({ ensemble: 'e1', playerId: 'bob', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    // Fail the first call; succeed on the second. The stub rejects for every
    // call while `rejection` is set, so switch it off mid-loop via a counter.
    let n = 0;
    tempo.factory = () => ({
      restart: async (ensemble: string, playerId: string, opts: any) => {
        tempo.calls.push({ ensemble, playerId, opts });
        n++;
        if (n === 1) throw new Error('transient network error');
        return { playerId, entryId: `entry-${n}` };
      },
    });
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(2);
    expect(summary.reattached).to.equal(1);
    expect(summary.failed).to.equal(1);
    expect(summary.details[0].outcome).to.deep.equal({ kind: 'failed', error: 'transient network error' });
    expect(summary.details[1].outcome).to.deep.equal({ kind: 'queued', entryId: 'entry-2' });
  });

  it('preferredHost defaults to local hostname when unset in summary', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'e1', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls[0].opts.host).to.equal(HOST);
  });

  describe('formatRestoreOutcome', function () {
    it('renders queued with entry id', function () {
      expect(formatRestoreOutcome({ kind: 'queued', entryId: 'entry-7' }))
        .to.equal('queued (outbox entry-7)');
    });
    it('renders failed with error message', function () {
      expect(formatRestoreOutcome({ kind: 'failed', error: 'boom' }))
        .to.equal('failed: boom');
    });
    it('renders skip reasons', function () {
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'preferredHost', detail: 'other' }))
        .to.equal('skipped: preferredHost=other');
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'ageWindow' }))
        .to.equal('skipped: age window');
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'ensembleAllowlist' }))
        .to.equal('skipped: ensemble allowlist');
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'attachmentConflict' }))
        .to.equal('skipped: AttachmentConflict');
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'prompt' }))
        .to.equal('prompt');
    });
  });

  it('preferredHost === local hostname — not filtered as cross-host', async function () {
    const client = makeFakeClient([
      fx({
        ensemble: 'e1',
        playerId: 'alice',
        detachedSince: new Date(NOW - 60_000).toISOString(),
        preferredHost: HOST,
      }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(1);
    expect(summary.reattached).to.equal(1);
  });
});
