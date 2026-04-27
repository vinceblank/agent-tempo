/**
 * Mock-adapter integration tests (ADR 0014 PR-2). Exercises the actual
 * `MockAttachment` class against a real session workflow running in a
 * `TestWorkflowEnvironment`, proving:
 *
 *   1. `claimAttachment` succeeds (the mock can take over a fresh attachment).
 *   2. The first heartbeat lands on the workflow side.
 *   3. Echo mode posts a `cue` outbox entry back to the sender with the
 *      `[ECHO] <text>` prefix.
 *   4. Scripted mode matches a rule and dispatches its action sequence
 *      through the outbox.
 *   5. The `__MOCK__:` directive prefix is parsed and dispatched inline,
 *      regardless of the configured mode.
 *
 * The Vitest `tests/adapters/mock/*` files cover the pure-logic surface
 * (parser, prefix parser, source-level recruit gate, build-exclusion script).
 * This file covers the behavior that's only true when the workflow is
 * running — i.e., the wire-protocol contract between adapter and workflow.
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
import { attachmentInfoQuery } from '../src/workflows/signals';
import type { AttachmentInfo, Message } from '../src/types';
import { MockAttachment, parseScenario } from '../src/adapters/mock';

/** Test subclass exposing the protected `processMessage` so we can drive
 *  one message at a time without spinning the full `run()` poll loop. */
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

/** Helper — pull the current outbox via the workflow query. */
async function readOutbox(handle: WorkflowHandle): Promise<Array<{ type: string; targetPlayerId?: string; message?: string; text?: string }>> {
  const entries = await handle.query(outboxQuery);
  return entries.map((e: any) => ({
    type: e.type,
    targetPlayerId: e.targetPlayerId,
    message: e.message,
    text: e.text,
  }));
}

/**
 * Inject a synthetic inbound message via the standard signal. The signal
 * payload is `{ from, text, isMaestro?, ... }`; the workflow assigns the
 * message id internally. We can't predict the id, so callers re-query
 * `pendingMessages` after injection to find the most recent inbound from
 * the named sender.
 */
async function injectMessage(handle: WorkflowHandle, from: string, text: string): Promise<void> {
  await handle.signal(receiveMessageSignal, { from, text });
}

describe('MockAttachment (PR-2 of #340-followup)', function () {
  this.timeout(30_000);

  before(async () => { await setupTestEnv(); });
  after(async () => { await teardownTestEnv(); });

  it('claimAttachment succeeds and first heartbeat lands', async () => {
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-claim-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'echo' });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        await adapter.testAttach(handle.workflowId);
        const info = await handle.query(attachmentInfoQuery) as AttachmentInfo;
        expect(info.phase).to.be.oneOf(['attached', 'awaiting']);
        expect(info.currentAttachment, 'attachment should be present').to.exist;
        expect(info.currentAttachment!.adapterId).to.equal('mock');
        expect(info.currentAttachment!.adapterClass).to.equal('sdk');
      } finally {
        await adapter.testStop();
      }
    });
  });

  it('echo mode round-trips a cue back to the sender with [ECHO] prefix', async () => {
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-echo-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'echo' });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await injectMessage(handle, 'alice', 'hello world');
        const messages: Message[] = await pinned.query('pendingMessages');
        const inbound = messages.find((m) => m.from === 'alice' && m.text === 'hello world');
        expect(inbound, 'message should be in pending').to.exist;
        await adapter.testProcessMessage(pinned, inbound!);

        const outbox = await readOutbox(pinned);
        const echo = outbox.find((e) => e.type === 'cue' && e.targetPlayerId === 'alice');
        expect(echo, 'echo cue should be enqueued').to.exist;
        expect(echo!.message).to.equal('[ECHO] hello world');
      } finally {
        await adapter.testStop();
      }
    });
  });

  it('scripted mode matches a rule and dispatches its actions', async () => {
    const scenario = parseScenario(`
name: test-scripted
defaultDelayMs: 0
rules:
  - when: "discuss"
    do:
      - cue:
          to: "@sender"
          message: "ack: $message"
      - report:
          type: "update"
          text: "delegated discussion"
  - when: "*"
    do:
      - cue:
          to: "@sender"
          message: "no rule matched"
`);
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-scripted-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'scripted', scenario });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await injectMessage(handle, 'bob', 'please discuss caching');
        const messages: Message[] = await pinned.query('pendingMessages');
        const inbound = messages.find((m) => m.from === 'bob')!;
        await adapter.testProcessMessage(pinned, inbound);

        const outbox = await readOutbox(pinned);
        const cue = outbox.find((e) => e.type === 'cue' && e.targetPlayerId === 'bob');
        const report = outbox.find((e) => e.type === 'report');
        expect(cue, 'first action should enqueue a cue').to.exist;
        expect(cue!.message).to.equal('ack: please discuss caching');
        expect(report, 'second action should enqueue a report').to.exist;
        expect(report!.text).to.equal('delegated discussion');
      } finally {
        await adapter.testStop();
      }
    });
  });

  it('__MOCK__: prefix is dispatched even when mode=echo', async () => {
    await withWorker(async () => {
      const md = playerMetadata({ playerId: 'mock-prefix-1', agentType: 'mock', adapterId: 'mock' });
      const handle = await startSession({ metadata: md });
      const adapter = new TestMockAttachment({ mode: 'echo' });
      const client = getClient();
      adapter.testConfigure(client, md.hostname);
      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await injectMessage(handle, 'alice', '__MOCK__: cue alice direct-from-prefix');
        const messages: Message[] = await pinned.query('pendingMessages');
        const inbound = messages.find((m) => m.from === 'alice')!;
        await adapter.testProcessMessage(pinned, inbound);

        const outbox = await readOutbox(pinned);
        // Prefix took precedence — should NOT see an [ECHO] form.
        const echoForm = outbox.find((e) => e.type === 'cue' && (e.message ?? '').startsWith('[ECHO]'));
        expect(echoForm, 'mode=echo should NOT have produced [ECHO] when __MOCK__: was present').to.not.exist;
        const directive = outbox.find((e) => e.type === 'cue' && e.targetPlayerId === 'alice');
        expect(directive, 'directive cue should be enqueued').to.exist;
        expect(directive!.message).to.equal('direct-from-prefix');
      } finally {
        await adapter.testStop();
      }
    });
  });
});
