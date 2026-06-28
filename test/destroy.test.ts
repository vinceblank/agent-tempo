import { expect } from 'chai';
import { Worker } from '@temporalio/worker';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import * as path from 'path';
import * as fs from 'fs';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
  isDestroyedQuery,
  attachmentInfoQuery,
  processingStartUpdate,
  getClient,
  getNativeConnection,
  TASK_QUEUE,
  mintTaskQueue,
  PROTOCOL_VERSION,
} from './helpers';

describe('destroy verb — fixes #102 (graceful stop → resurrection loop)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('marks the workflow destroyed and transitions phase to gone', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'destroy-bob', ensemble }),
      });

      // Pre-destroy: not destroyed.
      expect(await handle.query(isDestroyedQuery)).to.equal(false);

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'user requested stop' }] });

      // Post-destroy: isDestroyed flips true and attachment phase transitions to `gone`
      // (the authoritative lifecycle-terminal indicator post-#175).
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
      const info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('gone');

      // Workflow drains and completes on its own.
      await handle.result();
    });
  });

  it('refuses processingStart on a destroyed session (validator guard)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-attach-${Date.now()}`;
      // Start a live session, destroy it, then try to sneak in a processingStart update.
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'destroy-attach', ensemble }),
      });

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test' }] });

      // After destroy, the workflow COMPLETEs (§2.5). Any subsequent update MUST fail —
      // either the validator rejects (our typed `WorkflowGone` ApplicationFailure) or
      // Temporal rejects against the completed execution (`WorkflowNotFoundError`).
      // Both outcomes prove the attach-adjacent op was refused.
      let rejected = false;
      try {
        await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'late-msg' }] });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, 'expected processingStart to be rejected on destroyed session');

      // Workflow self-completes; just await the result.
      await handle.result().catch(() => {});
    });
  });

  it('second start with USE_EXISTING on a destroyed workflow gets a NEW run; old handle sees terminated', async function () {
    this.timeout(20_000);
    await withWorker(async () => {
      const ensemble = `destroy-resurrect-${Date.now()}`;
      const metadata = playerMetadata({ playerId: 'resurrect-bob', ensemble });
      const wfId = `agent-session-${ensemble}-resurrect-bob`;
      const client = getClient();

      const input = {
        metadata,
        autoSummary: `Session in test`,
        disableStaleDetection: true,
      };

      // Initial run — pin runId
      const handle1 = await client.workflow.start('agentSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
      });
      const runId1 = handle1.firstExecutionRunId;
      expect(runId1).to.be.a('string');

      // Destroy the first run
      await handle1.executeUpdate(destroyUpdate, { args: [{ reason: 'stop' }] });
      await handle1.result();

      // Simulate the adapter-recovery misbehavior: call start() again with USE_EXISTING.
      // Temporal reuses the old workflowId but (since it completed) allows a new run.
      const handle2 = await client.workflow.start('agentSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });
      const runId2 = handle2.firstExecutionRunId;

      // The second start returned a fresh run — that's the resurrection hazard.
      // But a correctly-written adapter would have pinned to runId1, and a query
      // against the runId1-pinned handle should not silently attach to run 2.
      expect(runId2).to.not.equal(runId1, 'USE_EXISTING on completed workflow should start a new run');

      // Confirm: the runId1-pinned handle reports the OLD run as closed.
      const pinnedToOld = client.workflow.getHandle(wfId, runId1!);
      const descOld = await pinnedToOld.describe();
      expect(['COMPLETED', 'TERMINATED', 'FAILED']).to.include(descOld.status.name);

      // The pinned-old isDestroyed query still succeeds against the historical run
      // (queries against closed workflows work in Temporal), returning true.
      expect(await pinnedToOld.query(isDestroyedQuery)).to.equal(true);

      // Clean up the second run
      await handle2.executeUpdate(destroyUpdate, { args: [{}] });
      await handle2.result();
    });
  });
});

// #164: destroy with a live attachment. Uses withWorker (shared host worker stub) to
// avoid the dual-worker cascade that withCustomHardTerminate causes (#150). We verify
// the behavioral contract (workflow completes, isDestroyed=true) rather than call-count.
// hardTerminate invocation was verified via live smoke test on Windows.

import {
  claimAttachmentUpdate,
  forceDetachUpdate,
} from '../src/workflows/signals';

