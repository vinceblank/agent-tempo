/**
 * Guard test for the MD-A liveness timings (src/pi/workflow-client.ts).
 *
 * Phase 2 / MD-A (maintainer-approved): the Pi extension reuses the existing
 * attachment lease/heartbeat at 30s heartbeat / 90s lease, holding the
 * lease = 3×heartbeat invariant (parity with the other SDK adapters). This test
 * pins those values so a future edit can't silently break the invariant — e.g.
 * shortening the lease below 2× the heartbeat would let a single dropped beat
 * spuriously detach a live interactive session.
 *
 * Pure — no Temporal, no Pi.
 */
import { expect } from 'chai';
import { PI_HEARTBEAT_MS, PI_LEASE_MS } from '../src/pi/workflow-client';

describe('Pi MD-A liveness timings', () => {
  it('uses a 30s heartbeat (SDK-adapter parity)', () => {
    expect(PI_HEARTBEAT_MS).to.equal(30_000);
  });

  it('uses a 90s lease', () => {
    expect(PI_LEASE_MS).to.equal(90_000);
  });

  it('holds the lease = 3×heartbeat invariant', () => {
    expect(PI_LEASE_MS).to.equal(3 * PI_HEARTBEAT_MS);
  });

  it('keeps the lease at least 2×heartbeat (a single missed beat must not expire it)', () => {
    expect(PI_LEASE_MS).to.be.at.least(2 * PI_HEARTBEAT_MS);
  });
});
