/**
 * #752 — cue/broadcast suspension warnings (B4c "make pause/hold LOUD").
 *
 * Motivating incident: a fresh post-crash ensemble came up paused; every
 * `cue` reported plain success; the messages sat in the senders' outboxes
 * for ~5h. These tests lock down the new behavior:
 *
 *  - paused ensemble / paused-held sender / paused-held target → the cue
 *    still SUBMITS (the outbox entry is durable) but the response says
 *    "queued", carries the ⚠ SUSPENDED warning, and names the resume verb.
 *  - broadcast checks the ensemble + SENDER axes only (no 2N per-target
 *    fan-out) and appends the same warning.
 *  - fully unsuspended → byte-identical legacy success line (no noise).
 *
 * Harness mirrors cue-detached-detection.test.ts: `queryHandleWithTimeout`
 * is stubbed with a per-query-name dispatch so the REAL suspension logic
 * runs against fake flags.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';

vi.mock('../../src/tools/resolve', () => ({
  resolveSession: vi.fn(),
}));
vi.mock('../../src/utils/query-timeout', () => ({
  queryHandleWithTimeout: vi.fn(),
}));
vi.mock('../../src/activities/resolve', () => ({
  scanEnsembleSessions: vi.fn().mockResolvedValue([]),
}));

import { renderToMcp } from '../../src/tools/descriptor';
import { buildCueTool } from '../../src/tools/cue';
import { buildBroadcastTool } from '../../src/tools/broadcast';
import { resolveSession } from '../../src/tools/resolve';
import { queryHandleWithTimeout } from '../../src/utils/query-timeout';
import type { Config } from '../../src/config';

const resolveSessionMock = vi.mocked(resolveSession);
const queryMock = vi.mocked(queryHandleWithTimeout);

// ── Harness ───────────────────────────────────────────────────────────

type CapturedHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

const fakeTargetHandle = { workflowId: 'wf-target' } as unknown as WorkflowHandle;

/**
 * Per-(workflowId, queryName) flag table consumed by BOTH query surfaces:
 * the mocked `queryHandleWithTimeout` (cue phase preflight + #752 suspension
 * preflight) and the raw `handle.query` (broadcast's `getMetadata` scan).
 * Missing entries throw — matching a missing maestro hub / pre-pause build.
 */
type FlagTable = Record<string, Record<string, unknown>>;

let currentFlags: FlagTable = {};

function dispatchQuery(workflowId: string, queryDef: unknown): unknown {
  const name = typeof queryDef === 'string' ? queryDef : (queryDef as { name: string }).name;
  const perWorkflow = currentFlags[workflowId];
  if (!perWorkflow || !(name in perWorkflow)) {
    throw new Error(`no stub for ${workflowId}/${name}`);
  }
  return perWorkflow[name];
}

function installFlags(flags: FlagTable): void {
  currentFlags = flags;
  queryMock.mockImplementation(
    async (handle: WorkflowHandle, queryDef: unknown) => dispatchQuery(handle.workflowId, queryDef),
  );
}

/** Flags for a fully live, unsuspended world. */
function liveFlags(overrides: FlagTable = {}): FlagTable {
  return {
    'wf-self': { paused: false, outboxLocked: false },
    'wf-target': {
      attachmentInfo: { phase: 'awaiting', inFlightCount: 0 },
      paused: false,
      outboxLocked: false,
    },
    'agent-maestro-test-ensemble': { maestroPaused: false },
    ...overrides,
  };
}

function buildHarness(tool: 'cue' | 'broadcast'): {
  call: CapturedHandler;
  executeUpdate: ReturnType<typeof vi.fn>;
} {
  const executeUpdate = vi.fn(async () => 'outbox-entry-id-test');
  const ownHandle = { workflowId: 'wf-self', executeUpdate } as unknown as WorkflowHandle;

  let captured: CapturedHandler | undefined;
  const fakeServer = {
    tool: (_n: unknown, _d: unknown, _s: unknown, handler: CapturedHandler) => {
      captured = handler;
    },
  } as unknown as McpServer;

  const fakeClient = {
    workflow: {
      getHandle: (id: string) =>
        ({
          workflowId: id,
          // Raw query surface used by broadcast's `getMetadata` scan.
          query: async (queryDef: unknown) => dispatchQuery(id, queryDef),
        }) as unknown as WorkflowHandle,
      // broadcast's target scan — one live target. The phase SA must be a
      // live phase or `shouldIncludeInBroadcast` filters it out.
      list: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            workflowId: 'wf-target',
            searchAttributes: { AgentTempoAttachmentState: ['awaiting'] },
          };
        },
      }),
    },
  } as unknown as Client;
  const fakeConfig: Config = { ensemble: 'test-ensemble' } as Config;

  const descriptor = tool === 'cue'
    ? buildCueTool(fakeClient, fakeConfig, () => 'cue-sender', ownHandle)
    : buildBroadcastTool(fakeClient, fakeConfig, () => 'cue-sender', ownHandle);
  renderToMcp(fakeServer, [descriptor]);

  if (!captured) throw new Error(`${tool} did not register a handler`);
  return { call: captured, executeUpdate };
}

