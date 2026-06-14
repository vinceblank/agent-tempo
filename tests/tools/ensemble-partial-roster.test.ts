/**
 * #845 — the `ensemble` tool must visibly flag a PARTIAL roster when the
 * visibility scan was truncated by its wall-clock deadline (Mode A), and —
 * critically — must NOT render a truncated-but-empty scan as "No active
 * sessions found" (false-empty is the dangerous case: an operator concludes
 * the whole ensemble died and takes destructive action).
 *
 * We mock `scanEnsembleSessionsWithStatus` to drive the truncation flag
 * directly — the scan internals (iterateWithDeadline's deadline throw) are
 * unit-tested separately in tests/utils/visibility-deadline.test.ts; here we
 * assert the TOOL's consumer behavior on the `{ truncated }` signal.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/activities/resolve', async (importActual) => {
  const actual = await importActual<typeof import('../../src/activities/resolve')>();
  return { ...actual, scanEnsembleSessionsWithStatus: vi.fn() };
});

import { buildEnsembleTool } from '../../src/tools/ensemble';
import { scanEnsembleSessionsWithStatus, type EnsembleSessionInfo } from '../../src/activities/resolve';

const mockScan = scanEnsembleSessionsWithStatus as unknown as ReturnType<typeof vi.fn>;

/** Client whose maestro query rejects → checkSuspension soft-fails (no banner). */
function fakeClient() {
  return {
    workflow: {
      getHandle: () => ({ query: async () => { throw new Error('no maestro'); } }),
    },
  } as any;
}

function makeTool() {
  return buildEnsembleTool(fakeClient(), { ensemble: 'tempo-impl' } as any, () => 'me', 'own-wf');
}

const activeSession: EnsembleSessionInfo = {
  workflowId: 'agent-session-tempo-impl-alice',
  playerId: 'alice',
  part: 'coding',
  hostname: 'h1',
  workDir: '/w',
  isConductor: false,
  agentType: 'claude',
  // phase undefined → classifyDormancy → 'active'
};

describe('ensemble tool — partial-roster banner (#845)', () => {
  it('truncated + EMPTY → partial banner, NOT "No active sessions found"', async () => {
    mockScan.mockResolvedValue({ sessions: [], truncated: true, scanned: 0 });
    const { text } = await makeTool().handler({});
    expect(text).toContain('⚠ partial roster');
    expect(text).not.toContain('No active sessions found');
  });

  it('truncated + non-empty → partial banner leads, summary still rendered', async () => {
    mockScan.mockResolvedValue({ sessions: [activeSession], truncated: true, scanned: 1 });
    const { text } = await makeTool().handler({});
    expect(text).toContain('⚠ partial roster');
    expect(text).toContain('1 active'); // summary line still present
    expect(text).toContain('alice');
    // Banner precedes the roster summary so it can't be missed.
    expect(text.indexOf('⚠ partial roster')).toBeLessThan(text.indexOf('1 active'));
  });

  it('NOT truncated + empty → clean "No active sessions found", no false banner', async () => {
    mockScan.mockResolvedValue({ sessions: [], truncated: false, scanned: 5 });
    const { text } = await makeTool().handler({});
    expect(text).toContain('No active sessions found');
    expect(text).not.toContain('⚠ partial roster');
  });

  it('NOT truncated + populated → no partial banner', async () => {
    mockScan.mockResolvedValue({ sessions: [activeSession], truncated: false, scanned: 1 });
    const { text } = await makeTool().handler({});
    expect(text).not.toContain('⚠ partial roster');
    expect(text).toContain('1 active');
  });
});
