/**
 * Happy-path tests for the PR-D verb methods on TempoClient.
 *
 * One test per method; exhaustive edge coverage lives in the underlying tool
 * tests (`test/tools.test.ts`) and the algorithm helper (`performRestart`).
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';

/** asName normalizes either a string or a typed workflow definition to its .name. */
const asName = (nameOrDef: unknown): string =>
  typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

/** Build a fake Temporal Client whose single listed workflow matches the target player. */
function makeClient(opts: {
  ensemble: string;
  playerId: string;
  phase: 'attached' | 'awaiting' | 'processing' | 'detached' | 'gone';
  currentAttachmentId?: string;
  hostname?: string;
}): { client: any; handle: any } {
  const hostname = opts.hostname ?? 'test-host';
  const signals: Array<{ name: string; args: unknown }> = [];
  const updates: Array<{ name: string; args: unknown }> = [];

  const info = {
    phase: opts.phase,
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

  const handle = {
    workflowId: `claude-session-${opts.ensemble}-${opts.playerId}`,
    signals,
    updates,
    async signal(nameOrDef: unknown, args: unknown) {
      signals.push({ name: asName(nameOrDef), args });
    },
    async query(nameOrDef: unknown) {
      const name = asName(nameOrDef);
      if (name === 'getMetadata') {
        return {
          playerId: opts.playerId,
          ensemble: opts.ensemble,
          hostname,
          workDir: '/work',
          isConductor: false,
          agentType: 'claude',
          status: 'active',
          adapterId: 'claude-code',
          sessionId: 'sess-uuid',
        };
      }
      if (name === 'getPart') return 'working on stuff';
      if (name === 'allMessages') return [];
      if (name === 'attachmentInfo') return info;
      return undefined;
    },
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      const name = asName(nameOrDef);
      updates.push({ name, args: updateOpts.args[0] });
      if (name === 'destroy') return undefined;
      if (name === 'forceDetach') return { reaped: true, previousAttachmentId: opts.currentAttachmentId };
      if (name === 'claimAttachment') {
        return {
          attachmentId: 'new-attach-001',
          runId: 'new-run-001',
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
          leaseMs: 90_000,
        };
      }
      if (name === 'enqueueSpawn') return { spawnEntryId: 'spawn-001' };
      return undefined;
    },
  };

  const client = {
    workflow: {
      getHandle: () => handle,
      async *list() {
        yield { workflowId: handle.workflowId };
      },
    },
  };

  return { client, handle };
}

describe('TempoClient PR-D verbs', () => {
  it('restart() runs §8.2 on a detached session — claim + enqueueSpawn + context', async () => {
    const { client, handle } = makeClient({
      ensemble: 'e1', playerId: 'alice', phase: 'detached',
    });
    const tempo = createTempoClient(client as any);

    const result = await tempo.restart('e1', 'alice');

    expect(result.playerId).toBe('alice');
    expect(result.attachmentId).toBe('new-attach-001');
    expect(result.spawnEntryId).toBe('spawn-001');
    expect(result.contextReplayed).toBe(true);
    expect(handle.updates.find((u: any) => u.name === 'claimAttachment')).toBeDefined();
    expect(handle.updates.find((u: any) => u.name === 'enqueueSpawn')).toBeDefined();
    // Detached — should not forceDetach.
    expect(handle.updates.find((u: any) => u.name === 'forceDetach')).toBeUndefined();
  });

  it('detach() sends requestDetach signal on an attached session', async () => {
    const { client, handle } = makeClient({
      ensemble: 'e1', playerId: 'bob', phase: 'attached', currentAttachmentId: 'attach-bob',
    });
    const tempo = createTempoClient(client as any);

    await tempo.detach('e1', 'bob', 3000);

    const detach = handle.signals.find((s: any) => s.name === 'requestDetach');
    expect(detach).toBeDefined();
    expect((detach!.args as any).deadlineMs).toBe(3000);
  });

  it('detach() is idempotent on an already-detached session', async () => {
    const { client, handle } = makeClient({
      ensemble: 'e1', playerId: 'carol', phase: 'detached',
    });
    const tempo = createTempoClient(client as any);

    await tempo.detach('e1', 'carol');

    expect(handle.signals.find((s: any) => s.name === 'requestDetach')).toBeUndefined();
  });

  it('destroy() calls destroyUpdate with the reason', async () => {
    const { client, handle } = makeClient({
      ensemble: 'e1', playerId: 'dave', phase: 'attached', currentAttachmentId: 'attach-dave',
    });
    const tempo = createTempoClient(client as any);

    await tempo.destroy('e1', 'dave', 'cleanup');

    const destroy = handle.updates.find((u: any) => u.name === 'destroy');
    expect(destroy).toBeDefined();
    expect((destroy!.args as any).reason).toBe('cleanup');
  });

  it('migrate() forwards host to restart algorithm', async () => {
    const { client, handle } = makeClient({
      ensemble: 'e1', playerId: 'eve', phase: 'detached',
    });
    const tempo = createTempoClient(client as any);

    const result = await tempo.migrate('e1', 'eve', 'other-host');

    expect(result.host).toBe('other-host');
    const claim = handle.updates.find((u: any) => u.name === 'claimAttachment');
    expect((claim!.args as any).host).toBe('other-host');
  });

  it('migrate() rejects empty host', async () => {
    const { client } = makeClient({
      ensemble: 'e1', playerId: 'frank', phase: 'detached',
    });
    const tempo = createTempoClient(client as any);

    await expect(tempo.migrate('e1', 'frank', '   ')).rejects.toThrow(/host/i);
  });

  it('attachmentInfo() returns the raw AttachmentInfo', async () => {
    const { client } = makeClient({
      ensemble: 'e1', playerId: 'gina', phase: 'attached', currentAttachmentId: 'attach-gina',
    });
    const tempo = createTempoClient(client as any);

    const info = await tempo.attachmentInfo('e1', 'gina');

    expect(info.phase).toBe('attached');
    expect(info.currentAttachment?.attachmentId).toBe('attach-gina');
  });
});
