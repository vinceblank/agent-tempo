/**
 * Claude Code adapter — V2 lifecycle path tests (PR-C commit 2).
 *
 * Exercises the `CLAUDE_TEMPO_LIFECYCLE_V2` branch in `InteractiveAttachment`:
 *
 *  - V2 **off**: adapter runs the legacy poll/markDelivered loop only; workflow
 *    never observes a `claimAttachment` call, so phase stays `booting`.
 *  - V2 **on**: adapter calls `claimAttachment`, phase transitions to `attached`,
 *    and the delivery poll still works (on the runId-pinned handle).
 *  - V2 **on, AttachmentConflict**: a prior claim from a different host holds the
 *    lease; the adapter's `start()` surfaces the conflict and the poller never
 *    runs.
 *
 * Heartbeat cadence (60s interactive) is not asserted directly — the 10s test
 * timeout would require real-time waits or descriptor hacks. The wire-protocol
 * test (`test/wire-protocol.test.ts`, drift detector since PR-G) + the base-class
 * unit tests cover that surface.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§3.2, 5, 9.2.
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
  pendingMessagesQuery,
  allMessagesQuery,
  destroyUpdate,
} from './helpers';
import {
  claimAttachmentUpdate,
  attachmentInfoQuery,
} from '../src/workflows/signals';
import type { AttachmentInfo, Message } from '../src/types';
import { InteractiveAttachment } from '../src/adapters/claude-code/adapter';

/** Poll `attachmentInfo` until phase reaches `expected` or timeout. */
async function waitForPhase(
  handle: WorkflowHandle,
  expected: AttachmentInfo['phase'],
  timeoutMs = 5000,
): Promise<AttachmentInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: AttachmentInfo | undefined;
  while (Date.now() < deadline) {
    last = await handle.query(attachmentInfoQuery);
    if (last.phase === expected) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Timed out waiting for phase="${expected}"; last=${JSON.stringify(last)}`,
  );
}

/** Poll until at least one message has been delivered (markDelivered drained pending). */
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

describe('claude-code adapter — V2 lifecycle (PR-C commit 2)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('V2 off: adapter delivers via legacy path without claiming an attachment', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `legacy-${Date.now()}` }),
      });

      // Sanity: phase starts as `booting` before anyone claims.
      const initial: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(initial.phase).to.equal('booting');
      expect(initial.currentAttachment).to.be.undefined;

      const received: Message[][] = [];
      const adapter = new InteractiveAttachment({
        client: getClient(),
        host: 'test-host',
        lifecycleV2: false,
      });
      const stop = adapter.start(handle, async (msgs) => {
        received.push(msgs);
      });

      try {
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'hello legacy' });
        await waitForDelivered(handle, 1);

        const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
        // Legacy path does not call claimAttachment — phase stays `booting`,
        // no currentAttachment populated.
        expect(info.phase).to.equal('booting', 'legacy path must not trigger claim');
        expect(info.currentAttachment).to.be.undefined;

        // Delivery callback ran with the message payload.
        const flat = received.flat();
        expect(flat.map((m) => m.text)).to.include('hello legacy');
      } finally {
        stop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('V2 on: adapter claims attachment and delivery still works on the pinned handle', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `v2-ok-${Date.now()}` }),
      });

      const received: Message[][] = [];
      const adapter = new InteractiveAttachment({
        client: getClient(),
        host: 'test-host',
        lifecycleV2: true,
      });
      const stop = adapter.start(handle, async (msgs) => {
        received.push(msgs);
      });

      try {
        // Wait for the background claim to land — phase moves booting → attached.
        const info = await waitForPhase(handle, 'attached');
        expect(info.currentAttachment).to.exist;
        expect(info.currentAttachment?.hostname).to.equal('test-host');
        expect(info.currentAttachment?.adapterId).to.equal('claude-code');
        expect(info.currentAttachment?.adapterClass).to.equal('interactive');

        // Delivery continues to work on the pinned handle.
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'hello v2' });
        await waitForDelivered(handle, 1);

        // Pending queue is drained after markDelivered.
        const pending: Message[] = await handle.query(pendingMessagesQuery);
        expect(pending).to.have.lengthOf(0);

        const flat = received.flat();
        expect(flat.map((m) => m.text)).to.include('hello v2');
      } finally {
        stop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('V2 on: AttachmentConflict prevents claim when another host already holds the lease', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `v2-conflict-${Date.now()}` }),
      });

      // Pre-claim from a different host so our adapter's claim surfaces AttachmentConflict.
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{
          host: 'host-other',
          adapterId: 'claude-code',
          adapterClass: 'interactive',
          leaseMs: 30_000,
        }],
      });

      const received: Message[][] = [];
      const adapter = new InteractiveAttachment({
        client: getClient(),
        host: 'test-host',
        lifecycleV2: true,
      });
      const stop = adapter.start(handle, async (msgs) => {
        received.push(msgs);
      });

      try {
        // Let the background claim attempt resolve (and fail with AttachmentConflict).
        // We can't await the returned closure — it's sync — so give the event loop a beat.
        await new Promise((r) => setTimeout(r, 500));

        // Phase still reflects host-other's attachment, not ours.
        const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
        expect(info.phase).to.equal('attached');
        expect(info.currentAttachment?.hostname).to.equal('host-other');

        // Our adapter never ran its delivery poll — send a message and confirm
        // it stays pending from our perspective. (The workflow still delivers
        // via the other adapter's not-present poller — so pending stays set.)
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'into the void' });
        // Give the poll cycle a chance to pick it up if it were running.
        await new Promise((r) => setTimeout(r, 1500));
        expect(received.flat()).to.have.lengthOf(0, 'conflicted adapter must not have polled');
      } finally {
        stop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });
});
