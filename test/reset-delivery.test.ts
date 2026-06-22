/**
 * Reset delivery (D14) — context clean-wipe poll-delivery.
 *
 * Exercises the workflow surface against a live TestWorkflowEnvironment:
 *   - set → query → ack: setPendingReset sets the flag (workflow-stamped
 *     requestedAt), pendingReset query returns it, ackReset(resetId) clears it.
 *   - race-safe ack: ackReset with a NON-matching id does NOT clear (so a newer
 *     reset landing during the extension's wipe isn't dropped).
 *   - latest-wins: a second setPendingReset replaces the prior (single-slot).
 *   - end-to-end: the `reset` tool path — submit a ResetOutboxEntry on player A
 *     → the dispatch loop runs deliverReset → sets pendingReset on player B,
 *     keyed by the outbox entry id.
 *
 * CAN-survival is enforced structurally by the type-checked
 * `SessionInput.pendingReset` carry field (removing the carry block surfaces as
 * a TS error), mirroring the player-state suite's rationale.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
  submitOutboxUpdate,
  outboxQuery,
  pollWithTimeout,
} from './helpers';
import {
  setPendingResetSignal,
  pendingIntakeQuery,
  ackResetSignal,
} from '../src/workflows/signals';
import type { PendingReset } from '../src/types';

const POLL_DELIVERY_MS = 10_000;

describe('reset delivery (D14)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  useSharedWorker(startOutboxWorker);

  const startFresh = (playerId: string) => startSession({ metadata: playerMetadata({ playerId }) });

  describe('pendingReset — set / query / ack', function () {
    it('setPendingReset → query returns it with a workflow-stamped requestedAt', async function () {
      this.timeout(10_000);
      const h = await startFresh(`reset-sq-${Date.now()}`);
      await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true, reason: 'stuck', requestedBy: 'conductor' });
      const pr = (await h.query(pendingIntakeQuery)).pendingReset;
      expect(pr, 'pendingReset').to.not.equal(null);
      const reset = pr as PendingReset;
      expect(reset).to.include({ resetId: 'r1', fresh: true, reason: 'stuck', requestedBy: 'conductor' });
      expect(reset.requestedAt).to.be.a('string').and.match(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('ackReset(resetId) clears the pending reset', async function () {
      this.timeout(10_000);
      const h = await startFresh(`reset-ack-${Date.now()}`);
      await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true });
      await h.signal(ackResetSignal, 'r1');
      expect((await h.query(pendingIntakeQuery)).pendingReset).to.equal(null);
    });

    it('ackReset with a NON-matching id does NOT clear (race-safe)', async function () {
      this.timeout(10_000);
      const h = await startFresh(`reset-race-${Date.now()}`);
      await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true });
      await h.signal(ackResetSignal, 'r2'); // stale/foreign ack — must NOT clear r1
      expect((await h.query(pendingIntakeQuery)).pendingReset?.resetId).to.equal('r1');
      await h.signal(ackResetSignal, 'r1'); // matching ack clears
      expect((await h.query(pendingIntakeQuery)).pendingReset).to.equal(null);
    });

    it('is latest-wins (a newer setPendingReset replaces the prior)', async function () {
      this.timeout(10_000);
      const h = await startFresh(`reset-lww-${Date.now()}`);
      await h.signal(setPendingResetSignal, { resetId: 'r1', fresh: true });
      await h.signal(setPendingResetSignal, { resetId: 'r2', fresh: true, reason: 'newer' });
      const pr = (await h.query(pendingIntakeQuery)).pendingReset;
      expect(pr?.resetId).to.equal('r2');
      expect(pr?.reason).to.equal('newer');
    });
  });

  describe('outbox delivery — reset tool → outbox → target', function () {
    it('a reset outbox entry sets pendingReset on the target (keyed by entry id)', async function () {
      this.timeout(45_000);
      const alice = await startFresh('alice-reset');
      const bob = await startFresh('bob-reset');

      const entryId = await alice.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'reset', targetPlayerId: 'bob-reset', invokerPlayerId: 'alice-reset', fresh: true, reason: 'wipe' }],
      });

      await pollWithTimeout(async () => {
        const pr = (await bob.query(pendingIntakeQuery)).pendingReset;
        const ob = await alice.query(outboxQuery);
        return pr !== null && ob.find((e) => e.type === 'reset')?.status === 'delivered';
      }, POLL_DELIVERY_MS);

      const pr = (await bob.query(pendingIntakeQuery)).pendingReset;
      expect(pr, 'bob pendingReset').to.not.equal(null);
      expect(pr!.resetId).to.equal(entryId); // resetId === the originating outbox entry id
      expect(pr!.fresh).to.equal(true);
      expect(pr!.reason).to.equal('wipe');
      expect(pr!.requestedBy).to.equal('alice-reset');

      const aliceOutbox = await alice.query(outboxQuery);
      const delivered = aliceOutbox.find((e) => e.type === 'reset');
      expect(delivered).to.exist;
      expect(delivered!.status).to.equal('delivered');
    });
  });
});
