/**
 * PR-E (daemon-resilience) — early continue-as-new state carries.
 *
 * The early-CAN trigger makes CAN fire ~2-3×/day/session instead of
 * effectively never (the server's ~10k-event suggestion). Two `let`s that
 * were "acceptably" reset per run while CAN was unreachable become
 * user-visible regressions at that cadence — these tests pin their carry:
 *
 * - `lastActivityTime` — pre-E it re-seeded to NOW at run start, so a
 *   frozen 10h-idle session would report `lastActivityAt: just now` after
 *   every CAN, corrupting the freeze-spotting surface (`getActivityState`).
 * - `coarseActivity` — pre-E it reset to `{ currentTool: null }`, blanking
 *   the mission-control board's currentTool/context% until the next
 *   heartbeat piggyback after every CAN.
 *
 * CAN is driven via the test-only `testForceContinueAsNewSignal` (#226
 * precedent) so the exact production CAN path runs — including the §2.3
 * lease extension and the full CAN payload — without ~2k filler events.
 * The early-CAN *trigger* itself (thresholds) is pure math tested in
 * `test/workflows/early-can-trigger.test.ts`; this suite covers the carry.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
  receiveMessageSignal,
  destroyUpdate,
  PROTOCOL_VERSION,
} from './helpers';
import {
  getActivityStateQuery,
  getCoarseActivityQuery,
  claimAttachmentUpdate,
  heartbeatSignal,
  testForceContinueAsNewSignal,
} from '../src/workflows/signals';
import type { WorkflowHandle } from '@temporalio/client';

describe('early-CAN state carries (PR-E)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  useSharedWorker(startOutboxWorker);

  /** Force CAN and wait for the successor run to be live. */
  async function forceCanAndAwaitSuccessor(handle: WorkflowHandle): Promise<void> {
    const originalRunId = (await handle.describe()).runId;
    await handle.signal(testForceContinueAsNewSignal);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const desc = await handle.describe();
      if (desc.runId !== originalRunId && desc.status.name === 'RUNNING') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('successor run did not appear within 8s of forced CAN');
  }

  async function destroyQuietly(handle: WorkflowHandle): Promise<void> {
    await handle.executeUpdate(destroyUpdate, { args: [{}] });
    await handle.result().catch(() => {});
  }

  it('lastActivityTime survives CAN — lastActivityAt does not reset to successor start', async function () {
    this.timeout(20_000);
    const handle = await startSession({
      metadata: playerMetadata({ playerId: `can-activity-${Date.now()}` }),
    });
    try {
      // A real "work" event stamps lastActivityTime deterministically.
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'ping' });
      const before = await handle.query(getActivityStateQuery);
      expect(before.activityCount).to.equal(1);

      // Real-time gap so a pre-fix re-seed at successor start would be
      // measurably LATER than the pre-CAN stamp.
      await new Promise((r) => setTimeout(r, 1_200));
      await forceCanAndAwaitSuccessor(handle);

      const after = await handle.query(getActivityStateQuery);
      // Exact ISO round-trip: the successor must report the SAME
      // last-activity instant, not its own start time.
      expect(after.lastActivityAt).to.equal(before.lastActivityAt);
      expect(after.activityCount).to.equal(before.activityCount);
    } finally {
      await destroyQuietly(handle);
    }
  });

  it('coarseActivity survives CAN — board does not blank currentTool/context%', async function () {
    this.timeout(20_000);
    const handle = await startSession({
      metadata: playerMetadata({ playerId: `can-coarse-${Date.now()}` }),
    });
    try {
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      // Heartbeat piggyback populates coarse activity (3c Tier-1).
      await handle.signal(heartbeatSignal, {
        attachmentId: token.attachmentId,
        at: new Date().toISOString(),
        currentTool: 'Bash',
        contextTokens: 12_345,
        contextPercent: 42,
      });
      const before = await handle.query(getCoarseActivityQuery);
      expect(before).to.deep.equal({ currentTool: 'Bash', contextTokens: 12_345, contextPercent: 42 });

      await forceCanAndAwaitSuccessor(handle);

      const after = await handle.query(getCoarseActivityQuery);
      expect(after).to.deep.equal(before);
    } finally {
      await destroyQuietly(handle);
    }
  });

  it('input-seed path: a fresh start with no carried fields begins idle at NOW', async function () {
    this.timeout(10_000);
    // Guards the `??` defaults: absent input (old CAN payloads, fresh
    // recruits) must behave exactly as pre-E — idle coarse, NOW-ish stamp.
    const t0 = Date.now();
    const handle = await startSession({
      metadata: playerMetadata({ playerId: `can-fresh-${Date.now()}` }),
    });
    try {
      const [coarse, activity] = await Promise.all([
        handle.query(getCoarseActivityQuery),
        handle.query(getActivityStateQuery),
      ]);
      expect(coarse).to.deep.equal({ currentTool: null });
      const stamp = Date.parse(activity.lastActivityAt);
      expect(stamp).to.be.at.least(t0 - 5_000);
      expect(stamp).to.be.at.most(Date.now() + 5_000);
    } finally {
      await destroyQuietly(handle);
    }
  });
});
