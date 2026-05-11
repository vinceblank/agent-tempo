/**
 * Unit tests for the visibility-iterator deadline helper (#336/#529).
 *
 * Tests three things:
 *  1. `iterateWithDeadline` passes through entries until the wall-clock
 *     deadline trips, then throws `VisibilityIteratorTimeoutError`.
 *  2. The error carries `site`, `deadlineMs`, and `partialCount` so
 *     warn-log surfaces are actionable.
 *  3. The `isVisibilityTimeout` type guard correctly narrows.
 *  4. `VISIBILITY_DEADLINES_MS` exposes all six site keys plus
 *     `orphanQueryBoot` / `orphanQueryCleanup`.
 *
 * Uses an injectable `now()` clock so tests don't depend on real wall
 * time — the helper deliberately exposes that injection point.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowExecutionInfo } from '@temporalio/client';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VisibilityIteratorTimeoutError,
  VISIBILITY_DEADLINES_MS,
} from '../../src/utils/visibility-deadline';

/** Fixture: a fake `WorkflowExecutionInfo` good enough for the type. */
function fakeWf(id: string): WorkflowExecutionInfo {
  return { workflowId: id } as unknown as WorkflowExecutionInfo;
}

/** Build an async iterable that yields N entries with an injectable per-step clock advance. */
function fakeStream(
  count: number,
  clock: { now: number },
  stepMs: number,
): AsyncIterable<WorkflowExecutionInfo> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<WorkflowExecutionInfo>> {
          if (i >= count) return { value: undefined, done: true };
          clock.now += stepMs;
          return { value: fakeWf(`wf-${i++}`), done: false };
        },
      };
    },
  };
}

describe('iterateWithDeadline', () => {
  it('yields every entry when the source completes before the deadline', async () => {
    const clock = { now: 0 };
    const yielded: string[] = [];
    for await (const wf of iterateWithDeadline(
      fakeStream(5, clock, 10), // 5 entries × 10ms = 50ms total
      1000, // deadline 1s — never trips
      'test-site',
      () => clock.now,
    )) {
      yielded.push(wf.workflowId);
    }
    expect(yielded).toEqual(['wf-0', 'wf-1', 'wf-2', 'wf-3', 'wf-4']);
  });

  it('throws VisibilityIteratorTimeoutError when the deadline trips mid-stream', async () => {
    const clock = { now: 0 };
    const yielded: string[] = [];
    const run = async () => {
      for await (const wf of iterateWithDeadline(
        fakeStream(10, clock, 100), // each step advances 100ms
        250, // deadline 250ms — trips after 2 entries (200ms < 250ms ≤ 300ms)
        'test-site',
        () => clock.now,
      )) {
        yielded.push(wf.workflowId);
      }
    };
    await expect(run()).rejects.toBeInstanceOf(VisibilityIteratorTimeoutError);
    // Two entries yielded: wf-0 at clock=100, wf-1 at clock=200. The
    // deadline check for wf-2 sees clock=300 > 250 and throws.
    expect(yielded).toEqual(['wf-0', 'wf-1']);
  });

  it('carries site, deadlineMs, and partialCount on the error', async () => {
    const clock = { now: 0 };
    try {
      for await (const _wf of iterateWithDeadline(
        fakeStream(10, clock, 100),
        150,
        'orphanQueryBoot',
        () => clock.now,
      )) {
        // consume
      }
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VisibilityIteratorTimeoutError);
      const ve = err as VisibilityIteratorTimeoutError;
      expect(ve.site).toBe('orphanQueryBoot');
      expect(ve.deadlineMs).toBe(150);
      // First entry at clock=100 yields fine. Second iteration finds
      // clock=200 > 150 and throws with partialCount=1.
      expect(ve.partialCount).toBe(1);
      expect(ve.message).toMatch(/orphanQueryBoot/);
      expect(ve.message).toMatch(/150ms/);
      expect(ve.message).toMatch(/1 entries/);
    }
  });

  it('throws immediately if the deadline is already past on the first iteration', async () => {
    const clock = { now: 1000 };
    const run = async () => {
      for await (const _wf of iterateWithDeadline(
        fakeStream(5, clock, 100),
        50, // deadline = 1050; first step puts clock at 1100 > 1050
        'test-site',
        () => clock.now,
      )) {
        // never reached
      }
    };
    await expect(run()).rejects.toBeInstanceOf(VisibilityIteratorTimeoutError);
  });

  it('handles an empty upstream stream gracefully (no error, no entries)', async () => {
    const clock = { now: 0 };
    const yielded: string[] = [];
    for await (const wf of iterateWithDeadline(
      fakeStream(0, clock, 10),
      1000,
      'test-site',
      () => clock.now,
    )) {
      yielded.push(wf.workflowId);
    }
    expect(yielded).toEqual([]);
  });
});

describe('isVisibilityTimeout', () => {
  it('returns true for VisibilityIteratorTimeoutError instances', () => {
    const err = new VisibilityIteratorTimeoutError('test', 1000, 0);
    expect(isVisibilityTimeout(err)).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isVisibilityTimeout(new Error('boom'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isVisibilityTimeout(undefined)).toBe(false);
    expect(isVisibilityTimeout(null)).toBe(false);
    expect(isVisibilityTimeout('string')).toBe(false);
    expect(isVisibilityTimeout({ message: 'fake' })).toBe(false);
  });
});

describe('VISIBILITY_DEADLINES_MS', () => {
  // Snapshot test — adding/removing a site is a deliberate change.
  // Keep the values in sync with `src/utils/visibility-deadline.ts`'s
  // doc-comment tuning rationale.
  it('exposes all six site keys with positive values', () => {
    const keys = Object.keys(VISIBILITY_DEADLINES_MS).sort();
    expect(keys).toEqual([
      'discoverEnsembles',
      'fireScheduleAll',
      'orphanQueryBoot',
      'orphanQueryCleanup',
      'resolveSession',
      'scanEnsembleSessions',
    ]);
    for (const v of Object.values(VISIBILITY_DEADLINES_MS)) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it('orphanQueryBoot > orphanQueryCleanup (boot can afford a longer scan)', () => {
    expect(VISIBILITY_DEADLINES_MS.orphanQueryBoot).toBeGreaterThan(
      VISIBILITY_DEADLINES_MS.orphanQueryCleanup,
    );
  });
});
