/**
 * Unit tests for the `restart` MCP tool's host-param routing.
 *
 * Asserts that:
 *  - the `host` arg is threaded into `RestartOutboxEntry.host` on the
 *    submitted outbox update;
 *  - omitting `host` produces an entry with no `host` field (so the
 *    activity falls back to preferredHost → metadata.hostname);
 *  - the `--yes-steal` guard fires before any outbox submission when
 *    cross-host force is detected without `confirmStealFromHost`.
 *
 * No Temporal connection — the registered tool handler is captured via a
 * fake McpServer (pattern shared with `test/tools.test.ts`), then called
 * directly with test arguments. The Temporal `client` parameter is a
 * mock that yields a single "target" workflow for resolveSession + returns
 * a fixture `attachmentInfo` for the guard query. The `handle` parameter
 * captures the submitted `submitOutbox` entry so assertions read the
 * entry shape.
 */
import { expect } from 'chai';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { registerRestartTool } from '../src/tools/restart';
import type { AttachmentInfo } from '../src/types';

type ToolHandler = (args: Record<string, any>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

const asName = (n: unknown) => typeof n === 'string' ? n : (n as any).name;

function extractHandler(reg: (server: McpServer) => void): ToolHandler {
  let captured: Function | undefined;
  const fake = {
    tool: (_n: unknown, _d: unknown, _s: unknown, h: Function) => { captured = h; },
  } as unknown as McpServer;
  reg(fake);
  if (!captured) throw new Error('No handler captured');
  return (args) => captured!(args, {});
}

function makeTargetClient(opts: { attachedHost?: string } = {}): any {
  // Build a fake client whose `workflow.list` yields a single candidate
  // and whose `getHandle().query(attachmentInfo)` returns the fixture.
  const info: AttachmentInfo = {
    phase: 'attached',
    inFlightCount: 0,
    ...(opts.attachedHost !== undefined ? {
      currentAttachment: {
        attachmentId: 'a1',
        hostname: opts.attachedHost,
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: '2026-04-12T00:00:00Z',
        lastHeartbeatAt: '2026-04-13T00:00:00Z',
        expiresAt: '2026-04-13T01:30:00Z',
        leaseMs: 90_000,
        runId: 'r1',
      },
    } : {}),
  };
  return {
    workflow: {
      getHandle: () => ({
        workflowId: 'claude-session-test-ensemble-target',
        async query(name: unknown) {
          const n = asName(name);
          if (n === 'attachmentInfo') return info;
          if (n === 'getMetadata') return { ensemble: 'test-ensemble', playerId: 'target' };
          return undefined;
        },
      }),
      async *list() { yield { workflowId: 'claude-session-test-ensemble-target' }; },
    },
  };
}

function makeCaptureHandle(): { handle: WorkflowHandle; entries: Array<{ name: string; args: unknown }> } {
  const entries: Array<{ name: string; args: unknown }> = [];
  const handle = {
    executeUpdate: async (nameOrDef: unknown, opts: { args: unknown[] }) => {
      entries.push({ name: asName(nameOrDef), args: opts.args[0] });
      return `entry-${entries.length}`;
    },
  } as unknown as WorkflowHandle;
  return { handle, entries };
}

const testConfig = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'claude-tempo',
  ensemble: 'test-ensemble',
  defaultAgent: 'claude' as const,
};

describe('restart tool host routing (PR-F)', function () {
  it('threads `host` into RestartOutboxEntry.host when supplied', async function () {
    const client = makeTargetClient({ attachedHost: 'localhost-test' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((s) =>
      registerRestartTool(s, client, testConfig as any, () => 'invoker', handle),
    );
    const result = await call({ playerId: 'target', host: 'other-host' });
    expect(result.isError).to.not.equal(true);
    expect(entries).to.have.length(1);
    const entry = entries[0].args as any;
    expect(entry.type).to.equal('restart');
    expect(entry.host).to.equal('other-host');
  });

  it('omits `host` from the entry when not supplied (downstream chooses)', async function () {
    const client = makeTargetClient();
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((s) =>
      registerRestartTool(s, client, testConfig as any, () => 'invoker', handle),
    );
    await call({ playerId: 'target' });
    const entry = entries[0].args as any;
    expect(entry.host).to.be.undefined;
  });

  it('forwards invokerPlayerId from getPlayerId()', async function () {
    const client = makeTargetClient();
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((s) =>
      registerRestartTool(s, client, testConfig as any, () => 'my-tempo-eng', handle),
    );
    await call({ playerId: 'target' });
    expect((entries[0].args as any).invokerPlayerId).to.equal('my-tempo-eng');
  });

  it('rejects cross-host force without confirmStealFromHost (guard fires before enqueue)', async function () {
    const client = makeTargetClient({ attachedHost: 'remote-host' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((s) =>
      registerRestartTool(s, client, testConfig as any, () => 'invoker', handle),
    );
    const result = await call({ playerId: 'target', force: true });
    expect(result.isError).to.be.true;
    // Critically, no entry was enqueued before the rejection.
    expect(entries).to.have.length(0);
  });

  it('allows cross-host force with matching confirmStealFromHost', async function () {
    const client = makeTargetClient({ attachedHost: 'remote-host' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((s) =>
      registerRestartTool(s, client, testConfig as any, () => 'invoker', handle),
    );
    const result = await call({
      playerId: 'target',
      force: true,
      confirmStealFromHost: 'remote-host',
      host: 'target-host',
    });
    expect(result.isError).to.not.equal(true);
    expect(entries).to.have.length(1);
    expect((entries[0].args as any).host).to.equal('target-host');
    expect((entries[0].args as any).force).to.be.true;
  });
});
