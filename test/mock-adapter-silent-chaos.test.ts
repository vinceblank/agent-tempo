/**
 * Silent + chaos mode integration tests (PR-3 of #340-followup, ADR 0014
 * §4.2). Uses the same `TestWorkflowEnvironment` plumbing as
 * `mock-adapter-claim-heartbeat.test.ts` so the wire-protocol contract
 * (markDelivered, processingStart/End, outbox population) is exercised
 * against a real session workflow.
 *
 *   - **Silent mode** drains messages without populating the outbox. The
 *     workflow's `pendingMessages` should clear after `processMessage`
 *     (proving `markDelivered` fired) but no `cue` / `report` entries
 *     should land — the harness can rely on this when validating
 *     heartbeat-stale / awaiting-phase transitions.
 *
 *   - **Chaos mode** echoes deterministically when `crashRate=0` and
 *     `failRate=0` (so the test can pin a known seed and assert the exact
 *     outbox shape). With `failRate=1` the deliver throws, and the
 *     message stays in `pendingMessages` (markDelivered did NOT fire) so
 *     the supervisor-recovery path picks it up next poll.
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
  outboxQuery,
} from './helpers';
import type { Message } from '../src/types';
import { MockAttachment } from '../src/adapters/mock';
import type { ChaosConfig } from '../src/adapters/mock/chaos';

class TestMockAttachment extends MockAttachment {
  public async testProcessMessage(pinned: WorkflowHandle, msg: Message): Promise<void> {
    await this.processMessage(pinned, msg);
  }
  public async testAttach(workflowId: string): Promise<WorkflowHandle> {
    return this.startV2Lifecycle(workflowId);
  }
  public async testStop(): Promise<void> {
    await this.stopV2Lifecycle('user-stop', /* graceful */ true);
  }
  public testConfigure(client: import('@temporalio/client').Client, host: string): void {
    this.configureV2(client, host);
  }
}

async function readOutbox(handle: WorkflowHandle): Promise<Array<{ type: string; targetPlayerId?: string; message?: string; text?: string }>> {
  const entries = await handle.query(outboxQuery);
  return entries.map((e: any) => ({
    type: e.type,
    targetPlayerId: e.targetPlayerId,
    message: e.message,
    text: e.text,
  }));
}

async function injectMessage(handle: WorkflowHandle, from: string, text: string): Promise<void> {
  await handle.signal(receiveMessageSignal, { from, text });
}

describe('MockAttachment silent + chaos modes (PR-3 of #340-followup)', function () {
  this.timeout(30_000);

  before(async () => { await setupTestEnv(); });
  after(async () => { await teardownTestEnv(); });

  it('silent mode drains pendingMessages without populating the outbox', async () => {
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-silent-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'silent' });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);

        // Inject three messages so we can prove silent mode handles the
        // batch — not just an accident-of-state where it skipped the first.
        await injectMessage(handle, 'alice', 'first');
        await injectMessage(handle, 'alice', 'second');
        await injectMessage(handle, 'bob', 'third');

        // Process every pending message.
        const before = await pinned.query('pendingMessages') as Message[];
        expect(before, 'three messages should be pending pre-process').to.have.lengthOf(3);
        for (const msg of before) {
          await adapter.testProcessMessage(pinned, msg);
        }

        // After silent processing: queue drains (markDelivered fired), no
        // outbox entries land.
        const after = await pinned.query('pendingMessages') as Message[];
        expect(after, 'pendingMessages should drain after silent processing').to.have.lengthOf(0);

        const outbox = await readOutbox(pinned);
        expect(outbox, 'silent mode must NOT enqueue any outbox entries').to.have.lengthOf(0);
      } finally {
        await adapter.testStop();
      }
    });
  });

  it('chaos mode with rates=0 echoes deterministically (sanity baseline)', async () => {
    // crashRate=0 + failRate=0 → every roll lands in the echo branch. The
    // PRNG is still consumed (two draws per message) so a follow-up test
    // can tighten this with a fixed seed if cross-call sequencing matters.
    const config: ChaosConfig = { delayMs: 0, failRate: 0, crashRate: 0, seed: 12345 };
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-chaos-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'chaos', chaosConfig: config });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await injectMessage(handle, 'alice', 'ping');
        const messages: Message[] = await pinned.query('pendingMessages');
        const inbound = messages.find((m) => m.from === 'alice')!;
        await adapter.testProcessMessage(pinned, inbound);

        const outbox = await readOutbox(pinned);
        const reply = outbox.find((e) => e.type === 'cue' && e.targetPlayerId === 'alice');
        expect(reply, 'chaos echo should enqueue a cue').to.exist;
        expect(reply!.message, 'chaos echo should use the [CHAOS-OK] prefix').to.equal('[CHAOS-OK] ping');
      } finally {
        await adapter.testStop();
      }
    });
  });

  it('chaos mode with failRate=1 throws inside deliver (message stays pending for retry)', async () => {
    // failRate=1 → every roll lands in the fail branch (crashRate=0 so
    // crash never wins). The throw inside `deliver()` propagates up; the
    // workflow's markDelivered does NOT fire, so the inbound message
    // stays in `pendingMessages` for the supervisor's next poll.
    const config: ChaosConfig = { delayMs: 0, failRate: 1, crashRate: 0, seed: 1 };
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-chaos-fail-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'chaos', chaosConfig: config });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await injectMessage(handle, 'alice', 'will-fail');
        const before = await pinned.query('pendingMessages') as Message[];
        const inbound = before.find((m) => m.from === 'alice')!;

        // The deliver wrapper catches the throw and surfaces it as a
        // failed delivery; processMessage itself shouldn't crash the
        // test runner.
        let caught: unknown;
        try {
          await adapter.testProcessMessage(pinned, inbound);
        } catch (err) {
          caught = err;
        }
        // Either deliver swallows the throw (returns normally with
        // markDelivered=false) OR re-raises it. Both shapes are fine —
        // the contract we care about is that the message stays pending.
        if (caught) {
          expect(String(caught)).to.match(/chaos: simulated failure/i);
        }

        // No outbox entry should have landed (chaos:fail throws BEFORE
        // any cue is submitted).
        const outbox = await readOutbox(pinned);
        const replies = outbox.filter((e) => e.type === 'cue');
        expect(replies, 'chaos:fail must NOT post a cue').to.have.lengthOf(0);

        // The actual contract chaos-mode is for: when deliver() throws
        // inside the wrapped callback, markDelivered does NOT fire and
        // the inbound message stays in `pendingMessages` for the
        // supervisor's next poll. Without this assertion, the test
        // would also pass for a no-op silent-mode-shaped path —
        // mirrors the silent-mode test's drain check.
        const after = await pinned.query('pendingMessages') as Message[];
        const stillPending = after.find((m) => m.from === 'alice' && m.text === 'will-fail');
        expect(stillPending, 'message should remain pending after chaos:fail throws').to.exist;
      } finally {
        await adapter.testStop();
      }
    });
  });
});
