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
import { createOutboxActivities } from '../src/activities/outbox';
import type { Config } from '../src/config';
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
    workflowId: opts.id ?? `agent-session-${opts.ensemble}-${opts.playerId}`,
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

  // #288 — CLI `restore <ensemble>` narrows the orphan loop to a single
  // ensemble. The filter runs BEFORE cross-host / age / allowlist filtering
  // so excluded ensembles never appear in `details`.
  it('ensemble filter — only matching ensembles are considered', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'band-a', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fx({ ensemble: 'band-b', playerId: 'bob', detachedSince: new Date(NOW - 60_000).toISOString() }),
      fx({ ensemble: 'band-a', playerId: 'charlie', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      ensemble: 'band-a',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls.map((c) => c.ensemble)).to.deep.equal(['band-a', 'band-a']);
    expect(summary.reattached).to.equal(2);
    expect(summary.details.map((d) => d.playerId)).to.deep.equal(['alice', 'charlie']);
  });

  it('ensemble filter — empty result when no orphans match the filter', async function () {
    const client = makeFakeClient([
      fx({ ensemble: 'band-a', playerId: 'alice', detachedSince: new Date(NOW - 60_000).toISOString() }),
    ]);
    const tempo = stubTempo();
    const summary = await restoreOrphansOnce(client, {
      hostname: HOST,
      invokerPlayerId: 'cli',
      policy: 'auto',
      ensemble: 'band-b',
      now: () => NOW,
      tempoClientFactory: tempo.factory,
    });
    expect(tempo.calls).to.have.length(0);
    expect(summary.details).to.have.length(0);
    expect(summary.reattached).to.equal(0);
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
      // #151 — `crossHost` is the readonly-listing label (distinct from the
      // active-restore `preferredHost` skip).
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'crossHost', detail: 'host-B' }))
        .to.equal('cross-host orphan: preferredHost=host-B');
      expect(formatRestoreOutcome({ kind: 'skipped', reason: 'crossHost' }))
        .to.equal('cross-host orphan: preferredHost=(unknown)');
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

  // #306 — user-invoked `/restore` narrows the orphan scan to
  // `phases: ['detached']`. A live `attached` fixture must NOT be treated
  // as an orphan candidate, or the caller will enqueue `deliverRestart` →
  // `requestDetach` against a healthy session and the `drainingDeadline`
  // hard-termination path will kill the adapter. This was the third PR #306
  // blocker: `/restore` tore down a live conductor that had NOT detached.
  describe('phases filter (#306)', function () {
    it("phases=['detached'] — an 'attached' fixture is filtered out; zero restarts enqueued", async function () {
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'live-conductor',
          phase: 'attached',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        phases: ['detached'],
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      // Zero restart calls — the live fixture was filtered at the
      // phase-allowlist gate inside `queryOrphanedSessions`. Because the
      // filter happens BEFORE `restoreOrphansOnce`'s own counter emitter,
      // there is no `skipped` detail entry — the candidate is simply
      // invisible to the restore loop.
      expect(tempo.calls).to.have.length(0);
      expect(summary).to.deep.equal({ reattached: 0, skipped: 0, failed: 0, details: [] });
    });

    it("phases=['detached'] — a 'detached' fixture is still restored", async function () {
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'parked',
          phase: 'detached',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        phases: ['detached'],
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(tempo.calls).to.have.length(1);
      expect(summary.reattached).to.equal(1);
      expect(summary.details[0].playerId).to.equal('parked');
    });

    it("no phases (daemon reconcile default) — an 'attached' fixture is included as a candidate and restart is enqueued", async function () {
      // Daemon reconcile-on-boot has no PID memory after a crash, so it
      // legitimately treats every live phase as a presumed orphan. An
      // `AttachmentConflict` from a still-live adapter is the intended
      // guard (counted as `skipped` per §10.6). Here we verify the
      // candidate is NOT pre-filtered — the restart does get enqueued.
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'maybe-live',
          phase: 'attached',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'daemon',
        policy: 'auto',
        // NOTE: no `phases` — broad default preserved.
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(tempo.calls).to.have.length(1);
      expect(summary.reattached).to.equal(1);
    });

    it("phases=['detached'] — mixed fixtures only return the detached one", async function () {
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'live',
          phase: 'attached',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
        fx({
          ensemble: 'e1',
          playerId: 'parked',
          phase: 'detached',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
        fx({
          ensemble: 'e1',
          playerId: 'processing-now',
          phase: 'processing',
          detachedSince: new Date(NOW - 60_000).toISOString(),
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        phases: ['detached'],
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(tempo.calls.map((c) => c.playerId)).to.deep.equal(['parked']);
      expect(summary.reattached).to.equal(1);
      expect(summary.details).to.have.length(1);
    });
  });

  // #151 — `mode: 'all-hosts-readonly'` cluster-view listing. Never calls
  // `restart`; emits every visible orphan as `{ kind: 'skipped', reason:
  // 'crossHost', detail: <preferredHost> }` so the CLI `--all-hosts`
  // formatter can group by host and annotate with liveness.
  describe("mode 'all-hosts-readonly' (#151)", function () {
    it('emits crossHost outcome for every orphan; never calls restart', async function () {
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'remote-1',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          preferredHost: 'host-B',
        }),
        fx({
          ensemble: 'e1',
          playerId: 'remote-2',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          preferredHost: 'host-C',
        }),
        // A local-preferred orphan should ALSO appear in readonly listing —
        // operator's cluster view shows everything. detail falls through to
        // the preferredHost.
        fx({
          ensemble: 'e1',
          playerId: 'local',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          preferredHost: HOST,
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto', // policy is short-circuited by readonly mode
        mode: 'all-hosts-readonly',
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(tempo.calls, 'restart never called in readonly mode').to.have.length(0);
      expect(summary.reattached).to.equal(0);
      expect(summary.failed).to.equal(0);
      expect(summary.skipped).to.equal(3);
      expect(summary.details.map((d) => d.playerId)).to.deep.equal(['remote-1', 'remote-2', 'local']);
      for (const d of summary.details) {
        expect(d.outcome.kind).to.equal('skipped');
        if (d.outcome.kind === 'skipped') {
          expect(d.outcome.reason).to.equal('crossHost');
        }
      }
      // detail carries the preferred host so the CLI can group/render.
      const details = summary.details.map((d) => (d.outcome as any).detail);
      expect(details).to.deep.equal(['host-B', 'host-C', HOST]);
    });

    it("preferredHost unset — detail falls through to lastAdapter.hostname", async function () {
      // Build a fixture with `lastAdapter` (the orphan's home-host clue when
      // preferredHost was never written).
      const fixture: Fixture = {
        workflowId: 'agent-session-e1-anon',
        info: { phase: 'detached', inFlightCount: 0 },
        summary: {
          ensemble: 'e1',
          playerId: 'anon',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          lastAdapter: { hostname: 'host-X', adapterId: 'claude-code' },
        },
      };
      const client = makeFakeClient([fixture]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        mode: 'all-hosts-readonly',
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(tempo.calls).to.have.length(0);
      expect(summary.details).to.have.length(1);
      expect(summary.details[0].outcome).to.deep.equal({
        kind: 'skipped',
        reason: 'crossHost',
        detail: 'host-X',
      });
    });

    it('preferredHost AND lastAdapter both unset — detail is "(unknown)"', async function () {
      const client = makeFakeClient([
        fx({ ensemble: 'e1', playerId: 'mystery', detachedSince: new Date(NOW - 60_000).toISOString() }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        mode: 'all-hosts-readonly',
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(summary.details[0].outcome).to.deep.equal({
        kind: 'skipped',
        reason: 'crossHost',
        detail: '(unknown)',
      });
    });

    it('readonly mode respects ensemble narrowing', async function () {
      const client = makeFakeClient([
        fx({
          ensemble: 'band-a',
          playerId: 'alice',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          preferredHost: 'host-B',
        }),
        fx({
          ensemble: 'band-b',
          playerId: 'bob',
          detachedSince: new Date(NOW - 60_000).toISOString(),
          preferredHost: 'host-C',
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        mode: 'all-hosts-readonly',
        ensemble: 'band-a',
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(summary.details.map((d) => d.playerId)).to.deep.equal(['alice']);
    });

    it('readonly mode does NOT apply age window — every visible orphan is listed', async function () {
      // An ancient orphan in `policy: 'auto'` local mode would be skipped
      // with reason=ageWindow. In readonly listing mode the operator wants
      // to SEE it (especially the dormant ones), so the age filter shouldn't
      // pre-filter the listing.
      const client = makeFakeClient([
        fx({
          ensemble: 'e1',
          playerId: 'ancient',
          detachedSince: '2020-01-01T00:00:00Z',
          preferredHost: 'host-B',
        }),
      ]);
      const tempo = stubTempo();
      const summary = await restoreOrphansOnce(client, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        mode: 'all-hosts-readonly',
        autoRestoreMaxAgeHours: 24,
        now: () => NOW,
        tempoClientFactory: tempo.factory,
      });
      expect(summary.details).to.have.length(1);
      expect(summary.details[0].outcome).to.deep.include({ kind: 'skipped', reason: 'crossHost' });
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

  // #306 — end-to-end: orphan reattach via `restoreOrphansOnce` flows through
  // `tempo.restart` → outbox `restart` entry → `deliverRestart` activity →
  // `enqueueSpawn` update. The same invariant that protects `/restart`
  // (commit 17a7858) must hold here: ALWAYS mint a new sessionId, ALWAYS
  // pass `resume: false`. The prior session's `.jsonl` transcript is not
  // guaranteed to have been flushed before the orphan's adapter died, so
  // `claude --resume <prior-uuid>` would error with "No conversation found
  // with session ID" and the new terminal would drop to shell. Wire this
  // test through the real `deliverRestart` activity (not a stubbed restart)
  // so the end-to-end path is locked in regardless of which intermediate
  // layer changes.
  describe('end-to-end orphan reattach flow (#306)', function () {
    const PRIOR_SESSION_ID = 'e1536377-6268-4fa7-8882-2aee08467f96';
    const FRESH_RUN_ID = 'r-fresh-1';
    const FRESH_ATTACHMENT_ID = 'a-fresh-1';

    /**
     * Build a Temporal `Client` shape rich enough to walk the full
     * `deliverRestart` algorithm. Captures every `executeUpdate` so the
     * test can locate the `enqueueSpawn` payload and assert on its shape.
     */
    function makeRichClient(orphan: {
      ensemble: string;
      playerId: string;
      priorSessionId: string;
    }) {
      const captured: Array<{ name: string; args: unknown }> = [];
      // The orphan's session workflow: phase=detached so `deliverRestart`
      // skips the request-detach / forceDetach branches and goes straight
      // to claim → enqueue spawn. Metadata pre-populated with the prior
      // (now stale) sessionId — the regression target. The fix mints a new
      // UUID and persists it via `updateMetadata`; tests for that signal
      // are no-ops here (we assert on the spawn payload directly).
      const sessionMetadata: Record<string, unknown> = {
        ensemble: orphan.ensemble,
        playerId: orphan.playerId,
        hostname: HOST,
        workDir: '/tmp/orphan-workdir',
        isConductor: true,
        agentType: 'claude',
        sessionId: orphan.priorSessionId,
      };
      const sessionInfo: AttachmentInfo = {
        phase: 'detached',
        inFlightCount: 0,
      };
      const sessionHandle = {
        async query(name: unknown) {
          const n = asName(name);
          if (n === 'getMetadata') return sessionMetadata;
          if (n === 'attachmentInfo') return sessionInfo;
          if (n === 'orphanSummary') {
            return {
              ensemble: orphan.ensemble,
              playerId: orphan.playerId,
              detachedSince: new Date(NOW - 60_000).toISOString(),
            } as OrphanSummary;
          }
          if (n === 'getPart') return '';
          if (n === 'allMessages') return [];
          return undefined;
        },
        async signal(_name: unknown, _payload?: unknown) {
          // updateMetadata + receiveMessage are durable side effects in
          // the real workflow; we don't need to mirror them — the spawn
          // payload is the assertion target.
        },
        async executeUpdate(nameOrDef: unknown, opts: { args: unknown[] }) {
          const n = asName(nameOrDef);
          captured.push({ name: n, args: opts.args[0] });
          if (n === 'claimAttachment') {
            return { attachmentId: FRESH_ATTACHMENT_ID, runId: FRESH_RUN_ID };
          }
          if (n === 'enqueueSpawn') {
            return { spawnEntryId: 'spawn-e2e-1' };
          }
          if (n === 'forceDetach') return { reaped: false };
          return {};
        },
      };

      const client = {
        workflow: {
          getHandle: () => sessionHandle,
          async *list() {
            yield {
              workflowId: `agent-session-${orphan.ensemble}-${orphan.playerId}`,
            };
          },
        },
      };

      return { client, captured };
    }

    const baseConfig: Config = {
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'agent-tempo',
      ensemble: 'test-orphan-e2e',
      defaultAgent: 'claude',
    };

    it('orphan reattach produces enqueueSpawn with resume:false + fresh sessionId', async function () {
      const orphan = {
        ensemble: 'e1',
        playerId: 'conductor',
        priorSessionId: PRIOR_SESSION_ID,
      };
      const { client, captured } = makeRichClient(orphan);

      // Real `deliverRestart` from the outbox activities — same code that
      // runs in production on the dispatch loop. The `tempoClientFactory`
      // funnels every `tempo.restart` call from `restoreOrphansOnce`
      // straight into this activity, so the assertion below is on the
      // identical payload that the session workflow's `enqueueSpawnUpdate`
      // handler would receive in the wild.
      const activities = createOutboxActivities(client as any, baseConfig);
      const factory = () => ({
        restart: async (ensemble: string, playerId: string, opts: any) => {
          await activities.deliverRestart({
            ensemble,
            targetPlayerId: playerId,
            invokerPlayerId: opts.invokerPlayerId ?? 'cli',
            ...(opts.host !== undefined ? { host: opts.host } : {}),
          });
          return { playerId, entryId: 'restart-entry-1' };
        },
      });

      const summary = await restoreOrphansOnce(client as any, {
        hostname: HOST,
        invokerPlayerId: 'cli',
        policy: 'auto',
        ensemble: orphan.ensemble,
        phases: ['detached'],
        now: () => NOW,
        tempoClientFactory: factory,
      });

      expect(summary.reattached, 'one orphan reattached').to.equal(1);
      expect(summary.failed, 'no failures').to.equal(0);

      const enq = captured.find((c) => c.name === 'enqueueSpawn');
      expect(enq, 'enqueueSpawn was called').to.exist;
      const args = enq!.args as any;

      // The bug: spawn used `resume: true` + the prior sessionId, then
      // claude --resume <uuid> failed with "No conversation found".
      expect(args.resume, 'spawn resume flag is false').to.equal(false);
      expect(args.sessionId, 'spawn sessionId is set').to.be.a('string');
      expect(args.sessionId, 'spawn sessionId is fresh, NOT the orphan\'s prior id').to.not.equal(PRIOR_SESSION_ID);
      // Sanity: shape is a UUIDv4.
      expect(args.sessionId).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // Routing fields the dispatch loop relies on — the pre-claimed token
      // should propagate through to the spawn entry.
      expect(args.attachmentId).to.equal(FRESH_ATTACHMENT_ID);
      expect(args.runId).to.equal(FRESH_RUN_ID);
    });
  });
});
