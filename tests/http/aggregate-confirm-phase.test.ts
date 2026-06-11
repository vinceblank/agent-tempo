/**
 * T0.1 (#748) — confirm-on-change phase validation in the AggregateRunner
 * (design addendum §B(d)).
 *
 * Asserts:
 *   1. A phase TRANSITION (track says 'attached', snapshot says 'detached')
 *      triggers exactly ONE confirm query for that player.
 *   2. The confirmer's answer OVERRIDES the snapshot phase (a false
 *      transition caused by SA lag is suppressed before the diff).
 *   3. Unchanged players and fresh adds cost zero confirm queries.
 *   4. A `null` confirm (unreachable workflow) falls back to the SA phase.
 *
 * (The local-profile/no-confirmer disablement lives in `tick()`'s
 * `confirmOnChange` constructor wiring — exercised by the existing
 * aggregate tick suites running with neither option set.)
 */
import { describe, it, expect, vi } from 'vitest';
import { AggregateRunner, type AggregateSnapshot, type PhaseConfirmer } from '../../src/http/aggregate';
import type { TempoClient } from '../../src/client/interface';
import type { AttachmentPhase } from '../../src/types';
import type { PlayerSummaryV1 } from '../../src/http/event-types';

function player(id: string, phase: AttachmentPhase, isConductor = false): PlayerSummaryV1 {
  return {
    playerId: id, ensemble: 'demo', hostname: 'h', isConductor,
    agentType: 'claude', part: '', workDir: '', phase,
  };
}

function snapshotWith(players: PlayerSummaryV1[]): AggregateSnapshot {
  return {
    capturedAt: new Date(0).toISOString(),
    ensembles: [{
      ensemble: 'demo', hasConductor: false,
      flags: { paused: false, held: false },
      players, schedules: [], chat: [],
    }],
    livePrelude: [{ ensemble: 'demo', hasConductor: false }],
    hostProfiles: {},
  };
}

function makeRunner(confirmPhase: PhaseConfirmer | undefined, costProfile: 'local' | 'cloud') {
  return new AggregateRunner({
    client: {} as TempoClient, // confirm path never touches the TempoClient
    bootEpoch: 1,
    costProfile,
    confirmPhase,
  });
}

/** Seed the runner's per-player phase track via a first applyDiff pass. */
function seed(runner: AggregateRunner, players: PlayerSummaryV1[]): void {
  runner.applyDiff(snapshotWith(players));
}

describe('AggregateRunner confirm-on-change (#748)', () => {
  it('confirms only transitioning players and overrides with the authoritative phase', async () => {
    const confirm = vi.fn(async (): Promise<AttachmentPhase | null> => 'attached');
    const runner = makeRunner(confirm, 'cloud');
    seed(runner, [player('alice', 'attached'), player('bob', 'awaiting')]);

    // SA lag claims alice detached; bob unchanged.
    const snap = snapshotWith([player('alice', 'detached'), player('bob', 'awaiting')]);
    await runner.confirmPhaseTransitions(snap);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('demo', 'alice', false);
    // The authoritative answer ('attached') suppressed the false transition.
    expect(snap.ensembles[0].players[0].phase).toBe('attached');
    expect(snap.ensembles[0].players[1].phase).toBe('awaiting');
  });

  it('keeps the confirmed phase when the transition is real', async () => {
    const confirm = vi.fn(async (): Promise<AttachmentPhase | null> => 'detached');
    const runner = makeRunner(confirm, 'cloud');
    seed(runner, [player('alice', 'attached')]);

    const snap = snapshotWith([player('alice', 'detached')]);
    await runner.confirmPhaseTransitions(snap);
    expect(snap.ensembles[0].players[0].phase).toBe('detached');
  });

  it('fresh adds cost zero confirm queries', async () => {
    const confirm = vi.fn(async (): Promise<AttachmentPhase | null> => 'attached');
    const runner = makeRunner(confirm, 'cloud');
    // No seed — every player is a fresh add.
    const snap = snapshotWith([player('newbie', 'booting')]);
    await runner.confirmPhaseTransitions(snap);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('null confirm (unreachable workflow) trusts the SA-sourced phase', async () => {
    const confirm = vi.fn(async (): Promise<AttachmentPhase | null> => null);
    const runner = makeRunner(confirm, 'cloud');
    seed(runner, [player('alice', 'attached')]);

    const snap = snapshotWith([player('alice', 'gone')]);
    await runner.confirmPhaseTransitions(snap);
    expect(snap.ensembles[0].players[0].phase).toBe('gone');
  });

  it('passes isConductor through to the confirmer (workflowId selection)', async () => {
    const confirm = vi.fn(async (): Promise<AttachmentPhase | null> => null);
    const runner = makeRunner(confirm, 'cloud');
    seed(runner, [player('maestro-1', 'attached', true)]);
    await runner.confirmPhaseTransitions(snapshotWith([player('maestro-1', 'detached', true)]));
    expect(confirm).toHaveBeenCalledWith('demo', 'maestro-1', true);
  });
});
