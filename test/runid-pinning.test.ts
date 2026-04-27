import { expect } from 'chai';
import { WorkflowIdConflictPolicy, WorkflowNotFoundError } from '@temporalio/client';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  playerMetadata,
  getMetadataQuery,
  updateMetadataSignal,

  destroyUpdate,
  getClient,
  TASK_QUEUE,
} from './helpers';

describe('runId pinning — prevents zombie-resurrection via unpinned handles', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('unpinned getHandle silently attaches to a new run with same workflowId (illustrates the hazard)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `pin-hazard-${Date.now()}`;
      const wfId = `claude-session-${ensemble}-pin-bot`;
      const client = getClient();
      const input = {
        metadata: playerMetadata({ playerId: 'pin-bot', ensemble }),
        autoSummary: `Session in test`,
        disableStaleDetection: true,
      };

      // Start run 1, capture runId
      const h1 = await client.workflow.start('claudeSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
      });
      const runId1 = h1.firstExecutionRunId!;

      // Complete run 1
      await h1.executeUpdate(destroyUpdate, { args: [{}] });
      await h1.result();

      // Start run 2 with USE_EXISTING (completed run allows this) — fresh runId
      const h2 = await client.workflow.start('claudeSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });
      const runId2 = h2.firstExecutionRunId!;
      expect(runId2).to.not.equal(runId1);

      // HAZARD demonstration: unpinned getHandle attaches to the CURRENT run (run 2),
      // silently. A caller expecting run 1 would not get an error.
      const unpinned = client.workflow.getHandle(wfId);
      const descUnpinned = await unpinned.describe();
      expect(descUnpinned.runId).to.equal(runId2, 'unpinned handle tracks current run');

      // Cleanup
      await h2.executeUpdate(destroyUpdate, { args: [{}] });
      await h2.result();
    });
  });

  it('pinned getHandle(wfId, runId) returns WorkflowNotFound if the pinned run is gone', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const ensemble = `pin-safe-${Date.now()}`;
      const wfId = `claude-session-${ensemble}-pin-safe`;
      const client = getClient();
      const input = {
        metadata: playerMetadata({ playerId: 'pin-safe', ensemble }),
        autoSummary: `Session in test`,
        disableStaleDetection: true,
      };

      // Start + terminate run 1
      const h1 = await client.workflow.start('claudeSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
      });
      const runId1 = h1.firstExecutionRunId!;
      await h1.executeUpdate(destroyUpdate, { args: [{}] });
      await h1.result();

      // The runId1-pinned handle can still query the historical run (queries against
      // closed workflows work in Temporal).
      const pinned1 = client.workflow.getHandle(wfId, runId1);
      const pinnedDesc = await pinned1.describe();
      expect(pinnedDesc.runId).to.equal(runId1);
      // Historical phase still readable via the `ClaudeTempoAttachmentState`
      // search attribute — `gone` marks the terminal destroy state post-#175.
      const pinnedPhase = (pinnedDesc.searchAttributes?.ClaudeTempoAttachmentState as string[] | undefined)?.[0];
      expect(pinnedPhase).to.equal('gone');

      // Start run 2 (fresh)
      const h2 = await client.workflow.start('claudeSessionWorkflow', {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [input],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });

      // The runId1-pinned handle is STILL pinned to run 1 — never silently attaches
      // to run 2 even though it's now the current run for this workflow ID.
      const pinnedAgain = await pinned1.describe();
      expect(pinnedAgain.runId).to.equal(runId1);
      expect(pinnedAgain.runId).to.not.equal(h2.firstExecutionRunId);

      // A signal attempt against the pinned-closed run throws — protects callers from
      // silently mutating a resurrected workflow.
      let threw = false;
      try {
        await pinned1.executeUpdate(destroyUpdate, { args: [{}] });
      } catch (err) {
        threw = true;
        // Could be WorkflowNotFoundError or a workflow-execution-already-completed error;
        // either way, it did NOT silently attach to run 2.
        expect(err instanceof WorkflowNotFoundError || String(err).toLowerCase().includes('completed')).to.equal(true);
      }
      expect(threw).to.equal(true, 'signal against pinned-closed run must fail, not attach to current');

      // Cleanup run 2
      await h2.executeUpdate(destroyUpdate, { args: [{}] });
      await h2.result();
    });
  });
});
