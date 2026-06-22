/**
 * #798 (V2 of the #782 audit) — forceDetach post-await re-check.
 *
 * forceDetachUpdate is async and non-atomic across its hardTerminate
 * await: pre-#798, a FRESH claim landing during the kill-await was
 * clobbered by the unconditional null-out. This suite rigs exactly that
 * interleave with a GATED hardTerminateAttachment stub (the activity
 * parks until the test releases it), drives the old attachment through
 * drain → exit → NEW claim while the update is suspended, then releases
 * the gate and asserts:
 *
 *   - the update returns { reaped: false } (the #798 re-check branch), and
 *   - the fresh claim SURVIVES (phase + attachmentId intact).
 *
 * A control case pins the unchanged happy path ({ reaped: true } when
 * nothing interleaves).
 */
import { expect } from 'chai';
import { Worker } from '@temporalio/worker';
import {
  setupSharedEnv,
  teardownTestEnv,
  startSession,
  playerMetadata,
  attachmentInfoQuery,
  destroyUpdate,
  getNativeConnection,
  getWorkflowBundle,
  mintTaskQueue,
  PROTOCOL_VERSION,
} from './helpers';
import {
  claimAttachmentUpdate,
  forceDetachUpdate,
  requestDetachSignal,
  adapterExitedSignal,
} from '../src/workflows/signals';

/** A manually-released gate the hardTerminate stub parks on. */
function makeGate() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const enteredP = new Promise<void>((r) => { entered = r; });
  return { released, release, entered: enteredP, markEntered: entered };
}

/**
 * Two workers (main + per-host) with a hardTerminateAttachment stub that
 * signals entry then PARKS until the test releases the gate — the
 * injectable-activity-delay rig the #798 issue prescribes.
 */
async function withGatedHardTerminate<T>(
  gate: ReturnType<typeof makeGate>,
  hostname: string,
  fn: (hardTerminateCalls: () => number) => Promise<T>,
): Promise<T> {
  const connection = getNativeConnection();
  const bundle = getWorkflowBundle(); // cached by setupTestEnv (T0.6 accessor)
  const hostTaskQueue = `agent-tempo-${hostname}`;
  const taskQueue = mintTaskQueue();

  // Invocation counter — the actual-harm pin (#810 QA): the kill must fire
  // EXACTLY once, for the OLD claim; a second invocation would mean the
  // update re-ran the kill against the fresh adapter's process.
  let hardTerminateCallCount = 0;
  const gatedStub = async () => {
    hardTerminateCallCount++;
    gate.markEntered();
    await gate.released;
    return { killedPids: [], strategy: 'none' as const, notes: ['gated stub'] };
  };

  const mainWorker = await Worker.create({
    connection,
    taskQueue,
    workflowBundle: bundle,
    stickyQueueScheduleToStartTimeout: '1s',
  });
  const hostWorker = await Worker.create({
    connection,
    taskQueue: hostTaskQueue,
    activities: { hardTerminateAttachment: gatedStub },
  });

  return mainWorker.runUntil(async () => {
    const hostPromise = hostWorker.run();
    try {
      return await fn(() => hardTerminateCallCount);
    } finally {
      hostWorker.shutdown();
      await hostPromise.catch(() => { /* cleanup */ });
    }
  });
}

describe('forceDetach post-await re-check (#798)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  it('a fresh claim landing during the kill-await SURVIVES: update returns reaped:false', async function () {
    this.timeout(30_000);
    const gate = makeGate();
    const hostname = 'test-host';
    const ensemble = `fd-recheck-${Date.now()}`;

    await withGatedHardTerminate(gate, hostname, async (hardTerminateCalls) => {
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: 'recheck-alpha',
          ensemble,
          hostname,
          workDir: '/tmp/recheck-alpha',
          agentType: 'claude',
        }),
      });

      // Old attachment A.
      const tokenA = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: hostname, protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });

      // Fire forceDetach — it parks inside the gated hardTerminate stub.
      const updatePromise = handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'restart' as const, expectedAttachmentId: tokenA.attachmentId, gracePeriodMs: 0 }],
      });
      await gate.entered; // the update is now suspended mid-await

      // The wedged-adapter restart shape: A drains + exits, then a FRESH
      // adapter claims — all while the update awaits the kill.
      await handle.signal(requestDetachSignal, { reason: 'restart', deadlineMs: 0 });
      await handle.signal(adapterExitedSignal, { attachmentId: tokenA.attachmentId, reason: 'restart' });
      const tokenB = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: hostname, protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      expect(tokenB.attachmentId).to.not.equal(tokenA.attachmentId);

      // Release the kill; the update resumes and must take the #798 branch.
      gate.release();
      const result = await updatePromise;
      expect(result.reaped, 'the re-check must refuse to clobber the fresh claim').to.equal(false);
      // Actual-harm pin (#810 QA): the kill fired exactly ONCE — for the OLD
      // claim. The reaped:false skip must not re-run hardTerminate against
      // the fresh adapter's process.
      expect(hardTerminateCalls()).to.equal(1);

      // The fresh claim survived.
      const info = await handle.query(attachmentInfoQuery);
      expect(info.currentAttachment?.attachmentId).to.equal(tokenB.attachmentId);
      expect(['attached', 'awaiting', 'processing']).to.include(info.phase);

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test cleanup' }] });
      await handle.result();
    });
  });

  it('control: with no interleave, forceDetach still reaps (reaped:true, phase detached)', async function () {
    this.timeout(30_000);
    const gate = makeGate();
    gate.release(); // no parking — plain fast stub
    const hostname = 'test-host';
    const ensemble = `fd-control-${Date.now()}`;

    await withGatedHardTerminate(gate, hostname, async (hardTerminateCalls) => {
      const handle = await startSession({
        metadata: playerMetadata({
          playerId: 'recheck-control',
          ensemble,
          hostname,
          workDir: '/tmp/recheck-control',
          agentType: 'claude',
        }),
      });
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: hostname, protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });

      const result = await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'restart' as const, expectedAttachmentId: token.attachmentId, gracePeriodMs: 0 }],
      });
      expect(result.reaped).to.equal(true);
      expect(hardTerminateCalls()).to.equal(1);

      const info = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('detached');
      expect(info.currentAttachment, 'attachment must be cleared on the reap path').to.not.exist;

      await handle.executeUpdate(destroyUpdate, { args: [{ reason: 'test cleanup' }] });
      await handle.result();
    });
  });
});
