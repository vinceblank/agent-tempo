/**
 * #910 — at-least-once outbox delivery dedup.
 *
 * The outbox dispatch loop delivers `cue` / `report` at-least-once: a
 * continueAsNew (or worker crash) landing after the delivery signal applies
 * server-side but before the entry's `delivered` status commits — or an
 * activity retry after a successful server-side signal — re-fires the same
 * `receiveMessage` / `playerReport` signal. The receiver dedups on the
 * originating outbox entry `id` (threaded as `deliveryId`) via a bounded FIFO
 * ring carried across CAN.
 *
 * These tests drive the receiver signals DIRECTLY (the dedup lives in the
 * receiver workflow handlers, independent of the activity), asserting:
 *   - a repeated `deliveryId` is a no-op (cue + report),
 *   - distinct ids and un-threaded (no-id) deliveries are NOT deduped,
 *   - a `seenDeliveryIds` ring restored from a CAN payload still dedups
 *     (the CAN-survival acceptance criterion).
 *
 * Design reference: issue #910.
 */
import { expect } from 'chai';
import type { Message } from '../src/types';
import {
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  conductorMetadata,
  destroyUpdate,
} from './helpers';
import {
  receiveMessageSignal,
  playerReportSignal,
  allMessagesQuery,
} from '../src/workflows/signals';

describe('session at-least-once delivery dedup (#910)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // Poll until the message count settles (signals apply asynchronously relative
  // to the test client). Returns the final message list.
  async function settledMessages(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: any,
    expectedLen: number,
  ): Promise<Message[]> {
    let msgs: Message[] = await handle.query(allMessagesQuery);
    for (let i = 0; i < 20 && msgs.length < expectedLen; i++) {
      await new Promise((r) => setTimeout(r, 100));
      msgs = await handle.query(allMessagesQuery);
    }
    // One extra settle pass so a (buggy) duplicate would have landed too.
    await new Promise((r) => setTimeout(r, 150));
    return handle.query(allMessagesQuery);
  }

  it('cue: a repeated deliveryId is dropped; distinct + un-threaded deliveries apply', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({ metadata: playerMetadata({ playerId: `dedup-cue-${Date.now()}` }) });

      // d1 twice (duplicate redelivery), d2 once, then two un-threaded (no id).
      await handle.signal(receiveMessageSignal, { from: 'alice', text: 'first', deliveryId: 'd1', responseRequested: false });
      await handle.signal(receiveMessageSignal, { from: 'alice', text: 'first', deliveryId: 'd1', responseRequested: false });
      await handle.signal(receiveMessageSignal, { from: 'alice', text: 'second', deliveryId: 'd2', responseRequested: false });
      await handle.signal(receiveMessageSignal, { from: 'alice', text: 'no-id-a', responseRequested: false });
      await handle.signal(receiveMessageSignal, { from: 'alice', text: 'no-id-b', responseRequested: false });

      // Expect 4: d1 (once, deduped) + d2 (once) + 2 un-threaded.
      const msgs = await settledMessages(handle, 4);
      const fromAlice = msgs.filter((m) => m.from === 'alice');
      expect(fromAlice.length, 'duplicate deliveryId must not double-apply').to.equal(4);
      expect(fromAlice.filter((m) => m.text === 'first').length, 'd1 applied exactly once').to.equal(1);
      expect(fromAlice.filter((m) => m.text === 'second').length).to.equal(1);
      // Un-threaded (no deliveryId) deliveries are never deduped — both land.
      expect(fromAlice.filter((m) => m.text.startsWith('no-id')).length, 'no-id deliveries are not deduped').to.equal(2);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('report: a repeated deliveryId is dropped on the conductor receiver', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({ metadata: conductorMetadata({ playerId: `dedup-report-${Date.now()}` }) });

      // playerReport pushes a `[type] text` self-message from the reporter on
      // each apply — a duplicate deliveryId must add only one.
      await handle.signal(playerReportSignal, { playerId: 'bob', text: 'done', type: 'result', deliveryId: 'r1' });
      await handle.signal(playerReportSignal, { playerId: 'bob', text: 'done', type: 'result', deliveryId: 'r1' });
      await handle.signal(playerReportSignal, { playerId: 'bob', text: 'blocked', type: 'blocker', deliveryId: 'r2' });

      const msgs = await settledMessages(handle, 2);
      const fromBob = msgs.filter((m) => m.from === 'bob');
      expect(fromBob.length, 'duplicate report deliveryId must not double-apply').to.equal(2);
      expect(fromBob.filter((m) => m.text.includes('done')).length, 'r1 applied once').to.equal(1);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('a seenDeliveryIds ring restored from a CAN payload still dedups', async function () {
    // CAN-survival acceptance: pre-seed the receiver with a `seenDeliveryIds`
    // ring (as a continueAsNew successor would rehydrate it). A redelivery whose
    // id is in the restored ring is dropped; a fresh id applies.
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `dedup-can-${Date.now()}` }),
        seenDeliveryIds: ['restored-dup'],
      });

      await handle.signal(receiveMessageSignal, { from: 'carol', text: 'replayed', deliveryId: 'restored-dup', responseRequested: false });
      await handle.signal(receiveMessageSignal, { from: 'carol', text: 'fresh', deliveryId: 'fresh-1', responseRequested: false });

      const msgs = await settledMessages(handle, 1);
      const fromCarol = msgs.filter((m) => m.from === 'carol');
      expect(fromCarol.length, 'restored-ring id dropped; fresh id applied').to.equal(1);
      expect(fromCarol[0].text).to.equal('fresh');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
