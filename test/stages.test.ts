/**
 * Tests for pipeline stage tracking on conductor workflows.
 */
import { expect } from 'chai';
import {
  setupTestEnv,
  teardownTestEnv,
  getClient,
  startSession,
  conductorMetadata,
  withWorker,
  updateMetadataSignal,
  skipTime,
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

const ENSEMBLE = 'test-ensemble';

describe('pipeline stages', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
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
      await skipTime(1); // flush pending workflow task before querying

      let stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('active');
      expect(stages[0].players.find((p: any) => p.playerId === 'alice')!.status).to.equal('reported');

      // Bob reports — stage should complete
      await handle.signal(playerReportSignal, {
        playerId: 'bob',
        text: 'All good',
        type: 'result',
      });
      await skipTime(1); // flush pending workflow task before querying

      stages = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('complete');
      expect(stages[0].completedAt).to.be.a('string');

      // Check completion message was injected
      const messages: Message[] = await handle.query(allMessagesQuery);
      const completion = messages.find((m: any) => m.text.includes('[stage complete]'));
      expect(completion).to.exist;
      expect(completion!.text).to.include('testing');
      expect(completion!.from).to.equal('_stage');

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
      await skipTime(1); // flush pending workflow task before querying

      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('failed');

      // Bob is still waiting (didn't need to report)
      expect(stages[0].players.find((p: any) => p.playerId === 'bob')!.status).to.equal('waiting');

      // Check failure message
      const messages: Message[] = await handle.query(allMessagesQuery);
      const failure = messages.find((m: any) => m.text.includes('[stage failed]') && m.text.includes('halted'));
      expect(failure).to.exist;
      expect(failure!.text).to.include('alice');
      expect(failure!.text).to.include('Build broken');

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

      // Alice reports blocker — should NOT halt
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Found issues',
        type: 'blocker',
      });
      await skipTime(1); // flush pending workflow task before querying

      let stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('active'); // Still active with continue policy

      // Bob reports result — now all done, should fail because alice was blocked
      await handle.signal(playerReportSignal, {
        playerId: 'bob',
        text: 'Looks good',
        type: 'result',
      });
      await skipTime(1); // flush pending workflow task before querying

      stages = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('failed');

      const messages: Message[] = await handle.query(allMessagesQuery);
      const failure = messages.find((m: any) => m.text.includes('[stage failed]') && m.text.includes('blocker'));
      expect(failure).to.exist;
      expect(failure!.text).to.include('alice');

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
      await skipTime(1); // flush pending workflow task before querying

      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('active');
      expect(stages[0].players[0].status).to.equal('waiting');

      // Now report result — should complete
      await handle.signal(playerReportSignal, {
        playerId: 'alice',
        text: 'Done',
        type: 'result',
      });
      await skipTime(1); // flush pending workflow task before querying

      const stages2: StageEntry[] = await handle.query(stagesQuery);
      expect(stages2[0].status).to.equal('complete');

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
      await skipTime(1); // flush pending workflow task before querying

      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages[0].status).to.equal('cancelled');
      expect(stages[0].completedAt).to.be.a('string');

      // Check cancellation message
      const messages: Message[] = await handle.query(allMessagesQuery);
      const cancel = messages.find((m: any) => m.text.includes('[stage cancelled]'));
      expect(cancel).to.exist;

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
      await skipTime(1); // flush pending workflow task before querying

      const stages: StageEntry[] = await handle.query(stagesQuery);
      expect(stages).to.have.lengthOf(1);
      expect(stages[0].players).to.have.lengthOf(3);
      expect(stages[0].failurePolicy).to.equal('continue');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });
});
