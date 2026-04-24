/**
 * #306: TempoClient direct-routing tests for the TUI structural-op paths.
 *
 * Covers the new `recruit` and `release` methods added to TempoClient so the
 * TUI can enqueue outbox entries on its own maestro session instead of
 * routing slash commands through the conductor's Claude Code session.
 *
 * Structure mirrors `pr-d-verbs.test.ts` — a fake Temporal client whose
 * maestro-session `executeUpdate` captures the submitted entries.
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';

const asName = (nameOrDef: unknown): string =>
  typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

interface SessionShape {
  playerId: string;
  outboxLocked?: boolean;
}

function makeClient(opts: {
  ensemble: string;
  sessions?: SessionShape[];
}): {
  client: any;
  entries: Array<{ name: string; args: unknown }>;
} {
  const entries: Array<{ name: string; args: unknown }> = [];
  const ensemble = opts.ensemble;
  const sessions = opts.sessions ?? [];

  const sessionHandles = new Map<string, any>();
  for (const s of sessions) {
    sessionHandles.set(`claude-session-${ensemble}-${s.playerId}`, {
      workflowId: `claude-session-${ensemble}-${s.playerId}`,
      async query(nameOrDef: unknown) {
        const name = asName(nameOrDef);
        if (name === 'outboxLocked') return s.outboxLocked === true;
        if (name === 'getMetadata') {
          return { ensemble, playerId: s.playerId, hostname: 'h', workDir: '/w' };
        }
        return undefined;
      },
    });
  }

  const maestroHandle = {
    workflowId: `claude-session-${ensemble}-maestro`,
    async executeUpdate(nameOrDef: unknown, opts2: { args: unknown[] }) {
      entries.push({ name: asName(nameOrDef), args: opts2.args[0] });
      return `entry-${entries.length}`;
    },
  };

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        if (workflowId.endsWith('-maestro')) return maestroHandle;
        return sessionHandles.get(workflowId) ?? {
          workflowId,
          async query() { return undefined; },
        };
      },
      async *list() {
        for (const s of sessions) {
          yield {
            workflowId: `claude-session-${ensemble}-${s.playerId}`,
            searchAttributes: {
              ClaudeTempoPlayerId: [s.playerId],
            },
          };
        }
      },
    },
  };

  return { client, entries };
}

describe('TempoClient.recruit (#306)', () => {
  it('enqueues a RecruitOutboxEntry on the caller-ensemble maestro session', async () => {
    const { client, entries } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);

    const result = await tempo.recruit('band', {
      name: 'alice',
      workDir: '/repo',
      agent: 'claude',
    });

    expect(result).toEqual({ playerId: 'alice', entryId: 'entry-1' });
    expect(entries).toHaveLength(1);
    const entry = entries[0].args as any;
    expect(entry.type).toBe('recruit');
    expect(entry.targetName).toBe('alice');
    expect(entry.workDir).toBe('/repo');
    expect(entry.agent).toBe('claude');
    expect(entry.isConductor).toBe(false);
  });

  it('defaults agent to "claude" when omitted', async () => {
    const { client, entries } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    await tempo.recruit('band', { name: 'bob', workDir: '/repo' });
    expect((entries[0].args as any).agent).toBe('claude');
  });

  it('forwards host + initialMessage + held flags when provided', async () => {
    const { client, entries } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    await tempo.recruit('band', {
      name: 'carol',
      workDir: '/repo',
      host: 'remote',
      initialMessage: 'go',
      held: true,
    });
    const entry = entries[0].args as any;
    expect(entry.targetHostname).toBe('remote');
    expect(entry.initialMessage).toBe('go');
    expect(entry.held).toBe(true);
  });

  // #306 regression: when opts.host is omitted the entry must still carry a
  // real `targetHostname` so the session workflow's `case 'recruit'` dispatch
  // routes spawnProcess to an actual host worker. Without this, the fallback
  // `entry.targetHostname || input.metadata.hostname` path would route to
  // `claude-tempo-dashboard` — the TUI maestro session's placeholder hostname
  // — and spawnProcess would hang forever on an unattended task queue.
  it('defaults targetHostname to the current OS hostname when host is omitted', async () => {
    const { hostname: osHostname } = await import('os');
    const { client, entries } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    await tempo.recruit('band', { name: 'elsa', workDir: '/repo' });
    const entry = entries[0].args as any;
    expect(entry.targetHostname).toBe(osHostname());
    // Critically: not 'dashboard' (the maestro session's metadata.hostname).
    expect(entry.targetHostname).not.toBe('dashboard');
    // ...and not undefined (which falls through to the maestro's placeholder).
    expect(entry.targetHostname).toBeDefined();
  });

  it('throws when playerType resolves to no known agent type', async () => {
    const { client } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    await expect(
      tempo.recruit('band', {
        name: 'dora',
        workDir: '/repo',
        playerType: 'not-a-real-agent-type-xyz',
      }),
    ).rejects.toThrow(/Unknown agent type/);
  });
});

describe('TempoClient.release (#306)', () => {
  it('single-player release: submits when outbox is locked', async () => {
    const { client, entries } = makeClient({
      ensemble: 'band',
      sessions: [{ playerId: 'alice', outboxLocked: true }],
    });
    const tempo = createTempoClient(client as any);

    const summary = await tempo.release('band', 'alice');

    expect(summary.released).toEqual(['alice']);
    expect(summary.errors).toEqual([]);
    expect(entries).toHaveLength(1);
    const entry = entries[0].args as any;
    expect(entry.type).toBe('release');
    expect(entry.targetPlayerId).toBe('alice');
  });

  it('single-player release rejects when outbox is NOT locked', async () => {
    const { client, entries } = makeClient({
      ensemble: 'band',
      sessions: [{ playerId: 'alice', outboxLocked: false }],
    });
    const tempo = createTempoClient(client as any);
    await expect(tempo.release('band', 'alice')).rejects.toThrow(/not held/);
    // No outbox entry submitted for a non-held session.
    expect(entries).toHaveLength(0);
  });

  it('single-player release rejects when the session is missing', async () => {
    const { client } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    await expect(tempo.release('band', 'ghost')).rejects.toThrow(/No session found/);
  });

  it('bulk release enqueues one entry per held session; skips maestro', async () => {
    const { client, entries } = makeClient({
      ensemble: 'band',
      sessions: [
        { playerId: 'alice', outboxLocked: true },
        { playerId: 'bob', outboxLocked: false }, // not held → skipped
        { playerId: 'carol', outboxLocked: true },
        { playerId: 'maestro', outboxLocked: true }, // explicit self-skip
      ],
    });
    const tempo = createTempoClient(client as any);

    const summary = await tempo.release('band');

    expect(summary.released.sort()).toEqual(['alice', 'carol']);
    expect(summary.errors).toEqual([]);
    expect(entries).toHaveLength(2);
    const targets = entries.map(e => (e.args as any).targetPlayerId).sort();
    expect(targets).toEqual(['alice', 'carol']);
  });

  it('bulk release on an empty ensemble returns an empty summary', async () => {
    const { client, entries } = makeClient({ ensemble: 'band' });
    const tempo = createTempoClient(client as any);
    const summary = await tempo.release('band');
    expect(summary).toEqual({ released: [], errors: [] });
    expect(entries).toHaveLength(0);
  });
});
