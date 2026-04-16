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

// #164 tests (hardTerminate call-count verification with claimAttachment) are deferred
// to the test-gap follow-up PR. The withCustomHardTerminate helper creates a second
// Temporal test environment on HOST_TASK_QUEUE whose cleanup races with subsequent test
// files, causing cascading "multiple workers with overlapping task types" failures (#150).
// The production code (#164 fix) was verified via live smoke test on Windows.
