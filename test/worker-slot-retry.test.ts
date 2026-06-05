/**
 * Unit tests for `createWorkerWithSlotRetry` — the #642 fix for the
 * within-process worker SlotKey-overlap race under CPU starvation.
 *
 * Coverage:
 *   1. `_isSlotOverlapError` / `_SLOT_OVERLAP_RE` match the real Rust-core
 *      overlap phrasing + the `SlotKey {` substring; reject unrelated errors.
 *   2. Happy path — returns the worker on attempt 1 with no retry overhead.
 *   3. Retry path — a single slot-overlap throw then success → retried once.
 *   4. RETHROW path — a non-matching error is thrown IMMEDIATELY (NOT retried),
 *      so genuine worker-init failures are never masked.
 *   5. Exhaustion — slot-overlap on every attempt rethrows the LAST error.
 */
import { expect } from 'chai';
import type { Worker } from '@temporalio/worker';
import {
  createWorkerWithSlotRetry,
  _isSlotOverlapError,
  _SLOT_OVERLAP_RE,
} from './helpers';

/** A stand-in worker — `createWorkerWithSlotRetry` only forwards it through. */
const sentinelWorker = { sentinel: true } as unknown as Worker;
const EMPTY_OPTS = {} as Parameters<typeof Worker.create>[0];

/** The real Rust-core overlap message (abridged from a CI failure). */
const OVERLAP_MSG =
  'Failed to initialize worker: Registration of multiple workers with overlapping ' +
  'worker task types on the same namespace, task queue, and deployment build ID not ' +
  'allowed: SlotKey { namespace: "default", task_queue: "test-agent-tempo" }';

function makeRecorder() {
  const sleeps: { ms: number }[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    sleep: async (ms: number) => { sleeps.push({ ms }); },
    log: (msg: string) => { logs.push(msg); },
  };
}

describe('_isSlotOverlapError / _SLOT_OVERLAP_RE (#642)', () => {
  it('matches the real Rust-core overlap phrasing', () => {
    expect(_isSlotOverlapError(new Error(OVERLAP_MSG))).to.equal(true);
  });
  it('matches the bare `SlotKey {` substring (phrasing-drift tolerant)', () => {
    expect(_isSlotOverlapError(new Error('boom SlotKey { namespace: "x" }'))).to.equal(true);
  });
  it('matches the overlap sentence alone', () => {
    expect(_isSlotOverlapError(new Error(
      'Registration of multiple workers with overlapping worker task types',
    ))).to.equal(true);
  });
  it('does NOT match unrelated worker-init errors', () => {
    expect(_isSlotOverlapError(new Error('connection refused'))).to.equal(false);
    expect(_isSlotOverlapError(new Error('Namespace default was not found'))).to.equal(false);
  });
  it('handles non-Error throws (string)', () => {
    expect(_isSlotOverlapError('some string')).to.equal(false);
    expect(_isSlotOverlapError('contains SlotKey {')).to.equal(true);
  });
  it('regex is exported for callers that need the pattern directly', () => {
    expect(_SLOT_OVERLAP_RE).to.be.an.instanceOf(RegExp);
  });
});

describe('createWorkerWithSlotRetry — happy path', () => {
  it('returns the worker on the first attempt with no retry overhead', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => { attempts++; return sentinelWorker; };
    const worker = await createWorkerWithSlotRetry(EMPTY_OPTS, {
      create, sleep: rec.sleep, log: rec.log,
    });
    expect(worker).to.equal(sentinelWorker);
    expect(attempts).to.equal(1);
    expect(rec.sleeps).to.have.lengthOf(0);
    expect(rec.logs).to.have.lengthOf(0);
  });
});

describe('createWorkerWithSlotRetry — slot-overlap retry path', () => {
  it('retries on a slot-overlap throw, succeeds on the second attempt', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      if (attempts === 1) throw new Error(OVERLAP_MSG);
      return sentinelWorker;
    };
    const worker = await createWorkerWithSlotRetry(EMPTY_OPTS, {
      create, sleep: rec.sleep, log: rec.log, random: () => 0.5, // deterministic jitter
    });
    expect(worker).to.equal(sentinelWorker);
    expect(attempts).to.equal(2);
    expect(rec.sleeps).to.have.lengthOf(1);
    // base 100 * 2^0 + floor(0.5 * 100) = 150
    expect(rec.sleeps[0].ms).to.equal(150);
    expect(rec.logs.some((l) => l.includes('attempt 1/4 hit worker-slot overlap'))).to.equal(true);
    expect(rec.logs.some((l) => l.includes('succeeded on attempt 2/4'))).to.equal(true);
  });
});

describe('createWorkerWithSlotRetry — non-matching error is rethrown immediately', () => {
  it('does NOT retry a non-slot-overlap error (masking guard)', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      throw new Error('Namespace default was not found: tcp connect error');
    };
    let caught: unknown;
    try {
      await createWorkerWithSlotRetry(EMPTY_OPTS, {
        create, sleep: rec.sleep, log: rec.log, random: () => 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an.instanceOf(Error);
    expect((caught as Error).message).to.contain('Namespace default was not found');
    expect(attempts).to.equal(1); // thrown on the first attempt, no retry
    expect(rec.sleeps).to.have.lengthOf(0);
  });
});

describe('createWorkerWithSlotRetry — exhaustion', () => {
  it('rethrows the LAST error after every attempt hits the overlap', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      throw new Error(`${OVERLAP_MSG} attempt#${attempts}`);
    };
    let caught: unknown;
    try {
      await createWorkerWithSlotRetry(EMPTY_OPTS, {
        attempts: 3,
        create, sleep: rec.sleep, log: rec.log, random: () => 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(attempts).to.equal(3);
    expect((caught as Error).message).to.contain('attempt#3'); // last error verbatim
    expect(rec.sleeps).to.have.lengthOf(2); // slept between the 3 attempts, not after the last
  });
});
