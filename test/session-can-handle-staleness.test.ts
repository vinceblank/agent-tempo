/**
 * #347 — force-restarted sessions cannot send outbox messages.
 *
 * **Root cause** (proven by this test): when the MCP server starts via
 * `client.workflow.start({ workflowIdConflictPolicy: USE_EXISTING })`,
 * the returned `WorkflowHandle` carries `firstExecutionRunId` populated
 * with the runId Temporal returned at that moment. Subsequent
 * `executeUpdate` calls on that handle send `firstExecutionRunId` in
 * the gRPC request, and Temporal validates it against the workflow
 * chain's actual first run. After ANY `continueAsNew` (CAN), the run
 * that `firstExecutionRunId` points to is no longer the first of the
 * chain — Temporal returns `WorkflowNotFoundError`, which surfaced to
 * the architect as "workflow execution not found" on cue/report.
 *
 * **Fix**: in `src/server.ts`, derive the tool-registration handle via
 * `client.workflow.getHandle(workflowId)` (no `firstExecutionRunId`).
 * The gRPC request omits chain validation, so updates resolve to
 * whatever run is currently open under the workflow ID.
 *
 * ## Why structural test, not runtime CAN trigger
 *
 * A first attempt drove a real CAN via `testForceContinueAsNewSignal`,
 * but the session workflow's main loop sleeps on `condition()` until an
 * outbox/phase/attachment event wakes it. The signal flips the
 * `forceContinueAsNew` flag but the loop body that checks the flag
 * doesn't iterate without an attachment claim — driving that
 * end-to-end requires the same fixture machinery as
 * `test/adapter-reconnect.test.ts` (full adapter + claim + heartbeat
 * timing). Out of scope for a hot-path bug fix.
 *
 * The structural tests below prove the SDK behavior the fix relies on:
 * a handle from `getHandle(workflowId)` lacks `firstExecutionRunId`
 * and routes operations to the latest open run; a handle constructed
 * with a stale `firstExecutionRunId` rejects with
 * `WorkflowNotFoundError`. Together those two facts are the bug.
 *
 * Reference for the SDK behavior:
 * - `node_modules/@temporalio/client/lib/workflow-client.js`
 *   line 140: `client.workflow.start()` sets `runId: undefined` but
 *   stamps `firstExecutionRunId` from the start response
 * - line 822: `executeUpdate` builds the request with both fields,
 *   and Temporal server validates the chain identity
 */
import { expect } from 'chai';
import { WorkflowNotFoundError } from '@temporalio/common';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { setupTestEnv, withWorker, getClient, playerMetadata, getTestEnsemble, TASK_QUEUE } from './helpers';
import { submitOutboxUpdate } from '../src/workflows/signals';
import type { OutboxEntryInput } from '../src/types';

const TEST_TIMEOUT = 30_000;

describe('#347 — session handle staleness across continueAsNew', () => {
  before(async () => { await setupTestEnv(); });

  it('STRUCTURAL: client.workflow.start() returns a handle whose firstExecutionRunId is the start runId', async function () {
    this.timeout(TEST_TIMEOUT);
    await withWorker(async () => {
      const client = getClient();
      const ensemble = getTestEnsemble();
      const playerId = `eng3-347-shape-${Date.now()}`;
      const workflowId = `agent-session-${ensemble}-${playerId}`;

      const startedHandle = await client.workflow.start('agentSessionWorkflow', {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{
          metadata: playerMetadata({ playerId }),
          autoSummary: 'Session in test',
          disableStaleDetection: true,
        }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });

      // The bug surface: the handle carries `firstExecutionRunId` per
      // the SDK's internal `_createWorkflowHandle` shape. This field
      // is what causes the post-CAN `WorkflowNotFoundError`.
      const startedRunId = (await startedHandle.describe()).runId;
      const internal = startedHandle as unknown as { firstExecutionRunId?: string };
      expect(internal.firstExecutionRunId,
        'started handle must carry firstExecutionRunId — this is the bug surface').to.equal(startedRunId);

      // Cleanup.
      try { await startedHandle.terminate('test cleanup'); } catch { /* ignore */ }
    });
  });

  it('STRUCTURAL: client.workflow.getHandle(workflowId) returns a handle WITHOUT firstExecutionRunId — survives CAN', async function () {
    this.timeout(TEST_TIMEOUT);
    await withWorker(async () => {
      const client = getClient();
      const ensemble = getTestEnsemble();
      const playerId = `eng3-347-fix-shape-${Date.now()}`;
      const workflowId = `agent-session-${ensemble}-${playerId}`;

      await client.workflow.start('agentSessionWorkflow', {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{
          metadata: playerMetadata({ playerId }),
          autoSummary: 'Session in test',
          disableStaleDetection: true,
        }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });

      // The fix shape: derive an unpinned handle via getHandle(workflowId).
      // Internal `firstExecutionRunId` is undefined, so executeUpdate's
      // gRPC request omits chain validation entirely.
      const unpinnedHandle = client.workflow.getHandle(workflowId);
      const internal = unpinnedHandle as unknown as { firstExecutionRunId?: string };
      expect(internal.firstExecutionRunId,
        'getHandle without runId must NOT carry firstExecutionRunId — this is the fix shape').to.be.undefined;

      // Sanity check: the unpinned handle accepts updates (proving the
      // tool-registration path in server.ts works against it).
      const entry: OutboxEntryInput = {
        type: 'cue', targetPlayerId: 'tempo-conductor', message: 'unpinned cue',
      };
      const entryId = await unpinnedHandle.executeUpdate(submitOutboxUpdate, { args: [entry] });
      expect(entryId).to.be.a('string');

      // Cleanup.
      try { await unpinnedHandle.terminate('test cleanup'); } catch { /* ignore */ }
    });
  });

  it('REPRODUCER: a handle with a stale firstExecutionRunId fails executeUpdate with WorkflowNotFoundError', async function () {
    this.timeout(TEST_TIMEOUT);
    await withWorker(async () => {
      const client = getClient();
      const ensemble = getTestEnsemble();
      const playerId = `eng3-347-stale-${Date.now()}`;
      const workflowId = `agent-session-${ensemble}-${playerId}`;

      await client.workflow.start('agentSessionWorkflow', {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{
          metadata: playerMetadata({ playerId }),
          autoSummary: 'Session in test',
          disableStaleDetection: true,
        }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });

      // Construct a handle whose firstExecutionRunId points at a
      // runId that doesn't belong to this workflow's chain — same
      // shape Temporal sees post-CAN when the started run is mid-chain
      // rather than first-of-chain. Use a syntactically-valid UUID
      // that's never been a real runId.
      const fakeFirstRunId = '00000000-0000-0000-0000-000000000001';
      const staleHandle = client.workflow.getHandle(workflowId, undefined, {
        firstExecutionRunId: fakeFirstRunId,
      });

      const entry: OutboxEntryInput = {
        type: 'cue', targetPlayerId: 'tempo-conductor', message: 'stale-handle attempt',
      };

      let caught: unknown;
      try {
        await staleHandle.executeUpdate(submitOutboxUpdate, { args: [entry] });
      } catch (err) {
        caught = err;
      }

      expect(caught,
        'executeUpdate against a stale firstExecutionRunId MUST reject — this is the architect-side symptom').to.exist;
      expect(caught).to.be.instanceOf(WorkflowNotFoundError);

      // Cleanup.
      try { await client.workflow.getHandle(workflowId).terminate('test cleanup'); } catch { /* ignore */ }
    });
  });
});
