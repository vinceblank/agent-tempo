/**
 * Unit tests for the cleanup-loop retention math (PR-E §13.4).
 *
 * `selectStaleDetachedOrphans` is the pure filter that drives pass 1 of the
 * cleanup loop. No Temporal connection — all inputs are fixture
 * `OrphanCandidate` objects with crafted `detachedSince` timestamps.
 */
import { expect } from 'chai';
import { selectStaleDetachedOrphans } from '../src/daemon';
import type { OrphanCandidate } from '../src/reconcile/orphans';

function makeOrphan(opts: {
  workflowId?: string;
  phase?: 'detached' | 'attached' | 'awaiting' | 'processing' | 'booting' | 'draining' | 'gone';
  detachedSince?: string;
  ensemble?: string;
  playerId?: string;
}): OrphanCandidate {
  return {
    workflowId: opts.workflowId ?? 'agent-session-e1-p1',
    info: {
      phase: opts.phase ?? 'detached',
      inFlightCount: 0,
    },
    summary: {
      ensemble: opts.ensemble ?? 'e1',
      playerId: opts.playerId ?? 'p1',
      ...(opts.detachedSince !== undefined ? { detachedSince: opts.detachedSince } : {}),
    },
  };
}

// Fixed clock — 2026-04-13T12:00:00Z.
const NOW = Date.parse('2026-04-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('selectStaleDetachedOrphans', function () {
  it('selects orphans detached longer than the threshold', function () {
    const orphans = [
      makeOrphan({ workflowId: 'w1', detachedSince: new Date(NOW - 10 * DAY).toISOString() }), // 10d old
      makeOrphan({ workflowId: 'w2', detachedSince: new Date(NOW - 3 * DAY).toISOString() }),  // 3d old
      makeOrphan({ workflowId: 'w3', detachedSince: new Date(NOW - 8 * DAY).toISOString() }),  // 8d old
    ];
    const stale = selectStaleDetachedOrphans(orphans, 7, NOW);
    const ids = stale.map((o) => o.workflowId).sort();
    expect(ids).to.deep.equal(['w1', 'w3']);
  });

  it('ignores orphans within the threshold', function () {
    const orphans = [
      makeOrphan({ detachedSince: new Date(NOW - 6 * DAY).toISOString() }),
      makeOrphan({ detachedSince: new Date(NOW - 1 * DAY).toISOString() }),
      makeOrphan({ detachedSince: new Date(NOW).toISOString() }),
    ];
    expect(selectStaleDetachedOrphans(orphans, 7, NOW)).to.deep.equal([]);
  });

  it('skips orphans without `detachedSince`', function () {
    const orphans = [
      makeOrphan({ workflowId: 'w1' }), // no detachedSince
      makeOrphan({ workflowId: 'w2', detachedSince: new Date(NOW - 100 * DAY).toISOString() }),
    ];
    const stale = selectStaleDetachedOrphans(orphans, 7, NOW);
    expect(stale.map((o) => o.workflowId)).to.deep.equal(['w2']);
  });

  it('skips orphans whose phase is not "detached"', function () {
    const orphans = [
      makeOrphan({ workflowId: 'w1', phase: 'attached', detachedSince: new Date(NOW - 100 * DAY).toISOString() }),
      makeOrphan({ workflowId: 'w2', phase: 'detached', detachedSince: new Date(NOW - 100 * DAY).toISOString() }),
      makeOrphan({ workflowId: 'w3', phase: 'processing', detachedSince: new Date(NOW - 100 * DAY).toISOString() }),
    ];
    const stale = selectStaleDetachedOrphans(orphans, 7, NOW);
    expect(stale.map((o) => o.workflowId)).to.deep.equal(['w2']);
  });

  it('skips orphans with unparseable `detachedSince`', function () {
    const orphans = [
      makeOrphan({ workflowId: 'w1', detachedSince: 'not-an-iso-date' }),
      makeOrphan({ workflowId: 'w2', detachedSince: new Date(NOW - 100 * DAY).toISOString() }),
    ];
    const stale = selectStaleDetachedOrphans(orphans, 7, NOW);
    expect(stale.map((o) => o.workflowId)).to.deep.equal(['w2']);
  });

  it('honors a custom threshold (30 days)', function () {
    const orphans = [
      makeOrphan({ workflowId: 'w1', detachedSince: new Date(NOW - 20 * DAY).toISOString() }),
      makeOrphan({ workflowId: 'w2', detachedSince: new Date(NOW - 35 * DAY).toISOString() }),
    ];
    const stale = selectStaleDetachedOrphans(orphans, 30, NOW);
    expect(stale.map((o) => o.workflowId)).to.deep.equal(['w2']);
  });

  it('returns an empty array when no orphans are supplied', function () {
    expect(selectStaleDetachedOrphans([], 7, NOW)).to.deep.equal([]);
  });
});
