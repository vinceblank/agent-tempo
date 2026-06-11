/**
 * T0.1 (#748) — pure unit tests for the maestro refresh-cadence resolver.
 * The function runs inside workflow code; it's exported pure (the
 * attachment-math precedent) so the cadence contract is pinned here
 * without a TestWorkflowEnvironment.
 */
import { describe, it, expect } from 'vitest';
import { resolveRefreshIntervalMs } from '../../src/workflows/maestro';

describe('resolveRefreshIntervalMs (#748)', () => {
  it('LOCAL / absent profile is byte-identical to pre-#748: 5s default', () => {
    expect(resolveRefreshIntervalMs({}, true)).toBe(5_000);
    expect(resolveRefreshIntervalMs({}, false)).toBe(5_000); // presence ignored
    expect(resolveRefreshIntervalMs({ costProfile: 'local' }, false)).toBe(5_000);
  });

  it('explicit pollIntervalMs always wins (test pinning, ops override)', () => {
    expect(resolveRefreshIntervalMs({ pollIntervalMs: 100 }, true)).toBe(100);
    expect(resolveRefreshIntervalMs({ pollIntervalMs: 100, costProfile: 'cloud' }, false)).toBe(100);
  });

  it('cloud profile: 20s with observers, 60s without', () => {
    expect(resolveRefreshIntervalMs({ costProfile: 'cloud' }, true)).toBe(20_000);
    expect(resolveRefreshIntervalMs({ costProfile: 'cloud' }, false)).toBe(60_000);
  });
});
