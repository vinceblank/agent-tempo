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
import { stopTemporalServer } from '../src/cli/commands';

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
