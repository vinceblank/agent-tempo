/**
 * #897 — spawn identity (A) + sessionId-match claim guard (B1).
 *
 * A: `spawnRecord` (host/pid/sessionId/spawnedAt) is persisted on the workflow,
 *    carried across continueAsNew (via SessionInput rehydration), and surfaced on
 *    the existing `orphanSummary` query.
 * B1: `claimAttachment` rejects a claim with `SessionIdMismatch` ONLY when both
 *    the claimant's `sessionId` AND the workflow's `metadata.sessionId` are
 *    present and differ; unset on either side → allowed (back-compat).
 *
 * Design reference: issue #897 (A+B).
 */
import { expect } from 'chai';
import type { AttachmentInfo, OrphanSummary } from '../src/types';
import {
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
  attachmentInfoQuery,
  orphanSummaryQuery,
  enqueueSpawnUpdate,
  outboxQuery,
  setPausedSignal,
} from '../src/workflows/signals';
import type { OutboxEntry } from '../src/types';

const claimArgs = (sessionId?: string) => ({
  host: 'host-A',
  adapterId: 'claude-code',
  adapterClass: 'interactive' as const,
  leaseMs: 60_000,
  protocolVersion: PROTOCOL_VERSION,
  ...(sessionId !== undefined ? { sessionId } : {}),
});

describe('session spawn identity + sessionId-match guard (#897)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('B1: rejects a claim whose sessionId differs from metadata.sessionId (SessionIdMismatch)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `sid-mismatch-${Date.now()}`, sessionId: 'sess-1' }),
      });
      let rejected = false;
      let chain = '';
      try {
        await handle.executeUpdate(claimAttachmentUpdate, { args: [claimArgs('sess-OTHER')] });
      } catch (err) {
        rejected = true;
        // The client wraps the validator's ApplicationFailure as a generic
        // "Workflow Update failed"; the typed message/`SessionIdMismatch` rides
        // on the cause chain.
        const parts: string[] = [];
        let e: unknown = err;
        for (let i = 0; i < 5 && e instanceof Error; i++) {
          parts.push(e.message);
          e = (e as { cause?: unknown }).cause;
        }
        chain = parts.join(' | ');
      }
      expect(rejected, 'mismatched sessionId claim must be rejected').to.equal(true);
      expect(chain).to.match(/SessionIdMismatch|sessionId/);

      // The session must remain unattached (the rejected claim created nothing).
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.currentAttachment).to.equal(undefined);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('B1: allows a claim whose sessionId matches metadata.sessionId', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `sid-match-${Date.now()}`, sessionId: 'sess-1' }),
      });
      const token = await handle.executeUpdate(claimAttachmentUpdate, { args: [claimArgs('sess-1')] });
      expect(token.attachmentId).to.be.a('string');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('B1: allows a claim with no sessionId (legacy adapter — back-compat)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `sid-unset-claim-${Date.now()}`, sessionId: 'sess-1' }),
      });
      const token = await handle.executeUpdate(claimAttachmentUpdate, { args: [claimArgs()] });
      expect(token.attachmentId).to.be.a('string');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('B1: allows any sessionId when metadata.sessionId is unset (fresh session)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `sid-meta-unset-${Date.now()}` }), // no sessionId
      });
      const token = await handle.executeUpdate(claimAttachmentUpdate, { args: [claimArgs('sess-anything')] });
      expect(token.attachmentId).to.be.a('string');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('A: a spawnRecord restored from a CAN payload is surfaced on orphanSummary', async function () {
    // Pre-seed `spawnRecord` via SessionInput (the continueAsNew-rehydration
    // shape) and assert the existing `orphanSummary` query surfaces it — covering
    // both the CAN carry and the query extension.
    this.timeout(15_000);
    await withWorker(async () => {
      const spawnRecord = {
        hostname: 'host-A',
        pid: 4242,
        sessionId: 'sess-spawn-1',
        spawnedAt: '2026-06-28T00:00:00.000Z',
      };
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `spawnrec-${Date.now()}` }),
        spawnRecord,
      });

      const summary: OrphanSummary = await handle.query(orphanSummaryQuery);
      expect(summary.spawnRecord).to.deep.equal(spawnRecord);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('D: enqueueSpawn dedups on the originating restart-entry-id (no double-spawn)', async function () {
    // Pause the session so spawn entries stay `pending` (not dispatched), then
    // enqueue twice with the SAME originId — the second must return the FIRST
    // spawnEntryId and NOT push a duplicate. A different originId enqueues fresh.
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `spawn-dedup-${Date.now()}` }),
      });
      // Hold the outbox so the pending spawn entries aren't dispatched mid-test.
      await handle.signal(setPausedSignal, true);

      const spawnArgs = (originId: string) => ({
        host: 'host-A',
        attachmentId: `att-${originId}`,
        runId: `run-${originId}`,
        resume: false,
        adapterId: 'claude-code',
        originId,
      });

      const first = await handle.executeUpdate(enqueueSpawnUpdate, { args: [spawnArgs('R1')] });
      const dup = await handle.executeUpdate(enqueueSpawnUpdate, { args: [spawnArgs('R1')] });
      const other = await handle.executeUpdate(enqueueSpawnUpdate, { args: [spawnArgs('R2')] });

      expect(dup.spawnEntryId, 'duplicate originId returns the first spawnEntryId').to.equal(first.spawnEntryId);
      expect(other.spawnEntryId, 'a different originId enqueues a fresh spawn').to.not.equal(first.spawnEntryId);

      const outbox: OutboxEntry[] = await handle.query(outboxQuery);
      const spawns = outbox.filter((e) => e.type === 'spawn');
      // Exactly two spawn entries (R1 once, R2 once) — the R1 duplicate was deduped.
      expect(spawns.length, 'R1 duplicate must not create a second spawn entry').to.equal(2);
      const r1Spawns = spawns.filter((e) => (e as { originId?: string }).originId === 'R1');
      expect(r1Spawns.length, 'exactly one spawn for originId R1').to.equal(1);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
