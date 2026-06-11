/**
 * Combined intake query (T0.3 of #747, #750) — `pendingIntake` against a live
 * TestWorkflowEnvironment.
 *
 * Locks the wire contract: the combined result is field-for-field identical
 * to the legacy `pendingMessages` + `pendingReset` pair (including the
 * both-pending-simultaneously case), and reflects the unchanged ack surfaces
 * (`markDelivered` / race-safe `ackReset`). The legacy queries remain served
 * alongside — additive, no renames.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
} from './helpers';
import {
  pendingIntakeQuery,
  pendingMessagesQuery,
  pendingResetQuery,
  setPendingResetSignal,
  ackResetSignal,
  receiveMessageSignal,
  markDeliveredSignal,
} from '../src/workflows/signals';
import type { PendingIntake } from '../src/workflows/signals';

describe('pendingIntake combined query (#750)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  useSharedWorker(startOutboxWorker);

  const startFresh = (playerId: string) => startSession({ metadata: playerMetadata({ playerId }) });

  it('fresh session → empty messages + null reset', async function () {
    this.timeout(10_000);
    const h = await startFresh(`intake-fresh-${Date.now()}`);
    const intake = await h.query(pendingIntakeQuery);
    expect(intake).to.deep.equal({ messages: [], pendingReset: null });
  });

  it('messages-only: identical to the legacy pendingMessages result', async function () {
    this.timeout(10_000);
    const h = await startFresh(`intake-msgs-${Date.now()}`);
    await h.signal(receiveMessageSignal, { from: 'alice', text: 'first cue' });
    await h.signal(receiveMessageSignal, { from: 'bob', text: 'second cue' });

    const intake: PendingIntake = await h.query(pendingIntakeQuery);
    const legacy = await h.query(pendingMessagesQuery);

    expect(intake.messages).to.deep.equal(legacy);
    expect(intake.messages.map((m) => m.text)).to.deep.equal(['first cue', 'second cue']);
    expect(intake.pendingReset).to.equal(null);
  });

  it('reset-only: identical to the legacy pendingReset result', async function () {
    this.timeout(10_000);
    const h = await startFresh(`intake-reset-${Date.now()}`);
    await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true, reason: 'stuck', requestedBy: 'conductor' });

    const intake: PendingIntake = await h.query(pendingIntakeQuery);
    const legacy = await h.query(pendingResetQuery);

    expect(intake.pendingReset).to.deep.equal(legacy);
    expect(intake.pendingReset).to.include({ resetId: 'r1', fresh: true, reason: 'stuck' });
    expect(intake.messages).to.deep.equal([]);
  });

  it('BOTH pending simultaneously → one query returns both (the pump tick case)', async function () {
    this.timeout(10_000);
    const h = await startFresh(`intake-both-${Date.now()}`);
    await h.signal(receiveMessageSignal, { from: 'alice', text: 'cue while reset pending' });
    await h.signal(setPendingResetSignal, { resetId: 'r-both', fresh: true });

    const intake: PendingIntake = await h.query(pendingIntakeQuery);
    expect(intake.messages).to.have.length(1);
    expect(intake.messages[0].text).to.equal('cue while reset pending');
    expect(intake.pendingReset?.resetId).to.equal('r-both');

    // Field-for-field parity with the legacy pair in the same state.
    expect(intake.messages).to.deep.equal(await h.query(pendingMessagesQuery));
    expect(intake.pendingReset).to.deep.equal(await h.query(pendingResetQuery));
  });

  it('reflects the unchanged ack surfaces: markDelivered + race-safe ackReset', async function () {
    this.timeout(10_000);
    const h = await startFresh(`intake-acks-${Date.now()}`);
    await h.signal(receiveMessageSignal, { from: 'alice', text: 'to be delivered' });
    await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true });

    const before: PendingIntake = await h.query(pendingIntakeQuery);
    expect(before.messages).to.have.length(1);
    const msgId = before.messages[0].id;

    // Stale/foreign ackReset must NOT clear the slot (race-safe id-match).
    await h.signal(ackResetSignal, 'r-other');
    expect((await h.query(pendingIntakeQuery)).pendingReset?.resetId).to.equal('r1');

    await h.signal(markDeliveredSignal, [msgId]);
    await h.signal(ackResetSignal, 'r1');

    const after: PendingIntake = await h.query(pendingIntakeQuery);
    expect(after).to.deep.equal({ messages: [], pendingReset: null });
  });
});