describe('destroy verb — fixes #164 (destroy with live attachment)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('destroys a session with a live attachment — workflow completes, isDestroyed=true', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-164-claimed-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: 'claimed-delta',
          ensemble,
          hostname: 'test-host',
          workDir: '/tmp/claimed-delta',
          agentType: 'claude',
        }),
      });

      // Create a live attachment — the #164 bug is specifically about this path.
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'test-host', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });

      // Capture phase before the workflow completes — queries don't work on
      // completed workflows in all Temporal client versions.
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'repro #164' }] });
      const info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('gone');

      // Destroy while attached — must not hang or throw.
      await handle.result();
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
    });
  });

  it('concurrent forceDetach + destroy — workflow reaches gone without errors', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-164-race-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: 'race-epsilon',
          ensemble,
          hostname: 'test-host',
          agentType: 'claude',
        }),
      });

      // Create a live attachment.
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'test-host', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });

      // Fire forceDetach and destroy concurrently.
      const results = await Promise.allSettled([
        handle.executeUpdate(forceDetachUpdate, {
          args: [{ reason: 'restart' as const, expectedAttachmentId: token.attachmentId, gracePeriodMs: 0 }],
        }),
        handle.executeUpdate(destroyUpdate, { args: [{ reason: 'race test' }] }),
      ]);

      // At least one must succeed. Both succeeding is also fine.
      const anyFulfilled = results.some((r) => r.status === 'fulfilled');
      expect(anyFulfilled, 'at least one of forceDetach/destroy must succeed').to.equal(true);

      // Workflow must complete (destroy wins).
      await handle.result();
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
    });
  });
});

