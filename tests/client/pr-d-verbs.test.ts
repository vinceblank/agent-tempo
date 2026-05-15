/**
 * Happy-path tests for the PR-D verb methods on TempoClient.
 *
 * After QA B1/B2/B3 remediation, the methods enqueue outbox entries on the
 * TUI-owned maestro session's workflow rather than firing signals/updates
 * directly. Tests assert on the submitted entry shape.
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';

const asName = (nameOrDef: unknown): string =>
  typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

/**
 * Fake Temporal Client whose `getHandle(maestroId)` returns a handle that
 * captures `submitOutbox` update calls. `attachmentInfo` still routes through
 * the resolveSession → workflow.list path for the read-only query methods.
 */
function makeClient(opts: {
  ensemble: string;
  playerId: string;
  phase?: 'attached' | 'awaiting' | 'processing' | 'detached' | 'gone';
  currentAttachmentId?: string;
}): {
  client: any;
  entries: Array<{ name: string; args: unknown }>;
} {
  const entries: Array<{ name: string; args: unknown }> = [];
  const hostname = 'test-host';
  const ensemble = opts.ensemble;
  const playerId = opts.playerId;
  const phase = opts.phase ?? 'attached';

  const attachmentInfo = {
    phase,
    inFlightCount: 0,
    ...(opts.currentAttachmentId
      ? {
          currentAttachment: {
            attachmentId: opts.currentAttachmentId,
            hostname,
            adapterId: 'claude-code',
            adapterClass: 'interactive',
            claimedAt: '2026-01-01T00:00:00Z',
            lastHeartbeatAt: '2026-01-01T00:00:00Z',
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
            leaseMs: 90_000,
            runId: 'run-x',
          },
        }
      : {}),
  };

  const sessionHandle = {
    workflowId: `agent-session-${ensemble}-${playerId}`,
    async query(nameOrDef: unknown) {
      const name = asName(nameOrDef);
      if (name === 'getMetadata') return { ensemble, playerId, hostname, workDir: '/w' };
      if (name === 'attachmentInfo') return attachmentInfo;
      return undefined;
    },
    async signal() { /* noop */ },
    async executeUpdate() { /* noop */ },
    async describe() { return { status: { name: 'RUNNING' } }; },
  };

  const maestroHandle = {
    workflowId: `agent-session-${ensemble}-maestro`,
    async executeUpdate(nameOrDef: unknown, opts: { args: unknown[] }) {
      entries.push({ name: asName(nameOrDef), args: opts.args[0] });
      return `entry-${entries.length}`;
    },
  };

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        if (workflowId.endsWith('-maestro')) return maestroHandle;
        return sessionHandle;
      },
      async *list() {
        yield { workflowId: sessionHandle.workflowId };
      },
    },
  };

  return { client, entries };
}

describe('TempoClient PR-D verbs (outbox-queued)', () => {
  it('restart() enqueues RestartOutboxEntry on the maestro session', async () => {
    const { client, entries } = makeClient({
      ensemble: 'e1', playerId: 'alice', phase: 'detached',
    });
    const tempo = createTempoClient(client as any);

    const result = await tempo.restart('e1', 'alice', { invokerPlayerId: 'test' });

    expect(result.playerId).toBe('alice');
    expect(result.entryId).toBe('entry-1');
    expect(entries).toHaveLength(1);
    const entry = entries[0].args as any;
    expect(entry.type).toBe('restart');
    expect(entry.targetPlayerId).toBe('alice');
    expect(entry.invokerPlayerId).toBe('test');
  });

  it('restart() forwards host + fresh + force flags', async () => {
    const { client, entries } = makeClient({ ensemble: 'e1', playerId: 'bob' });
    const tempo = createTempoClient(client as any);
    await tempo.restart('e1', 'bob', { host: 'other-host', fresh: true, force: true });
    const entry = entries[0].args as any;
    expect(entry.host).toBe('other-host');
    expect(entry.fresh).toBe(true);
    expect(entry.force).toBe(true);
  });

  it('detach() enqueues DetachOutboxEntry', async () => {
    const { client, entries } = makeClient({ ensemble: 'e1', playerId: 'carol', phase: 'attached' });
    const tempo = createTempoClient(client as any);

    await tempo.detach('e1', 'carol', 3000);

    const entry = entries[0].args as any;
    expect(entry.type).toBe('detach');
    expect(entry.targetPlayerId).toBe('carol');
    expect(entry.deadlineMs).toBe(3000);
    expect(entry.reason).toBe('user-stop');
  });

  it('destroy() enqueues DestroyOutboxEntry with reason', async () => {
    const { client, entries } = makeClient({ ensemble: 'e1', playerId: 'dave' });
    const tempo = createTempoClient(client as any);

    await tempo.destroy('e1', 'dave', 'cleanup');

    const entry = entries[0].args as any;
    expect(entry.type).toBe('destroy');
    expect(entry.targetPlayerId).toBe('dave');
    expect(entry.reason).toBe('cleanup');
    expect(entry.notifyConductor).toBe(true);
  });

  it('migrate() enqueues RestartOutboxEntry with host', async () => {
    const { client, entries } = makeClient({ ensemble: 'e1', playerId: 'eve' });
    const tempo = createTempoClient(client as any);

    const result = await tempo.migrate('e1', 'eve', 'other-host');

    expect(result.host).toBe('other-host');
    const entry = entries[0].args as any;
    expect(entry.type).toBe('restart');
    expect(entry.host).toBe('other-host');
  });

  it('migrate() rejects empty host', async () => {
    const { client } = makeClient({ ensemble: 'e1', playerId: 'frank' });
    const tempo = createTempoClient(client as any);
    await expect(tempo.migrate('e1', 'frank', '   ')).rejects.toThrow(/host/i);
  });

  it('attachmentInfo() remains a direct query (read-only — no outbox)', async () => {
    const { client, entries } = makeClient({
      ensemble: 'e1', playerId: 'gina', phase: 'attached', currentAttachmentId: 'attach-gina',
    });
    const tempo = createTempoClient(client as any);

    const info = await tempo.attachmentInfo('e1', 'gina');

    expect(info.phase).toBe('attached');
    expect(info.currentAttachment?.attachmentId).toBe('attach-gina');
    // Read-only path — no outbox entries enqueued.
    expect(entries).toHaveLength(0);
  });
});
