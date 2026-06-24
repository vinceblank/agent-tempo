/**
 * #704 Item 1a — booting attach-timeout watchdog.
 *
 * A fresh, ARMED session (headless adapter, no handoff) that never reaches
 * `claimAttachment` within `BOOTING_DEADLINE_MS` flips to terminal `gone` with
 * `lastDetachReason = 'boot-timeout'` and stamps the `AgentTempoCloseReason`
 * tombstone MEMO (read by the bootstrap orphan-guard, Item 1b). The watchdog is
 * DISARMED for interactive `claude-code` (`canBlockOnDialog: true`, until #890)
 * and for handoffs, and never trips once an attachment is claimed.
 *
 * Test env note: `setupTestEnv` uses `createLocal()` (REAL wall-clock time, no
 * time-skipping — see helpers.ts), so these tests use the `bootingDeadlineMs`
 * metadata override to set a short deadline and real-sleep past it.
 *
 * Design reference: docs/design/704-batch-fix-brief.md (Item 1a/1b),
 * docs/design/704-is-demo-companion-brief.md (§2 structural gating).
 */
import { expect } from 'chai';
import type { AttachmentInfo, OrphanSummary } from '../src/types';
import {
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  skipTime,
  claimAttachmentUpdate,
  destroyUpdate,
  isDestroyedQuery,
  attachmentInfoQuery,
  PROTOCOL_VERSION,
  getClient,
} from './helpers';
import { orphanSummaryQuery } from '../src/workflows/signals';
import { MEMO_KEYS } from '../src/utils/search-attributes';

// Short deadline so the watchdog trips within the test window (real time).
const SHORT_DEADLINE_MS = 400;
// Sleep comfortably past the deadline + one loop re-evaluation.
const WAIT_PAST_DEADLINE_MS = 1_200;

describe('session boot-timeout watchdog (#704 Item 1a/1b)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('ARMED headless session that never attaches → gone + boot-timeout reason + tombstone memo', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const playerId = `boot-armed-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({
          playerId,
          // Headless adapter, fresh boot ⇒ armed. `canBlockOnDialog: false` is the
          // resolved descriptor value (omitting it is equivalent / also armed).
          canBlockOnDialog: false,
          bootingDeadlineMs: SHORT_DEADLINE_MS,
        }),
      });

      // Never claim — let the watchdog trip. The workflow COMPLETEs on boot-timeout.
      await handle.result();

      // Terminal phase + reason.
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('gone');
      expect(info.currentAttachment).to.equal(undefined);
      expect(await handle.query(isDestroyedQuery)).to.equal(true);

      const summary: OrphanSummary = await handle.query(orphanSummaryQuery);
      expect(summary.reason).to.equal('boot-timeout');

      // Tombstone MEMO for the orphan-guard (Item 1b).
      const desc = await getClient().workflow.getHandle(handle.workflowId).describe();
      expect(desc.memo?.[MEMO_KEYS.closeReason]).to.equal('boot-timeout');
    });
  });

  it('DISARMED interactive (canBlockOnDialog) session stays booting past the deadline', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const playerId = `boot-disarmed-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({
          playerId,
          // Interactive claude-code can park on the dev-channels dialog ⇒ disarmed.
          canBlockOnDialog: true,
          bootingDeadlineMs: SHORT_DEADLINE_MS,
        }),
      });

      await skipTime(WAIT_PAST_DEADLINE_MS);

      // Must NOT have been swept — interactive recruits keep today's indefinite
      // booting behavior until #890.
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('booting');
      expect(await handle.query(isDestroyedQuery)).to.equal(false);

      // Clean up.
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('a session that CLAIMS before the deadline disarms the watchdog (never trips)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const playerId = `boot-claimed-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({
          playerId,
          canBlockOnDialog: false,
          bootingDeadlineMs: SHORT_DEADLINE_MS,
        }),
      });

      // Claim immediately — this clears `bootingSince`.
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'copilot', adapterClass: 'sdk', leaseMs: 60_000 }],
      });

      // Wait well past the booting deadline; the claimed session must remain.
      await skipTime(WAIT_PAST_DEADLINE_MS);

      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.be.oneOf(['attached', 'awaiting']);
      expect(info.currentAttachment?.attachmentId).to.equal(token.attachmentId);
      expect(await handle.query(isDestroyedQuery)).to.equal(false);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('a HANDOFF session (currentAttachment carried) does not arm the watchdog', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const playerId = `boot-handoff-${Date.now()}`;
      const now = Date.now();
      // Simulate a restart/migrate successor: a carried attachment + non-booting phase.
      const handle = await startSession({
        metadata: playerMetadata({
          playerId,
          canBlockOnDialog: false,
          bootingDeadlineMs: SHORT_DEADLINE_MS,
        }),
        phase: 'attached',
        currentAttachment: {
          attachmentId: 'handoff-att-1',
          hostname: 'host-A',
          adapterId: 'copilot',
          adapterClass: 'sdk',
          claimedAt: new Date(now).toISOString(),
          lastHeartbeatAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          leaseMs: 60_000,
          runId: 'handoff-run-1',
        },
      });

      await skipTime(WAIT_PAST_DEADLINE_MS);

      // The handoff session is `attached`, never `booting`, and must not be swept.
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.not.equal('gone');
      expect(await handle.query(isDestroyedQuery)).to.equal(false);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('destroy stamps the AgentTempoCloseReason="destroyed" tombstone memo (Item 1b)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const playerId = `destroy-memo-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({ playerId, canBlockOnDialog: true }),
      });

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test cleanup' }] });
      await handle.result();

      const desc = await getClient().workflow.getHandle(handle.workflowId).describe();
      expect(desc.memo?.[MEMO_KEYS.closeReason]).to.equal('destroyed');
    });
  });
});
