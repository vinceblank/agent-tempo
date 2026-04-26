/**
 * Mocha tests for the #287 ensemble-scope MCP tools: `shutdown`, `restore`,
 * and the new `destroy(ensemble?)` branch.
 *
 * Same harness as `test/tools.test.ts`: fake McpServer captures the handler
 * closure, we invoke it with a fake Temporal Client that records every
 * signal / update / terminate call. No TestWorkflowEnvironment needed — the
 * tools are pure transformations over the client boundary, so this is the
 * fastest + most focused way to lock behaviour.
 *
 * Workflow-level round-trip coverage (phase transitions under real signal
 * delivery) stays in the existing `test/pause-resume.test.ts`,
 * `test/destroy.test.ts`, and `test/rebuild-reboot.test.ts` suites.
 */
import { expect } from 'chai';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../src/config';
import { registerShutdownTool } from '../src/tools/shutdown';
import { registerRestoreTool } from '../src/tools/restore';
import { registerDestroyTool } from '../src/tools/destroy';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

function extractHandler(registerFn: (server: McpServer) => void): ToolHandler {
  let captured: Function | undefined;
  const fakeServer = {
    tool: (_name: unknown, _desc: unknown, _schema: unknown, handler: Function) => {
      captured = handler;
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  if (!captured) throw new Error('No handler captured — tool did not call server.tool()');
  return (args: Record<string, any>) => captured!(args, {}) as Promise<ToolResult>;
}

const asName = (n: unknown): string =>
  typeof n === 'string' ? n : (n as { name: string }).name;

// ── Fake client harness ─────────────────────────────────────────────────

interface Call {
  workflowId: string;
  kind: 'signal' | 'update' | 'terminate';
  name: string;
  payload?: unknown;
}

/**
 * `scanEnsembleSessions` iterates `client.workflow.list()` and queries
 * `getMetadata` + `getPart` on each result. The fake below returns matching
 * metadata for every `sessionIds` entry; anything else is "not a member".
 */
function makeClient(opts: {
  ensemble: string;
  players: string[];
  includeConductor?: boolean;
  hasScheduler?: boolean;
  hasMaestroHub?: boolean;
  failOnUpdate?: Set<string>;
}) {
  const { ensemble, players, includeConductor = false } = opts;
  const hasScheduler = opts.hasScheduler ?? true;
  const hasMaestroHub = opts.hasMaestroHub ?? true;
  const failOnUpdate = opts.failOnUpdate ?? new Set<string>();

  const calls: Call[] = [];
  const sessionIds: Array<{ workflowId: string; playerId: string; isConductor: boolean }> =
    players.map((p) => ({
      workflowId: `claude-session-${ensemble}-${p}`,
      playerId: p,
      isConductor: false,
    }));
  if (includeConductor) {
    sessionIds.push({
      workflowId: `claude-session-${ensemble}-conductor`,
      playerId: 'conductor',
      isConductor: true,
    });
  }

  const makeHandle = (workflowId: string) => ({
    workflowId,
    async query(nameOrDef: unknown) {
      const n = asName(nameOrDef);
      if (n === 'getMetadata') {
        const s = sessionIds.find((x) => x.workflowId === workflowId);
        if (!s) return undefined;
        return {
          ensemble,
          playerId: s.playerId,
          hostname: 'test-host',
          workDir: '/w',
          isConductor: s.isConductor,
          agentType: 'claude',
        };
      }
      if (n === 'getPart') return '';
      return undefined;
    },
    async signal(nameOrDef: unknown, payload?: unknown) {
      calls.push({ workflowId, kind: 'signal', name: asName(nameOrDef), payload });
    },
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      const name = asName(nameOrDef);
      calls.push({ workflowId, kind: 'update', name, payload: updateOpts.args[0] });
      if (failOnUpdate.has(workflowId)) throw new Error(`update ${name} failed`);
      return `entry-${calls.length}`;
    },
    async terminate(reason?: string) {
      calls.push({ workflowId, kind: 'terminate', name: 'terminate', payload: reason });
    },
  });

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        if (!hasScheduler && workflowId === `claude-scheduler-${ensemble}`) {
          return {
            workflowId,
            async signal() { throw new Error('workflow not found'); },
            async terminate() { throw new Error('workflow not found'); },
            async executeUpdate() { throw new Error('workflow not found'); },
          };
        }
        if (!hasMaestroHub && workflowId === `claude-maestro-${ensemble}`) {
          return {
            workflowId,
            async signal() { throw new Error('workflow not found'); },
            async terminate() { throw new Error('workflow not found'); },
            async executeUpdate() { throw new Error('workflow not found'); },
          };
        }
        return makeHandle(workflowId);
      },
      async *list() {
        for (const s of sessionIds) yield { workflowId: s.workflowId };
      },
    },
  } as unknown as Client;

  return { client, calls, sessionIds };
}

