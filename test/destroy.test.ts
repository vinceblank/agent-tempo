import { expect } from 'chai';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  withCustomHardTerminate,
  startSession,
  playerMetadata,
  getMetadataQuery,
  destroyUpdate,
  isDestroyedQuery,
  processingStartUpdate,
  getClient,
  TASK_QUEUE,
} from './helpers';
import { claimAttachmentUpdate } from '../src/workflows/signals';

describe('destroy verb — fixes #102 (graceful stop → resurrection loop)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('marks the workflow destroyed and transitions to terminated status', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-${Date.now()}`;
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'destroy-bob', ensemble }),
      });

      // Pre-destroy: not destroyed
      expect(await handle.query(isDestroyedQuery)).to.equal(false);

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'user requested stop' }] });

      // Post-destroy: query returns true, metadata status is terminated
      expect(await handle.query(isDestroyedQuery)).to.equal(true);
      const meta = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('terminated');

      // Workflow drains and completes on its own
      await handle.result();
    });
  });

  it('refuses processingStart on a destroyed session (validator guard)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-attach-${Date.now()}`;
      // Start a live session, destroy it, then try to sneak in a processingStart update.
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'destroy-attach', ensemble, status: 'active' }),
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
      const wfId = `claude-session-${ensemble}-resurrect-bob`;
      const client = getClient();

      const input = {
        metadata,
        autoSummary: `Session in test`,
        disableStaleDetection: true,
      };

      // Initial run — pin runId
      const handle1 = await client.workflow.start('claudeSessionWorkflow', {
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
      const handle2 = await client.workflow.start('claudeSessionWorkflow', {
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

describe('destroy verb — fixes #164 (orphaned claude.exe when attachment is live)', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('invokes hardTerminateAttachment on the host queue with the right args before flipping phase', async function () {
    this.timeout(15_000);
    const calls: Array<{
      ensemble: string;
      playerName: string;
      agent: string;
      workDir: string;
    }> = [];
    await withCustomHardTerminate(
      async (input) => {
        calls.push(input);
        return { killedPids: [4242], strategy: 'search', notes: [] };
      },
      async () => {
        const ensemble = `destroy-164-${Date.now()}`;
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'probe-alpha',
            ensemble,
            hostname: 'test-host',
            workDir: '/tmp/probe-alpha',
            agentType: 'claude',
          }),
        });

        // Create a live attachment — the #164 bug only triggers when currentAttachment is non-null.
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'test-host', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
        });

        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'repro #164' }] });

        // Workflow still completes — destroy remains terminal.
        await handle.result();

        // And it invoked hardTerminate once, on the per-host queue, with the right shape.
        expect(calls.length, 'hardTerminateAttachment should be called once').to.equal(1);
        expect(calls[0]).to.deep.equal({
          ensemble,
          playerName: 'probe-alpha',
          agent: 'claude',
          workDir: '/tmp/probe-alpha',
        });

        // And the workflow is destroyed post-run (query against the historical run).
        expect(await handle.query(isDestroyedQuery)).to.equal(true);
      },
    );
  });

  it('still completes and transitions to gone when hardTerminate throws (best-effort)', async function () {
    this.timeout(15_000);
    let calls = 0;
    await withCustomHardTerminate(
      async () => {
        calls++;
        throw new Error('host worker offline — simulated #164 best-effort path');
      },
      async () => {
        const ensemble = `destroy-164-besteffort-${Date.now()}`;
        const handle = await startSession({
          metadata: playerMetadata({
            playerId: 'probe-beta',
            ensemble,
            hostname: 'test-host',
            agentType: 'claude',
          }),
        });

        // Create a live attachment so hardTerminate is invoked.
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'test-host', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
        });

        // The update MUST resolve (destroy is terminal even when hardTerminate fails).
        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'kill fails' }] });

        // The workflow MUST complete — this is the critical invariant: a failed
        // hardTerminate does NOT wedge the workflow in a non-terminal state.
        await handle.result();

        expect(calls, 'hardTerminateAttachment should have been attempted').to.be.greaterThan(0);
        expect(await handle.query(isDestroyedQuery)).to.equal(true);
        const meta = await handle.query(getMetadataQuery);
        expect(meta.status).to.equal('terminated');
      },
    );
  });

  it('is idempotent on already-destroyed sessions (second destroy is a no-op, hardTerminate not re-invoked)', async function () {
    this.timeout(15_000);
    let calls = 0;
    await withCustomHardTerminate(
      async () => {
        calls++;
        return { killedPids: [], strategy: 'none', notes: [] };
      },
      async () => {
        const ensemble = `destroy-164-idem-${Date.now()}`;
        const handle = await startSession({
          metadata: playerMetadata({ playerId: 'probe-gamma', ensemble, hostname: 'test-host' }),
        });

        // Create a live attachment so the first destroy triggers hardTerminate.
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ host: 'test-host', adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
        });

        await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'first' }] });
        await handle.result();

        // Second destroy against the already-completed run: should not throw, and
        // must not schedule a second activity (workflow is gone — validator + the
        // `phase === 'gone'` early return both protect this). Temporal may reject
        // the update with a WorkflowNotFoundError since the workflow is closed;
        // that's fine — the key assertion is `calls === 1`.
        try {
          await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'second' }] });
        } catch {
          /* expected — workflow has completed */
        }
        expect(calls, 'hardTerminateAttachment should only be invoked once').to.equal(1);
      },
    );
  });
});
