/**
 * Issue #172 — conductor defers lineup instructions until the user's first
 * message, then delivers a combined prompt (lineup context + resume-ensemble
 * directive + user text).
 *
 * Covers the workflow-level pieces:
 *   - `setPendingStartupContextUpdate` stores context (conductor sessions only)
 *   - `pendingStartupContextQuery` returns the stored value (null when cleared)
 *   - First real user message triggers combined delivery and clears the field
 *   - Subsequent messages pass through unchanged
 *   - Non-conductor sessions reject the update (returns `stored: false`)
 *
 * Note: there is intentionally no per-sender filter in the handler — the
 * `load_lineup` tool pauses the entire ensemble on the initial-startup path
 * (scheduler + per-session outbox + maestro), so system/scheduler/maestro
 * traffic is halted upstream. Any message that reaches the handler while
 * held is either (a) a user message or (b) a maestro relay that carries a
 * user message through.
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
      // The resume-ensemble directive prelude MUST be present so the
      // conductor knows to call `resume_ensemble` before anything else.
      expect(combined.text.toLowerCase()).to.include('resume_ensemble');

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

  // #172 restart/rejoin idempotency guard: once the first real user message
  // has consumed the held context, subsequent `setPendingStartupContext`
  // updates (e.g. a second `up --lineup` against a post-release conductor)
  // MUST refuse silently — returning `{ stored: false }` rather than
  // re-arming the hold.
  it('setPendingStartupContext returns { stored: false } after the first user message has been consumed', async function () {
    this.timeout(10_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: `pending-idempotency-${Date.now()}` }),
      });

      // Arm + consume the hold normally.
      const first = await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'FIRST_CONTEXT', playersCount: 2 }],
      });
      expect(first.stored).to.equal(true);

      await handle.signal(receiveMessageSignal, {
        from: 'user',
        text: 'first real user message',
      });

      // Cleared after consumption.
      const clearedAfterFirst = await handle.query(pendingStartupContextQuery);
      expect(clearedAfterFirst).to.equal(null);

      // Second attempt to arm MUST be refused (idempotency guard) — the
      // conductor is past initial startup and re-arming would silently
      // corrupt behavior on the conductor's next user message.
      const second = await handle.executeUpdate(setPendingStartupContextUpdate, {
        args: [{ context: 'SECOND_CONTEXT', playersCount: 9 }],
      });
      expect(second.stored).to.equal(false);

      // And the stored value must remain null — NOT re-armed.
      const stillCleared = await handle.query(pendingStartupContextQuery);
      expect(stillCleared).to.equal(null);

      // A subsequent user message passes through verbatim (no combining with
      // SECOND_CONTEXT, which was refused).
      await handle.signal(receiveMessageSignal, {
        from: 'user',
        text: 'post-release message',
      });
      const msgs = await handle.query(allMessagesQuery);
      // [0] = combined first-user prompt; [1] = plain second message.
      expect(msgs).to.have.lengthOf(2);
      expect(msgs[1].text).to.equal('post-release message');
      expect(msgs[1].text).to.not.include('SECOND_CONTEXT');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