const testConfig = (ensemble: string): Config => ({
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'claude-tempo',
  ensemble,
  defaultAgent: 'claude',
});

const fakeHandle = {} as unknown as WorkflowHandle;

// ── shutdown ────────────────────────────────────────────────────────────

describe('shutdown tool (#287)', function () {
  it('signals requestDetach on every peer session + pauses scheduler + maestro', async function () {
    const ensemble = 'shutdown-basic';
    const { client, calls } = makeClient({ ensemble, players: ['alice', 'bob'] });
    const call = extractHandler((server) =>
      registerShutdownTool(server, client, testConfig(ensemble), () => 'operator'),
    );

    const result = await call({});
    expect(result.isError).to.not.equal(true);

    // Two detach signals (one per session), plus maestro + scheduler pauses.
    expect(calls.filter((c) => c.name === 'requestDetach')).to.have.lengthOf(2);
    expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === true)).to.equal(true);
    expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === true)).to.equal(true);

    // Message body mentions the count.
    expect(result.content[0].text).to.include('2 detaching');
  });

  it('skips the caller session (self-skip)', async function () {
    const ensemble = 'shutdown-self';
    const { client, calls } = makeClient({ ensemble, players: ['operator', 'alice'] });
    const call = extractHandler((server) =>
      registerShutdownTool(server, client, testConfig(ensemble), () => 'operator'),
    );
    await call({});

    // Only alice got the detach — operator was skipped.
    const detachTargets = calls
      .filter((c) => c.name === 'requestDetach')
      .map((c) => c.workflowId);
    expect(detachTargets).to.deep.equal([`claude-session-${ensemble}-alice`]);
  });

  it('forwards custom deadlineMs onto requestDetach payload', async function () {
    const ensemble = 'shutdown-deadline';
    const { client, calls } = makeClient({ ensemble, players: ['alice'] });
    const call = extractHandler((server) =>
      registerShutdownTool(server, client, testConfig(ensemble), () => 'operator'),
    );
    await call({ deadlineMs: 8_000 });

    const detach = calls.find((c) => c.name === 'requestDetach');
    expect((detach!.payload as any).deadlineMs).to.equal(8_000);
  });

  it('tolerates missing scheduler + maestro (best-effort)', async function () {
    const ensemble = 'shutdown-nopausables';
    const { client, calls } = makeClient({
      ensemble, players: ['alice'], hasScheduler: false, hasMaestroHub: false,
    });
    const call = extractHandler((server) =>
      registerShutdownTool(server, client, testConfig(ensemble), () => 'operator'),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);

    // Detach signal still fires on the session.
    expect(calls.filter((c) => c.name === 'requestDetach')).to.have.lengthOf(1);
    // Neither pause signal landed.
    expect(calls.some((c) => c.name === 'setSchedulerPaused')).to.equal(false);
    expect(calls.some((c) => c.name === 'maestroSetPaused')).to.equal(false);
  });
});

