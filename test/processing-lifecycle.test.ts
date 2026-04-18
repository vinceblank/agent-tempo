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

  // #99 regression test deleted in #178: the `stale` detection heuristic it
  // exercised was removed entirely in #175. The failure mode it prevented
  // (long tool calls misclassified as stale) is now structurally impossible —
  // the phase machine tracks in-flight work via `processingStart`/`processingEnd`
  // and the 3-minute stale heuristic doesn't exist anymore. The
  // `processingStart`/`processingEnd` → `inFlightMessages` contract is covered
  // by the sibling `suspendOnProcessingStart` test above.
});