beforeEach(() => {
  resolveSessionMock.mockReset();
  queryMock.mockReset();
  resolveSessionMock.mockResolvedValue(fakeTargetHandle);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── cue ───────────────────────────────────────────────────────────────

describe('cue suspension warning (#752)', () => {
  it('unsuspended → legacy success line, no warning', async () => {
    installFlags(liveFlags());

    const { call, executeUpdate } = buildHarness('cue');
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Message sent to tempo-eng. (outbox: outbox-entry-id-test)');
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('ensemble paused → cue still submits, response says queued + names play/release', async () => {
    installFlags(liveFlags({ 'agent-maestro-test-ensemble': { maestroPaused: true } }));

    const { call, executeUpdate } = buildHarness('cue');
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(result.isError).toBeFalsy();
    // The entry IS queued — suspension must never block the submit.
    expect(executeUpdate).toHaveBeenCalledTimes(1);
    const text = result.content[0].text;
    expect(text).toContain('queued');
    expect(text).toContain('⚠ SUSPENDED');
    expect(text).toContain('the ensemble is PAUSED');
    expect(text).toContain('deliver');
    expect(text).toContain('`play`');
    expect(text).toContain('release: true');
  });

  it('held sender (warm hold) → warning names the sender hold', async () => {
    installFlags(liveFlags({ 'wf-self': { paused: false, outboxLocked: true } }));

    const { call, executeUpdate } = buildHarness('cue');
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(executeUpdate).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('your session is HELD');
  });

  it('paused/held target → warning names the target', async () => {
    installFlags(liveFlags({
      'wf-target': {
        attachmentInfo: { phase: 'awaiting', inFlightCount: 0 },
        paused: false,
        outboxLocked: true,
      },
    }));

    const { call, executeUpdate } = buildHarness('cue');
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(executeUpdate).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('"tempo-eng" is HELD');
  });

  it('suspension query failures → silent fallthrough to the legacy success line', async () => {
    // Phase preflight succeeds; every suspension query throws (missing
    // maestro hub, pre-pause-era workflows). No warning, no error.
    installFlags({
      'wf-target': { attachmentInfo: { phase: 'awaiting', inFlightCount: 0 } },
    });

    const { call, executeUpdate } = buildHarness('cue');
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Message sent to tempo-eng. (outbox: outbox-entry-id-test)');
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── broadcast ─────────────────────────────────────────────────────────

describe('broadcast suspension warning (#752)', () => {
  /** Metadata the broadcast target scan reads via the raw `getMetadata` query. */
  function broadcastFlags(overrides: FlagTable = {}): FlagTable {
    return liveFlags({
      'wf-target': {
        getMetadata: { ensemble: 'test-ensemble', playerId: 'tempo-eng' },
      },
      ...overrides,
    });
  }

  it('unsuspended → legacy success line, no warning', async () => {
    installFlags(broadcastFlags());

    const { call, executeUpdate } = buildHarness('broadcast');
    const result = await call({ message: 'all hands' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Broadcast sent to 1 player: tempo-eng');
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('ensemble paused → fan-out still submits + warning appended', async () => {
    installFlags(broadcastFlags({ 'agent-maestro-test-ensemble': { maestroPaused: true } }));

    const { call, executeUpdate } = buildHarness('broadcast');
    const result = await call({ message: 'all hands' });

    expect(result.isError).toBeFalsy();
    expect(executeUpdate).toHaveBeenCalledTimes(1);
    const text = result.content[0].text;
    expect(text).toContain('Broadcast sent to 1 player');
    expect(text).toContain('⚠ SUSPENDED');
    expect(text).toContain('the ensemble is PAUSED');
    expect(text).toContain('release: true');
  });
});
