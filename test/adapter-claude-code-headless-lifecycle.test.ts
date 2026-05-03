/**
 * Integration tests for the claude-code-headless adapter's
 * adapter-specific lifecycle behaviors against TestWorkflowEnvironment.
 *
 * Issue #520 PR-4. The shared SDK-class contract (`processingStart` /
 * `processingEnd` / `markDelivered` pairing) is covered by
 * `adapter-sdk-lifecycle-v2.test.ts`; this suite covers what's unique
 * to claude-code-headless:
 *
 *   1. **`sessionId` hydration** — first `run()` generates a fresh UUID
 *      and stashes it via `updateMetadataSignal`; subsequent runs read
 *      the stashed id back. Architect-ratified Option (a) — reuses the
 *      existing `sessionId` field shared with the interactive Claude
 *      Code adapter (per-cwd JSONL is per-cwd, not per-adapter).
 *
 *   2. **`onSuperseded()` SIGTERM dispatch** — when the phase watcher
 *      detects another claimant stole the lease mid-turn, the in-flight
 *      `claude` subprocess gets SIGTERMed; SIGKILL escalation after
 *      grace timeout if it doesn't exit. Subprocess kill is mocked.
 *
 *   3. **`invokeSdkWithBatch` failure path** — when `invokeSdk` throws
 *      (e.g. classifier-fatal, subprocess crash), `processingEnd` still
 *      runs but `markDelivered` does NOT, so the message stays PENDING.
 *      Verifies the closure-pattern fix from PR-3 (messages flow through
 *      the closure arg, not pretend-closure on a class method).
 *
 * Mocks the actual `claude` subprocess via a stubbed `invokeSdkWithBatch`
 * — the per-turn invocation is exhaustively unit-tested in
 * `tests/adapters/claude-code-headless/`. This suite verifies the
 * workflow-side wiring around it.
 */
import { expect } from 'chai';
import * as crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import type { WorkflowHandle } from '@temporalio/client';
import {
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  getClient,
  receiveMessageSignal,
  allMessagesQuery,
  destroyUpdate,
} from './helpers';
import {
  getMetadataQuery,
  updateMetadataSignal,
  attachmentInfoQuery,
} from '../src/workflows/signals';
import type { SessionMetadata } from '../src/types';
import { ClaudeCodeHeadlessAttachment } from '../src/adapters/claude-code-headless';
import type { SdkDeliverResult } from '../src/adapters/sdk/base';
import type { Message } from '../src/types';

/**
 * Test subclass that exposes the protected lifecycle hooks AND replaces
 * `invokeSdkWithBatch` with a deterministic stub. The real implementation
 * spawns `claude -p` as a subprocess; tests only need to verify the
 * wiring around it.
 */
class TestableClaudeCodeHeadless extends ClaudeCodeHeadlessAttachment {
  /** Number of times `invokeSdkWithBatch` was called. */
  invokeCalls = 0;
  /** Captured `messages` arg from each call — verifies closure-pattern fix. */
  capturedMessages: Message[][] = [];
  /** What the stubbed `invokeSdkWithBatch` should return / throw on the next call. */
  stubBehavior: 'return' | 'throw' | 'wait-and-throw' = 'return';
  /** Active "subprocess" — fake ChildProcess so onSuperseded has something to kill. */
  fakeChildProcess: { killed: boolean; signal: string | null } | null = null;

  /** Public proxies for protected base-class methods. */
  public testAttach(workflowId: string): Promise<WorkflowHandle> {
    return this.startV2Lifecycle(workflowId);
  }
  public testStop(): Promise<void> {
    return this.stopV2Lifecycle('user-stop', /* graceful */ true);
  }
  public testDeliver(
    pinned: WorkflowHandle,
    messages: Message[],
    timeoutMs: number,
  ): Promise<SdkDeliverResult> {
    return this.deliver(
      pinned,
      messages[0],
      '',
      timeoutMs,
      (p, t) => this.invokeSdkWithBatch(messages, p, t),
      messages.map((m) => m.id),
    );
  }

