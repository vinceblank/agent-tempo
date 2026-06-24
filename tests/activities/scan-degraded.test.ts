/**
 * #886 slice 2 — scanEnsembleSessionsCloud degraded-row behaviour.
 *
 * When extracting a workflow's observation fields throws, the OLD code
 * silently dropped the row — making a transient failure read as "player
 * absent" → roster flapping (contra #777). The new behaviour emits a DEGRADED
 * row that preserves identity (workflowId + best-effort playerId) and flags
 * `degraded: true`, so the player stays in the roster marked uncertain.
 *
 * The search-attribute getters are defensive (they return undefined rather
 * than throw on odd input), so we mock the getter module to force an
 * extraction throw for one specific workflow while the others extract cleanly.
 */
import { describe, it, expect, vi } from 'vitest';

// Force `getPart` to throw for any workflow flagged `_boom`; everything else
// extracts deterministically. Partial-mock keeps the module's real exports
// the resolver imports (sanitizeQueryValue, MEMO_KEYS, …) present.
vi.mock('../../src/utils/search-attributes', () => ({
  getAttachmentPhase: (wf: any) => wf._phase ?? 'attached',
  getSearchAttrString: (wf: any, key: string) =>
    key === 'AgentTempoPlayerId' ? wf._playerId
      : key === 'AgentTempoHostname' ? 'host-1'
        : undefined,
  getMemoString: () => 'memo-val',
  getWorkflowMetaString: () => undefined,
  getIsConductor: () => false,
  getPlayerType: () => 'tempo-soloist',
  getPart: (wf: any) => {
    if (wf._boom) throw new Error('extraction boom');
    return 'a part';
  },
  sanitizeQueryValue: (s: string) => s,
  MEMO_KEYS: { workDir: 'wd', gitRoot: 'gr', gitBranch: 'gb', agentType: 'at' },
}));

import { scanEnsembleSessionsCloud } from '../../src/activities/resolve';

function makeClient(workflows: any[]) {
  async function* gen() {
    for (const wf of workflows) yield wf;
  }
  return {
    workflow: {
      list: () => gen(),
      // BPM getActivityState query — return a stable shape so healthy rows get
      // their tempo fields; irrelevant to the degraded assertion.
      getHandle: () => ({ query: async () => ({ activityCount: 1, lastActivityAt: 'now' }) }),
    },
  } as any;
}

describe('#886 scanEnsembleSessionsCloud degraded rows', () => {
  it('emits a degraded row (preserving identity) instead of dropping on extraction failure', async () => {
    const healthy = { workflowId: 'agent-session-ens-alice', _playerId: 'alice' };
    const broken = { workflowId: 'agent-session-ens-bob', _playerId: 'bob', _boom: true };
    const logs: string[] = [];

    const rows = await scanEnsembleSessionsCloud(
      makeClient([healthy, broken]),
      'ens',
      (...a) => logs.push(a.join(' ')),
    );

    // Both players present — the broken one was NOT dropped (anti-flap).
    expect(rows.map((r) => r.playerId).sort()).toEqual(['alice', 'bob']);

    const aliceRow = rows.find((r) => r.playerId === 'alice')!;
    expect(aliceRow.degraded).toBeFalsy();
    expect(aliceRow.part).toBe('a part');

    const bobRow = rows.find((r) => r.playerId === 'bob')!;
    expect(bobRow.degraded).toBe(true);
    // Identity preserved (real playerId, not re-keyed on workflowId → no churn).
    expect(bobRow.playerId).toBe('bob');
    expect(bobRow.workflowId).toBe('agent-session-ens-bob');
    // Non-identity fields are best-effort blanks.
    expect(bobRow.part).toBe('');
    expect(bobRow.hostname).toBe('');
    // A degraded row is logged (named, not silent).
    expect(logs.some((l) => l.includes('degraded row') && l.includes('agent-session-ens-bob'))).toBe(true);
  });

  it('a fully healthy scan flags no rows degraded', async () => {
    const rows = await scanEnsembleSessionsCloud(
      makeClient([
        { workflowId: 'agent-session-ens-a', _playerId: 'a' },
        { workflowId: 'agent-session-ens-b', _playerId: 'b' },
      ]),
      'ens',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.degraded)).toBe(true);
  });

  it('salvages playerId from the workflowId when even that getter throws', async () => {
    // A workflow whose _playerId is undefined AND getPart throws: the salvage
    // falls back to the workflowId, and the row is still emitted (never dropped).
    const broken = { workflowId: 'agent-session-ens-ghost', _playerId: undefined, _boom: true };
    const rows = await scanEnsembleSessionsCloud(makeClient([broken]), 'ens');
    expect(rows).toHaveLength(1);
    expect(rows[0].degraded).toBe(true);
    expect(rows[0].playerId).toBe('agent-session-ens-ghost');
  });
});
