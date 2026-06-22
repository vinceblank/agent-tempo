/**
 * Tests for `TempoClient.listEnsemblesBounded()` (#336/#529 site 6).
 *
 * Validates the structured-outcome contract:
 *  - On normal completion: `{ items, timedOut: false, scanned }` with
 *    `scanned` reflecting the actual iterator count.
 *  - On visibility-iterator deadline: `{ items, timedOut: true, scanned }`,
 *    where `items` reflects the partial aggregation (so test/diag surfaces
 *    can inspect what was enumerated).
 *  - Catastrophic errors (other than visibility timeout) propagate, not
 *    silently swallowed (parity with the existing `listEnsembles()`'s
 *    `.catch(() => [])` reserved exclusively for the unbounded variant).
 *
 * Uses a minimal fake `@temporalio/client` `Client` — we only need
 * `workflow.list()` and `workflow.getHandle()`, both stubbed.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { createTempoClientCore } from '../../src/client/core';
import { VisibilityIteratorTimeoutError } from '../../src/utils/visibility-deadline';

interface FakeWf {
  workflowId: string;
  searchAttributes?: Record<string, unknown>;
  /** Decoded workflow memo — where conductor/playerType live after #788's
   *  SA→memo migration (the readers `getIsConductor`/`getPlayerType` are
   *  memo-only now). Ensemble name + phase stay in `searchAttributes`. */
  memo?: Record<string, unknown>;
}

/** Build a minimal fake Client whose `workflow.list` returns the given entries. */
function makeFakeClient(opts: {
  entries: FakeWf[];
  /** Throw a non-timeout error from list() instead of yielding entries. */
  listThrows?: Error;
  /** Throw a visibility-timeout error mid-stream after this many entries. */
  throwAfter?: number;
  /** Per-handle `query` stub. Default returns paused=false. */
  pausedByMaestro?: Record<string, boolean>;
}): Client {
  return {
    workflow: {
      list: ({ query: _query }: { query: string }): AsyncIterable<FakeWf> => {
        if (opts.listThrows) throw opts.listThrows;
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next(): Promise<IteratorResult<FakeWf>> {
                if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
                  throw new VisibilityIteratorTimeoutError(
                    'listEnsemblesBounded', 500, i,
                  );
                }
                if (i >= opts.entries.length) return { value: undefined, done: true };
                return { value: opts.entries[i++], done: false };
              },
            };
          },
        };
      },
      getHandle: (wfId: string) => {
        const paused = opts.pausedByMaestro?.[wfId] ?? false;
        return {
          workflowId: wfId,
          query: async (_q: string) => paused,
        } as unknown as ReturnType<Client['workflow']['getHandle']>;
      },
    },
  } as unknown as Client;
}

/**
 * Build an entry mirroring what `listEnsemblesBounded` reads. Ensemble name +
 * phase are search attributes (`getEnsembleName`/`getAttachmentPhase` stay SA);
 * conductor + playerType go in the **memo** (`getIsConductor`/`getPlayerType`
 * are memo-only after #788's SA→memo migration). Memo values are plain decoded
 * values, not the array-wrapped form search attributes use.
 */
function entry(ensemble: string, opts: {
  phase?: string;
  isConductor?: boolean;
  playerType?: string;
  workflowId?: string;
} = {}): FakeWf {
  const hasMeta = opts.isConductor !== undefined || opts.playerType !== undefined;
  return {
    workflowId: opts.workflowId ?? `${ensemble}-player-${Math.random().toString(36).slice(2)}`,
    searchAttributes: {
      AgentTempoEnsemble: [ensemble],
      ...(opts.phase !== undefined ? { AgentTempoAttachmentState: [opts.phase] } : {}),
    },
    ...(hasMeta ? {
      memo: {
        ...(opts.isConductor !== undefined ? { AgentTempoIsConductor: opts.isConductor } : {}),
        ...(opts.playerType !== undefined ? { AgentTempoPlayerType: opts.playerType } : {}),
      },
    } : {}),
  };
}

describe('TempoClient.listEnsemblesBounded()', () => {
  it('returns timedOut: false and full items when iterator completes', async () => {
    const c = createTempoClientCore(makeFakeClient({
      entries: [
        entry('alpha', { phase: 'attached' }),
        entry('alpha', { phase: 'attached', isConductor: true }),
        entry('beta', { phase: 'attached' }),
      ],
    }));
    const r = await c.listEnsemblesBounded(1000);
    expect(r.timedOut).toBe(false);
    expect(r.scanned).toBe(3);
    expect(r.items.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('returns timedOut: true on VisibilityIteratorTimeoutError', async () => {
    const c = createTempoClientCore(makeFakeClient({
      entries: [
        entry('alpha', { phase: 'attached' }),
        entry('beta', { phase: 'attached' }),
        entry('gamma', { phase: 'attached' }), // never reached
      ],
      throwAfter: 2, // throws on the 3rd next() call
    }));
    const r = await c.listEnsemblesBounded(500);
    expect(r.timedOut).toBe(true);
    expect(r.scanned).toBe(2);
    // The partial result still gets surfaced — test/diag value.
    // `alpha` and `beta` were enumerated before the throw.
    expect(r.items.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('propagates non-timeout errors (does NOT silently swallow like listEnsembles())', async () => {
    const c = createTempoClientCore(makeFakeClient({
      entries: [],
      listThrows: new Error('temporal frontend disconnected'),
    }));
    await expect(c.listEnsemblesBounded(500)).rejects.toThrow('temporal frontend disconnected');
  });

  it('returns empty items + timedOut: false when no workflows match', async () => {
    const c = createTempoClientCore(makeFakeClient({ entries: [] }));
    const r = await c.listEnsemblesBounded(1000);
    expect(r).toEqual({ items: [], timedOut: false, scanned: 0 });
  });

  it('parity with listEnsembles() shape: items[] entries carry name + state', async () => {
    const c = createTempoClientCore(makeFakeClient({
      entries: [
        entry('alpha', { phase: 'attached', isConductor: true }),
      ],
    }));
    const r = await c.listEnsemblesBounded(1000);
    expect(r.items.length).toBe(1);
    expect(r.items[0]).toMatchObject({
      name: 'alpha',
      hasConductor: true,
    });
    expect(['online', 'paused', 'offline']).toContain(r.items[0].state);
  });
});