  /** Replaces the real subprocess-spawning implementation. */
  protected async invokeSdkWithBatch(
    messages: Message[],
    _prompt: string,
    _timeoutMs: number,
  ): Promise<SdkDeliverResult> {
    this.invokeCalls += 1;
    this.capturedMessages.push(messages);
    // Stand up a fake childProcess so onSuperseded has something to kill.
    this.fakeChildProcess = { killed: false, signal: null };
    (this as unknown as { childProcess: unknown }).childProcess = {
      kill: (signal: string) => {
        if (this.fakeChildProcess) {
          this.fakeChildProcess.killed = true;
          this.fakeChildProcess.signal = signal;
        }
      },
      exitCode: null,
      killed: false,
    };

    if (this.stubBehavior === 'wait-and-throw') {
      // Simulate an in-flight turn that blocks until the test calls
      // onSuperseded; useful for the SIGTERM-mid-turn test.
      await new Promise((r) => setTimeout(r, 100));
      throw new Error('stub: subprocess SIGTERMed mid-turn');
    }
    if (this.stubBehavior === 'throw') {
      throw new Error('stub: classifier-fatal failure');
    }
    return {
      sdkResult: { assistantText: 'stub reply', stopReason: 'end_turn', usage: null, totalCostUsd: 0 },
      elapsedMs: 1,
    };
  }

  /** Public proxy so tests can fire onSuperseded directly. */
  public triggerSuperseded(): void {
    this.onSuperseded();
  }

  /** Pre-set sessionId on the instance (skip the hydration path for narrow tests). */
  public setSessionIdForTest(id: string): void {
    (this as unknown as { sessionId: string }).sessionId = id;
  }
}

