/**
 * Unit tests for the #752 suspension preflight + formatters
 * (`src/utils/suspension.ts`) — B4c of the temporal-cost-rearchitecture
 * design doc. Locks down:
 *
 *  - `checkSuspension` reads the three axes (maestro paused, session paused,
 *    session held) via bounded queries and soft-fails EVERY failure mode to
 *    "not suspended" — including a client with no workflow service at all.
 *  - `formatSuspensionWarning` says the message IS queued, WILL deliver on
 *    resume, and names the resume verb (`play` / `release: true`) — the
 *    issue's acceptance wording.
 *  - `formatSuspensionBanner` emits one ⏸ line per active axis and is null
 *    when nothing is suspended (no banner noise on healthy ensembles).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client, WorkflowHandle } from '@temporalio/client';

vi.mock('../../src/utils/query-timeout', () => ({
  queryHandleWithTimeout: vi.fn(),
}));

import { queryHandleWithTimeout } from '../../src/utils/query-timeout';
import {
  checkSuspension,
  describeSuspensionCauses,
  formatSuspensionWarning,
  formatSuspensionBanner,
  type SuspensionState,
} from '../../src/utils/suspension';

const queryMock = vi.mocked(queryHandleWithTimeout);

/** Dispatch the mocked query by (workflowId, queryName). */
function mockFlags(flags: Record<string, Record<string, boolean>>): void {
  queryMock.mockImplementation(async (handle: WorkflowHandle, queryDef: unknown) => {
    const name = typeof queryDef === 'string' ? queryDef : (queryDef as { name: string }).name;
    const perWorkflow = flags[handle.workflowId];
    if (!perWorkflow || !(name in perWorkflow)) {
      throw new Error(`no stub for ${handle.workflowId}/${name}`);
    }
    return perWorkflow[name];
  });
}

function fakeHandle(workflowId: string): WorkflowHandle {
  return { workflowId } as unknown as WorkflowHandle;
}

/** Client whose getHandle returns an identity-only handle (queries are mocked). */
const fakeClient = {
  workflow: { getHandle: (id: string) => fakeHandle(id) },
} as unknown as Client;

const CLEAN: SuspensionState = { ensemblePaused: false, self: { paused: false, held: false } };

beforeEach(() => {
  queryMock.mockReset();
});

describe('checkSuspension (#752)', () => {
  it('reads maestro paused + self paused/held + target paused/held', async () => {
    mockFlags({
      'agent-maestro-jam': { maestroPaused: true },
      'wf-self': { paused: true, outboxLocked: false },
      'wf-target': { paused: false, outboxLocked: true },
    });

    const state = await checkSuspension(fakeClient, 'jam', {
      self: fakeHandle('wf-self'),
      target: fakeHandle('wf-target'),
    });

    expect(state.ensemblePaused).toBe(true);
    expect(state.self).toEqual({ paused: true, held: false });
    expect(state.target).toEqual({ paused: false, held: true });
  });

  it('omits target when no target handle is passed', async () => {
    mockFlags({
      'agent-maestro-jam': { maestroPaused: false },
      'wf-self': { paused: false, outboxLocked: false },
    });

    const state = await checkSuspension(fakeClient, 'jam', { self: fakeHandle('wf-self') });
    expect(state.target).toBeUndefined();
    expect(describeSuspensionCauses(state)).toEqual([]);
  });

  it('soft-fails every query failure to "not suspended"', async () => {
    queryMock.mockRejectedValue(new Error('worker wedged'));

    const state = await checkSuspension(fakeClient, 'jam', {
      self: fakeHandle('wf-self'),
      target: fakeHandle('wf-target'),
    });

    expect(state).toEqual({
      ensemblePaused: false,
      self: { paused: false, held: false },
      target: { paused: false, held: false },
    });
  });

  it('soft-fails a client without a workflow service (bare test stub)', async () => {
    const state = await checkSuspension({} as Client, 'jam', { self: fakeHandle('wf-self') });
    expect(state).toEqual(CLEAN);
  });

  it('treats non-boolean query results as "not suspended"', async () => {
    // Defensive: an old/foreign workflow answering the query name with a
    // non-boolean payload must not light the banner.
    queryMock.mockResolvedValue({ unexpected: 'shape' });
    const state = await checkSuspension(fakeClient, 'jam', { self: fakeHandle('wf-self') });
    expect(describeSuspensionCauses(state)).toEqual([]);
  });
});

