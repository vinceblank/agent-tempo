import { expect } from 'chai';
import { OutboxEntry, Message, SessionMetadata } from '../src/types';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  withWorkerAndOutboxActivities,
  startSession,
  playerMetadata,
  getMetadataQuery,
  pendingMessagesQuery,
  markDeliveredSignal,
  processingStartUpdate,
  processingEndUpdate,
  inFlightMessagesQuery,
  destroyUpdate,
  updateMetadataSignal,
  submitOutboxUpdate,
} from './helpers';

/** Outbox seed — wakes the main loop so stale detection runs an iteration. */
function seedOutbox(): OutboxEntry[] {
  return [{
    id: 'seed-probe',
    type: 'cue',
    targetPlayerId: '_probe',
    message: '_wake',
    createdAt: new Date().toISOString(),
    status: 'pending',
  }];
}

/** Deliver all pending messages so the workflow can exit cleanly. */
async function deliverAll(handle: any): Promise<void> {
  const msgs = await handle.query(pendingMessagesQuery);
  const ids = (msgs as Message[]).filter((m) => !m.delivered).map((m) => m.id);
  if (ids.length > 0) await handle.signal(markDeliveredSignal, ids);
}

describe('processing lifecycle — fixes #99 (long tool calls misclassified as stale)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('tracks in-flight messages via processingStart/End', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'proc-track' }),
      });

      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'msg-1' }] });
      expect(await handle.query(inFlightMessagesQuery)).to.deep.equal(['msg-1']);

      await handle.executeUpdate(processingEndUpdate, { args: [{ messageId: 'msg-1' }] });
      expect(await handle.query(inFlightMessagesQuery)).to.be.empty;

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('processingStart/End are idempotent — duplicate messageIds do not corrupt state', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'proc-idem' }),
      });

      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'msg-a' }] });
      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'msg-a' }] }); // retry
      expect(await handle.query(inFlightMessagesQuery)).to.deep.equal(['msg-a']); // set dedupes

      await handle.executeUpdate(processingEndUpdate, { args: [{ messageId: 'msg-a' }] });
      await handle.executeUpdate(processingEndUpdate, { args: [{ messageId: 'msg-a' }] }); // idempotent
      expect(await handle.query(inFlightMessagesQuery)).to.be.empty;

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('rejects processingStart with missing messageId (validator)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'proc-val' }),
      });

      let rejected = false;
      try {
        await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: '' }] });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, 'expected validator rejection for empty messageId');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('tracks multiple concurrent in-flight messages', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'proc-multi' }),
      });

      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'a' }] });
      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'b' }] });
      await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'c' }] });

      expect(await handle.query(inFlightMessagesQuery)).to.have.members(['a', 'b', 'c']);

      await handle.executeUpdate(processingEndUpdate, { args: [{ messageId: 'b' }] });
      expect(await handle.query(inFlightMessagesQuery)).to.have.members(['a', 'c']);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('suppresses stale detection while a message is in-flight, then resumes once released (#99)', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      // Pre-seed a 5-minute-old undelivered message (would normally trigger stale detection,
      // since the threshold is 3 minutes) and pre-populate inFlightMessageIds so the very
      // first main-loop iteration treats the adapter as processing.
      const oldMsg: Message = {
        id: 'msg-1',
        from: 'conductor',
        text: 'Do a long task',
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
        delivered: false,
      };

      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'proc-stale', status: 'active' }),
        disableStaleDetection: false,
        messages: [oldMsg],
        inFlightMessageIds: ['msg-1'],
        processingSince: now - 5 * 60 * 1000,
        // Seed the outbox so the main loop wakes on first iteration and runs stale check.
        outbox: seedOutbox(),
      });

      // Give the workflow a beat to run its first main-loop iteration.
      await new Promise((r) => setTimeout(r, 2000));
      const meta1: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta1.status).to.not.equal('stale');
      expect(await handle.query(inFlightMessagesQuery)).to.deep.equal(['msg-1']);

      // End processing — next iteration should let stale detection fire.
      await handle.executeUpdate(processingEndUpdate, { args: [{ messageId: 'msg-1' }] });
      // Submit another outbox seed to wake the loop again.
      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: '_probe2', message: '_wake2' }],
      });
      await new Promise((r) => setTimeout(r, 2000));

      const meta2: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta2.status).to.equal('stale');

      // Cleanup: deliver pending messages, then destroy. v0.25 destroy (§2.5) is
      // "abandon and COMPLETE" — no drain-wait — so no signals after destroy.
      await deliverAll(handle);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
