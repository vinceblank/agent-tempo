import { expect } from 'chai';
import { SessionMetadata, OutboxEntry } from '../src/types';
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
  receiveMessageSignal,
} from './helpers';

/**
 * Helper: deliver all pending messages so the workflow can exit cleanly
 * when disableStaleDetection is false (it waits for all messages delivered).
 */
async function deliverAll(handle: any): Promise<void> {
  const msgs = await handle.query('pendingMessages');
  const ids = (msgs as any[]).filter((m: any) => !m.delivered).map((m: any) => m.id);
  if (ids.length > 0) await handle.signal('markDelivered', ids);
}

/**
 * Pre-seeded pending outbox entry to wake the workflow condition loop.
 * The outbox dispatch does NOT update lastOutboundTime — only the
 * submitOutboxUpdate handler does. This preserves pre-set timestamps.
 */
function seedOutbox(): OutboxEntry[] {
  return [{
    id: 'seed-probe',
    type: 'cue',
    targetPlayerId: '_probe',
    message: '_wake',
    createdAt: new Date().toISOString(),
    status: 'pending',
  }];
}

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

      await handle.signal(updateMetadataSignal, { status: 'blocked' });

      let meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('blocked');

      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue' as const, targetPlayerId: 'someone', message: 'hello' }],
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

      await handle.signal(updateMetadataSignal, { status: 'stale' });

      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue' as const, targetPlayerId: 'someone', message: 'hello' }],
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
      expect(meta.status).to.equal('blocked');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  // ── responseRequested blocked detection ──
  //
  // Test environment uses createLocal() (no time-skipping). The workflow's
  // main loop: condition(() => terminated || hasPendingOutbox(), '5 min').
  //
  // Strategy: seed a pending outbox entry via SessionInput so the condition
  // fires on the first iteration. Outbox DISPATCH doesn't touch lastOutboundTime.
  // Pre-set lastInboundRRTime and lastOutboundTime to simulate elapsed time.
  // After asserting, deliver all messages and terminate so the workflow exits cleanly.

  it('does NOT flag as blocked when lastOutboundTime > lastInboundRRTime', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'idle-no-block', status: 'active' }),
        disableStaleDetection: false,
        lastInboundRRTime: now - 10 * 60 * 1000,
        lastOutboundTime: now - 8 * 60 * 1000,
        outbox: seedOutbox(),
      });

      await new Promise(r => setTimeout(r, 2000));
      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.not.equal('blocked');

      await deliverAll(handle);
      // PR-C commit 4: terminate shim routes to §2.5 destroy semantics (abandon in-flight,
      // complete immediately). Second deliverAll removed — workflow is already gone.
      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('does NOT flag as blocked when lastInboundRRTime is 0', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'no-rr-safe', status: 'active' }),
        disableStaleDetection: false,
        lastInboundRRTime: 0,
        lastOutboundTime: Date.now(),
        outbox: seedOutbox(),
      });

      await new Promise(r => setTimeout(r, 2000));
      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.not.equal('blocked');

      await deliverAll(handle);
      // PR-C commit 4: terminate shim routes to §2.5 destroy semantics (abandon in-flight,
      // complete immediately). Second deliverAll removed — workflow is already gone.
      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('flags as blocked when unanswered RR message exceeds window', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'true-blocked-rr', status: 'active' }),
        disableStaleDetection: false,
        lastInboundRRTime: now - 10 * 60 * 1000,
        lastOutboundTime: now - 15 * 60 * 1000,
        outbox: seedOutbox(),
      });

      await new Promise(r => setTimeout(r, 2000));
      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('blocked');

      await deliverAll(handle);
      // PR-C commit 4: terminate shim routes to §2.5 destroy semantics (abandon in-flight,
      // complete immediately). Second deliverAll removed — workflow is already gone.
      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('responseRequested:false messages do NOT trigger blocked', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'rr-false-ok', status: 'active' }),
        disableStaleDetection: false,
        lastInboundRRTime: 0,
        lastOutboundTime: now - 30 * 60 * 1000,
        outbox: seedOutbox(),
      });

      await handle.signal(receiveMessageSignal, { from: 'sys', text: 'info', responseRequested: false });
      await deliverAll(handle);

      await new Promise(r => setTimeout(r, 2000));
      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.not.equal('blocked');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      // PR-C commit 4: terminate → §2.5 destroy; second deliverAll removed.
      await handle.result();
    });
  });

  it('outbox submission recovers blocked via lastOutboundTime update', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'rr-recover', status: 'blocked' }),
        lastInboundRRTime: now - 10 * 60 * 1000,
        lastOutboundTime: now - 15 * 60 * 1000,
      });

      let meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('blocked');

      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue' as const, targetPlayerId: 'someone', message: 'alive' }],
      });

      meta = await handle.query(getMetadataQuery);
      expect(meta.status).to.equal('active');

      await handle.signal(updateMetadataSignal, { status: 'terminated' });
      await handle.result();
    });
  });

  it('SessionInput accepts lastInboundRRTime and lastOutboundTime for continueAsNew', async function () {
    this.timeout(30_000);
    await withWorkerAndOutboxActivities(async () => {
      const now = Date.now();
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'carry-fields', status: 'active' }),
        disableStaleDetection: false,
        lastInboundRRTime: now - 3 * 60 * 1000,
        lastOutboundTime: now - 1 * 60 * 1000,
        outbox: seedOutbox(),
      });

      await new Promise(r => setTimeout(r, 2000));
      const meta: SessionMetadata = await handle.query(getMetadataQuery);
      expect(meta.status).to.not.equal('blocked');

      await deliverAll(handle);
      // PR-C commit 4: terminate shim routes to §2.5 destroy semantics (abandon in-flight,
      // complete immediately). Second deliverAll removed — workflow is already gone.
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
