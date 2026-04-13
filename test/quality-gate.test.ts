import { expect } from 'chai';
import { QualityGate } from '../src/types';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  conductorMetadata,
  playerMetadata,
  updateMetadataSignal,

  destroyUpdate,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
} from './helpers';

describe('quality gates', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('creates a quality gate on conductor', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'pr-review',
        criteria: ['Tests pass', 'No lint errors', 'Code reviewed'],
        createdBy: 'conductor',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates).to.have.length(1);
      expect(gates[0].task).to.equal('pr-review');
      expect(gates[0].status).to.equal('open');
      expect(gates[0].criteria).to.have.length(3);
      expect(gates[0].criteria[0].text).to.equal('Tests pass');
      expect(gates[0].criteria[0].status).to.equal('pending');
      expect(gates[0].createdBy).to.equal('conductor');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('evaluates criteria and derives passed status', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'deploy',
        criteria: ['Build succeeds', 'E2E tests pass'],
        createdBy: 'conductor',
      });

      // Mark both as passed
      await handle.signal(evaluateGateCriteriaSignal, {
        task: 'deploy',
        evaluations: [
          { index: 0, status: 'passed', notes: 'Green build' },
          { index: 1, status: 'passed' },
        ],
        evaluatedBy: 'qa',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates[0].status).to.equal('passed');
      expect(gates[0].criteria[0].status).to.equal('passed');
      expect(gates[0].criteria[0].evaluatedBy).to.equal('qa');
      expect(gates[0].criteria[0].notes).to.equal('Green build');
      expect(gates[0].criteria[1].status).to.equal('passed');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('evaluates criteria and derives failed status', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'release',
        criteria: ['Unit tests', 'Integration tests', 'Security scan'],
        createdBy: 'conductor',
      });

      // Pass first, fail second
      await handle.signal(evaluateGateCriteriaSignal, {
        task: 'release',
        evaluations: [
          { index: 0, status: 'passed' },
          { index: 1, status: 'failed', notes: '3 failures' },
        ],
        evaluatedBy: 'qa',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates[0].status).to.equal('failed');
      expect(gates[0].criteria[0].status).to.equal('passed');
      expect(gates[0].criteria[1].status).to.equal('failed');
      expect(gates[0].criteria[2].status).to.equal('pending');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('stays open when some criteria are still pending', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'partial',
        criteria: ['A', 'B', 'C'],
        createdBy: 'conductor',
      });

      // Only evaluate first criterion
      await handle.signal(evaluateGateCriteriaSignal, {
        task: 'partial',
        evaluations: [{ index: 0, status: 'passed' }],
        evaluatedBy: 'qa',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates[0].status).to.equal('open');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('replaces an existing gate with the same task name', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      // Create initial gate
      await handle.signal(setQualityGateSignal, {
        task: 'pr-review',
        criteria: ['Old criterion'],
        createdBy: 'conductor',
      });

      // Replace with new criteria
      await handle.signal(setQualityGateSignal, {
        task: 'pr-review',
        criteria: ['New criterion 1', 'New criterion 2'],
        createdBy: 'conductor',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates).to.have.length(1);
      expect(gates[0].criteria).to.have.length(2);
      expect(gates[0].criteria[0].text).to.equal('New criterion 1');
      expect(gates[0].status).to.equal('open');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('ignores evaluations for non-existent gate', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      // Evaluate a gate that doesn't exist — should not throw
      await handle.signal(evaluateGateCriteriaSignal, {
        task: 'nonexistent',
        evaluations: [{ index: 0, status: 'passed' }],
        evaluatedBy: 'qa',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates).to.have.length(0);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('ignores out-of-bounds criterion index', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'bounds-test',
        criteria: ['Only one'],
        createdBy: 'conductor',
      });

      // Index 5 is out of bounds — should be silently ignored
      await handle.signal(evaluateGateCriteriaSignal, {
        task: 'bounds-test',
        evaluations: [
          { index: 0, status: 'passed' },
          { index: 5, status: 'failed' },
        ],
        evaluatedBy: 'qa',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates[0].status).to.equal('passed');
      expect(gates[0].criteria).to.have.length(1);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('supports multiple gates simultaneously', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setQualityGateSignal, {
        task: 'gate-a',
        criteria: ['Criterion A'],
        createdBy: 'conductor',
      });
      await handle.signal(setQualityGateSignal, {
        task: 'gate-b',
        criteria: ['Criterion B'],
        createdBy: 'conductor',
      });

      const gates: QualityGate[] = await handle.query(qualityGatesQuery);
      expect(gates).to.have.length(2);
      expect(gates.map((g) => g.task)).to.include.members(['gate-a', 'gate-b']);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('non-conductor session does not have quality gate query', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'player-no-gates' }),
      });

      try {
        await handle.query(qualityGatesQuery);
        expect.fail('Should have thrown for non-conductor');
      } catch (err: any) {
        // Expected: query handler not registered for non-conductor
        expect(err.message).to.include('qualityGates');
      }

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });
});
