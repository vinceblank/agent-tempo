/**
 * Unit tests for `createLocalWithRetry` — the #150 fix for the
 * intermittent Windows EACCES on `TestWorkflowEnvironment.createLocal()`.
 *
 * Pure-logic coverage. No real Temporal, no real network. The helper
 * accepts dependency injections (`create`, `reapOrphans`, `sleep`,
 * `log`, `random`) so we can drive every branch deterministically.
 *
 * Tested behaviors:
 *   1. First-attempt success — no retry path triggered, no reap, no log.
 *   2. EACCES → reap → retry. Reap is invoked exactly once before the
 *      next attempt, with the right ordering.
 *   3. Non-EACCES error → retry without reap.
 *   4. Exponential backoff math: 1s / 2s / 4s by default.
 *   5. Jitter is bounded by `jitterMs`.
 *   6. Final-attempt failure rethrows the LAST error verbatim (not
 *      wrapped) — callers reading the stack trace see the real cause.
 *   7. EACCES regex matches both real Rust core bridge phrasings:
 *      "Access is denied" and "(os error 5)".
 */
import { expect } from 'chai';
import {
  _ACCESS_DENIED_RE,
  _isAccessDeniedError,
  createLocalWithRetry,
} from './helpers';
import type { TestWorkflowEnvironment } from '@temporalio/testing';

/** A stand-in env — `createLocalWithRetry` only forwards it through. */
const sentinelEnv = { _stub: true } as unknown as TestWorkflowEnvironment;

interface CapturedCall { ms: number; }
function makeRecorder() {
  const sleeps: CapturedCall[] = [];
  const logs: string[] = [];
  let reapCount = 0;
  return {
    sleeps,
    logs,
    get reapCount(): number { return reapCount; },
    sleep: async (ms: number) => { sleeps.push({ ms }); },
    log: (msg: string) => { logs.push(msg); },
    reap: async () => { reapCount++; },
  };
}

describe('_isAccessDeniedError / _ACCESS_DENIED_RE', () => {
  it('matches the real Rust core bridge EACCES phrasing', () => {
    expect(_isAccessDeniedError(new Error(
      'Failed to start ephemeral server: Access is denied. (os error 5)',
    ))).to.equal(true);
  });
  it('matches just `os error 5`', () => {
    expect(_isAccessDeniedError(new Error('boot failed: os error 5'))).to.equal(true);
  });
  it('matches lower-cased "access is denied"', () => {
    expect(_isAccessDeniedError(new Error('access is denied'))).to.equal(true);
  });
  it('does NOT match unrelated errors', () => {
    expect(_isAccessDeniedError(new Error('connection refused'))).to.equal(false);
    expect(_isAccessDeniedError(new Error('out of memory'))).to.equal(false);
  });
  it('handles non-Error throws (string)', () => {
    expect(_isAccessDeniedError('some string')).to.equal(false);
    expect(_isAccessDeniedError('os error 5')).to.equal(true);
  });
  it('regex is exported for callers that need the pattern directly', () => {
    expect(_ACCESS_DENIED_RE).to.be.an.instanceOf(RegExp);
  });
});

describe('createLocalWithRetry — happy path', () => {
  it('returns env on first attempt with no retry overhead', async () => {
    const rec = makeRecorder();
    const create = async () => sentinelEnv;
    const env = await createLocalWithRetry({}, {
      create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log,
    });
    expect(env).to.equal(sentinelEnv);
    expect(rec.sleeps).to.have.lengthOf(0);
    expect(rec.reapCount).to.equal(0);
    expect(rec.logs).to.have.lengthOf(0);
  });
});

