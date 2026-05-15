/**
 * #306 follow-up: TempoClient.isAnySessionHeld unit tests.
 *
 * The TUI polls this every 2s alongside `isMaestroPaused` to drive the
 * StatusBar held indicator + the matching pinned tip. Coverage:
 *  - Returns true when ANY non-maestro session has outboxLocked=true.
 *  - Returns false when no sessions are locked.
 *  - Skips the maestro session — its outbox lock state is internal and
 *    must never trigger the user-facing held indicator.
 *  - Treats per-session query failures as "not held" so a single flaky
 *    workflow doesn't pin the indicator forever.
 *  - Returns false on scan failure (defensive — bare ensembles or
 *    Temporal connection blips shouldn't render a stale held badge).
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';

const asName = (nameOrDef: unknown): string =>
  typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

interface SessionShape {
  playerId: string;
  outboxLocked?: boolean;
  /** When true, the `outboxLocked` query throws — exercising the soft-fail path. */
  queryThrows?: boolean;
}

function makeClient(opts: {
  ensemble: string;
  sessions?: SessionShape[];
  /** When true, `client.workflow.list` throws — exercising the outer catch. */
  listThrows?: boolean;
}): { client: any } {
  const ensemble = opts.ensemble;
  const sessions = opts.sessions ?? [];

  const sessionHandles = new Map<string, any>();
  for (const s of sessions) {
    sessionHandles.set(`agent-session-${ensemble}-${s.playerId}`, {
      workflowId: `agent-session-${ensemble}-${s.playerId}`,
      async query(nameOrDef: unknown) {
        const name = asName(nameOrDef);
        if (name === 'getMetadata') {
          return {
            ensemble,
            playerId: s.playerId,
            hostname: 'h',
            workDir: '/w',
            isConductor: false,
            agentType: 'claude',
          };
        }
        if (name === 'getPart') return '';
        if (name === 'outboxLocked') {
          if (s.queryThrows) throw new Error('query failed');
          return s.outboxLocked === true;
        }
        return undefined;
      },
    });
  }

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        return sessionHandles.get(workflowId) ?? {
          workflowId,
          async query() { return undefined; },
        };
      },
      async *list() {
        if (opts.listThrows) {
          throw new Error('list failed');
        }
        for (const s of sessions) {
          yield {
            workflowId: `agent-session-${ensemble}-${s.playerId}`,
            searchAttributes: {
              AgentTempoPlayerId: [s.playerId],
            },
          };
        }
      },
    },
  };

  return { client };
}

describe('TempoClient.isAnySessionHeld (#306 follow-up)', () => {
  it('returns true when at least one non-maestro session is locked', async () => {
    const { client } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'alice', outboxLocked: false },
        { playerId: 'bob', outboxLocked: true },
        { playerId: 'carol', outboxLocked: false },
      ],
    });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(true);
  });

  it('returns false when no sessions are locked', async () => {
    const { client } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'alice', outboxLocked: false },
        { playerId: 'bob', outboxLocked: false },
      ],
    });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(false);
  });

  it('returns false when there are no sessions in the ensemble', async () => {
    const { client } = makeClient({ ensemble: 'band', sessions: [] });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(false);
  });

  it('skips the maestro session even when its outbox is locked', async () => {
    // The maestro session is the TUI's own dashboard attachment — its
    // outbox lock state is internal mechanics, never user-facing held.
    const { client } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'maestro', outboxLocked: true },
        { playerId: 'alice', outboxLocked: false },
      ],
    });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(false);
  });

  it('treats per-session query failures as "not held" (skips and continues)', async () => {
    // A flaky session that throws on `outboxLocked` shouldn't pin the
    // indicator. The scan continues to the next session.
    const { client } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'alice', queryThrows: true },
        { playerId: 'bob', outboxLocked: false },
      ],
    });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(false);
  });

  it('returns true when one session throws but another is locked', async () => {
    // Mid-scan failures must not mask a real held session.
    const { client } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'alice', queryThrows: true },
        { playerId: 'bob', outboxLocked: true },
      ],
    });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(true);
  });

  it('returns false when the ensemble scan itself throws', async () => {
    // Defensive — Temporal connection blips or bare ensembles shouldn't
    // cause the StatusBar to render a stale held badge.
    const { client } = makeClient({ ensemble: 'band', listThrows: true });
    const tempo = createTempoClient(client as any);
    expect(await tempo.isAnySessionHeld('band')).toBe(false);
  });
});
