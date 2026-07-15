/**
 * P0 restore/restart fix (2026-07-15 incident) — the headless maestro session
 * (`agent-session-{e}-maestro`) is the outbox host for TempoClient's
 * cross-workflow verbs (restart/reset/detach/release/recruit/destroy). It was
 * historically created by the TUI (deleted in #789) and later by only SOME
 * daemon HTTP routes, and even then self-reaps after its 24h
 * `workflowExecutionTimeout` — so `restore` and `restart` (both documented
 * recovery paths) failed with `workflow not found for ID:
 * agent-session-{e}-maestro` on any ensemble whose maestro session was never
 * (re)created.
 *
 * These tests pin the fix: every maestro-hosted submit self-heals by calling
 * `ensureMaestroSession` and retrying ONCE when the maestro session is gone,
 * and the ensure path mints the CORRECT id templates (`agent-session-{e}-maestro`
 * for the session host, `agent-maestro-{e}` for the hub).
 */
import { describe, it, expect } from 'vitest';
import { createTempoClient } from '../../src/client';
import { isWorkflowGoneError } from '../../src/client/core';

const asName = (nameOrDef: unknown): string =>
  typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

/** The SDK's WorkflowNotFoundError shape, without importing the class. */
function workflowNotFound(workflowId: string): Error {
  const err = new Error(`workflow not found for ID: ${workflowId}`);
  err.name = 'WorkflowNotFoundError';
  return err;
}

/**
 * Fake Temporal Client modeling the incident: the maestro session does NOT
 * exist until `workflow.start('agentSessionWorkflow', {workflowId:
 * agent-session-{e}-maestro})` is called; before that, every `executeUpdate`
 * against it rejects exactly like the live repro.
 */
function makeClient(ensemble: string, opts: { maestroExists?: boolean } = {}) {
  const entries: Array<{ name: string; args: unknown }> = [];
  const starts: Array<{ workflowType: string; workflowId: string }> = [];
  let maestroExists = opts.maestroExists ?? false;
  const maestroId = `agent-session-${ensemble}-maestro`;

  const maestroHandle = {
    workflowId: maestroId,
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      if (!maestroExists) throw workflowNotFound(maestroId);
      entries.push({ name: asName(nameOrDef), args: updateOpts.args[0] });
      return `entry-${entries.length}`;
    },
    async signal() { /* noop */ },
  };

  const sessionHandle = {
    async query() { return undefined; },
    async signal() { /* noop */ },
    async executeUpdate() { /* noop */ },
    async describe() { return { status: { name: 'RUNNING' } }; },
  };

  const client = {
    workflow: {
      getHandle(workflowId: string) {
        if (workflowId === maestroId) return maestroHandle;
        return sessionHandle;
      },
      async start(workflowType: string, startOpts: { workflowId: string }) {
        starts.push({ workflowType, workflowId: startOpts.workflowId });
        if (workflowType === 'agentSessionWorkflow' && startOpts.workflowId === maestroId) {
          maestroExists = true;
        }
        return { workflowId: startOpts.workflowId };
      },
      async *list() { /* no sessions */ },
    },
  };

  return { client, entries, starts };
}

describe('maestro-session self-heal (P0 restore/restart fix)', () => {
  it('restart() creates the missing maestro session and succeeds (the restore/restart incident repro)', async () => {
    const { client, entries, starts } = makeClient('cll');
    const tempo = createTempoClient(client as any);

    const result = await tempo.restart('cll', 'cll-security', { invokerPlayerId: 'daemon' });

    expect(result.entryId).toBe('entry-1');
    expect(entries).toHaveLength(1);
    expect((entries[0].args as any).type).toBe('restart');
    expect((entries[0].args as any).targetPlayerId).toBe('cll-security');

    // Pin the id templates: the SESSION-template id hosts the outbox…
    const sessionStart = starts.find((s) => s.workflowType === 'agentSessionWorkflow');
    expect(sessionStart?.workflowId).toBe('agent-session-cll-maestro');
    // …and the ensure ALSO brings up the per-ensemble hub with the
    // MAESTRO-template id (the workflow `temporal workflow list` shows).
    const hubStart = starts.find((s) => s.workflowType === 'agentMaestroWorkflow');
    expect(hubStart?.workflowId).toBe('agent-maestro-cll');
  });

  it('does not re-ensure on the fast path (maestro session already exists)', async () => {
    const { client, entries, starts } = makeClient('e1', { maestroExists: true });
    const tempo = createTempoClient(client as any);

    await tempo.restart('e1', 'alice');

    expect(entries).toHaveLength(1);
    expect(starts).toHaveLength(0); // no ensure round-trip when healthy
  });

  it('detach() and destroy(player) self-heal through the same choke point', async () => {
    const { client, entries, starts } = makeClient('e2');
    const tempo = createTempoClient(client as any);

    await tempo.detach('e2', 'bob');
    await tempo.destroy('e2', 'bob');

    expect(entries.map((e) => (e.args as any).type)).toEqual(['detach', 'destroy']);
    // Ensure ran once for the first miss; second verb hits the fast path.
    expect(starts.filter((s) => s.workflowType === 'agentSessionWorkflow')).toHaveLength(1);
  });

  it('a non-gone error propagates without triggering ensure', async () => {
    const { client, starts } = makeClient('e3', { maestroExists: true });
    const tempo = createTempoClient(client as any);
    const boom = new Error('deadline exceeded');
    (client as any).workflow.getHandle('agent-session-e3-maestro').executeUpdate = async () => {
      throw boom;
    };

    await expect(tempo.restart('e3', 'carol')).rejects.toThrow('deadline exceeded');
    expect(starts).toHaveLength(0);
  });

  it('gives up (propagates) when the maestro session is still gone after ensure', async () => {
    const { client } = makeClient('e4');
    // Sabotage: start "succeeds" but the workflow never materializes.
    (client as any).workflow.start = async (_t: string, o: { workflowId: string }) => ({ workflowId: o.workflowId });
    const tempo = createTempoClient(client as any);

    await expect(tempo.restart('e4', 'dave')).rejects.toThrow(/workflow not found/i);
  });
});

describe('isWorkflowGoneError', () => {
  it('matches the SDK error class name and both message shapes', () => {
    expect(isWorkflowGoneError(workflowNotFound('agent-session-x-maestro'))).toBe(true);
    expect(isWorkflowGoneError(new Error('workflow not found for ID: agent-session-cll-maestro'))).toBe(true);
    expect(isWorkflowGoneError(new Error('Workflow execution already completed'))).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isWorkflowGoneError(new Error('deadline exceeded'))).toBe(false);
    expect(isWorkflowGoneError(new Error('Connection refused'))).toBe(false);
    expect(isWorkflowGoneError('workflow not found')).toBe(false); // non-Error
    expect(isWorkflowGoneError(undefined)).toBe(false);
  });
});
