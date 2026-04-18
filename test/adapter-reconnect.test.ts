/**
 * Adapter reconnect tests (#201).
 *
 * Covers the `BaseAttachment` reconnect loop and `InteractiveAttachment`'s
 * opt-in policy. The production bug (pre-#201) was: when the workflow reaped
 * our lease on the laptop-sleep path, the adapter's phase watcher silently
 * observed `phase=detached, currentAttachment=undefined` and never fired
 * terminal. Messages piled up in `pendingMessages` for hours.
 *
 * Tests here pin down the four branches that matter:
 *   1. `shouldReconnect` opt-in values (unit).
 *   2. `abortableSleep` resolves / rejects (unit).
 *   3. Adapter reconnects after a workflow-side `forceDetach` reap (integration).
 *   4. Adapter fires `destroy` terminal when the workflow is destroyed mid-reconnect.
 *
 * Integration tests use a short-heartbeat subclass + shrunk reconnect-timing overrides
 * so the full detach → reap → detect → re-claim → resume-delivery cycle runs in <3s.
 */
import { expect } from 'chai';
import type { WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  getClient,
  receiveMessageSignal,
  allMessagesQuery,
  destroyUpdate,
  forceDetachUpdate,
  attachmentInfoQuery,
} from './helpers';
import { testForceContinueAsNewSignal } from '../src/workflows/signals';
import type { AttachmentInfo, Message, DetachReason } from '../src/types';
import { InteractiveAttachment } from '../src/adapters/claude-code/adapter';
import type { BaseAttachmentOptions } from '../src/adapters/base';

/**
 * Short-heartbeat subclass. Production uses 60 000ms; here we use 400ms so the
 * phase watcher ticks every 2s (5 × heartbeatMs) and `leaseMs = 3 × heartbeatMs
 * = 1200ms` — the minimum `claimAttachment` allows is 1000ms (see
 * session.ts `claimAttachmentUpdate` validator). Reconnect timing is shrunk
 * via `options.reconnectTiming` so the full reclaim cycle runs inside a 15s test.
 */
class FastInteractiveAttachment extends InteractiveAttachment {
  readonly descriptor = {
    adapterId: 'claude-code',
    adapterClass: 'interactive' as const,
    blocksOnLLMTurn: false,
    heartbeatMs: 400,
  };

  /** Test introspection for `shouldReconnect` — the base class method is protected. */
  public reconnectDecides(reason: DetachReason): boolean {
    return this.shouldReconnect(reason);
  }

  /** Test introspection for `abortableSleep`. */
  public sleepAndRace(ms: number): Promise<void> {
    return this.abortableSleep(ms);
  }

  /** Expose teardown so tests can drive lifecycle. */
  public async publicStopV2(reason: DetachReason = 'user-stop'): Promise<void> {
    return this.stopV2Lifecycle(reason, false);
  }
}

