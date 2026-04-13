/**
 * PR-A attachment lease tests.
 *
 * Covers the lease-extension primitive and CAN-boundary state carry-over. The
 * main-loop reap on lease expiry (§9.5.a) is exercised more robustly through the
 * phase-transition tests in `session-phase-machine.test.ts` (via forceDetach);
 * asserting the timer-based reap deterministically in TestWorkflowEnvironment
 * requires a fragile time-skip + poll dance, so we validate the state carry-over
 * and extension math here instead.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §2.3, §9.5.
 */
import { expect } from 'chai';
import type { AttachmentInfo, Attachment } from '../src/types';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
} from './helpers';
import {
  claimAttachmentUpdate,
  attachmentInfoQuery,
} from '../src/workflows/signals';

describe('attachment lease (v0.25 PR-A)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('lease renewal via claimAttachment preserves attachmentId and at least matches expiresAt', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({ metadata: playerMetadata({ playerId: `renew-${Date.now()}` }) });
      const t1 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });

      // Renewal path — same attachmentId, fresh expiresAt.
      const t2 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000, expectedAttachmentId: t1.attachmentId }],
      });
      expect(t2.attachmentId).to.equal(t1.attachmentId, 'renewal preserves attachmentId');
      // In test env the clock may not advance between the two calls; at minimum the renewed
      // expiresAt should be >= the original.
      expect(new Date(t2.expiresAt).getTime())
        .to.be.gte(new Date(t1.expiresAt).getTime(), 'renewal refreshes expiresAt');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('CAN-boundary: pre-populated currentAttachment is restored and phase=attached (§2.3)', async function () {
    this.timeout(10_000);
    // Simulate the CAN-boundary state restoration: the old execution writes `currentAttachment`
    // into the new execution's SessionInput (with the §2.3 lease extension already applied).
    // The new execution should boot with phase='attached' and the carried attachment intact.
    await withWorker(async () => {
      const now = Date.now();
      const carriedAttachment: Attachment = {
        attachmentId: 'pre-can-attach',
        hostname: 'host-carried',
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: new Date(now - 60_000).toISOString(),
        lastHeartbeatAt: new Date(now).toISOString(),
        // The extension in §2.3 sets this to now + HEARTBEAT_INTERVAL_MS (30s by default);
        // pick a safely-in-the-future value.
        expiresAt: new Date(now + 30_000).toISOString(),
        // #119a: leaseMs is the caller-negotiated renewal window — each heartbeat
        // extends expiresAt by this amount. 60s matches a typical interactive-adapter lease.
        leaseMs: 60_000,
        runId: 'pre-can-run',
      };

      const handle = await startSession({
        metadata: playerMetadata({ playerId: `can-${Date.now()}` }),
        currentAttachment: carriedAttachment,
        phase: 'attached',
        preferredHost: 'host-carried',
      });

      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('attached');
      expect(info.currentAttachment?.attachmentId).to.equal('pre-can-attach');
      expect(info.currentAttachment?.hostname).to.equal('host-carried');
      // Carried expiresAt must survive unchanged — the workflow must not reset leases on boot.
      expect(info.currentAttachment?.expiresAt).to.equal(carriedAttachment.expiresAt);
      expect(info.preferredHost).to.equal('host-carried');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
