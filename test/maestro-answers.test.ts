/**
 * Tests for the maestro Q&A answer mailbox (#700 P2, commit 1 / A).
 *
 * The coat-check clone for correlated answers: a player parks an answer via
 * `maestroPostAnswer` keyed by the planner-supplied `questionId`; the planner
 * reads it back via `maestroGetAnswer`. Follows the coat-check.test.ts harness
 * (shared TestWorkflowEnvironment + `withWorkerAndMaestroActivities`).
 *
 * Coverage:
 *   - post → query roundtrip (from / text / answeredAt)
 *   - query null for an unknown questionId
 *   - overwrite: re-posting the same questionId reuses its slot (retry-safe)
 *   - caps: 20 distinct answers OK; the 21st distinct → MaestroAnswersFull
 *   - validation: empty questionId/from/text + oversize text
 *
 * TTL-expiry sweep and CAN-carry are PURE mirrors of the coat-check
 * `sweepExpired*` + non-empty-carry idioms (structurally identical, same
 * `workflowNow()` clock) — scoped to structural parity exactly as
 * coat-check.test.ts scopes its own CAN-carry coverage (see that file's header).
 */
import { expect } from 'chai';
import { Client, WorkflowHandle, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  getTestEnsemble,
  TASK_QUEUE,
  withWorkerAndMaestroActivities,
} from './helpers';
import {
  maestroShutdownSignal,
  maestroPostAnswerUpdate,
  maestroGetAnswerQuery,
} from '../src/workflows/maestro-signals';
import { MAESTRO_ANSWERS_MAX, MESSAGE_MAX } from '../src/utils/validation';

let ENSEMBLE: string;
const FAST_POLL_MS = 500;
let testCounter = 0;
const pendingHandles: WorkflowHandle[] = [];

async function startMaestro(client: Client): Promise<WorkflowHandle> {
  const input = { ensemble: ENSEMBLE, pollIntervalMs: FAST_POLL_MS };
  const handle = await client.workflow.start('agentMaestroWorkflow', {
    workflowId: `agent-maestro-${ENSEMBLE}-answers-${++testCounter}`,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  pendingHandles.push(handle);
  return handle;
}

describe('maestro Q&A answer mailbox (#700 P2)', function () {
  before(async function () {
    this.timeout(120_000);
    await setupTestEnv();
    ENSEMBLE = getTestEnsemble();
  });

  after(async function () {
    await teardownTestEnv();
  });

  afterEach(async function () {
    const toClean = pendingHandles.splice(0);
    for (const handle of toClean) {
      try {
        await handle.signal(maestroShutdownSignal);
        await handle.result().catch(() => { /* COMPLETED or worker-stopped */ });
      } catch { /* already complete */ }
    }
  });

  it('post → query roundtrip returns the parked answer', async function () {
    this.timeout(10_000);
    await withWorkerAndMaestroActivities({}, async () => {
      const handle = await startMaestro(getClient());

      const res = await handle.executeUpdate(maestroPostAnswerUpdate, {
        args: [{ questionId: 'q-1', from: 'tempo-eng', text: 'migration done, tests green' }],
      });
      expect(res).to.deep.equal({ stored: true });

      const entry = await handle.query(maestroGetAnswerQuery, 'q-1');
      expect(entry).to.not.equal(null);
      expect(entry!.questionId).to.equal('q-1');
      expect(entry!.from).to.equal('tempo-eng');
      expect(entry!.text).to.equal('migration done, tests green');
      expect(entry!.answeredAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });
  });

  it('query returns null for an unknown questionId', async function () {
    this.timeout(10_000);
    await withWorkerAndMaestroActivities({}, async () => {
      const handle = await startMaestro(getClient());
      const entry = await handle.query(maestroGetAnswerQuery, 'never-asked');
      expect(entry).to.equal(null);
      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });
  });

  it('re-posting the same questionId overwrites and reuses the slot (retry-safe)', async function () {
    this.timeout(10_000);
    await withWorkerAndMaestroActivities({}, async () => {
      const handle = await startMaestro(getClient());

      await handle.executeUpdate(maestroPostAnswerUpdate, {
        args: [{ questionId: 'q-1', from: 'tempo-eng', text: 'first' }],
      });
      await handle.executeUpdate(maestroPostAnswerUpdate, {
        args: [{ questionId: 'q-1', from: 'tempo-eng', text: 'second (retry)' }],
      });

      const entry = await handle.query(maestroGetAnswerQuery, 'q-1');
      expect(entry!.text).to.equal('second (retry)');

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });
  });

  it('fills 20 distinct answers, then rejects the 21st with MaestroAnswersFull', async function () {
    this.timeout(20_000);
    await withWorkerAndMaestroActivities({}, async () => {
      const handle = await startMaestro(getClient());

      for (let i = 0; i < MAESTRO_ANSWERS_MAX; i++) {
        await handle.executeUpdate(maestroPostAnswerUpdate, {
          args: [{ questionId: `q-${i}`, from: 'p', text: `a${i}` }],
        });
      }
      try {
        await handle.executeUpdate(maestroPostAnswerUpdate, {
          args: [{ questionId: 'q-overflow', from: 'p', text: 'nope' }],
        });
        expect.fail('Should have thrown MaestroAnswersFull');
      } catch (err: any) {
        expect(err).to.be.instanceOf(WorkflowUpdateFailedError);
        expect(err.cause?.message).to.match(/mailbox full/i);
      }

      // A retry overwriting an EXISTING questionId still succeeds at the cap.
      const res = await handle.executeUpdate(maestroPostAnswerUpdate, {
        args: [{ questionId: 'q-0', from: 'p', text: 'overwrite at cap' }],
      });
      expect(res).to.deep.equal({ stored: true });

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });
  });

  it('rejects empty questionId / from / text and oversize text', async function () {
    this.timeout(10_000);
    await withWorkerAndMaestroActivities({}, async () => {
      const handle = await startMaestro(getClient());

      const cases: Array<{ args: any; rx: RegExp }> = [
        { args: { questionId: '', from: 'p', text: 't' }, rx: /questionId/i },
        { args: { questionId: 'q', from: '', text: 't' }, rx: /from/i },
        { args: { questionId: 'q', from: 'p', text: '' }, rx: /text must be/i },
        { args: { questionId: 'q', from: 'p', text: 'x'.repeat(MESSAGE_MAX + 1) }, rx: /exceeds/i },
      ];
      for (const c of cases) {
        try {
          await handle.executeUpdate(maestroPostAnswerUpdate, { args: [c.args] });
          expect.fail(`Should have thrown for ${JSON.stringify(c.args).slice(0, 40)}`);
        } catch (err: any) {
          expect(err.cause?.message).to.match(c.rx);
        }
      }

      await handle.signal(maestroShutdownSignal);
      await handle.result();
    });
  });
});