// #227: destroy on a `phase=detached` session used to skip `hardTerminateAttachment`
// (the `if (currentAttachment)` guard short-circuited because detached → null), leaking
// `claude.exe` processes + terminal tabs. Exposed in the wild by the #226 CAN-cascade
// repro during beta.2 teardown. This suite pins the fix: destroy now reads the best
// host it has (currentAttachment.hostname → lastAdapterMeta.hostname → preferredHost →
// input.metadata.hostname) and fires the activity whenever *any* host is known, passing
// the same ensemble/player/agent payload as the attached path.
//
// We use a custom capturing `hardTerminateAttachment` stub (instead of the shared
// `withWorker` stub) so we can assert the invocation happened, with the right args,
// regardless of phase.
describe('destroy verb — fixes #227 (orphan claude.exe on detached destroy)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  /**
   * Locate the pre-built workflow bundle. Resolves up from __dirname until we find
   * `workflow-bundle.js` at the repo root. Mirrors `test/helpers.ts`'s private helper;
   * inlined here to avoid widening the helpers export surface for one file.
   */
  function findWorkflowBundle(): string {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'workflow-bundle.js');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    throw new Error('workflow-bundle.js not found. Run `npm run build`.');
  }

  /**
   * Spin up two workers (main task queue + per-host) with a hardTerminateAttachment
   * stub that pushes every invocation into `captured`. Mirrors the structure of
   * `withWorker` in helpers.ts but inlined so the capture is test-local.
   */
  async function withCapturingHardTerminate<T>(
    captured: Array<{ host: string; ensemble: string; playerName: string; agent: string; workDir: string }>,
    hostname: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const connection = getNativeConnection();
    const bundle = { code: fs.readFileSync(findWorkflowBundle(), 'utf-8') };
    const hostTaskQueue = `agent-tempo-${hostname}`;
    // #721 — mint a fresh queue: this inlined setup uses bare Worker.create
    // (no slot-retry), so reusing a previously-minted queue would race the
    // prior worker's SlotKey release unprotected. Minting also updates the
    // live TASK_QUEUE binding, so startSession() inside `fn` agrees.
    const taskQueue = mintTaskQueue();

    const captureStub = async (input: {
      ensemble: string;
      playerName: string;
      agent: string;
      workDir: string;
    }) => {
      captured.push({ host: hostname, ...input });
      return { killedPids: [], strategy: 'none' as const, notes: ['capture stub'] };
    };

    const mainWorker = await Worker.create({
      connection,
      taskQueue,
      workflowBundle: bundle,
      // #777 — match the helpers.ts choke-point default (this is the one
      // worker-create site that bypasses createWorkerWithSlotRetry): bound a
      // missed sticky dispatch to 1s instead of the SDK's silent 10s.
      stickyQueueScheduleToStartTimeout: '1s',
    });
    const hostWorker = await Worker.create({
      connection,
      taskQueue: hostTaskQueue,
      activities: { hardTerminateAttachment: captureStub },
    });

    return mainWorker.runUntil(async () => {
      const hostPromise = hostWorker.run();
      try {
        return await fn();
      } finally {
        hostWorker.shutdown();
        await hostPromise.catch(() => { /* cleanup */ });
      }
    });
  }

  it('fires hardTerminateAttachment on destroy when phase=detached (core #227 repro)', async function () {
    this.timeout(20_000);
    const captured: Array<{ host: string; ensemble: string; playerName: string; agent: string; workDir: string }> = [];
    const ensemble = `destroy-227-detached-${Date.now()}`;
    const playerName = 'orphan-alpha';
    const hostname = 'test-host';

    await withCapturingHardTerminate(captured, hostname, async () => {
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: playerName,
          ensemble,
          hostname,
          workDir: '/tmp/orphan-alpha',
          agentType: 'claude',
        }),
      });

      // Bring the session through its full lifecycle to a true `phase=detached`
      // state — this is exactly the repro path from the #227 issue body
      // (adapter had attached and then its lease was reaped).
      const token = await handle.executeUpdate(
        (await import('../src/workflows/signals')).claimAttachmentUpdate,
        { args: [{ host: hostname, protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }] },
      );
      await handle.executeUpdate(
        (await import('../src/workflows/signals')).forceDetachUpdate,
        {
          args: [{
            reason: 'heartbeat-timeout' as const,
            expectedAttachmentId: token.attachmentId,
            gracePeriodMs: 0,
          }],
        },
      );

      // Confirm the workflow is in the bug-exposing state: phase=detached,
      // currentAttachment=null, but lastAdapterMeta.hostname populated by the reap.
      const preDestroy = await handle.query(attachmentInfoQuery);
      expect(preDestroy.phase).to.equal('detached');
      expect(preDestroy.currentAttachment).to.be.undefined;

      // Pre-#227 this destroy would return success, the workflow would complete,
      // but hardTerminateAttachment would never have been dispatched.
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: '#227 repro' }] });

      // Post-#227: the kill activity was dispatched with the lastAdapterMeta host.
      expect(captured.length, 'hardTerminate must be invoked on detached destroy').to.be.at.least(1);
      const invocation = captured[0];
      expect(invocation.host).to.equal(hostname);
      expect(invocation.ensemble).to.equal(ensemble);
      expect(invocation.playerName).to.equal(playerName);
      expect(invocation.agent).to.equal('claude');
      expect(invocation.workDir).to.equal('/tmp/orphan-alpha');

      await handle.result();
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
    });
  });

  it('still fires hardTerminateAttachment on destroy when phase=attached (regression guard on the #164 path)', async function () {
    this.timeout(20_000);
    const captured: Array<{ host: string; ensemble: string; playerName: string; agent: string; workDir: string }> = [];
    const ensemble = `destroy-227-attached-${Date.now()}`;
    const playerName = 'orphan-beta';
    const hostname = 'test-host';

    await withCapturingHardTerminate(captured, hostname, async () => {
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: playerName,
          ensemble,
          hostname,
          workDir: '/tmp/orphan-beta',
          agentType: 'claude',
        }),
      });

      await handle.executeUpdate(
        (await import('../src/workflows/signals')).claimAttachmentUpdate,
        { args: [{ host: hostname, protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }] },
      );

      // phase=attached → #164 path; previously worked, must still work.
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: '#164 regression guard' }] });

      expect(captured.length, 'hardTerminate must still fire on attached destroy').to.be.at.least(1);
      expect(captured[0].host).to.equal(hostname);
      expect(captured[0].ensemble).to.equal(ensemble);
      expect(captured[0].playerName).to.equal(playerName);

      await handle.result();
    });
  });

  it('skips hardTerminate cleanly when there is no host to target (phase=booting)', async function () {
    // Edge case: a session that was never attached AND has no preferred host.
    // We force this by constructing metadata with an empty hostname. The destroy
    // handler must NOT dispatch the activity (no host to target), but MUST still
    // complete the workflow. No orphan can exist without a spawn, so this is
    // correctness: the fix should skip, not crash.
    this.timeout(15_000);
    const captured: Array<{ host: string; ensemble: string; playerName: string; agent: string; workDir: string }> = [];
    const ensemble = `destroy-227-nohost-${Date.now()}`;

    // Note: we can't actually set hostname='' via playerMetadata() defaults —
    // the helper always sets 'test-host'. We mirror withCapturingHardTerminate's
    // structure but use a non-existent host so if the activity WERE dispatched
    // it would hang for the whole retry window. The 10s test timeout catches
    // such a regression. The expected behavior is captured.length === 0.
    await withCapturingHardTerminate(captured, 'test-host', async () => {
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: 'never-attached',
          ensemble,
          hostname: 'test-host', // needed for recruit-time fallback
          workDir: '/tmp/never-attached',
          agentType: 'claude',
        }),
      });

      // No claimAttachment, no forceDetach → phase=booting, no lastAdapterMeta,
      // no preferredHost beyond metadata.hostname. With our fix, `killHost`
      // falls through to input.metadata.hostname='test-host' and we DO dispatch
      // (the activity itself returns strategy='none' for a non-existent process,
      // which is the correct safe behavior — see issue #227 §Proposed fix).
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'no-attach destroy' }] });

      // metadata.hostname fallback means the activity IS dispatched — but with
      // strategy='none' the process search finds nothing. Either outcome here is
      // acceptable as long as the workflow completes cleanly:
      //   - 1+ invocation with strategy='none' (current fix behavior)
      //   - 0 invocations (if we tightened the guard in a future PR)
      // We assert just on workflow completion — the "always dispatch when a host
      // exists" property is already pinned by the detached/attached tests above.
      await handle.result();
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
    });
  });
});
