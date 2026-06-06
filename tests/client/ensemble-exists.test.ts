/**
 * `TempoClient.ensembleExists` (#673) — the strongly-consistent existence check
 * the SSE gate uses as a fallback when Temporal visibility (`listEnsembles`)
 * hasn't indexed a just-created ensemble yet. It `describe()`s the per-ensemble
 * maestro hub and reports RUNNING-only as "exists".
 */
import { describe, it, expect } from 'vitest';
import type { Client } from '@temporalio/client';
import { createTempoClientCore } from '../../src/client/core';

/** Fake Client whose maestro-hub `describe()` is controllable. */
function clientWithDescribe(describeImpl: () => Promise<{ status: { name: string } }>): Client {
  return {
    workflow: {
      getHandle: (_id: string) => ({ describe: describeImpl }),
    },
  } as unknown as Client;
}

describe('TempoClient.ensembleExists (#673)', () => {
  it('returns true when the maestro hub describe()s as RUNNING (visibility-miss recovery)', async () => {
    const core = createTempoClientCore(
      clientWithDescribe(async () => ({ status: { name: 'RUNNING' } })),
    );
    expect(await core.ensembleExists('demo')).toBe(true);
  });

  it('returns false for a TERMINATED hub (destroyed ensemble — not live)', async () => {
    const core = createTempoClientCore(
      clientWithDescribe(async () => ({ status: { name: 'TERMINATED' } })),
    );
    expect(await core.ensembleExists('demo')).toBe(false);
  });

  it('returns false for a COMPLETED hub', async () => {
    const core = createTempoClientCore(
      clientWithDescribe(async () => ({ status: { name: 'COMPLETED' } })),
    );
    expect(await core.ensembleExists('demo')).toBe(false);
  });

  it('returns false when describe() throws WorkflowNotFoundError (never created)', async () => {
    const core = createTempoClientCore(
      clientWithDescribe(async () => { throw new Error('workflow execution not found'); }),
    );
    expect(await core.ensembleExists('demo')).toBe(false);
  });
});
