import { expect } from 'chai';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  getMetadataQuery,
  destroyUpdate,
  isDestroyedQuery,
  processingStartUpdate,
  getClient,
  TASK_QUEUE,
} from './helpers';

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

  it('refuses processingStart once destroyRequested is set (in-workflow guard)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `destroy-attach-${Date.now()}`;
      // Start a session pre-marked as destroyed via input state (simulates continue-as-new
      // of a destroyed workflow) — this keeps the workflow alive long enough for us to
      // observe the in-workflow guard without racing workflow completion.
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'destroy-attach', ensemble, status: 'pending' }),
        destroyed: true,
      });

      expect(await handle.query(isDestroyedQuery)).to.equal(true);

      let rejected = false;
      try {
        await handle.executeUpdate(processingStartUpdate, { args: [{ messageId: 'late-msg' }] });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, 'expected processingStart to be rejected on destroyed session');

      // Force-terminate rather than waiting — the workflow's main loop is still running
      // with status=pending since we bypassed the normal destroy flow.
      await handle.terminate('test cleanup');
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
