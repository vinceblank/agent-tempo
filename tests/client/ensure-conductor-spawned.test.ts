/**
 * Unit tests for `ensureConductorSpawned` — see
 * `src/client/ensure-conductor-spawned.ts`.
 *
 * Pins the #306 race-handling branch (commit `4a8788b`): when the parallel
 * `restoreOrphansOnce` path wins and reattaches the conductor first, our
 * fallback `spawnConductor` call throws "A conductor is already running for
 * ensemble …". That throw is the *success* condition for this helper — it
 * must surface as `{ spawned: false, reason: 'alreadyLive' }`, NOT
 * `{ spawned: false, reason: 'spawnFailed', … }`. The two outcomes look
 * superficially similar but `spawnFailed` puts the UI on an error path,
 * while `alreadyLive` is a benign convergence.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureConductorSpawned } from '../../src/client/ensure-conductor-spawned';
import type { TempoClient } from '../../src/client';

/**
 * Build a minimal fake TempoClient covering only the two methods this
 * helper touches. Casting through `unknown` keeps the rest of the
 * TempoClient surface out of these tests.
 */
function makeFakeClient(opts: {
  attachmentInfo: () => Promise<{ phase: string }>;
  spawnConductor: () => Promise<void>;
}): TempoClient {
  return {
    attachmentInfo: opts.attachmentInfo,
    spawnConductor: opts.spawnConductor,
  } as unknown as TempoClient;
}

describe('ensureConductorSpawned — #306 race-handling branch (commit 4a8788b)', () => {
  it('returns alreadyLive (NOT spawnFailed) when spawnConductor throws "conductor is already running"', async () => {
    const spawnConductor = vi.fn(async () => {
      // Mirrors the real CLI error from `agent-tempo up <ensemble>` when
      // a conductor workflow is already attached. The case-insensitive
      // regex in the helper means casing differences shouldn't matter,
      // but we use the actual message to keep the test honest.
      throw new Error('A conductor is already running for ensemble foo');
    });
    const client = makeFakeClient({
      // attachmentInfo throws → helper falls through to the spawn branch.
      attachmentInfo: vi.fn(async () => { throw new Error('no conductor session'); }),
      spawnConductor,
    });

    const result = await ensureConductorSpawned('foo', client);

    expect(result).toEqual({ spawned: false, reason: 'alreadyLive' });
    expect(spawnConductor).toHaveBeenCalledOnce();
    expect(spawnConductor).toHaveBeenCalledWith({ ensemble: 'foo' });
  });

  it('returns spawnFailed (NOT alreadyLive) when spawnConductor throws an unrelated error', async () => {
    // Contrast test — pins the boundary between the race-success branch
    // and a genuine spawn failure. The /conductor is already running/i
    // regex must NOT match this message.
    const client = makeFakeClient({
      attachmentInfo: vi.fn(async () => { throw new Error('no conductor session'); }),
      spawnConductor: vi.fn(async () => { throw new Error('terminal not found'); }),
    });

    const result = await ensureConductorSpawned('foo', client);

    expect(result).toEqual({
      spawned: false,
      reason: 'spawnFailed',
      error: 'terminal not found',
    });
  });
});