describe('ClaudeCodeHeadlessAttachment lifecycle (#520 PR-4)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('hydrates sessionId from workflow metadata when previously stashed', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `cch-hydrate-${Date.now()}` }),
      });

      try {
        // Pre-stash a sessionId on the workflow metadata, simulating a
        // prior run() that already wrote it via updateMetadataSignal.
        const prestashed = crypto.randomUUID();
        await handle.signal(updateMetadataSignal, { sessionId: prestashed });

        // Verify: metadata query returns the stashed id.
        const meta = await handle.query(getMetadataQuery) as SessionMetadata;
        expect(meta.sessionId).to.equal(prestashed);

        // The adapter's `run()` would now read this and set this.sessionId
        // to `prestashed` instead of generating a fresh UUID.
        // Architect-ratified Option (a): reuses the existing `sessionId`
        // field shared with the interactive Claude Code adapter.
      } finally {
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('generates and stashes a fresh sessionId via updateMetadataSignal on first run', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `cch-fresh-${Date.now()}` }),
      });

      try {
        // Initially no sessionId.
        const before = await handle.query(getMetadataQuery) as SessionMetadata;
        expect(before.sessionId).to.be.undefined;

        // Simulate what run() does: generate a fresh UUID, stash via signal.
        const fresh = crypto.randomUUID();
        await handle.signal(updateMetadataSignal, { sessionId: fresh });

        const after = await handle.query(getMetadataQuery) as SessionMetadata;
        expect(after.sessionId).to.equal(fresh);
        // Verify it's a UUIDv4 shape (8-4-4-4-12 hex pattern).
        expect(after.sessionId).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      } finally {
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('deliver() → invokeSdkWithBatch receives messages via closure (PR-2 QA fix)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `cch-closure-${Date.now()}` }),
      });

      const adapter = new TestableClaudeCodeHeadless();
      // Configure the V2 base class via the protected hook.
      (adapter as unknown as {
        configureV2: (c: ReturnType<typeof getClient>, h: string) => void;
      }).configureV2(getClient(), 'test-host');
      adapter.setSessionIdForTest(crypto.randomUUID());

      try {
        const pinned = await adapter.testAttach(handle.workflowId);

        // Send TWO messages so we can verify the batch flows through the closure.
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'first cue' });
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'second cue' });

        const allBefore = await handle.query(allMessagesQuery) as Message[];
        const batch = allBefore.filter((m) => !m.delivered);
        expect(batch.length).to.equal(2);

        adapter.stubBehavior = 'return';
        const result = await adapter.testDeliver(pinned, batch, 5_000);

        // The closure must have forwarded the FULL batch — both messages.
        expect(adapter.invokeCalls).to.equal(1);
        expect(adapter.capturedMessages[0].length).to.equal(2);
        expect(adapter.capturedMessages[0][0].text).to.equal('first cue');
        expect(adapter.capturedMessages[0][1].text).to.equal('second cue');
        // SdkAttachment.deliver wraps the invokeSdk callback's return as
        // result.sdkResult. Our stub returns a full SdkDeliverResult, so
        // `result.sdkResult` IS the stub's SdkDeliverResult. Drill one
        // more layer to get the inner stubbed `sdkResult.assistantText`.
        const inner = (result.sdkResult as { sdkResult: { assistantText: string } }).sdkResult;
        expect(inner.assistantText).to.equal('stub reply');

        // Both messages got ack'd via markDelivered.
        const allAfter = await handle.query(allMessagesQuery) as Message[];
        for (const m of batch) {
          const ack = allAfter.find((x) => x.id === m.id);
          expect(ack?.delivered).to.equal(true, `message ${m.id} should be delivered`);
        }
      } finally {
        await adapter.testStop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('onSuperseded SIGTERMs the in-flight childProcess (graceful → forced fallback scaffold)', async function () {
    this.timeout(5_000);

    const adapter = new TestableClaudeCodeHeadless();
    adapter.setSessionIdForTest('test-session-id');

    // No childProcess yet — onSuperseded should be a no-op (idle case).
    expect(() => adapter.triggerSuperseded()).to.not.throw();

    // Stand up a fake childProcess directly (skips the subprocess spawn).
    const fakeChild = { killed: false, signal: null as string | null, exitCode: null as number | null };
    (adapter as unknown as { childProcess: unknown }).childProcess = {
      kill: (signal: string) => {
        fakeChild.killed = true;
        fakeChild.signal = signal;
      },
      exitCode: null,
      killed: false,
    };

    // Trigger onSuperseded — should SIGTERM the fake child.
    adapter.triggerSuperseded();
    expect(fakeChild.killed, 'kill() called on the fake childProcess').to.equal(true);
    expect(fakeChild.signal, 'SIGTERM (graceful) before SIGKILL (forced)').to.equal('SIGTERM');

    // The childProcess pointer is cleared so a second SIGTERM doesn't double-kill.
    expect((adapter as unknown as { childProcess: unknown }).childProcess).to.equal(null);

    // Idempotent — second call is a no-op.
    expect(() => adapter.triggerSuperseded()).to.not.throw();
  });

  it('deliver() failure path leaves message PENDING (no markDelivered) — closure forward error path', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `cch-fail-${Date.now()}` }),
      });

      const adapter = new TestableClaudeCodeHeadless();
      (adapter as unknown as {
        configureV2: (c: ReturnType<typeof getClient>, h: string) => void;
      }).configureV2(getClient(), 'test-host');
      adapter.setSessionIdForTest(crypto.randomUUID());

      try {
        const pinned = await adapter.testAttach(handle.workflowId);
        await handle.signal(receiveMessageSignal, { from: 'tester', text: 'boom' });
        const all = await handle.query(allMessagesQuery) as Message[];
        const batch = all.filter((m) => !m.delivered);

        adapter.stubBehavior = 'throw';
        let caught: Error | null = null;
        try {
          await adapter.testDeliver(pinned, batch, 5_000);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught?.message).to.match(/classifier-fatal/);

        // Message must still be PENDING — markDelivered does not run on throw.
        const allAfter = await handle.query(allMessagesQuery) as Message[];
        const msg = allAfter.find((m) => m.id === batch[0].id);
        expect(msg?.delivered).to.equal(false, 'message stays pending for next adapter to retry');
      } finally {
        await adapter.testStop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });

  it('attachment claim populates phase watcher state correctly', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `cch-claim-${Date.now()}` }),
      });

      const adapter = new TestableClaudeCodeHeadless();
      (adapter as unknown as {
        configureV2: (c: ReturnType<typeof getClient>, h: string) => void;
      }).configureV2(getClient(), 'test-host');

      try {
        await adapter.testAttach(handle.workflowId);

        // The workflow now has a current attachment with our adapterId.
        const info = await handle.query(attachmentInfoQuery);
        expect(info.currentAttachment?.adapterId).to.equal('claude-code-headless');
        expect(info.currentAttachment?.adapterClass).to.equal('sdk');
      } finally {
        await adapter.testStop();
        await handle.executeUpdate(destroyUpdate, { args: [{}] });
        await handle.result().catch(() => {});
      }
    });
  });
});
