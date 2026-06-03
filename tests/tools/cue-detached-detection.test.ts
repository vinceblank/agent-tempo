/**
 * Unit tests for the cue tool's #562 phase pre-flight.
 *
 * Pre-fix, `cue` to a detached/gone player returned "Message sent to X.
 * (outbox: …)" — wire-truthful (the Temporal signal IS delivered to the
 * workflow inbox) but operator-misleading because no live adapter surfaces
 * the message. This test locks down the three branches per researcher's
 * Option A:
 *   - `phase=processing` (or any active phase) → success (outbox submit fires)
 *   - `phase=detached` or `phase=gone` → fail with the new error message
 *     (outbox submit NOT called)
 *   - phase query throws → fall through to outbox best-effort + stderr log
 *
 * Uses the `vi.mock` pattern established by recruit-preflight.test.ts to
 * stub the two cross-cutting helpers (`resolveSession`,
 * `queryHandleWithTimeout`) without dragging in a real Temporal client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';

// vi.mock is hoisted above imports — SUT sees stubbed modules at first import.
vi.mock('../../src/tools/resolve', () => ({
  resolveSession: vi.fn(),
}));
vi.mock('../../src/utils/query-timeout', () => ({
  queryHandleWithTimeout: vi.fn(),
}));
// #566 merged into main on top of #562, so the unknown-player branch in
// cue.ts now calls `scanEnsembleSessions` to format the actionable error.
// Stub it to a quiet empty list — this file's tests focus on the #562
// pre-flight, not on #566's message shape (covered in cue-unknown-player.test.ts).
vi.mock('../../src/activities/resolve', () => ({
  scanEnsembleSessions: vi.fn().mockResolvedValue([]),
}));

import { renderToMcp } from '../../src/tools/descriptor';
import { buildCueTool, formatDetachedDeliveryError } from '../../src/tools/cue';
import { resolveSession } from '../../src/tools/resolve';
import { queryHandleWithTimeout } from '../../src/utils/query-timeout';
import { scanEnsembleSessions } from '../../src/activities/resolve';
import type { Config } from '../../src/config';
import type { AttachmentInfo } from '../../src/types';

const resolveSessionMock = vi.mocked(resolveSession);
const queryMock = vi.mocked(queryHandleWithTimeout);
const scanMock = vi.mocked(scanEnsembleSessions);

// ── Harness ───────────────────────────────────────────────────────────

type CapturedHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

function captureTool(): {
  call: CapturedHandler;
  executeUpdate: ReturnType<typeof vi.fn>;
} {
  const executeUpdate = vi.fn(async () => 'outbox-entry-id-test');
  const ownHandle = { executeUpdate } as unknown as WorkflowHandle;

  let captured: CapturedHandler | undefined;
  const fakeServer = {
    tool: (_name: unknown, _desc: unknown, _schema: unknown, handler: CapturedHandler) => {
      captured = handler;
    },
  } as unknown as McpServer;

  const fakeClient = {} as Client;
  const fakeConfig: Config = { ensemble: 'test-ensemble' } as Config;

  renderToMcp(fakeServer, [buildCueTool(fakeClient, fakeConfig, () => 'cue-sender', ownHandle)]);

  if (!captured) throw new Error('cue did not register a handler');
  return { call: captured, executeUpdate };
}

/** Build a fake "target" workflow handle — only needed for identity. */
const fakeTargetHandle = { workflowId: 'fake-target' } as unknown as WorkflowHandle;

beforeEach(() => {
  resolveSessionMock.mockReset();
  queryMock.mockReset();
  scanMock.mockReset();
  scanMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('cue phase pre-flight (#562)', () => {
  it('success path: active phase → outbox submit fires', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'processing', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'tempo-eng', message: 'hello' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Message sent to tempo-eng');
    expect(result.content[0].text).toContain('outbox: outbox-entry-id-test');
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('success path: attached phase → outbox submit fires', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'attached', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'tempo-eng', message: 'hi' });

    expect(result.isError).toBeFalsy();
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('success path: awaiting phase → outbox submit fires (live but idle)', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'awaiting', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'tempo-eng', message: 'hi' });

    expect(result.isError).toBeFalsy();
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('success path: draining phase → outbox submit fires (mid-shutdown is brief)', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'draining', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'tempo-eng', message: 'hi' });

    // Per #562 design: draining is NOT in UNDELIVERABLE_PHASES (false-positives
    // during normal teardown), so the cue goes through.
    expect(result.isError).toBeFalsy();
    expect(executeUpdate).toHaveBeenCalledTimes(1);
  });

  it('fail path: detached phase → error returned, outbox NOT submitted', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'detached', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'detached-player', message: 'are you there?' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('detached-player');
    expect(result.content[0].text).toContain("'detached'");
    expect(result.content[0].text).toContain('NOT delivered');
    expect(result.content[0].text).toContain('recall');
    expect(result.content[0].text).toContain('restart');
    expect(result.content[0].text).toContain('auto-deliver');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('fail path: gone phase → error returned, outbox NOT submitted', async () => {
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockResolvedValue({ phase: 'gone', inFlightCount: 0 } as AttachmentInfo);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'gone-player', message: 'rip' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'gone'");
    expect(result.content[0].text).toContain('NOT delivered');
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it('fallthrough path: query throws → outbox submit fires best-effort, stderr logged', async () => {
    // Simulate worker wedge: queryHandleWithTimeout throws (QueryTimeoutError
    // in production; any error here for testability).
    resolveSessionMock.mockResolvedValue(fakeTargetHandle);
    queryMock.mockRejectedValue(new Error('Temporal query timed out after 1000ms'));

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'wedged-player', message: 'hello' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Message sent to wedged-player');
    expect(executeUpdate).toHaveBeenCalledTimes(1);

    // Stderr log emitted with the player id + the underlying error message.
    expect(stderrSpy).toHaveBeenCalled();
    const stderrCall = stderrSpy.mock.calls[0].join(' ');
    expect(stderrCall).toContain('[agent-tempo:cue]');
    expect(stderrCall).toContain('wedged-player');
    expect(stderrCall).toContain('timed out');

    stderrSpy.mockRestore();
  });

  it('null resolveSession flows through #566 unknown-player error (NOT the #562 phase path)', async () => {
    // After #566 merged on top of #562, the null-resolveSession branch
    // routes through `formatUnknownPlayerError` (which calls
    // `scanEnsembleSessions`). The #562 phase pre-flight must NOT fire
    // in this branch — verified via `queryMock`.
    resolveSessionMock.mockResolvedValue(null);

    const { call, executeUpdate } = captureTool();
    const result = await call({ playerId: 'phantom', message: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not registered');
    expect(scanMock).toHaveBeenCalledTimes(1);
    // Phase query never runs when resolution failed.
    expect(queryMock).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
  });
});

describe('formatDetachedDeliveryError', () => {
  it('names the player and the offending phase', () => {
    const msg = formatDetachedDeliveryError('alice', 'detached');
    expect(msg).toContain('"alice"');
    expect(msg).toContain("'detached'");
  });

  it('includes all three recovery options (AC #3 from #562 body)', () => {
    const msg = formatDetachedDeliveryError('alice', 'gone');
    expect(msg).toContain('recall');
    expect(msg).toContain('restart');
    expect(msg).toContain('auto-deliver');
  });

  it('says "NOT delivered" so the operator sees the wire-vs-visible distinction', () => {
    const msg = formatDetachedDeliveryError('alice', 'detached');
    expect(msg).toContain('NOT delivered');
  });
});