/** Poll until `pred(info)` is true or timeout. Returns the final info snapshot. */
async function waitForAttachmentInfo(
  handle: WorkflowHandle,
  pred: (info: AttachmentInfo) => boolean,
  timeoutMs = 5000,
  label = '<predicate>',
): Promise<AttachmentInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: AttachmentInfo | undefined;
  while (Date.now() < deadline) {
    last = await handle.query(attachmentInfoQuery);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}; last info=${JSON.stringify(last)}`,
  );
}

/** Poll until at least one message has been delivered. Used to confirm delivery post-reconnect. */
async function waitForDelivered(
  handle: WorkflowHandle,
  atLeast = 1,
  timeoutMs = 5000,
): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all: Message[] = await handle.query(allMessagesQuery);
    const delivered = all.filter((m) => m.delivered);
    if (delivered.length >= atLeast) return delivered;
    await new Promise((r) => setTimeout(r, 50));
  }
  const snapshot: Message[] = await handle.query(allMessagesQuery);
  throw new Error(
    `Timed out waiting for ${atLeast} delivered message(s); got ${JSON.stringify(snapshot)}`,
  );
}

describe('adapter reconnect (#201)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  describe('shouldReconnect policy', () => {
    it('InteractiveAttachment opts into reconnect for lease-loss reasons only', () => {
      const adapter = new FastInteractiveAttachment();
      // Recoverable — the workflow is still live, we just lost the lease (#201)
      // or the pinned runId got CAN'd and we need to rebind (#226).
      expect(adapter.reconnectDecides('heartbeat-timeout')).to.equal(true);
      expect(adapter.reconnectDecides('superseded')).to.equal(true);
      expect(adapter.reconnectDecides('continued-as-new')).to.equal(true);
      // Non-recoverable — workflow truly gone or user explicitly stopped.
      expect(adapter.reconnectDecides('destroy')).to.equal(false);
      expect(adapter.reconnectDecides('user-stop')).to.equal(false);
      expect(adapter.reconnectDecides('agent-exited')).to.equal(false);
      expect(adapter.reconnectDecides('force')).to.equal(false);
      expect(adapter.reconnectDecides('reconnect-exhausted')).to.equal(false);
    });
  });

  describe('abortableSleep', () => {
    it('resolves after the requested duration', async () => {
      const adapter = new FastInteractiveAttachment();
      const started = Date.now();
      await adapter.sleepAndRace(120);
      const elapsed = Date.now() - started;
      expect(elapsed).to.be.at.least(100, 'should not resolve early');
      // Generous upper bound — timers are imprecise on loaded runners.
      expect(elapsed).to.be.at.most(1000, 'should resolve near the requested time');
    });

    it('rejects with aborted:stopped when stopV2Lifecycle fires during sleep', async () => {
      const adapter = new FastInteractiveAttachment();
      const sleeping = adapter.sleepAndRace(5000);
      // Give the timer a moment to register with `sleepAborters`.
      await new Promise((r) => setTimeout(r, 20));
      await adapter.publicStopV2();
      let err: Error | undefined;
      try {
        await sleeping;
      } catch (e) {
        err = e as Error;
      }
      expect(err, 'sleep should have rejected').to.exist;
      expect(err!.message).to.equal('aborted:stopped');
    });
  });

  describe('workflow-side lease reap triggers automatic reconnect', () => {
    it('adapter re-claims and resumes delivery after forceDetach', async function () {
      // Budget: initial claim (<1s) + phase-watcher tick (1s = 5 * 200ms) +
      // reconnect backoff (100ms) + re-claim (<1s) + delivery (<1s) ≈ 4s comfortable.
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `reconnect-ok-${Date.now()}` }),
        });

        const received: Message[][] = [];
        const terminals: DetachReason[] = [];
        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          // Shrink the reconnect loop so a full cycle runs in ~300ms.
          reconnectTiming: { baseMs: 100, maxMs: 500, budgetMs: 10_000, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);
        adapter.onTerminal((r) => { terminals.push(r); });
        const stop = adapter.start(handle, async (msgs) => { received.push(msgs); });

        try {
          // 1. Initial claim lands.
          const attached = await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'attached' && !!i.currentAttachment,
            5000,
            'initial attached',
          );
          const firstAttachmentId = attached.currentAttachment!.attachmentId;

          // 2. Workflow-side reap — simulates laptop-sleep lease expiry but immediate.
          //    `forceDetach` with gracePeriodMs=0 clears currentAttachment + sets phase=detached.
          await handle.executeUpdate(forceDetachUpdate, {
            args: [{ reason: 'heartbeat-timeout', gracePeriodMs: 0 }],
          });
          await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'detached' && !i.currentAttachment,
            3000,
            'workflow reaped attachment',
          );

          // 3. Adapter's phase watcher observes the reap and the reconnect loop
          //    re-claims. Phase returns to `attached` with a DIFFERENT attachmentId.
          const reattached = await waitForAttachmentInfo(
            handle,
            (i) =>
              i.phase === 'attached' &&
              !!i.currentAttachment &&
              i.currentAttachment.attachmentId !== firstAttachmentId,
            10_000,
            'adapter reconnected with fresh attachment',
          );
          expect(reattached.currentAttachment!.hostname).to.equal('test-host');

          // 4. Terminal must NOT have fired — recovery was clean.
          expect(terminals).to.deep.equal([]);

          // 5. Delivery works on the new pinned handle.
          await handle.signal(receiveMessageSignal, {
            from: 'tester',
            text: 'post-reconnect cue',
          });
          await waitForDelivered(handle, 1);
          const flat = received.flat();
          expect(flat.map((m) => m.text)).to.include('post-reconnect cue');
        } finally {
          stop();
          await handle.executeUpdate(destroyUpdate, { args: [{}] });
          await handle.result().catch(() => { /* expected */ });
        }
      });
    });

    it('fires `reconnect-exhausted` terminal when the budget elapses without re-claim', async function () {
      // #206 follow-up: pre-#206 this path only had unit coverage via the abort-during-sleep case.
      // We now assert the loop's budget-exhaustion exit fires the distinct terminal reason.
      //
      // Strategy: set `budgetMs: 0` so the loop's `while (!stopped && Date.now() < deadline)`
      // guard evaluates to false immediately on entry — no claim attempts, straight to
      // the budget-exhausted branch. The phase-watcher + forceDetach machinery is unchanged
      // from the happy-path reconnect test, only the budget differs.
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `reconnect-exhausted-${Date.now()}` }),
        });

        const terminals: DetachReason[] = [];
        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          // budgetMs=0 → zero-ms deadline → the while-guard rejects on first check →
          // no claim attempts → fires `reconnect-exhausted`. Base/max are arbitrary
          // (never slept on) but set small so if the test ever regresses into running
          // the loop body, it still finishes within the 15s timeout.
          reconnectTiming: { baseMs: 100, maxMs: 200, budgetMs: 0, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);
        adapter.onTerminal((r) => { terminals.push(r); });
        const stop = adapter.start(handle, async () => { /* no-op */ });

        try {
          // Initial claim succeeds (budgetMs only affects the reconnect loop).
          await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'attached',
            5000,
            'initial attached',
          );

          // Reap workflow-side. Phase watcher will detect `phase=detached, currentAttachment=undefined`
          // and enter the reconnect loop — which, with budgetMs=0, bails out immediately.
          await handle.executeUpdate(forceDetachUpdate, {
            args: [{ reason: 'heartbeat-timeout', gracePeriodMs: 0 }],
          });

          // Wait for the terminal — single event, should land within one phase-watcher
          // tick (descriptor.heartbeatMs * 5 = 2000ms) plus a few ms of loop bailout.
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline && terminals.length === 0) {
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(terminals, 'terminal should have fired').to.have.lengthOf(1);
          expect(terminals[0]).to.equal('reconnect-exhausted');
        } finally {
          stop();
          await handle.executeUpdate(destroyUpdate, { args: [{}] });
          await handle.result().catch(() => { /* expected */ });
        }
      });
    });

    it('fires `destroy` terminal if the workflow is destroyed mid-reconnect', async function () {
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `reconnect-destroy-${Date.now()}` }),
        });

        const terminals: DetachReason[] = [];
        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          // Longer backoff so destroy lands while the loop is still waiting.
          reconnectTiming: { baseMs: 400, maxMs: 800, budgetMs: 5_000, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);
        adapter.onTerminal((r) => { terminals.push(r); });
        const stop = adapter.start(handle, async () => { /* no-op */ });

        try {
          // Initial claim
          await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'attached',
            5000,
            'initial attached',
          );

          // Reap — kicks the reconnect loop in the adapter.
          await handle.executeUpdate(forceDetachUpdate, {
            args: [{ reason: 'heartbeat-timeout', gracePeriodMs: 0 }],
          });
          await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'detached',
            3000,
            'workflow reaped',
          );

          // Destroy before the adapter gets a chance to re-claim.
          await handle.executeUpdate(destroyUpdate, { args: [{}] });

          // Adapter's reconnect pre-check should see phase=gone / WorkflowGone
          // and fire `destroy` terminal. Exact wake-up time depends on where
          // the loop is in its backoff cycle.
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline && terminals.length === 0) {
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(terminals, 'terminal should have fired').to.have.lengthOf(1);
          expect(terminals[0]).to.equal('destroy');
        } finally {
          stop();
          await handle.result().catch(() => { /* expected */ });
        }
      });
    });
  });

  // #226: the session workflow's `continueAsNew` closes the adapter's pinned
  // runId, and until this fix the adapter's tick loops conflated
  // `WorkflowExecutionAlreadyCompleted` (old run closed, successor is live)
  // with `WorkflowNotFound` (workflow id gone) — both fired `destroy`
  // terminal, so the adapter stopped polling even though the successor was
  // accepting signals. Result: inbound cues landed in `pendingMessages` and
  // were silently marked `(undelivered)`.
  //
  // The fix reads the closed run's history for `WorkflowExecutionContinuedAsNew`,
  // rebinds the pinned handle to the successor runId, and resumes delivery
  // — no re-claim, because the workflow's §2.3 CAN-boundary lease extension
  // keeps the lease alive across the transition. These tests drive the fix
  // via the test-only `testForceContinueAsNewSignal` so the CAN path fires
  // without spamming ~10k history events to hit the server's native threshold.
  describe('CAN successor rebind (#226)', () => {
    it('adapter rebinds to CAN successor runId and resumes delivery', async function () {
      // Budget: initial claim (<1s) + CAN fire + first heartbeat-tick detection
      // (400ms) + fetchHistory + rebind + delivery (<1s) comfortably <10s. The
      // conductor brief specifies a 30s ceiling; 15s is plenty of headroom.
      this.timeout(30_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `can-rebind-${Date.now()}` }),
        });

        const received: Message[][] = [];
        const terminals: DetachReason[] = [];
        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          // Reconnect-loop timing is only consulted for the #201 path; CAN
          // rebind is a short-circuit (no backoff). Keep the shrunk values so
          // this file's other suites stay fast.
          reconnectTiming: { baseMs: 100, maxMs: 500, budgetMs: 10_000, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);
        adapter.onTerminal((r) => { terminals.push(r); });
        const stop = adapter.start(handle, async (msgs) => { received.push(msgs); });

        try {
          // 1. Adapter claims on the initial run. Capture its runId via describe()
          //    so we can confirm the successor differs after CAN.
          const firstAttached = await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'attached' && !!i.currentAttachment,
            5000,
            'initial attached',
          );
          const firstAttachmentId = firstAttached.currentAttachment!.attachmentId;
          const firstRunId = firstAttached.currentAttachment!.runId;
          const originalRunId = (await handle.describe()).runId;
          expect(firstRunId, 'attachment runId should match the original run').to.equal(originalRunId);

          // 2. Force CAN via the test-only signal. The unpinned `handle` routes
          //    signals to the current run; once the workflow continues-as-new,
          //    subsequent queries to `handle` resolve against the successor.
          await handle.signal(testForceContinueAsNewSignal);

          // 3. Wait for the successor run to be live — detected by describe()
          //    returning a different runId than the original.
          const canDeadline = Date.now() + 5000;
          let successorRunId = originalRunId;
          while (Date.now() < canDeadline) {
            const desc = await handle.describe();
            if (desc.runId !== originalRunId && desc.status.name === 'RUNNING') {
              successorRunId = desc.runId;
              break;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(successorRunId, 'CAN successor runId should differ from the original').to.not.equal(originalRunId);

          // 4. Workflow carries `currentAttachment` forward across CAN with the
          //    §2.3 lease extension, so the successor sees the same attachmentId.
          //    The pinned adapter handle targeting `originalRunId` will now throw
          //    `WorkflowExecutionAlreadyCompleted` on heartbeat / phase-watcher;
          //    the fix detects that, reads history for the CAN event, and rebinds.
          const rebindDeadline = Date.now() + 10_000;
          let afterRebind = await handle.query(attachmentInfoQuery);
          while (Date.now() < rebindDeadline) {
            afterRebind = await handle.query(attachmentInfoQuery);
            // The adapter's rebind triggers a fresh heartbeat on the successor run,
            // which updates `currentAttachment.lastHeartbeatAt` beyond the value
            // carried across CAN. Same attachmentId — no re-claim happened.
            if (
              afterRebind.currentAttachment?.attachmentId === firstAttachmentId &&
              new Date(afterRebind.currentAttachment.lastHeartbeatAt).getTime() >
                new Date(firstAttached.currentAttachment!.lastHeartbeatAt).getTime()
            ) {
              break;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(afterRebind.currentAttachment, 'attachment still present on successor').to.exist;
          expect(
            afterRebind.currentAttachment!.attachmentId,
            'attachmentId preserved across CAN rebind (no re-claim)',
          ).to.equal(firstAttachmentId);

          // 5. Terminal must NOT have fired — the CAN rebind is transparent.
          expect(terminals, 'no terminal during CAN rebind').to.deep.equal([]);

          // 6. Send a cue AFTER CAN. This is the core repro of #226: pre-fix the
          //    successor accepted the signal but no poller was bound to it, so the
          //    message stayed `(undelivered)`. Post-fix the rebound poller delivers it.
          await handle.signal(receiveMessageSignal, {
            from: 'tester',
            text: 'post-CAN cue',
          });
          const delivered = await waitForDelivered(handle, 1, 10_000);
          expect(delivered.map((m) => m.text)).to.include('post-CAN cue');
        } finally {
          stop();
          await handle.executeUpdate(destroyUpdate, { args: [{}] });
          await handle.result().catch(() => { /* expected */ });
        }
      });
    });

    it('still fires `destroy` when the workflow truly completes (no CAN successor in history)', async function () {
      // Regression guard for the classifier branch: if the pinned run closes
      // without a `WorkflowExecutionContinuedAsNewEvent`, the adapter must fire
      // `destroy`, not hang waiting for a successor that never materializes.
      // The existing "destroyed mid-reconnect" test covers the workflow-id-gone
      // path; this one covers the "specific run completed, no CAN chain" path
      // that `handleRunEndError` introduces.
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `can-true-destroy-${Date.now()}` }),
        });

        const terminals: DetachReason[] = [];
        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          reconnectTiming: { baseMs: 100, maxMs: 300, budgetMs: 5_000, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);
        adapter.onTerminal((r) => { terminals.push(r); });
        const stop = adapter.start(handle, async () => { /* no-op */ });

        try {
          await waitForAttachmentInfo(
            handle,
            (i) => i.phase === 'attached',
            5000,
            'initial attached',
          );

          // Destroy the workflow — closes the run, no CAN event in history.
          // The adapter's next heartbeat/query tick will see
          // `WorkflowExecutionAlreadyCompleted` (or `WorkflowNotFound` if the
          // server is quick about GC); either way the classifier must route
          // to `fireTerminal('destroy')`, not hang waiting for a rebind.
          await handle.executeUpdate(destroyUpdate, { args: [{}] });

          const deadline = Date.now() + 8000;
          while (Date.now() < deadline && terminals.length === 0) {
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(terminals, 'terminal should have fired').to.have.lengthOf(1);
          expect(terminals[0]).to.equal('destroy');
        } finally {
          stop();
          await handle.result().catch(() => { /* expected */ });
        }
      });
    });
  });
});
