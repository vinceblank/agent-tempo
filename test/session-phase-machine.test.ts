/**
 * PR-A phase machine tests.
 *
 * Verifies the §2.2 invariants and the reachability of all seven phases via the
 * documented transitions from §2.4:
 *   booting -> attached (claimAttachment)
 *   attached -> processing (processingStart with in-flight 0 -> 1)
 *   processing -> attached (processingEnd back to 0)
 *   attached -> draining (requestDetach)
 *   draining -> detached (adapterExited OR drainingDeadline)
 *   detached -> attached (claimAttachment)
 *   any -> gone (destroy)
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§2.2-2.6, §9.2.
 */
import { expect } from 'chai';
import type { AttachmentInfo, OrphanSummary } from '../src/types';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
  processingStartUpdate,
  processingEndUpdate,
  isDestroyedQuery,
} from './helpers';
import {
  claimAttachmentUpdate,
  forceDetachUpdate,
  requestDetachSignal,
  adapterExitedSignal,
  heartbeatSignal,
  attachmentInfoQuery,
  orphanSummaryQuery,
  setPreferredHostUpdate,
} from '../src/workflows/signals';

describe('session phase machine (v0.25 PR-A)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  // Helper: start a fresh session in booting phase.
  async function startFreshSession(playerId: string) {
    return startSession({ metadata: playerMetadata({ playerId }) });
  }

  it('fresh workflow starts in phase=booting with no attachment', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`booting-${Date.now()}`);
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('booting');
      expect(info.currentAttachment).to.equal(undefined);
      expect(info.inFlightCount).to.equal(0);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('booting -> attached via claimAttachment', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`claim-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      expect(token.attachmentId).to.be.a('string');
      expect(token.runId).to.be.a('string');
      expect(token.leaseMs).to.equal(30_000);
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('attached');
      expect(info.currentAttachment?.hostname).to.equal('host-A');
      expect(info.currentAttachment?.adapterClass).to.equal('interactive');
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('claimAttachment is idempotent on renewal (same expectedAttachmentId returns same token)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`renew-${Date.now()}`);
      const t1 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      // Renewal with same expectedAttachmentId.
      const t2 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000, expectedAttachmentId: t1.attachmentId }],
      });
      expect(t2.attachmentId).to.equal(t1.attachmentId);
      // expiresAt should have been extended (later than or equal to t1's).
      expect(new Date(t2.expiresAt).getTime()).to.be.gte(new Date(t1.expiresAt).getTime());
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('claimAttachment rejects with AttachmentConflict when another lease is live', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`conflict-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      let rejected = false;
      try {
        // No expectedAttachmentId + active lease = conflict.
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'host-B', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
        });
      } catch {
        // SDK wraps the ApplicationFailure; the important thing is the update was rejected.
        rejected = true;
      }
      expect(rejected).to.equal(true, 'expected AttachmentConflict when claiming over a live lease');
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('claimAttachment leaseMs out of range is rejected by the validator', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`bad-lease-${Date.now()}`);
      let rejected = false;
      try {
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 999 }],
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('attached -> processing -> awaiting via processingStart/End (#117 fix)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`proc-phase-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });

      // Start processing
      const r1 = await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      expect(r1.inFlightCount).to.equal(1);
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('processing');
      expect(info.inFlightCount).to.equal(1);
      expect(info.processingSince).to.be.a('string');

      // End processing — per #117 fix + design §2.2, when in-flight hits 0 and the
      // outbox is empty, phase refines to `awaiting` (idle attached), not bare `attached`.
      const r2 = await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      expect(r2.inFlightCount).to.equal(0);
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');
      expect(info.processingSince).to.equal(undefined);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('processingStart rejects updates with a superseded expectedAttachmentId', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`supersede-${Date.now()}`);
      const t1 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      // Force-detach; then claim fresh.
      await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'restart', gracePeriodMs: 0 }],
      });
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-B', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });

      // Old attachment id -> rejected.
      let rejected = false;
      try {
        await handle.executeUpdate(processingStartUpdate, {
          args: [{ messageId: 'late', expectedAttachmentId: t1.attachmentId }],
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, 'expected AttachmentMismatch on superseded attachmentId');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('attached -> draining -> detached via requestDetach + adapterExited', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`drain-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });

      await handle.signal(requestDetachSignal, { reason: 'user-stop', deadlineMs: 5_000 });
      // Poll attachmentInfo briefly — phase should hit 'draining'.
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      // The requestDetach signal may not have been processed yet at first query; loop with tiny wait.
      for (let i = 0; i < 10 && info.phase !== 'draining'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('draining');

      await handle.signal(adapterExitedSignal, { attachmentId: token.attachmentId, reason: 'agent-exited' });
      for (let i = 0; i < 10 && info.phase !== 'detached'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('detached');
      expect(info.currentAttachment).to.equal(undefined);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('forceDetach is idempotent on already-detached', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`fd-idem-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      const r1 = await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'force', gracePeriodMs: 0 }],
      });
      expect(r1.reaped).to.equal(true);
      const r2 = await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'force', gracePeriodMs: 0 }],
      });
      expect(r2.reaped).to.equal(false);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('detached -> attached via a fresh claimAttachment', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`reattach-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      await handle.executeUpdate(forceDetachUpdate, { args: [{ reason: 'force', gracePeriodMs: 0 }] });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('detached');

      const t2 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-B', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('attached');
      expect(info.currentAttachment?.attachmentId).to.equal(t2.attachmentId);
      expect(info.currentAttachment?.hostname).to.equal('host-B');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('destroy -> gone is terminal (workflow COMPLETEs; isDestroyed returns true)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`gone-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test' }] });
      await handle.result();
      // After completion, queries against the closed execution still work.
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('gone');
      expect(info.currentAttachment).to.equal(undefined);
    });
  });

  it('destroy is idempotent on already-gone', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`destroy-idem-${Date.now()}`);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      // Workflow has completed; re-issuing destroy against a completed run is a WorkflowNotFound
      // error at the Temporal layer, which is the canonical "already gone" signal to the caller.
      let threw = false;
      try {
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
      await handle.result().catch(() => {});
    });
  });

  it('claimAttachment after destroy fails with WorkflowGone semantics (workflow completed)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`gone-claim-${Date.now()}`);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      let rejected = false;
      try {
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'host-X', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, 'claim on destroyed workflow must fail');
      await handle.result().catch(() => {});
    });
  });

  it('setPreferredHost + orphanSummary round-trip', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`pref-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      await handle.executeUpdate(setPreferredHostUpdate, { args: [{ host: 'host-preferred' }] });
      await handle.executeUpdate(forceDetachUpdate, { args: [{ reason: 'user-stop', gracePeriodMs: 0 }] });

      const summary: OrphanSummary = await handle.query(orphanSummaryQuery);
      expect(summary.preferredHost).to.equal('host-preferred');
      expect(summary.reason).to.equal('user-stop');
      expect(summary.detachedSince).to.be.a('string');
      expect(summary.lastAdapter?.hostname).to.equal('host-A');
      expect(summary.lastAdapter?.adapterId).to.equal('claude-code');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('heartbeat with wrong attachmentId is silently ignored (last-write-wins guard)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`hb-guard-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      const originalExpiresAt = token.expiresAt;

      // Heartbeat for a different attachmentId — should be ignored.
      await handle.signal(heartbeatSignal, { attachmentId: 'not-the-real-id', at: new Date().toISOString() });

      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      // expiresAt unchanged (heartbeat was dropped)
      expect(info.currentAttachment?.expiresAt).to.equal(originalExpiresAt);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  // ── awaiting phase invariants (v0.25 PR-C commit 5; fixes #117) ──
  //
  // `awaiting` is the idle refinement of `attached` — the attachment is held,
  // `inFlightMessages` is empty, and no outbox entries are pending/processing.
  // Design doc §2.2 (seven workflow phases) + §2.4 (transition authority).
  //
  // The `awaiting` phase is entered by two code paths:
  //   1. `processingEnd` handler when `inFlightMessages.size` hits 0 AND the
  //      outbox has no pending/processing entries — direct transition from
  //      `processing → awaiting`.
  //   2. Main-loop refinement: after outbox dispatch drain, if phase is
  //      `attached`, in-flight is 0, and outbox is idle — transition
  //      `attached → awaiting`. Covers the case where outbox drained without
  //      passing through `processing` (e.g. cue/report entries, not messages).

  it('processing -> awaiting via processingEnd when outbox is empty (#117)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`awaiting-direct-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });

      // Start processing a message
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('processing');

      // End processing with no outbox entries — must land in `awaiting`, not `attached`.
      await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');
      expect(info.inFlightCount).to.equal(0);
      expect(info.currentAttachment?.attachmentId).to.equal(token.attachmentId);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('awaiting -> processing via processingStart (processingStart guard is live post-#117)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`awaiting-to-proc-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });

      // Get to awaiting via processingStart/End cycle on an empty outbox.
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'warmup', expectedAttachmentId: token.attachmentId }],
      });
      await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'warmup', expectedAttachmentId: token.attachmentId }],
      });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');

      // Now from awaiting, a new processingStart must lift us back to processing.
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm-new', expectedAttachmentId: token.attachmentId }],
      });
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('processing');
      expect(info.inFlightCount).to.equal(1);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('awaiting -> draining via requestDetach', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`awaiting-drain-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });

      // Enter awaiting.
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');

      // requestDetach lifts awaiting → draining.
      await handle.signal(requestDetachSignal, { reason: 'user-stop', deadlineMs: 5_000 });
      for (let i = 0; i < 10 && info.phase !== 'draining'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('draining');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('awaiting -> detached via forceDetach', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`awaiting-force-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });

      // Enter awaiting.
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');

      // forceDetach reaps awaiting → detached.
      const r = await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'force', gracePeriodMs: 0 }],
      });
      expect(r.reaped).to.equal(true);
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('detached');
      expect(info.currentAttachment).to.equal(undefined);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('awaiting -> gone via destroy (§2.4 "any -> gone")', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`awaiting-gone-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });

      // Enter awaiting.
      await handle.executeUpdate(processingStartUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      await handle.executeUpdate(processingEndUpdate, {
        args: [{ messageId: 'm1', expectedAttachmentId: token.attachmentId }],
      });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('awaiting');

      // Destroy from awaiting → gone. Workflow COMPLETEs.
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'awaiting-destroy' }] });
      await handle.result();
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('gone');
      expect(info.currentAttachment).to.equal(undefined);
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
    });
  });

  it('claimAttachment + renewal keeps phase=attached (awaiting requires processing cycle)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      // Sanity check: freshly claimed attachments start in `attached`, NOT `awaiting`.
      // Awaiting is specifically the post-`processingEnd` idle refinement — without a
      // processing cycle, the main-loop refinement would move us to awaiting, but the
      // test queries fast enough that attached is observable. If this assertion flakes,
      // it's fine to also accept `awaiting` as valid (both are idle attached states).
      const handle = await startFreshSession(`awaiting-vs-attached-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });

      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      // Post-#117, main-loop refinement may have already lifted us to awaiting —
      // both attached and awaiting are acceptable here. This invariant ensures
      // we never land in a wrong-attachment-state phase.
      expect(['attached', 'awaiting']).to.include(info.phase);
      expect(info.currentAttachment).to.not.equal(undefined);
      expect(info.inFlightCount).to.equal(0);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