describe('describeSuspensionCauses — every axis is loud', () => {
  it('empty on the clean state', () => {
    expect(describeSuspensionCauses(CLEAN)).toEqual([]);
  });

  it.each([
    [{ ...CLEAN, ensemblePaused: true }],
    [{ ...CLEAN, self: { paused: true, held: false } }],
    [{ ...CLEAN, self: { paused: false, held: true } }],
    [{ ...CLEAN, target: { paused: true, held: false } }],
    [{ ...CLEAN, target: { paused: false, held: true } }],
  ] as const)('non-empty when any single axis is set: %j', (state) => {
    expect(describeSuspensionCauses(state as SuspensionState).length).toBeGreaterThan(0);
  });
});

describe('describeSuspensionCauses', () => {
  it('suppresses redundant per-session paused phrasing when the ensemble is paused', () => {
    // Ensemble pause fans setPaused to every session — repeating "your
    // session is paused" under an ensemble-paused headline is noise.
    const causes = describeSuspensionCauses({
      ensemblePaused: true,
      self: { paused: true, held: false },
      target: { paused: true, held: false },
    }, { targetPlayerId: 'bob' });
    expect(causes).toEqual(['the ensemble is PAUSED']);
  });

  it('names the target on target-only causes', () => {
    const causes = describeSuspensionCauses({
      ...CLEAN,
      target: { paused: true, held: true },
    }, { targetPlayerId: 'bob' });
    expect(causes.join('; ')).toContain('"bob" is PAUSED');
    expect(causes.join('; ')).toContain('"bob" is HELD');
  });

  it('self-held is reported even under ensemble pause (release is a separate verb)', () => {
    const causes = describeSuspensionCauses({
      ensemblePaused: true,
      self: { paused: true, held: true },
    });
    expect(causes).toContain('your session is HELD (outbox locked)');
  });
});

describe('formatSuspensionWarning (#752 AC wording)', () => {
  it('null when nothing is suspended — no warning noise on the happy path', () => {
    expect(formatSuspensionWarning(CLEAN)).toBeNull();
  });

  it('says the message IS queued and will deliver on resume', () => {
    const msg = formatSuspensionWarning({ ...CLEAN, ensemblePaused: true })!;
    expect(msg).toContain('queued');
    expect(msg).toContain('deliver');
    expect(msg).toContain('on resume');
  });

  it('names the resume verb: play with release: true', () => {
    const msg = formatSuspensionWarning({ ...CLEAN, self: { paused: false, held: true } })!;
    expect(msg).toContain('`play`');
    expect(msg).toContain('release: true');
  });
});

describe('formatSuspensionBanner', () => {
  it('null when nothing is suspended', () => {
    expect(formatSuspensionBanner(CLEAN, 'jam')).toBeNull();
  });

  it('ensemble-paused banner names the ensemble and warns cues queue', () => {
    const banner = formatSuspensionBanner({ ...CLEAN, ensemblePaused: true }, 'jam')!;
    expect(banner).toContain('ENSEMBLE PAUSED');
    expect(banner).toContain('"jam"');
    expect(banner).toContain('cues queue');
    expect(banner).toContain('`play`');
  });

  it('self-held banner explains the warm hold', () => {
    const banner = formatSuspensionBanner({ ...CLEAN, self: { paused: false, held: true } }, 'jam')!;
    expect(banner).toContain('YOUR SESSION IS HELD');
    expect(banner).toContain('release: true');
  });

  it('stacks one line per axis + the resume hint', () => {
    const banner = formatSuspensionBanner(
      { ensemblePaused: true, self: { paused: true, held: true } },
      'jam',
    )!;
    const lines = banner.split('\n');
    expect(lines).toHaveLength(3); // ensemble + held + resume hint (self-paused folded into ensemble line)
    expect(lines[0]).toContain('ENSEMBLE PAUSED');
    expect(lines[1]).toContain('HELD');
    expect(lines[2]).toContain('`play`');
  });
});
