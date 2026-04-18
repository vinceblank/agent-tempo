/**
 * Unit tests for the `daemon start` pre-flight decision (issue #157 PR B).
 *
 * Tests the pure `evaluateStartPreflight` helper in `src/cli/daemon-command.ts`.
 * The handler that wraps this helper maps its output to console writes + `process.exit`
 * + `startDaemon` — all trivially reviewable; the non-trivial logic lives in this
 * decision function.
 */
import { expect } from 'chai';
import { evaluateStartPreflight } from '../src/cli/daemon-command';
import type { DaemonProcessInfo, DaemonStatus } from '../src/cli/daemon';

describe('evaluateStartPreflight (#157 PR B)', function () {
  // Helper — build a plausible scanner result entry.
  const proc = (pid: number, suffix = 'repos/claude-tempo/dist/daemon.js'): DaemonProcessInfo => ({
    pid,
    commandLine: `node /home/dev/${suffix}`,
  });

  it('returns "already-running" when the tracked pid is live (no-op)', function () {
    const status: DaemonStatus = { running: true, pid: 4242, heartbeatAge: 500 };
    const result = evaluateStartPreflight([proc(4242)], status, /* force */ false);
    expect(result).to.deep.equal({ action: 'already-running', pid: 4242 });
  });

  it('returns "already-running" even when force is true — force does not kill a live daemon', function () {
    const status: DaemonStatus = { running: true, pid: 4242 };
    const result = evaluateStartPreflight([proc(4242)], status, /* force */ true);
    expect(result).to.deep.equal({ action: 'already-running', pid: 4242 });
  });

  it('returns "abort" with the orphan list when scanner finds untracked processes', function () {
    const status: DaemonStatus = { running: false };
    const result = evaluateStartPreflight([proc(1111), proc(2222)], status, /* force */ false);
    expect(result.action).to.equal('abort');
    if (result.action === 'abort') {
      expect(result.orphans.map((o) => o.pid).sort()).to.deep.equal([1111, 2222]);
    }
  });

  it('returns "abort" listing ONLY untracked pids — the tracked pid is filtered out', function () {
    // Scenario: stale pid file points at 1111 (somehow still alive), and scanner
    // also finds 2222 and 3333. Only 2222 + 3333 are orphans for the purpose of
    // "should I abort".
    // In practice `status.running` would be true when pid is live, which would hit
    // the already-running branch first. This test pins selectOrphans' filter
    // behavior even if the status snapshot lags reality.
    const status: DaemonStatus = { running: false, pid: 1111 };
    const result = evaluateStartPreflight([proc(1111), proc(2222), proc(3333)], status, /* force */ false);
    expect(result.action).to.equal('abort');
    if (result.action === 'abort') {
      expect(result.orphans.map((o) => o.pid).sort()).to.deep.equal([2222, 3333]);
    }
  });

  it('returns "spawn" with cleanupStalePid=false when scanner is empty and force is false', function () {
    const status: DaemonStatus = { running: false };
    const result = evaluateStartPreflight([], status, /* force */ false);
    expect(result).to.deep.equal({ action: 'spawn', cleanupStalePid: false });
  });

  it('returns "spawn" with cleanupStalePid=true on the force path — bypasses orphan check', function () {
    // Even with orphans present, force skips the abort branch.
    const status: DaemonStatus = { running: false };
    const result = evaluateStartPreflight([proc(1111), proc(2222)], status, /* force */ true);
    expect(result).to.deep.equal({ action: 'spawn', cleanupStalePid: true });
  });

  it('returns "spawn" with cleanupStalePid=true on force path even when scanner is empty', function () {
    // cleanupStalePid is a consequence of `force`, not of the scanner result.
    const status: DaemonStatus = { running: false };
    const result = evaluateStartPreflight([], status, /* force */ true);
    expect(result).to.deep.equal({ action: 'spawn', cleanupStalePid: true });
  });
});
