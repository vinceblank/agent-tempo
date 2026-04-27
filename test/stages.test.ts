/**
 * Tests for pipeline stage tracking on conductor workflows.
 */
import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  getTestEnsemble,
  startSession,
  conductorMetadata,
  withWorker,
  updateMetadataSignal,
  destroyUpdate,
} from './helpers';
import {
  setStageSignal,
  cancelStageSignal,
  stagesQuery,
  playerReportSignal,
  allMessagesQuery,
} from '../src/workflows/signals';
import type { StageEntry, Message } from '../src/types';

/** Per-file ensemble namespace — seeded in `before()` (see #210). */
let ENSEMBLE: string;

/**
 * Poll `assertFn` until it succeeds (no throw) or `timeoutMs` elapses.
 *
 * Replaces the `await skipTime(1); expect(...)` pattern that raced the
 * workflow dispatch loop on slow CI runners and caused intermittent
 * failures on Node 22 (#190). `skipTime(1)` is a real 1ms sleep, which
 * was gambling that the Rust worker core → JS workflow task → dispatch
 * loop → state mutation round-trip completes within 1ms. On hosted
 * runners under noisy-neighbor load it routinely doesn't.
 *
 * Local to this file per the #190 brief — global helper placement is
 * deferred to the #191 test-architecture work.
 */
async function retry<T>(
  assertFn: () => Promise<T>,
  // Default timeout bumped from 5s→10s in #178 to absorb Node 24 CI latency
  // spikes (#196/#197 saw the "completes stage when all players report result"
  // test flake on first CI run, pass on rerun). 50ms polling × 200 iterations
  // still well under worst-case scheduler variance.
  { timeoutMs = 10_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await assertFn();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

describe('pipeline stages', function () {
  before(async function () {
    // 120s matches `setupSharedEnv()` in helpers.ts — see issue #383 P1
    // for why 60s tipped over on contended runners. Inlined here (not
    // delegated to `setupSharedEnv`) because this hook also captures the
    // test ensemble after env boot.
    this.timeout(120_000);
    await setupTestEnv();
    ENSEMBLE = getTestEnsemble();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('creates a stage on conductor via signal', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-1', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'code-review',
        players: ['alice', 'bob'],
        createdBy: 'stage-cond-1',
      });

      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages).to.have.lengthOf(1);
      expect(stages[0].name).to.equal('code-review');
      expect(stages[0].status).to.equal('active');
      expect(stages[0].failurePolicy).to.equal('halt');
      expect(stages[0].players).to.have.lengthOf(2);
      expect(stages[0].players[0].playerId).to.equal('alice');
      expect(stages[0].players[0].status).to.equal('waiting');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('completes stage when all players report result', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-2', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'testing',
        players: ['alice', 'bob'],
        createdBy: 'stage-cond-2',
      });

      // Alice reports
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Tests pass',
        type: 'result',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages[0].status).to.equal('active');
        expect(stages[0].players.find((p: any) => p.playerId === 'alice')!.status).to.equal('reported');
      });

      // Bob reports — stage should complete
      await handle.signal(playerReportSignal, {
        playerId: 'bob',
        text: 'All good',
        type: 'result',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages[0].status).to.equal('complete');
        expect(stages[0].completedAt).to.be.a('string');

        const messages: Message[] = await handle.query(allMessagesQuery);
        const completion = messages.find((m: any) => m.text.includes('[stage complete]'));
        expect(completion, 'completion message').to.exist;
        expect(completion!.text).to.include('testing');
        expect(completion!.from).to.equal('_stage');
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('fails stage immediately on blocker with halt policy', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-3', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'deploy',
        players: ['alice', 'bob'],
        failurePolicy: 'halt',
        createdBy: 'stage-cond-3',
      });

      // Alice reports blocker — should halt immediately
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Build broken',
        type: 'blocker',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages[0].status).to.equal('failed');
        // Bob is still waiting (didn't need to report)
        expect(stages[0].players.find((p: any) => p.playerId === 'bob')!.status).to.equal('waiting');

        const messages: Message[] = await handle.query(allMessagesQuery);
        const failure = messages.find((m: any) => m.text.includes('[stage failed]') && m.text.includes('halted'));
        expect(failure, 'failure message').to.exist;
        expect(failure!.text).to.include('alice');
        expect(failure!.text).to.include('Build broken');
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('waits for all players on blocker with continue policy', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-4', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'review',
        players: ['alice', 'bob'],
        failurePolicy: 'continue',
        createdBy: 'stage-cond-4',
      });

      // Alice reports blocker — should NOT halt (continue policy)
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Found issues',
        type: 'blocker',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        // Still active with continue policy — alice's blocker is recorded
        // but the stage waits for everyone before transitioning.
        expect(stages[0].status).to.equal('active');
      });

      // Bob reports result — now all done, should fail because alice was blocked
      await handle.signal(playerReportSignal, {
        playerId: 'bob',
        text: 'Looks good',
        type: 'result',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages[0].status).to.equal('failed');

        const messages: Message[] = await handle.query(allMessagesQuery);
        const failure = messages.find((m: any) => m.text.includes('[stage failed]') && m.text.includes('blocker'));
        expect(failure, 'failure message').to.exist;
        expect(failure!.text).to.include('alice');
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('question report does not affect stage status', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-5', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'impl',
        players: ['alice'],
        createdBy: 'stage-cond-5',
      });

      // Question — no stage effect
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'What API should I use?',
        type: 'question',
      });

      // A question is a no-op on stage state. There's no post-signal state
      // change to poll for — instead, we sleep briefly to give the dispatch
      // loop a chance to (wrongly) mutate state, then assert it hasn't.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('active');
      expect(stages[0].players[0].status).to.equal('waiting');

      // Now report result — should complete
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Done',
        type: 'result',
      });

      await retry(async () => {
        const stages2: StageEntry[] = await handle.query(stagesQuery);
        expect(stages2[0].status).to.equal('complete');
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('cancels an active stage', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-6', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'cancelled-stage',
        players: ['alice'],
        createdBy: 'stage-cond-6',
      });

      await handle.signal(cancelStageSignal, 'cancelled-stage');

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages[0].status).to.equal('cancelled');
        expect(stages[0].completedAt).to.be.a('string');

        const messages: Message[] = await handle.query(allMessagesQuery);
        const cancel = messages.find((m: any) => m.text.includes('[stage cancelled]'));
        expect(cancel, 'cancel message').to.exist;
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('replaces existing stage with same name', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'stage-cond-7', ensemble: ENSEMBLE }),
      });

      await handle.signal(setStageSignal, {
        name: 'replaceable',
        players: ['alice'],
        createdBy: 'stage-cond-7',
      });

      await handle.signal(setStageSignal, {
        name: 'replaceable',
        players: ['alice', 'bob', 'carol'],
        failurePolicy: 'continue',
        createdBy: 'stage-cond-7',
      });

      await retry(async () => {
        const stages: StageEntry[] = await handle.query(stagesQuery);
        expect(stages).to.have.lengthOf(1);
        expect(stages[0].players).to.have.lengthOf(3);
        expect(stages[0].failurePolicy).to.equal('continue');
      });

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });
});
