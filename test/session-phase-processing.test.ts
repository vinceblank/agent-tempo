/**
 * PR-A phase machine — processing/awaiting cluster.
 *
 * Split out of `session-phase-machine.test.ts` for shard balance (#233).
 * This file owns the `processing` and `awaiting` phase transitions from
 * the #117 design: `attached → processing → awaiting` via
 * processingStart/End, the supersession guard on processingStart, and
 * the four awaiting-exit paths (→ processing, → draining, → detached
 * via forceDetach, → gone via destroy).
 *
 * Companion files:
 *   - session-phase-claim.test.ts   — claim/lease mechanics
 *   - session-phase-detach.test.ts  — requestDetach/drain/destroy/orphan
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§2.2-2.6, §9.2.
 */
import { expect } from 'chai';
import type { AttachmentInfo } from '../src/types';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
  processingStartUpdate,
  processingEndUpdate,
  isDestroyedQuery,
  PROTOCOL_VERSION,
} from './helpers';
import {
  claimAttachmentUpdate,
  forceDetachUpdate,
  requestDetachSignal,
  attachmentInfoQuery,
} from '../src/workflows/signals';

describe('session phase machine — processing/awaiting (v0.25 PR-A)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // Helper: start a fresh session in booting phase. Duplicated across each of
  // the #233 split files; per tempo-architect's plan it's cheaper to copy the
  // 3 lines than to introduce a new shared fixture surface.
  async function startFreshSession(playerId: string) {
    return startSession({ metadata: playerMetadata({ playerId }) });
  }

  it('attached -> processing -> awaiting via processingStart/End (#117 fix)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`proc-phase-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      // Force-detach; then claim fresh.
      await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'restart', gracePeriodMs: 0 }],
      });
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-B', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
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
});
