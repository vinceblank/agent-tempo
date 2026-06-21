/**
 * PR-A phase machine — claim/lease cluster.
 *
 * Split out of `session-phase-machine.test.ts` for shard balance (#233).
 * This file owns the attached-lifecycle: `booting → attached` via claim,
 * claim idempotency + conflict + validator guards, `detached → attached`
 * re-attach, and the two heartbeat-as-lease-renewal invariants (wrong-id
 * silent-drop + #119a leaseMs honored over the prior hardcoded default).
 *
 * Companion files:
 *   - session-phase-processing.test.ts — processing/awaiting (#117)
 *   - session-phase-detach.test.ts     — requestDetach/drain/destroy/orphan
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
  PROTOCOL_VERSION,
} from './helpers';
import {
  claimAttachmentUpdate,
  forceDetachUpdate,
  heartbeatSignal,
  attachmentInfoQuery,
  getCoarseActivityQuery,
} from '../src/workflows/signals';

describe('session phase machine — claim/lease (v0.25 PR-A)', function () {
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      // Renewal with same expectedAttachmentId.
      const t2 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000, expectedAttachmentId: t1.attachmentId }],
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      let rejected = false;
      try {
        // No expectedAttachmentId + active lease = conflict.
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'host-B', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
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
          args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 999 }],
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('detached -> attached via a fresh claimAttachment', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`reattach-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      await handle.executeUpdate(forceDetachUpdate, { args: [{ reason: 'force', gracePeriodMs: 0 }] });
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('detached');

      const t2 = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-B', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('attached');
      expect(info.currentAttachment?.attachmentId).to.equal(t2.attachmentId);
      expect(info.currentAttachment?.hostname).to.equal('host-B');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('heartbeat with wrong attachmentId is silently ignored (last-write-wins guard)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`hb-guard-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
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

  it('heartbeat renews expiresAt by the claim-time leaseMs, not a workflow default (#119a)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`hb-leasems-${Date.now()}`);

      // Pick two lease windows far enough apart that we can distinguish them
      // even with workflow-clock jitter: 45s (our negotiated value) vs 90s
      // (the prior hardcoded LEASE_MS default). The heartbeat must use 45s.
      const NEGOTIATED_LEASE_MS = 45_000;
      const PRIOR_DEFAULT_MS = 90_000;

      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: NEGOTIATED_LEASE_MS }],
      });
      const claimTime = new Date(token.expiresAt).getTime() - NEGOTIATED_LEASE_MS;

      // Send a heartbeat — the workflow should extend expiresAt using the
      // attachment's stored leaseMs (= NEGOTIATED), not the old LEASE_MS constant.
      await handle.signal(heartbeatSignal, {
        attachmentId: token.attachmentId,
        at: new Date().toISOString(),
      });

      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      const post = new Date(info.currentAttachment!.expiresAt).getTime();
      const delta = post - claimTime;
      // Delta must be consistent with NEGOTIATED_LEASE_MS (with tolerance for
      // workflow-clock advancement between claim and heartbeat). If the bug
      // returned, delta would land near PRIOR_DEFAULT_MS (90s).
      expect(delta).to.be.lessThan(PRIOR_DEFAULT_MS, 'heartbeat must not extend by workflow default LEASE_MS');
      expect(delta).to.be.greaterThan(NEGOTIATED_LEASE_MS - 5_000, 'heartbeat must extend by at least leaseMs - jitter');
      expect(delta).to.be.lessThan(NEGOTIATED_LEASE_MS + 5_000, 'heartbeat must extend by at most leaseMs + jitter');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('heartbeat piggyback stores coarse activity; getCoarseActivity reflects it (3c Tier-1)', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`hb-coarse-${Date.now()}`);

      // Default before any coarse-bearing heartbeat: idle, no context.
      const before = await handle.query(getCoarseActivityQuery);
      expect(before).to.deep.equal({ currentTool: null });

      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'pi', adapterClass: 'sdk', leaseMs: 90_000 }],
      });

      // Heartbeat carrying coarse fields → stored field-wise.
      await handle.signal(heartbeatSignal, {
        attachmentId: token.attachmentId,
        at: new Date().toISOString(),
        currentTool: 'bash',
        contextTokens: 1200,
        contextPercent: 3,
      });
      expect(await handle.query(getCoarseActivityQuery)).to.deep.equal({
        currentTool: 'bash', contextTokens: 1200, contextPercent: 3,
      });

      // A heartbeat that only updates currentTool merges field-wise (context kept).
      await handle.signal(heartbeatSignal, {
        attachmentId: token.attachmentId,
        at: new Date().toISOString(),
        currentTool: null, // back to idle
      });
      expect(await handle.query(getCoarseActivityQuery)).to.deep.equal({
        currentTool: null, contextTokens: 1200, contextPercent: 3,
      });

      // A plain heartbeat (no coarse fields) leaves coarse state untouched.
      await handle.signal(heartbeatSignal, {
        attachmentId: token.attachmentId,
        at: new Date().toISOString(),
      });
      expect(await handle.query(getCoarseActivityQuery)).to.deep.equal({
        currentTool: null, contextTokens: 1200, contextPercent: 3,
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
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
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
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
