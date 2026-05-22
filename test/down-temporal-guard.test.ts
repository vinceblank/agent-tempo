/**
 * Unit tests for the cross-profile coexistence guard on `down`'s shared
 * Temporal kill (#423, ADR 0014 §5.6).
 *
 * The Temporal dev server is a single OS-wide process — `pkill -f
 * 'temporal server start-dev'` on POSIX and `taskkill /IM temporal.exe`
 * on Windows kill it by name and cannot distinguish dev vs prod profile
 * ownership. Without the guard, `agent-tempo --dev down` would tear
 * down the prod profile's Temporal as collateral damage. The matching
 * guard already lives on `stopDaemon`'s zombie reaper; PR-B of #423
 * adds it to `down` and exposes `--kill-shared-temporal` as the
 * explicit hard-reset opt-in.
 *
 * These tests exercise `stopTemporalServer` directly with stubbed
 * exec/probe hooks — no real `pkill`/`taskkill`, no touching the
 * developer's home dir.
 */
import { expect } from 'chai';
import { stopTemporalServer, startTemporalForDestroy } from '../src/cli/commands';
import type { Config } from '../src/config';

describe('stopTemporalServer — cross-profile guard (#423, ADR 0014 §5.6)', () => {
  /** Capture (cmd, args) tuples passed to the exec hook. */
  function makeRecorder(): {
    calls: Array<[string, string[]]>;
    exec: (cmd: string, args: string[]) => void;
  } {
    const calls: Array<[string, string[]]> = [];
    return { calls, exec: (cmd, args) => { calls.push([cmd, args]); } };
  }

  it('kills Temporal when no other profile shows signs of life', () => {
    const { calls, exec } = makeRecorder();
    const result = stopTemporalServer({
      killSharedTemporal: false,
      isOtherProfileLikelyRunning: () => false,
      platform: 'linux',
      exec,
    });
    expect(result.action).to.equal('killed');
    expect(calls).to.deep.equal([['pkill', ['-f', 'temporal server start-dev']]]);
  });

  it('skips the kill when the other profile is likely running and the flag is unset', () => {
    const { calls, exec } = makeRecorder();
    const result = stopTemporalServer({
      killSharedTemporal: false,
      isOtherProfileLikelyRunning: () => true,
      platform: 'linux',
      exec,
    });
    expect(result.action).to.equal('skipped-cross-profile');
    expect(calls).to.be.empty;
  });

  it('proceeds with the kill when --kill-shared-temporal overrides the guard', () => {
    const { calls, exec } = makeRecorder();
    const result = stopTemporalServer({
      killSharedTemporal: true,
      isOtherProfileLikelyRunning: () => true,
      platform: 'darwin',
      exec,
    });
    expect(result.action).to.equal('killed');
    expect(calls).to.deep.equal([['pkill', ['-f', 'temporal server start-dev']]]);
  });

  it('uses taskkill on win32', () => {
    const { calls, exec } = makeRecorder();
    const result = stopTemporalServer({
      killSharedTemporal: false,
      isOtherProfileLikelyRunning: () => false,
      platform: 'win32',
      exec,
    });
    expect(result.action).to.equal('killed');
    expect(calls).to.deep.equal([['taskkill', ['/F', '/IM', 'temporal.exe']]]);
  });

  it('returns failed when exec throws (e.g. pkill not found, no matching process)', () => {
    const result = stopTemporalServer({
      killSharedTemporal: true,
      isOtherProfileLikelyRunning: () => false,
      platform: 'linux',
      exec: () => { throw new Error('pkill: no process found'); },
    });
    expect(result.action).to.equal('failed');
    if (result.action === 'failed') {
      expect((result.error as Error).message).to.match(/pkill/);
    }
  });

  it('does not invoke exec on the skipped-cross-profile path even on win32', () => {
    const { calls, exec } = makeRecorder();
    const result = stopTemporalServer({
      killSharedTemporal: false,
      isOtherProfileLikelyRunning: () => true,
      platform: 'win32',
      exec,
    });
    expect(result.action).to.equal('skipped-cross-profile');
    expect(calls).to.be.empty;
  });
});

/**
 * Unit tests for `startTemporalForDestroy` — the temp Temporal server `down
 * --destroy` boots when Temporal happens to be down (PR #617). Covers the
 * readiness-timeout orphan path: on timeout the spawned child MUST be killed
 * so `down` never leaves a stray `temporal server start-dev` booting in the
 * background.
 *
 * The spawn + reachability probe are injected, so no real Temporal process
 * is ever launched and the readiness loop runs instantly via `pollDelayMs`.
 */
describe('startTemporalForDestroy — readiness + orphan kill (PR #617)', () => {
  /** Minimal config — only `temporalAddress` matters, and only for the
   *  production defaults which every test overrides. */
  const config = { temporalAddress: 'localhost:7233' } as Config;

  /** Fake child that records `kill`/`unref` invocations. */
  function makeChild(): { kill: () => void; unref: () => void; kills: number; unrefs: number } {
    const c = {
      kills: 0,
      unrefs: 0,
      kill() { c.kills++; },
      unref() { c.unrefs++; },
    };
    return c;
  }

  it('returns started=true and does NOT kill the child when Temporal becomes reachable', async () => {
    const child = makeChild();
    const result = await startTemporalForDestroy(config, {
      spawn: () => child,
      isReachable: async () => true,
      attempts: 5,
      pollDelayMs: 1,
    });
    expect(result.started).to.equal(true);
    expect(child.kills).to.equal(0);
    expect(child.unrefs).to.equal(1);
  });

  it('kills the spawned child on readiness timeout (orphan prevention)', async () => {
    const child = makeChild();
    const result = await startTemporalForDestroy(config, {
      spawn: () => child,
      isReachable: async () => false,
      attempts: 4,
      pollDelayMs: 1,
    });
    expect(result.started).to.equal(false);
    expect(child.kills).to.equal(1);
    expect(child.unrefs).to.equal(1);
  });

  it('succeeds without killing when Temporal comes up partway through the poll loop', async () => {
    const child = makeChild();
    let probes = 0;
    const result = await startTemporalForDestroy(config, {
      spawn: () => child,
      isReachable: async () => { probes++; return probes >= 3; },
      attempts: 10,
      pollDelayMs: 1,
    });
    expect(result.started).to.equal(true);
    expect(probes).to.equal(3);
    expect(child.kills).to.equal(0);
  });

  it('swallows a kill() that throws (child already exited) on timeout', async () => {
    const child = {
      unrefs: 0,
      kill() { throw new Error('ESRCH: no such process'); },
      unref() { child.unrefs++; },
    };
    const result = await startTemporalForDestroy(config, {
      spawn: () => child,
      isReachable: async () => false,
      attempts: 2,
      pollDelayMs: 1,
    });
    expect(result.started).to.equal(false);
    expect(child.unrefs).to.equal(1);
  });
});