// ── restore ─────────────────────────────────────────────────────────────

describe('restore tool (#287)', function () {
  it('delegates to restoreOrphansOnce then unpauses scheduler + maestro', async function () {
    const ensemble = 'restore-basic';
    const orphansModule = require('../src/reconcile/orphans') as typeof import('../src/reconcile/orphans');
    const originalFn = orphansModule.restoreOrphansOnce;
    let capturedOpts: unknown = null;
    (orphansModule as any).restoreOrphansOnce = async (_c: unknown, opts: unknown) => {
      capturedOpts = opts;
      return {
        reattached: 1,
        skipped: 0,
        failed: 0,
        details: [
          { playerId: 'alice', ensemble, outcome: { kind: 'queued', entryId: 'entry-1' } },
        ],
      };
    };

    try {
      const { client, calls } = makeClient({ ensemble, players: [] });
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({});
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('1 reattached');
      expect((capturedOpts as any).invokerPlayerId).to.equal('operator');
      expect((capturedOpts as any).policy).to.equal('auto');

      // Unpause signals fire on scheduler + maestro.
      expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === false)).to.equal(true);
      expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === false)).to.equal(true);
    } finally {
      (orphansModule as any).restoreOrphansOnce = originalFn;
    }
  });

  it('reports an error (isError=true) when restoreOrphansOnce throws', async function () {
    const ensemble = 'restore-throws';
    const orphansModule = require('../src/reconcile/orphans') as typeof import('../src/reconcile/orphans');
    const originalFn = orphansModule.restoreOrphansOnce;
    (orphansModule as any).restoreOrphansOnce = async () => {
      throw new Error('visibility API unreachable');
    };

    try {
      const { client } = makeClient({ ensemble, players: [] });
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({});
      expect(result.isError).to.equal(true);
      expect(result.content[0].text).to.include('visibility API unreachable');
    } finally {
      (orphansModule as any).restoreOrphansOnce = originalFn;
    }
  });

  // #306: the maestro/scheduler hub unpause is necessary but not sufficient.
  // Each session keeps its own `paused` flag, and the outbox dispatcher
  // gates on it (`canDispatch = !outboxLocked && !paused && hasPendingOutbox()`).
  // Without this fan-out the conductor accepts messages but never replies —
  // matches the bug `e61e192` fixed on `TempoClient.restore`. The MCP tool
  // path was missed in that PR; this test locks in parity.
  it('fans out setPaused=false to every session in the ensemble', async function () {
    const ensemble = 'restore-fanout';
    const orphansModule = require('../src/reconcile/orphans') as typeof import('../src/reconcile/orphans');
    const originalFn = orphansModule.restoreOrphansOnce;
    (orphansModule as any).restoreOrphansOnce = async () => ({
      reattached: 0,
      skipped: 0,
      failed: 0,
      details: [],
    });

    try {
      const { client, calls } = makeClient({
        ensemble,
        players: ['alice', 'bob'],
        includeConductor: true,
      });
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({});
      expect(result.isError).to.not.equal(true);

      // alice + bob + conductor = 3 session signals.
      const setPausedFalse = calls.filter(
        (c) => c.kind === 'signal' && c.name === 'setPaused' && c.payload === false,
      );
      expect(setPausedFalse).to.have.lengthOf(3);

      // Maestro + scheduler unpause still fire alongside the session fan-out.
      expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === false)).to.equal(true);
      expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === false)).to.equal(true);
    } finally {
      (orphansModule as any).restoreOrphansOnce = originalFn;
    }
  });
});

// ── destroy (ensemble scope) ────────────────────────────────────────────

