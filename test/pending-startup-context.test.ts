/**
 * Issue #172 — conductor defers lineup instructions until the user's first
 * message, then delivers a combined prompt (lineup context + release directive
 * + user text).
 *
 * Covers the workflow-level pieces:
 *   - `setPendingStartupContextUpdate` stores context (conductor sessions only)
 *   - `pendingStartupContextQuery` returns the stored value (null when cleared)
 *   - First real user message triggers combined delivery and clears the field
 *   - Subsequent messages pass through unchanged
 *   - System / lineup / maestro / scheduler / conductor senders DO NOT trigger
 *     the release (so the ensemble-ready banner or scheduler fires landing
 *     before the user doesn't prematurely drain the context)
 *   - Non-conductor sessions reject the update (returns `stored: false`)
 */
import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  conductorMetadata,
  receiveMessageSignal,
  allMessagesQuery,
  destroyUpdate,
} from './helpers';
import {
  setPendingStartupContextUpdate,
  pendingStartupContextQuery,
} from '../src/workflows/signals';

describe('pending startup context (#172)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('stores pending context on a conductor and exposes it via query', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: `pending-store-${Date.now()}` }),
      });
      const result = await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'You are the lead conductor.', playersCount: 3 }],
      });
      expect(result.stored).to.equal(true);

      const stored = await handle.query(pendingStartupContextQuery);
      expect(stored).to.deep.equal({
        context: 'You are the lead conductor.',
        playersCount: 3,
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('rejects setPendingStartupContext on non-conductor sessions', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `pending-nonconductor-${Date.now()}` }),
      });
      const result = await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'should be ignored', playersCount: 0 }],
      });
      expect(result.stored).to.equal(false);

      const stored = await handle.query(pendingStartupContextQuery);
      expect(stored).to.equal(null);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it("combines pending context with the user's first real message, then clears the field", async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: `pending-first-msg-${Date.now()}` }),
      });
      await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'LINEUP_CONTEXT_MARKER', playersCount: 2 }],
      });

      // User's first real message.
      await handle.signal(receiveMessageSignal, {
        from: 'user',
        text: 'USER_TASK_MARKER',
      });

      const msgs = await handle.query(allMessagesQuery);
      expect(msgs).to.have.lengthOf(1);
      const combined = msgs[0];
      expect(combined.from).to.equal('user');
      expect(combined.text).to.include('LINEUP_CONTEXT_MARKER');
      expect(combined.text).to.include('USER_TASK_MARKER');
      // The release-players directive prelude MUST be present so the
      // conductor knows to call `release` after decomposing.
      expect(combined.text.toLowerCase()).to.include('release');

      // Pending context is cleared after first-user-message consumes it.
      const stored = await handle.query(pendingStartupContextQuery);
      expect(stored).to.equal(null);

      // A subsequent user message passes through verbatim — NO combining.
      await handle.signal(receiveMessageSignal, {
        from: 'user',
        text: 'SECOND_USER_MESSAGE',
      });
      const msgs2 = await handle.query(allMessagesQuery);
      expect(msgs2).to.have.lengthOf(2);
      expect(msgs2[1].text).to.equal('SECOND_USER_MESSAGE');
      expect(msgs2[1].text).to.not.include('LINEUP_CONTEXT_MARKER');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('does NOT flush pending context on system / lineup / maestro / scheduler / self messages', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: `pending-system-senders-${Date.now()}` }),
      });
      await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'HELD_CONTEXT', playersCount: 1 }],
      });

      // System banner (the "ensemble ready" message) lands first.
      await handle.signal(receiveMessageSignal, {
        from: 'system',
        text: 'Ensemble **x** is ready. 1 player on standby.',
      });
      // A scheduler fire lands before the user speaks.
      await handle.signal(receiveMessageSignal, {
        from: 'scheduler',
        text: 'Scheduled nudge',
      });
      // Another conductor-to-self echo (e.g. self-cue).
      await handle.signal(receiveMessageSignal, {
        from: 'conductor',
        text: 'echo',
      });
      // Maestro dashboard message (explicit flag path).
      await handle.signal(receiveMessageSignal, {
        from: 'some-dashboard',
        text: 'maestro nudge',
        isMaestro: true,
      });
      // Lineup (already deferred but double-check).
      await handle.signal(receiveMessageSignal, {
        from: 'lineup',
        text: 'stray lineup signal',
      });

      // All system/maestro/scheduler/self/lineup traffic was stored verbatim
      // and NONE of them consumed the pending context.
      const before = await handle.query(pendingStartupContextQuery);
      expect(before?.context).to.equal('HELD_CONTEXT');

      // Now the real user speaks — THAT finally flushes the context.
      await handle.signal(receiveMessageSignal, {
        from: 'user',
        text: 'Here is my task',
      });
      const after = await handle.query(pendingStartupContextQuery);
      expect(after).to.equal(null);

      const msgs = await handle.query(allMessagesQuery);
      // 5 system-ish messages stored verbatim + 1 combined user message.
      expect(msgs).to.have.lengthOf(6);
      const userMsg = msgs[msgs.length - 1];
      expect(userMsg.text).to.include('HELD_CONTEXT');
      expect(userMsg.text).to.include('Here is my task');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('no-op interception when conductor has no pending context', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: `pending-none-${Date.now()}` }),
      });
      await handle.signal(receiveMessageSignal, { from: 'user', text: 'plain message' });
      const msgs = await handle.query(allMessagesQuery);
      expect(msgs).to.have.lengthOf(1);
      expect(msgs[0].text).to.equal('plain message');
      expect(msgs[0].from).to.equal('user');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
