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
import { registerPauseTool } from '../src/tools/pause';

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
  /** Workflow IDs whose `.signal()` should throw (simulates RPC failure). */
  failOnSignal?: Set<string>;
}) {
  const { ensemble, players, includeConductor = false } = opts;
  const hasScheduler = opts.hasScheduler ?? true;
  const hasMaestroHub = opts.hasMaestroHub ?? true;
  const failOnUpdate = opts.failOnUpdate ?? new Set<string>();
  const failOnSignal = opts.failOnSignal ?? new Set<string>();

  const calls: Call[] = [];
  const sessionIds: Array<{ workflowId: string; playerId: string; isConductor: boolean }> =
    players.map((p) => ({
      workflowId: `agent-session-${ensemble}-${p}`,
      playerId: p,
      isConductor: false,
    }));
  if (includeConductor) {
    sessionIds.push({
      workflowId: `agent-session-${ensemble}-conductor`,
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
      if (failOnSignal.has(workflowId)) throw new Error(`signal to ${workflowId} failed`);
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
        if (!hasScheduler && workflowId === `agent-scheduler-${ensemble}`) {
          return {
            workflowId,
            async signal() { throw new Error('workflow not found'); },
            async terminate() { throw new Error('workflow not found'); },
            async executeUpdate() { throw new Error('workflow not found'); },
          };
        }
        if (!hasMaestroHub && workflowId === `agent-maestro-${ensemble}`) {
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
  taskQueue: 'agent-tempo',
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
    expect(detachTargets).to.deep.equal([`agent-session-${ensemble}-alice`]);
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

  // INVARIANT (QA #306 review): `restore` always unpauses ALL sessions —
  // including ones a user deliberately paused via `/pause` (or any other
  // setPaused=true path). The "always unpause" contract is intentional UX:
  // restoring a parked ensemble means waking it up wholesale, never
  // partially. If a future change wants smarter logic — e.g. "remember
  // which sessions were user-paused before shutdown and skip those on
  // restore" — flip the behavior AND this test together. Don't loosen
  // this assertion without explicitly updating the contract.
  it('always unpauses ALL sessions, even ones previously paused by the user', async function () {
    const ensemble = 'restore-unpause-invariant';
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
        players: ['alice', 'bob', 'charlie'],
        includeConductor: true,
      });

      // Simulate a "user paused alice deliberately" setup: pre-record a
      // setPaused=true signal for alice on the call log. The fake client
      // doesn't track paused state across calls — what we're locking in is
      // that `restore` ALWAYS sends setPaused=false to every session,
      // regardless of whatever paused-true history precedes it.
      const aliceWfId = `agent-session-${ensemble}-alice`;
      await client.workflow.getHandle(aliceWfId).signal('setPaused', true);

      // Sanity: the pre-pause was recorded.
      expect(calls.filter((c) => c.name === 'setPaused' && c.payload === true)).to.have.lengthOf(1);

      // Now restore.
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({});
      expect(result.isError).to.not.equal(true);

      // Every session — alice (deliberately paused) + bob + charlie +
      // conductor = 4 — gets setPaused=false. The deliberately-paused
      // alice is NOT exempted.
      const setPausedFalse = calls.filter(
        (c) => c.kind === 'signal' && c.name === 'setPaused' && c.payload === false,
      );
      expect(setPausedFalse).to.have.lengthOf(4);
      expect(setPausedFalse.map((c) => c.workflowId)).to.have.members([
        `agent-session-${ensemble}-alice`,
        `agent-session-${ensemble}-bob`,
        `agent-session-${ensemble}-charlie`,
        `agent-session-${ensemble}-conductor`,
      ]);

      // Ordering invariant: the unpause to alice must come AFTER the
      // user's deliberate pause — restore overrides, doesn't merge.
      const idxPause = calls.findIndex(
        (c) => c.workflowId === aliceWfId && c.name === 'setPaused' && c.payload === true,
      );
      const idxUnpause = calls.findIndex(
        (c) => c.workflowId === aliceWfId && c.name === 'setPaused' && c.payload === false,
      );
      expect(idxPause).to.be.greaterThan(-1);
      expect(idxUnpause).to.be.greaterThan(idxPause);
    } finally {
      (orphansModule as any).restoreOrphansOnce = originalFn;
    }
  });

  // #306 follow-up (regression risk #2 from the holistic review):
  // cross-host restore. The MCP tool runs inside the daemon worker; if
  // the operator's daemon is on host A but the parked sessions' workflows
  // were attached to host B before shutdown, the visibility query
  // (`AND AgentTempoHostname = "<host>"`) needs B's hostname, not A's.
  // The tool now accepts an optional `hostname` param.
  it('forwards a custom hostname arg through to restoreOrphansOnce', async function () {
    const ensemble = 'restore-cross-host';
    const orphansModule = require('../src/reconcile/orphans') as typeof import('../src/reconcile/orphans');
    const originalFn = orphansModule.restoreOrphansOnce;
    let capturedOpts: { hostname?: string } | null = null;
    (orphansModule as any).restoreOrphansOnce = async (_c: unknown, opts: { hostname?: string }) => {
      capturedOpts = opts;
      return { reattached: 0, skipped: 0, failed: 0, details: [] };
    };

    try {
      const { client } = makeClient({ ensemble, players: [] });
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({ hostname: 'remote-host-b' });
      expect(result.isError).to.not.equal(true);

      // The custom hostname is what reached restoreOrphansOnce.
      expect(capturedOpts).to.not.equal(null);
      expect(capturedOpts!.hostname).to.equal('remote-host-b');

      // The headline surfaces the explicit host so the user can see it
      // wasn't a default-host scan.
      expect(result.content[0].text).to.include('(host: remote-host-b)');
    } finally {
      (orphansModule as any).restoreOrphansOnce = originalFn;
    }
  });

  it('omitted hostname defaults to the local OS hostname (preserves prior behavior)', async function () {
    const ensemble = 'restore-default-host';
    const orphansModule = require('../src/reconcile/orphans') as typeof import('../src/reconcile/orphans');
    const originalFn = orphansModule.restoreOrphansOnce;
    let capturedOpts: { hostname?: string } | null = null;
    (orphansModule as any).restoreOrphansOnce = async (_c: unknown, opts: { hostname?: string }) => {
      capturedOpts = opts;
      return { reattached: 0, skipped: 0, failed: 0, details: [] };
    };

    try {
      const { client } = makeClient({ ensemble, players: [] });
      const call = extractHandler((server) =>
        registerRestoreTool(server, client, testConfig(ensemble), () => 'operator'),
      );
      const result = await call({});
      expect(result.isError).to.not.equal(true);

      // Default = `os.hostname()` — the actual value depends on the
      // machine, so we just assert it's a non-empty string.
      expect(capturedOpts!.hostname).to.be.a('string');
      expect((capturedOpts!.hostname as string).length).to.be.greaterThan(0);

      // The headline does NOT show "(host: ...)" when default — preserves
      // the original output shape for callers that don't pass the param.
      expect(result.content[0].text).to.not.include('(host:');
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
      `agent-scheduler-${ensemble}`,
      `agent-maestro-${ensemble}`,
    ]);

    // Conductor destroy is the LAST workflow-mutation call — by the order the
    // tool's architect (tempo-architect) specified: peers → scheduler →
    // maestro → conductor.
    const ops = calls.filter((c) => c.kind === 'update' || c.kind === 'terminate');
    expect(ops.at(-1)!.workflowId).to.equal(`agent-session-${ensemble}-conductor`);

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
      `agent-session-${ensemble}-alice`,
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
    expect(destroyedIds).to.deep.equal([`agent-session-${ensemble}-alice`]);
    expect(destroyedIds).to.not.include(`agent-session-${ensemble}-conductor`);
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

  // #306: a buggy caller passing `{playerId: ""}` must NOT silently fall
  // through to ensemble-wide destroy mode. The Zod schema (`.min(1)`)
  // catches normal MCP traffic; the handler guard catches programmatic
  // callers that bypass Zod (e.g. this test harness, which captures the
  // raw handler closure without running schema validation).
  it('rejects empty-string playerId with a clear error', async function () {
    const ensemble = 'destroy-empty-playerid';
    const { client, calls } = makeClient({
      ensemble,
      players: ['alice', 'bob'],
      includeConductor: true,
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    const result = await call({ playerId: '' });
    expect(result.isError).to.equal(true);
    expect(result.content[0].text).to.match(/empty string/i);

    // Critical: NO destroy / terminate calls landed. An empty-string
    // playerId must NEVER be treated as ensemble-wide destroy.
    expect(calls.filter((c) => c.kind === 'update' && c.name === 'destroy')).to.have.lengthOf(0);
    expect(calls.filter((c) => c.kind === 'terminate')).to.have.lengthOf(0);
  });

  // #306 follow-up (regression risk #3 from the holistic review):
  // ensemble-scope destroy uses `Promise.allSettled`, so individual peer
  // failures land as `failed` outcomes instead of throwing. The tool
  // surfaces a count, but the user has no way to know that re-running is
  // the recovery path. Pin a hint in the response message that says so.
  it('partial-failure surfaces an indeterminate-state hint and "partially destroyed" headline', async function () {
    const ensemble = 'destroy-partial-fail';
    // alice's `executeUpdate` throws — simulates an RPC failure mid-fan-out.
    const aliceWfId = `agent-session-${ensemble}-alice`;
    const { client } = makeClient({
      ensemble,
      players: ['alice', 'bob'],
      includeConductor: true,
      failOnUpdate: new Set([aliceWfId]),
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    const result = await call({});
    // The tool itself succeeds — `Promise.allSettled` doesn't throw, and
    // the partial failure is surfaced in the user-facing text instead.
    expect(result.isError).to.not.equal(true);

    const text = result.content[0].text;
    // Headline shifts from "destroyed" to "partially destroyed" so the
    // user can't miss that something didn't go cleanly.
    expect(text).to.include('partially destroyed');
    expect(text).to.not.include(`Ensemble **${ensemble}** destroyed.`);
    // Counts include the failure.
    expect(text).to.match(/\b1 failed\b/);
    // The actionable hint surfaces the slash command + ensemble name.
    expect(text).to.include('1 peer in indeterminate state');
    expect(text).to.include(`run \`/destroy ${ensemble}\``);
    expect(text).to.include('again to clean up');
    // Errors block still present so the user sees what failed.
    expect(text).to.include('alice:');
  });

  // Plural variant: when ≥2 peers fail, the hint says "peers" (not "peer").
  it('partial-failure with multiple failures pluralizes the hint correctly', async function () {
    const ensemble = 'destroy-partial-fail-many';
    const aliceWfId = `agent-session-${ensemble}-alice`;
    const bobWfId = `agent-session-${ensemble}-bob`;
    const { client } = makeClient({
      ensemble,
      players: ['alice', 'bob', 'charlie'],
      includeConductor: true,
      failOnUpdate: new Set([aliceWfId, bobWfId]),
    });
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig(ensemble), () => 'operator', fakeHandle),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('2 peers in indeterminate state');
  });
});

// ── pause tool ──────────────────────────────────────────────────────────────
//
// `pause` is the sibling of `play`, `restore`, `shutdown`, and `destroy` in
// the #287 ensemble-verb family. All four have direct coverage in this file;
// `pause` was the odd one out. Risk is low (thin wrapper over `signalAllSessions`
// + `pauseMaestroAndScheduler`) but omitting it left a gap flagged in the
// #306 holistic review. These tests mirror the pattern of `restore tool` and
// `shutdown tool` above.
//
describe('pause tool (#287)', function () {
  it('signals setPaused=true on every session and pauses maestro + scheduler', async function () {
    const ensemble = 'pause-basic';
    const { client, calls } = makeClient({ ensemble, players: ['alice', 'bob'] });
    const call = extractHandler((server) =>
      registerPauseTool(server, client, testConfig(ensemble), () => 'conductor'),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);

    // Every session receives setPaused=true.
    const setPausedTrue = calls.filter(
      (c) => c.kind === 'signal' && c.name === 'setPaused' && c.payload === true,
    );
    expect(setPausedTrue).to.have.lengthOf(2);

    // Maestro + scheduler paused.
    expect(calls.some((c) => c.name === 'maestroSetPaused' && c.payload === true)).to.equal(true);
    expect(calls.some((c) => c.name === 'setSchedulerPaused' && c.payload === true)).to.equal(true);

    // Response headline confirms the ensemble.
    expect(result.content[0].text).to.include(`Ensemble **${ensemble}** paused.`);
    expect(result.content[0].text).to.include('2 session(s) paused');
  });

  it('surfaces maestro + scheduler in the response when both are present', async function () {
    const ensemble = 'pause-bits';
    const { client } = makeClient({ ensemble, players: ['alice'] });
    const call = extractHandler((server) =>
      registerPauseTool(server, client, testConfig(ensemble), () => 'conductor'),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);
    const text = result.content[0].text;
    expect(text).to.include('maestro paused');
    expect(text).to.include('scheduler paused');
  });

  it('is best-effort when scheduler or maestro are not running', async function () {
    // Even when both infrastructure workflows are absent, the tool must not
    // throw and the session signal must still fire.
    const ensemble = 'pause-no-infra';
    const { client, calls } = makeClient({
      ensemble,
      players: ['alice'],
      hasScheduler: false,
      hasMaestroHub: false,
    });
    const call = extractHandler((server) =>
      registerPauseTool(server, client, testConfig(ensemble), () => 'conductor'),
    );
    const result = await call({});
    expect(result.isError).to.not.equal(true);

    // Session signal still dispatched.
    expect(calls.filter((c) => c.name === 'setPaused' && c.payload === true)).to.have.lengthOf(1);
    // Infra signals not present (both threw and were swallowed).
    const text = result.content[0].text;
    expect(text).to.not.include('maestro paused');
    expect(text).to.not.include('scheduler paused');
  });

  it('reports session-level errors without throwing (best-effort fan-out)', async function () {
    const ensemble = 'pause-session-fail';
    const { client } = makeClient({
      ensemble,
      players: ['alice', 'bob'],
      failOnSignal: new Set([`agent-session-${ensemble}-alice`]),
    });
    const call = extractHandler((server) =>
      registerPauseTool(server, client, testConfig(ensemble), () => 'conductor'),
    );
    const result = await call({});
    // Tool itself succeeds — allSettled absorbs individual failures.
    expect(result.isError).to.not.equal(true);
    // Errors block surfaces in the response text.
    const text = result.content[0].text;
    expect(text).to.include('Errors:');
    expect(text).to.include('alice');
    // Bob still got paused (1 session(s) paused).
    expect(text).to.include('1 session(s) paused');
  });
});
