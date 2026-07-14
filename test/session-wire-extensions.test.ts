/**
 * Session wire extensions — #399 W2 (Q5.2 / Q5.5 / Q5.6 / Q5.7).
 *
 * Covers the four new queries the dashboard reads to populate
 * PlayerDetail's `Phase & lease` + `Messages` KV sections, and the
 * counters that back them.
 *
 * - `getRunId` — returns the workflow's runId (string)
 * - `getMessagingState` — `{ received, sent, outbox: status }` with a
 *   stale-threshold reduce on `outbox`
 * - `getActivityState` — `{ activityCount, lastActivityAt: ISO }` —
 *   activityCount mirrors the ~20 lastActivityTime mutation sites
 * - `getLeaseState` — `{ expiresAt: number | null, leaseMs: number | null }`
 *   parsed from the current attachment's ISO `expiresAt`
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
  receiveMessageSignal,
  submitOutboxUpdate,
  destroyUpdate,
  PROTOCOL_VERSION,
} from './helpers';
import {
  getRunIdQuery,
  getMessagingStateQuery,
  getActivityStateQuery,
  getLeaseStateQuery,
  getCoarseActivityQuery,
  getWireMetaQuery,
  claimAttachmentUpdate,
  forceDetachUpdate,
} from '../src/workflows/signals';

describe('session wire extensions (#399 W2)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // Share one worker across all tests rather than spinning per-test
  // via `withWorker(...)`. Per-test workers in the shared env race on
  // the slot-key registration check (`Registration of multiple workers
  // with overlapping worker task types`) — same issue #383 P3.1 hit on
  // outbox.test.ts. The Q5.2-Q5.7 queries don't exercise outbox
  // activities, but `startOutboxWorker` is the cheapest stable
  // shared-worker fixture available.
  useSharedWorker(startOutboxWorker);

  async function startFresh(playerId: string) {
    return startSession({ metadata: playerMetadata({ playerId }) });
  }

  // ── Q5.2 — getRunId ────────────────────────────────────────────────

  describe('getRunId (Q5.2)', function () {
    it('returns the workflow runId as a non-empty string', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`runid-${Date.now()}`);
      const runId = await handle.query(getRunIdQuery);
      expect(runId).to.be.a('string');
      expect(runId.length).to.be.greaterThan(0);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  // ── Q5.5 — getMessagingState ───────────────────────────────────────

  describe('getMessagingState (Q5.5)', function () {
    it('initial state: received=0, sent=0, outbox="empty"', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`msg-init-${Date.now()}`);
      const state = await handle.query(getMessagingStateQuery);
      expect(state).to.deep.equal({ received: 0, sent: 0, outbox: 'empty' });
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('receivedCount increments per inbound cue', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`msg-recv-${Date.now()}`);
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'one' });
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'two' });
      const state = await handle.query(getMessagingStateQuery);
      expect(state.received).to.equal(2);
      expect(state.sent).to.equal(0);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('sentCount increments per submitOutbox', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`msg-sent-${Date.now()}`);
      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'hi' }],
      });
      await handle.executeUpdate(submitOutboxUpdate, {
        args: [{ type: 'cue', targetPlayerId: 'nobody', message: 'hi2' }],
      });
      const state = await handle.query(getMessagingStateQuery);
      // sentCount is bumped at submission time, regardless of whether
      // the dispatch loop later marks the entry delivered/failed.
      expect(state.sent).to.equal(2);
      // Outbox status is whatever the dispatch loop has projected by
      // query time. The shared worker registers outbox activities;
      // they fail with "no target" but the entry status flips so the
      // exact string here is loop-timing-dependent. Loose match keeps
      // the messaging-counter test robust.
      expect(state.outbox).to.match(/^empty$|pending$|failed|\d+ pending/);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  // ── Q5.6 — getActivityState ────────────────────────────────────────

  describe('getActivityState (Q5.6)', function () {
    it('initial state: activityCount=0, lastActivityAt is an ISO string', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`act-init-${Date.now()}`);
      const state = await handle.query(getActivityStateQuery);
      expect(state.activityCount).to.equal(0);
      expect(state.lastActivityAt).to.be.a('string');
      expect(Number.isFinite(Date.parse(state.lastActivityAt))).to.equal(true);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('activityCount bumps per inbound cue', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`act-bump-${Date.now()}`);
      // Use signals only — outbox submissions also bump but the
      // dispatch loop's state mutations bump again, making the
      // assertion fragile. The happy-path "every receiveMessage += 1"
      // contract is enough to pin the counter behaviour for the
      // maestro fan-query.
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'one' });
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'two' });
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'three' });
      const state = await handle.query(getActivityStateQuery);
      expect(state.activityCount).to.equal(3);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  // ── Q5.7 — getLeaseState ───────────────────────────────────────────

  describe('getLeaseState (Q5.7)', function () {
    it('returns nulls when no active lease (booting)', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`lease-init-${Date.now()}`);
      const state = await handle.query(getLeaseStateQuery);
      expect(state).to.deep.equal({ expiresAt: null, leaseMs: null });
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('returns numeric expiresAt + leaseMs after claimAttachment', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`lease-attached-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      const state = await handle.query(getLeaseStateQuery);
      expect(state.leaseMs).to.equal(30_000);
      expect(state.expiresAt).to.be.a('number');
      // The query parses the workflow-side ISO string — the resulting
      // epoch ms must match the token's `expiresAt` ISO when re-parsed.
      expect(state.expiresAt).to.equal(Date.parse(token.expiresAt));
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('returns nulls again after forceDetach', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`lease-detached-${Date.now()}`);
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      await handle.executeUpdate(forceDetachUpdate, {
        args: [{ reason: 'user-stop', gracePeriodMs: 0 }],
      });
      const state = await handle.query(getLeaseStateQuery);
      expect(state).to.deep.equal({ expiresAt: null, leaseMs: null });
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  // ── getWireMeta (daemon-resilience PR-B) ───────────────────────────
  //
  // The combined query MUST return field-for-field what the four
  // standalone queries return — `getPlayerWireMeta` switched its poll
  // path to this single query, so any drift between the combined and
  // standalone shapes silently corrupts the snapshot projection.

  describe('getWireMeta (combined, PR-B)', function () {
    it('initial state matches the standalone queries field-for-field', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`wiremeta-init-${Date.now()}`);
      const [combined, runId, messaging, lease, coarse] = await Promise.all([
        handle.query(getWireMetaQuery),
        handle.query(getRunIdQuery),
        handle.query(getMessagingStateQuery),
        handle.query(getLeaseStateQuery),
        handle.query(getCoarseActivityQuery),
      ]);
      expect(combined.runId).to.equal(runId);
      expect(combined.messaging).to.deep.equal(messaging);
      expect(combined.lease).to.deep.equal(lease);
      // #937 fast-follow (d): cross-check `coarse` against the LIVE
      // standalone query, not a static literal — parity must hold no
      // matter what the heartbeat piggyback has (or hasn't) populated.
      expect(combined.coarse).to.deep.equal(coarse);
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });

    it('reflects lease + messaging changes exactly like the standalone queries', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`wiremeta-live-${Date.now()}`);
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'host-A', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 30_000 }],
      });
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'one' });
      await handle.signal(receiveMessageSignal, { from: 'tester', text: 'two' });

      const combined = await handle.query(getWireMetaQuery);
      expect(combined.lease.leaseMs).to.equal(30_000);
      expect(combined.lease.expiresAt).to.equal(Date.parse(token.expiresAt));
      expect(combined.messaging.received).to.equal(2);
      expect(combined.messaging.sent).to.equal(0);

      // Cross-check against the standalone queries — both surfaces stay
      // served (stable wire protocol; older daemons still poll them).
      // Coarse included per #937 fast-follow (d): live query, not literal.
      const [messaging, lease, coarse] = await Promise.all([
        handle.query(getMessagingStateQuery),
        handle.query(getLeaseStateQuery),
        handle.query(getCoarseActivityQuery),
      ]);
      expect(combined.messaging).to.deep.equal(messaging);
      expect(combined.lease).to.deep.equal(lease);
      expect(combined.coarse).to.deep.equal(coarse);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
