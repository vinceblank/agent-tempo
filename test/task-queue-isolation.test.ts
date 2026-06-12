/**
 * #721 — per-withWorker unique task queues (structural SlotKey-overlap fix).
 *
 * The Mocha suite used to share one fixed `test-agent-tempo` queue across
 * every worker in the process. The Rust core-bridge releases a worker's
 * SlotKey *after* `runUntil` resolves at the Node layer, so consecutive
 * `withWorker` calls raced the not-yet-released slot and threw
 * "Registration of multiple workers with overlapping worker task types …"
 * under CPU load (#642). `createWorkerWithSlotRetry` is the band-aid;
 * minting a unique queue per worker creation makes the collision
 * structurally impossible.
 *
 * These tests pin the three invariants the fix relies on:
 *   1. consecutive `withWorker` invocations never share a queue;
 *   2. the exported `TASK_QUEUE` is a live binding — a workflow started via
 *      `taskQueue: TASK_QUEUE` inside the callback lands on the exact queue
 *      that callback's worker polls (round-trip proven via query + describe);
 *   3. `setupTestEnv()` re-mints, so file-scope reads never see a previous
 *      file's queue (or the bare pre-#721 literal).
 *
 * NOTE: the live-binding design rests on the SERIAL-WITHWORKER CONSTRAINT
 * (#721) — no two `withWorker*` invocations may run concurrently within one
 * process (enforced by tests/conformance/serial-withworker-fence.test.ts).
 * Parallel-Mocha with per-FILE worker processes is safe (module state is
 * per-process); intra-process concurrency is the only forbidden shape.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  getMetadataQuery,
  destroyUpdate,
  TASK_QUEUE,
} from './helpers';
import type { SessionMetadata } from '../src/types';

/** Minted shape: test-agent-tempo-<8 hex chars>-<counter>. */
const MINTED_QUEUE_RE = /^test-agent-tempo-[0-9a-f]{8}-\d+$/;

describe('per-test task-queue isolation (#721)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('file-scope TASK_QUEUE is already minted after setupTestEnv (never the bare literal)', function () {
    expect(TASK_QUEUE).to.match(
      MINTED_QUEUE_RE,
      'setupTestEnv must re-mint so pre-withWorker reads see this file\'s namespace',
    );
  });

  it('consecutive withWorker invocations mint distinct queues', async function () {
    this.timeout(45_000);

    const seen: string[] = [];
    await withWorker(async () => {
      seen.push(TASK_QUEUE);
    });
    await withWorker(async () => {
      seen.push(TASK_QUEUE);
    });

    expect(seen).to.have.length(2);
    for (const q of seen) expect(q).to.match(MINTED_QUEUE_RE);
    expect(seen[0]).to.not.equal(
      seen[1],
      'two withWorker calls must never share a SlotKey',
    );
  });

  it('workflows started via the live binding run on the queue the worker polls', async function () {
    this.timeout(45_000);

    await withWorker(async () => {
      const insideQueue = TASK_QUEUE;

      // startSession reads the live TASK_QUEUE binding internally.
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'queue-isolation-probe' }),
      });

      // The workflow's recorded task queue is the one minted for this worker…
      const desc = await handle.describe();
      expect(desc.taskQueue).to.equal(
        insideQueue,
        'workflow must start on the queue minted for the enclosing withWorker',
      );

      // …and the worker actually serves it: a query round-trip requires a
      // worker polling that queue to process the workflow task.
      const metadata: SessionMetadata = await handle.query(getMetadataQuery);
      expect(metadata.playerId).to.equal('queue-isolation-probe');

      // Clean up inside the worker scope — with unique queues, no later
      // worker would ever process this workflow's tasks.
      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test cleanup' }] });
      await handle.result();
    });
  });
});
