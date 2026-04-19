/**
 * PR-A phase machine — detach/destroy/orphan cluster.
 *
 * Split out of `session-phase-machine.test.ts` for shard balance (#233).
 * This file owns the phase-exit paths out of the attached lifecycle:
 * `requestDetach` (with adapterExited AND drainingDeadline elapsed),
 * `forceDetach` idempotency, the `destroy → gone` terminal path + its
 * WorkflowGone effects on subsequent claimAttachment, the
 * `setPreferredHost + orphanSummary` round-trip, and the pre-seeded
 * expired-lease reap-on-boot invariant.
 *
 * The two `skipTime`-based tests (drainingDeadline timeout + default 5s
 * window) live here together so any future migration to the Temporal
 * test server's `createTimeSkipping()` mode is one-file scope. These
 * are the two tests driving the `~48s` wall-clock for this file — the
 * other 7 are in the ~1s range.
 *
 * Companion files:
 *   - session-phase-claim.test.ts        — claim/lease mechanics
 *   - session-phase-processing.test.ts   — processing/awaiting (#117)
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§2.2-2.6, §9.2.
 */
import { expect } from 'chai';
import type { Attachment, AttachmentInfo, OrphanSummary } from '../src/types';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
  isDestroyedQuery,
  skipTime,
} from './helpers';
import {
  claimAttachmentUpdate,
  forceDetachUpdate,
  requestDetachSignal,
  adapterExitedSignal,
  attachmentInfoQuery,
  orphanSummaryQuery,
  setPreferredHostUpdate,
} from '../src/workflows/signals';

describe('session phase machine — detach/destroy (v0.25 PR-A)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  // Helper: start a fresh session in booting phase. Duplicated across each of
  // the #233 split files; per tempo-architect's plan it's cheaper to copy the
  // 3 lines than to introduce a new shared fixture surface.
  async function startFreshSession(playerId: string) {
    return startSession({ metadata: playerMetadata({ playerId }) });
  }

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

  it('attached -> detached via drainingDeadline timeout (no adapterExited) — #159 Gap 1', async function () {
    // Regression test for issue #159: when `requestDetach` fires and the adapter never
    // acknowledges, the workflow MUST auto-promote draining -> detached after the caller-
    // supplied deadline. Pre-fix: the signal handler ignored `deadlineMs` and the main
    // loop was sleeping on a far-away lease-expiry timer, so the workflow stayed in
    // `draining` for 30+ seconds past the requested grace window.
    this.timeout(30_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`drain-deadline-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        // Long lease — without the Gap 1b wake-epoch fix, the main loop would sleep on
        // the ~10 min lease timer and miss the 2s drain deadline entirely.
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 600_000 }],
      });

      // Request graceful detach with a short custom deadline. The pre-fix code threw
      // this value away and used a hardcoded 5s, so this assertion also exercises the
      // Gap 1a fix (honoring `deadlineMs` from the signal).
      await handle.signal(requestDetachSignal, { reason: 'user-stop', deadlineMs: 2_000 });

      // Confirm the transition to draining was applied.
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      for (let i = 0; i < 10 && info.phase !== 'draining'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('draining');

      // Before the deadline elapses we should still be in `draining` — the timer
      // hasn't fired yet. skipTime uses the test server's time-skipping clock so this
      // doesn't actually sleep.
      await skipTime(1_000);
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase, 'phase should still be draining before deadline').to.equal('draining');

      // Push past the deadline. The main loop must wake on its deadline-race timer,
      // notice the drain elapsed, and promote the phase.
      await skipTime(2_000);
      // Poll briefly — the promotion runs on the workflow task after skipTime advances
      // the clock, so it may not be reflected in the very first query.
      for (let i = 0; i < 20 && info.phase !== 'detached'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase, 'drainingDeadline should have promoted phase to detached').to.equal('detached');
      expect(info.currentAttachment).to.equal(undefined);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('requestDetach with omitted deadlineMs falls back to the default 5s window', async function () {
    // Coverage for the "default is preserved" branch of #159 Gap 1a. Some callers (older
    // wire protocol consumers, test harnesses) still signal without `deadlineMs`; the
    // workflow should behave exactly as before those callers for that path.
    this.timeout(20_000);
    await withWorker(async () => {
      const handle = await startFreshSession(`drain-default-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 600_000 }],
      });

      // Intentionally cast to bypass the typed signature so we can simulate a legacy
      // caller that omits `deadlineMs`. The handler treats non-finite/missing values
      // as "use default".
      await handle.signal(requestDetachSignal, { reason: 'user-stop' } as any);

      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      for (let i = 0; i < 10 && info.phase !== 'draining'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('draining');

      // Default window is 5s — still draining at 3s.
      await skipTime(3_000);
      info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('draining');

      // Past 5s (total 6s) — auto-promoted.
      await skipTime(3_000);
      for (let i = 0; i < 20 && info.phase !== 'detached'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('detached');

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

  it('expired pre-seeded attachment is reaped on boot: phase -> detached, reason -> heartbeat-timeout', async function () {
    this.timeout(10_000);
    // Exercises §9.5.a lease-expiry reap phase-agnostically. Pre-seeded via
    // SessionInput.currentAttachment (CAN-boundary style) with expiresAt in the
    // past, the workflow's first main-loop tick should reap. This also validates
    // that the reap path is live for `awaiting` / `processing` / `attached`
    // callers — the commit-5-deferred heartbeat-timeout wiring noted that the
    // existing §9.5.a code already handles all phases phase-agnostically.
    await withWorker(async () => {
      const now = Date.now();
      const expiredAttachment: Attachment = {
        attachmentId: 'pre-seeded-expired',
        hostname: 'host-expired',
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: new Date(now - 120_000).toISOString(),
        lastHeartbeatAt: new Date(now - 90_000).toISOString(),
        expiresAt: new Date(now - 30_000).toISOString(), // expired 30s ago
        leaseMs: 30_000,
        runId: 'pre-seeded-run',
      };

      const handle = await startSession({
        metadata: playerMetadata({ playerId: `hb-reap-${Date.now()}` }),
        currentAttachment: expiredAttachment,
        phase: 'attached',
      });

      // Poll briefly — the main loop should wake and reap on first iteration.
      let info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      for (let i = 0; i < 20 && info.phase === 'attached'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        info = await handle.query(attachmentInfoQuery);
      }
      expect(info.phase).to.equal('detached');
      expect(info.currentAttachment).to.equal(undefined);

      const summary: OrphanSummary = await handle.query(orphanSummaryQuery);
      expect(summary.reason).to.equal('heartbeat-timeout');
      expect(summary.lastAdapter?.hostname).to.equal('host-expired');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
