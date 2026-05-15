/**
 * Contract drift guard — architect's risk #14 (PR-3) / #2 (PR-4).
 *
 * Verifies:
 *
 * 1. {@link MockDashboardClient} structurally satisfies our local
 *    {@link DashboardTempoClient} interface. If the dashboard adds a
 *    method to its interface without adding the mock, this fails.
 *
 * 2. The wire types we depend on (`EnsembleSummary`, `EnsembleStateV1`,
 *    `TempoEvent`) match the daemon-side wire types. The path-aliased
 *    type imports from `agent-tempo/*` mean a wire-protocol change
 *    upstream automatically breaks our tsc build — but we make the
 *    expectation explicit here so a future contributor reading this
 *    test understands the dependency.
 */
import { describe, it, expect } from 'vitest';
import type { DashboardTempoClient } from '../src/lib/client';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import type {
  EnsembleStateV1,
  EnsembleSummary,
  TempoEvent,
} from 'agent-tempo/http/event-types';

describe('Contract drift — DashboardTempoClient ↔ MockDashboardClient', () => {
  it('MockDashboardClient implements every method on DashboardTempoClient', () => {
    // The class declaration uses `implements DashboardTempoClient`, so
    // tsc will fail if a method is missing. This runtime check is a
    // belt-and-braces sanity assertion that the mock instance behaves.
    const _: DashboardTempoClient = new MockDashboardClient();
    expect(typeof _.listEnsembles).toBe('function');
    expect(typeof _.state).toBe('function');
    expect(typeof _.subscribe).toBe('function');
  });
});

describe('Contract drift — wire types match daemon-side shapes', () => {
  it('EnsembleSummary fixture conforms to the daemon wire type', () => {
    const summary: EnsembleSummary = {
      name: 'demo',
      playerCount: 2,
      hasConductor: true,
      state: 'online',
    };
    expect(summary.name).toBe('demo');
  });

  it('EnsembleStateV1 fixture conforms to the daemon wire type', () => {
    const snapshot: EnsembleStateV1 = makeSnapshot();
    expect(snapshot.v).toBe(1);
    expect(snapshot.flags).toBeDefined();
  });

  it('TempoEvent discriminated union narrows on `type`', () => {
    // If the union shape changes (e.g. SseEventBase loses `v: 1`), this
    // construction fails to type-check.
    const e: TempoEvent = {
      v: 1,
      type: 'heartbeat',
      eventId: '0:1',
      payload: { at: '2026-04-27T00:00:00.000Z' },
    };
    expect(e.type).toBe('heartbeat');
  });
});
