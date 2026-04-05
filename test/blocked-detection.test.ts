import { expect } from 'chai';
import { SessionMetadata } from '../src/types';
import { shouldIncludeInBroadcast } from '../src/utils/validation';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorkerAndOutboxActivities,
  withWorker,
  startSession,
  playerMetadata,
  updateMetadataSignal,
  getMetadataQuery,
  submitOutboxUpdate,
  setPartSignal,
} from './helpers';

describe('blocked session detection', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('auto-recovers from blocked to active on outbox submission', async function () {
    await withWorkerAndOutboxActivities(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'blocked-recovery' }),
      });

      // Manually set status to blocked (simulating detection)
      await handle.signal(updateMetadataSignal, { status: 'blocked' });

      let meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('blocked');

      // Submit an outbox entry — should auto-recover to active
      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{
          type: 'cue' as const,
          targetPlayerId: 'someone',
          message: 'hello',
        }],
      });

      meta = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('active');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('does not auto-recover from other statuses on outbox submission', async function () {
    await withWorkerAndOutboxActivities(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'stale-no-recover' }),
      });

      // Set to stale — outbox should NOT change status
      await handle.signal(updateMetadataSignal, { status: 'stale' });

      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{
          type: 'cue' as const,
          targetPlayerId: 'someone',
          message: 'hello',
        }],
      });

      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('stale');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('blocked status is queryable via getMetadata', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'blocked-query' }),
      });

      await handle.signal(updateMetadataSignal, { status: 'blocked' });

      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('blocked');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('setPart signal does not recover blocked status', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'blocked-setpart' }),
      });

      await handle.signal(updateMetadataSignal, { status: 'blocked' });
      await handle.signal(setPartSignal, 'working on something');

      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      // setPart updates lastOutboundTime but doesn't auto-recover — only outbox does
      expect(meta.status).to.equal('blocked');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });
});

describe('blocked broadcast exclusion', function () {
  it('excludes blocked sessions from broadcast', function () {
    expect(shouldIncludeInBroadcast('blocked', false)).to.be.false;
    expect(shouldIncludeInBroadcast('blocked', true)).to.be.false;
  });

  it('still includes active sessions', function () {
    expect(shouldIncludeInBroadcast('active', false)).to.be.true;
  });

  it('still excludes pending and terminated', function () {
    expect(shouldIncludeInBroadcast('pending', false)).to.be.false;
    expect(shouldIncludeInBroadcast('terminated', false)).to.be.false;
  });

  it('excludes stale by default but includes with flag', function () {
    expect(shouldIncludeInBroadcast('stale', false)).to.be.false;
    expect(shouldIncludeInBroadcast('stale', true)).to.be.true;
  });
});