describe('createLocalWithRetry — EACCES retry path', () => {
  it('reaps orphans + retries on EACCES, succeeds on second attempt', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      if (attempts === 1) throw new Error('Failed to start ephemeral server: Access is denied. (os error 5)');
      return sentinelEnv;
    };
    const env = await createLocalWithRetry({}, {
      create,
      reapOrphans: rec.reap,
      sleep: rec.sleep,
      log: rec.log,
      random: () => 0.5, // deterministic jitter
    });
    expect(env).to.equal(sentinelEnv);
    expect(attempts).to.equal(2);
    expect(rec.reapCount).to.equal(1);
    expect(rec.sleeps).to.have.lengthOf(1);
    // Default base 1000ms × factor^0 + jitter (0.5 × 200 = 100).
    expect(rec.sleeps[0].ms).to.equal(1100);
    // Failure log + recovery log.
    expect(rec.logs.some((l) => l.includes('attempt 1/3 failed'))).to.equal(true);
    expect(rec.logs.some((l) => l.includes('reaping orphans + retrying'))).to.equal(true);
    expect(rec.logs.some((l) => l.includes('succeeded on attempt 2/3'))).to.equal(true);
  });

  it('does NOT reap on non-EACCES errors', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      if (attempts === 1) throw new Error('connection refused');
      return sentinelEnv;
    };
    await createLocalWithRetry({}, {
      create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log, random: () => 0,
    });
    expect(attempts).to.equal(2);
    expect(rec.reapCount).to.equal(0);
    expect(rec.logs.some((l) => l.includes('reaping'))).to.equal(false);
    expect(rec.logs.some((l) => l.includes('retrying'))).to.equal(true);
  });

  it('continues retrying when reap itself throws (non-fatal)', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      if (attempts === 1) throw new Error('Access is denied');
      return sentinelEnv;
    };
    const reapOrphans = async () => { throw new Error('tasklist unavailable'); };
    const env = await createLocalWithRetry({}, {
      create, reapOrphans, sleep: rec.sleep, log: rec.log, random: () => 0,
    });
    expect(env).to.equal(sentinelEnv);
    expect(attempts).to.equal(2);
    expect(rec.logs.some((l) => l.includes('reap during retry failed'))).to.equal(true);
  });
});

describe('createLocalWithRetry — exhaustion + backoff', () => {
  it('rethrows the LAST error verbatim after attempts exhausted', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const errors = [
      new Error('Access is denied (os error 5)'),
      new Error('Access is denied (os error 5)'),
      new Error('still denied'),
    ];
    const create = async () => {
      const e = errors[attempts++];
      throw e;
    };
    let caught: unknown;
    try {
      await createLocalWithRetry({}, {
        create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log, random: () => 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(attempts).to.equal(3);
    expect(caught).to.equal(errors[2]); // verbatim, not wrapped
  });

  it('uses exponential backoff: 1000 / 2000 / 4000 ms (no jitter for math check)', async () => {
    const rec = makeRecorder();
    const create = async () => { throw new Error('Access is denied'); };
    try {
      await createLocalWithRetry({}, {
        create,
        reapOrphans: rec.reap,
        sleep: rec.sleep,
        log: rec.log,
        random: () => 0, // 0 jitter
        jitterMs: 0,
      });
    } catch { /* expected */ }
    expect(rec.sleeps.map((s) => s.ms)).to.deep.equal([1000, 2000]);
    // Note: 3 attempts → 2 sleeps (no sleep after the final failed attempt).
  });

  it('honors custom attempt count + base delay', async () => {
    const rec = makeRecorder();
    const create = async () => { throw new Error('Access is denied'); };
    try {
      await createLocalWithRetry({}, {
        create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log,
        attempts: 5, baseDelayMs: 100, factor: 2, jitterMs: 0, random: () => 0,
      });
    } catch { /* expected */ }
    // 5 attempts → 4 sleeps: 100, 200, 400, 800
    expect(rec.sleeps.map((s) => s.ms)).to.deep.equal([100, 200, 400, 800]);
  });

  it('jitter is bounded by jitterMs', async () => {
    const rec = makeRecorder();
    const create = async () => { throw new Error('Access is denied'); };
    try {
      await createLocalWithRetry({}, {
        create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log,
        attempts: 2, baseDelayMs: 1000, jitterMs: 200,
        random: () => 0.999, // max jitter
      });
    } catch { /* expected */ }
    // 1000 + floor(0.999 × 200) = 1000 + 199 = 1199 (max jitter).
    expect(rec.sleeps[0].ms).to.equal(1199);
  });
});

describe('createLocalWithRetry — log shape', () => {
  it('emits one failure log per failed attempt + one success log on recovery', async () => {
    const rec = makeRecorder();
    let attempts = 0;
    const create = async () => {
      attempts++;
      if (attempts < 3) throw new Error('Access is denied');
      return sentinelEnv;
    };
    await createLocalWithRetry({}, {
      create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log, random: () => 0,
    });
    // 2 failures + 1 success = 3 log lines, all prefixed.
    expect(rec.logs).to.have.lengthOf(3);
    expect(rec.logs.every((l) => l.startsWith('[test:setupTestEnv]'))).to.equal(true);
    expect(rec.logs[2]).to.include('succeeded on attempt 3/3');
  });

  it('emits no logs when the first attempt succeeds', async () => {
    const rec = makeRecorder();
    const create = async () => sentinelEnv;
    await createLocalWithRetry({}, {
      create, reapOrphans: rec.reap, sleep: rec.sleep, log: rec.log,
    });
    expect(rec.logs).to.have.lengthOf(0);
  });
});