describe('destroy tool — ensemble scope (#287)', function () {
  it('destroys peer sessions, terminates scheduler + maestro, then destroys conductor last', async function () {
    const ensemble = 'destroy-ens-order';
    const { client, calls } = makeClient({
      ensemble,
      players: ['alice', 'bob'],
      includeConductor: true,
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);

    const destroyUpdates = calls.filter((c) => c.kind === 'update' && c.name === 'destroy');
    // 2 peers + 1 conductor = 3 destroys. Self skipped (operator isn't in sessions).
    expect(destroyUpdates).to.have.lengthOf(3);

    // Scheduler + maestro terminated exactly once each.
    const terminates = calls.filter((c) => c.kind === 'terminate');
    expect(terminates.map((c) => c.workflowId)).to.deep.equal([
      `claude-scheduler-${ensemble}`,
      `claude-maestro-${ensemble}`,
    ]);

    // Conductor destroy is the LAST workflow-mutation call — by the order the
    // tool's architect (tempo-architect) specified: peers → scheduler →
    // maestro → conductor.
    const ops = calls.filter((c) => c.kind === 'update' || c.kind === 'terminate');
    expect(ops.at(-1)!.workflowId).to.equal(`claude-session-${ensemble}-conductor`);

    // Summary message surfaces the counts.
    expect(result.content[0].text).to.include('3 destroyed');
    expect(result.content[0].text).to.include('2 terminated');
  });

  it('skips the caller even when caller is a regular session member', async function () {
    const ensemble = 'destroy-ens-self';
    const { client, calls } = makeClient({
      ensemble,
      players: ['operator', 'alice'],
      includeConductor: false,
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    await call({});

    const destroyUpdates = calls.filter((c) => c.kind === 'update' && c.name === 'destroy');
    // Only alice's workflow got destroyed — operator was self-skipped.
    expect(destroyUpdates.map((c) => c.workflowId)).to.deep.equal([
      `claude-session-${ensemble}-alice`,
    ]);
  });

  it('skips the conductor destroy when caller IS the conductor', async function () {
    const ensemble = 'destroy-ens-conductor-self';
    const { client, calls } = makeClient({
      ensemble,
      players: ['alice'],
      includeConductor: true,
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'conductor', fakeHandle),
    );
    await call({});

    // Conductor (caller) not destroyed; alice is.
    const destroyedIds = calls
      .filter((c) => c.kind === 'update' && c.name === 'destroy')
      .map((c) => c.workflowId);
    expect(destroyedIds).to.deep.equal([`claude-session-${ensemble}-alice`]);
    expect(destroyedIds).to.not.include(`claude-session-${ensemble}-conductor`);
  });

  it('single-player mode (playerId given) enqueues outbox entry via caller handle', async function () {
    const ensemble = 'destroy-single';
    const { client } = makeClient({ ensemble, players: ['alice'] });

    // The single-player branch uses the caller's `handle.executeUpdate` with
    // `submitOutboxUpdate`. Use a fresh spy handle to capture it.
    const captured: Array<{ name: string; args: unknown[] }> = [];
    const callerHandle = {
      async executeUpdate(nameOrDef: unknown, opts: { args: unknown[] }) {
        captured.push({ name: asName(nameOrDef), args: opts.args });
        return 'outbox-entry-1';
      },
    } as unknown as WorkflowHandle;

    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', callerHandle),
    );
    const result = await call({ playerId: 'alice', reason: 'cleanup' });
    expect(result.isError).to.not.equal(true);
    expect(captured).to.have.lengthOf(1);
    expect(captured[0].name).to.equal('submitOutbox');
    expect((captured[0].args[0] as any).type).to.equal('destroy');
    expect((captured[0].args[0] as any).targetPlayerId).to.equal('alice');
  });

  it('single-player mode refuses self-destroy', async function () {
    const ensemble = 'destroy-single-self';
    const { client } = makeClient({ ensemble, players: ['operator'] });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    const result = await call({ playerId: 'operator' });
    expect(result.isError).to.equal(true);
    expect(result.content[0].text).to.match(/own session/i);
  });
});
