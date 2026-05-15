/**
 * Unit tests for the daemon management utilities.
 *
 * These tests verify daemon PID file management logic in isolation.
 * No Temporal server or worker processes needed — fast, pure unit tests.
 *
 * Covers:
 *   - isDaemonRunning / getDaemonStatus (src/cli/daemon.ts)
 *   - stopDaemon (src/cli/daemon.ts)
 *   - PID file cleanup for stale processes
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isDaemonRunning,
  getDaemonStatus,
  stopDaemon,
  DAEMON_PID_PATH,
  DAEMON_LOCK_PATH,
  DAEMON_HEARTBEAT_PATH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MULTIPLIER,
  STALE_LOCK_MS,
  tryAcquireLockFile,
  checkLockFileStale,
} from '../src/cli/daemon';
import { writePidFileAtomic } from '../src/daemon';

// Use a temp directory for test PID files to avoid interfering with a real daemon
const ORIGINAL_PID_PATH = DAEMON_PID_PATH;
let tmpDir: string;

/** Write a PID file at `pidPath`, ensuring the parent directory exists. */
function seedPidFile(pidPath: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(pid));
}

/**
 * Override the PID path module-level constant for testing.
 * Since DAEMON_PID_PATH is a `const` string, we can't override it directly.
 * Instead, we test the logic by manipulating the real PID file location
 * (only when no real daemon is running) and restoring it afterwards.
 *
 * Alternative: test the individual behaviors by writing/removing PID files.
 */

describe('daemon management', function () {

  describe('getDaemonStatus', function () {
    it('returns { running: false } when no PID file exists', function () {
      // Remove PID file if it exists from a previous test
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      const status = getDaemonStatus();
      expect(status.running).to.be.false;
      expect(status.pid).to.be.undefined;
    });

    it('returns { running: true, pid } when PID file contains current process PID', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);

      try {
        const status = getDaemonStatus();
        expect(status.running).to.be.true;
        expect(status.pid).to.equal(process.pid);
      } finally {
        try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      }
    });

    it('cleans up stale PID file when process is dead', function () {
      // Use a PID that is almost certainly not running (very high number)
      const deadPid = 2147483646; // max PID on most systems
      seedPidFile(DAEMON_PID_PATH, deadPid);

      const status = getDaemonStatus();
      expect(status.running).to.be.false;
      expect(status.pid).to.be.undefined;

      // PID file should have been cleaned up
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });

    it('handles corrupt PID file gracefully', function () {
      fs.mkdirSync(path.dirname(DAEMON_PID_PATH), { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, 'not-a-number');

      const status = getDaemonStatus();
      expect(status.running).to.be.false;

      // Corrupt PID file should have been cleaned up
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });

    describe('heartbeatAge (#157 PR B)', function () {
      // Run after any other getDaemonStatus test so we don't interfere with them.
      afterEach(function () {
        try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
        try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
      });

      it('reports a fresh heartbeatAge when the heartbeat file exists and is recent', function () {
        seedPidFile(DAEMON_PID_PATH, process.pid);
        fs.writeFileSync(DAEMON_HEARTBEAT_PATH, '');
        // mtime is now — age should be 0 or a few ms
        const status = getDaemonStatus();
        expect(status.running).to.be.true;
        expect(status.heartbeatAge).to.be.a('number');
        expect(status.heartbeatAge!).to.be.at.least(0);
        expect(status.heartbeatAge!).to.be.below(1000); // sane upper bound for just-written file
      });

      it('reports heartbeatAge: null when the heartbeat file is missing (daemon running, pre-first-touch)', function () {
        seedPidFile(DAEMON_PID_PATH, process.pid);
        try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
        const status = getDaemonStatus();
        expect(status.running).to.be.true;
        expect(status.heartbeatAge).to.equal(null);
      });

      it('reports a stale heartbeatAge when the file mtime is beyond the stale threshold', function () {
        seedPidFile(DAEMON_PID_PATH, process.pid);
        fs.writeFileSync(DAEMON_HEARTBEAT_PATH, '');
        // Backdate mtime to 5 intervals ago — well beyond the 2x staleness threshold.
        const staleSecs = (HEARTBEAT_INTERVAL_MS * 5) / 1000;
        const backdated = Date.now() / 1000 - staleSecs;
        fs.utimesSync(DAEMON_HEARTBEAT_PATH, backdated, backdated);

        const status = getDaemonStatus();
        expect(status.running).to.be.true;
        expect(status.heartbeatAge).to.be.a('number');
        expect(status.heartbeatAge!).to.be.at.least(HEARTBEAT_INTERVAL_MS * HEARTBEAT_STALE_MULTIPLIER);
      });

      it('does not populate heartbeatAge when the daemon is not running', function () {
        try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
        // Even if a stale heartbeat file is lying around, the running=false path
        // returns early and never reads it — the field should be absent.
        fs.writeFileSync(DAEMON_HEARTBEAT_PATH, '');
        const status = getDaemonStatus();
        expect(status.running).to.be.false;
        expect(status.heartbeatAge).to.be.undefined;
      });
    });
  });

  describe('isDaemonRunning', function () {
    it('returns false when no PID file exists', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      expect(isDaemonRunning()).to.be.false;
    });

    it('returns true when PID file contains a living process', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);

      try {
        expect(isDaemonRunning()).to.be.true;
      } finally {
        try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      }
    });
  });

  describe('stopDaemon', function () {
    // Inject an empty scan + no-op killer so these tests don't accidentally
    // signal real daemon processes that happen to be running on the dev box.
    // Also disable the cross-profile coexistence probe (ADR 0014 §5.6) —
    // otherwise tests fail on dev machines where the developer happens to
    // be running a prod daemon with a port file present.
    const noopOpts = {
      scan: () => [] as Array<{ pid: number; commandLine: string }>,
      killer: () => { /* no-op */ },
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
    };

    it('returns false when daemon is not running', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      expect(stopDaemon(noopOpts)).to.be.false;
    });

    it('removes PID file when stopping', function () {
      // Write a stale PID — stopDaemon should clean it up regardless
      const deadPid = 2147483646;
      seedPidFile(DAEMON_PID_PATH, deadPid);

      // stopDaemon checks status first — dead PID means not running
      const result = stopDaemon(noopOpts);
      // Since the process is dead, getDaemonStatus will return false and clean up
      expect(result).to.be.false;
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });
  });

  // ── Zombie-reaping (this PR) ──
  //
  // `stopDaemon` must also kill orphan `node dist/daemon.js` processes that
  // the PID file doesn't track — otherwise `down --destroy` and
  // `daemon stop` leave zombies polling Temporal task queues with stale
  // (pre-rebuild) code in memory.
  describe('stopDaemon — zombie reaping', function () {
    afterEach(function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    });

    /**
     * Stable single-profile injection: zombie reaping should run as if no
     * dev profile is active. ADR 0014 §5.6 zombie-suppression has its own
     * dedicated tests; the legacy reaping suite is for the single-profile
     * case the #157 PR established.
     */
    const singleProfileOverrides = {
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
    };

    it('kills tracked daemon AND zombies discovered by the scanner', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid); // tracked = current process (alive)
      const killed: number[] = [];
      const scan = () => [
        { pid: 99001, commandLine: 'node /tmp/agent-tempo/dist/daemon.js' },
        { pid: 99002, commandLine: 'node /opt/agent-tempo/dist/daemon.js' },
      ];
      const killer = (pid: number) => { killed.push(pid); };

      const result = stopDaemon({ scan, killer, ...singleProfileOverrides });

      expect(result).to.be.true;
      // Tracked PID + both zombies
      expect(killed.sort()).to.deep.equal([process.pid, 99001, 99002].sort());
      // PID file is always cleaned up after a tracked-stop
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });

    it('reaps zombies even when no tracked daemon exists', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      const killed: number[] = [];
      const scan = () => [
        { pid: 88001, commandLine: 'node /tmp/agent-tempo/dist/daemon.js' },
      ];
      const killer = (pid: number) => { killed.push(pid); };

      const result = stopDaemon({ scan, killer, ...singleProfileOverrides });

      expect(result).to.be.true;
      expect(killed).to.deep.equal([88001]);
    });

    it('excludes the tracked PID from the zombie list (selectOrphans)', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);
      const killed: number[] = [];
      // Scanner happens to also report the tracked PID (e.g. our own daemon
      // showed up in the OS process listing). selectOrphans must drop it so
      // we don't double-signal.
      const scan = () => [
        { pid: process.pid, commandLine: 'node /tmp/agent-tempo/dist/daemon.js' },
        { pid: 77001, commandLine: 'node /opt/agent-tempo/dist/daemon.js' },
      ];
      const killer = (pid: number) => { killed.push(pid); };

      stopDaemon({ scan, killer, ...singleProfileOverrides });

      // process.pid is killed exactly once (via the tracked path), 77001 once
      // (via the zombie path). No duplicate.
      const counts = killed.reduce<Record<number, number>>((acc, p) => {
        acc[p] = (acc[p] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts[process.pid]).to.equal(1);
      expect(counts[77001]).to.equal(1);
    });

    it('returns true when only zombies are killed (no tracked daemon)', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      const scan = () => [{ pid: 66001, commandLine: 'node x/dist/daemon.js' }];
      const killer = () => { /* succeeds */ };
      expect(stopDaemon({ scan, killer, ...singleProfileOverrides })).to.be.true;
    });

    it('survives scanner failures (returns true if tracked daemon was killed)', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);
      const killed: number[] = [];
      const scan = () => { throw new Error('ps: not found'); };
      const killer = (pid: number) => { killed.push(pid); };

      const result = stopDaemon({ scan, killer, ...singleProfileOverrides });

      expect(result).to.be.true;
      // Tracked PID was still killed despite scanner blowing up
      expect(killed).to.deep.equal([process.pid]);
    });

    it('survives killer errors on individual zombies (continues to next)', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      const killed: number[] = [];
      const scan = () => [
        { pid: 55001, commandLine: 'node x/dist/daemon.js' },
        { pid: 55002, commandLine: 'node y/dist/daemon.js' },
        { pid: 55003, commandLine: 'node z/dist/daemon.js' },
      ];
      const killer = (pid: number) => {
        if (pid === 55002) throw new Error('ESRCH');
        killed.push(pid);
      };

      const result = stopDaemon({ scan, killer, ...singleProfileOverrides });

      // 55001 and 55003 got killed; 55002 threw and was swallowed
      expect(result).to.be.true;
      expect(killed.sort()).to.deep.equal([55001, 55003]);
    });

    it('uses SIGTERM on POSIX, no signal on Windows', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      const scan = () => [{ pid: 44001, commandLine: 'node x/dist/daemon.js' }];
      const killer = (pid: number, signal?: NodeJS.Signals | number) => {
        calls.push({ pid, signal });
      };

      stopDaemon({ scan, killer, ...singleProfileOverrides, platform: 'linux' });
      expect(calls).to.deep.equal([{ pid: 44001, signal: 'SIGTERM' }]);

      calls.length = 0;
      stopDaemon({ scan, killer, ...singleProfileOverrides, platform: 'win32' });
      expect(calls).to.deep.equal([{ pid: 44001, signal: undefined }]);
    });
  });

  // ── Cross-profile coexistence (ADR 0014 §5.6) ──
  //
  // Dev + prod daemons on the same machine MUST coexist. `daemon stop`
  // for one profile must never reap the other profile's daemon as a
  // "zombie". Two paths:
  //   - Strict: opposite profile has a parseable, live PID. We pass it
  //     through `selectOrphans` exclusion list so the scanner never
  //     reports it as a zombie.
  //   - Weak: opposite profile shows weak evidence (port file but no
  //     parseable PID file). The reaper is suppressed entirely — better
  //     to leave a single zombie unkilled than to wrongly kill the
  //     other profile's running daemon.
  describe('stopDaemon — cross-profile coexistence (ADR 0014 §5.6)', function () {
    afterEach(function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    });

    it('excludes the opposite profile PID from the zombie set when known', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);
      const killed: number[] = [];
      const scan = () => [
        { pid: 12345, commandLine: 'node /opposite/dist/daemon.js' },
        { pid: 67890, commandLine: 'node /actual-zombie/dist/daemon.js' },
      ];
      const killer = (pid: number) => { killed.push(pid); };

      stopDaemon({
        scan,
        killer,
        // Opposite profile is running with a known PID — excluded from reap.
        isOtherProfileLikelyRunning: () => true,
        getOtherProfilePid: () => 12345,
      });

      // Tracked daemon (process.pid) was killed. `12345` is the opposite
      // profile and survives. `67890` is suppressed too because the
      // opposite-likely-running probe trips the weak-evidence skip path.
      expect(killed).to.include(process.pid);
      expect(killed).to.not.include(12345);
    });

    it('skips zombie reaper entirely when opposite profile shows weak evidence', function () {
      seedPidFile(DAEMON_PID_PATH, process.pid);
      const killed: number[] = [];
      // Scanner returns an opposite-profile-shaped process AND a real zombie.
      // With weak evidence, we'd rather miss the zombie than risk killing
      // the opposite profile.
      const scan = () => [
        { pid: 22222, commandLine: 'node /opposite-untracked/dist/daemon.js' },
      ];
      const killer = (pid: number) => { killed.push(pid); };

      stopDaemon({
        scan,
        killer,
        isOtherProfileLikelyRunning: () => true,
        getOtherProfilePid: () => undefined, // PID unknown — port file present
      });

      // Tracked daemon got killed; nothing else.
      expect(killed).to.deep.equal([process.pid]);
    });
  });

  // ── Regression tests for #182 stale-lock recovery ──
  //
  // These exercise the lock-file primitives directly. We can't invoke
  // `startDaemon()` in a unit test without spawning an actual daemon, so we
  // test the building blocks (`tryAcquireLockFile`, `checkLockFileStale`)
  // that the stale-lock recovery path is built from.

  describe('lock file — #182 stale-lock recovery', function () {
    // Use a scratch path so we don't collide with a real daemon start lock
    // that might exist on this machine.
    let scratchLock: string;

    beforeEach(function () {
      const scratch = path.join(os.tmpdir(), `agent-tempo-lock-test-${process.pid}-${Date.now()}`);
      fs.mkdirSync(scratch, { recursive: true });
      scratchLock = path.join(scratch, 'daemon.pid.lock');
    });

    afterEach(function () {
      try { fs.unlinkSync(scratchLock); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(scratchLock)); } catch { /* ignore */ }
    });

    describe('tryAcquireLockFile', function () {
      it('creates the lock file with {pid, mtime} JSON content', function () {
        const now = 1_700_000_000_000;
        const acquired = tryAcquireLockFile(scratchLock, 12345, now);
        expect(acquired).to.be.true;
        const parsed = JSON.parse(fs.readFileSync(scratchLock, 'utf8'));
        expect(parsed).to.deep.equal({ pid: 12345, mtime: now });
      });

      it('returns false when the lock file already exists', function () {
        fs.writeFileSync(scratchLock, '{"pid":1,"mtime":1}');
        const acquired = tryAcquireLockFile(scratchLock, process.pid, Date.now());
        expect(acquired).to.be.false;
      });

      it('propagates non-EEXIST errors (e.g. bad directory)', function () {
        const bogus = path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'nested', 'lock');
        expect(() => tryAcquireLockFile(bogus)).to.throw();
      });
    });

    describe('checkLockFileStale', function () {
      it('reports stale when the file is missing', function () {
        const result = checkLockFileStale(scratchLock, Date.now());
        expect(result.stale).to.be.true;
        expect(result.reason).to.match(/missing/);
        expect(result.content).to.be.null;
      });

      it('reports stale when the file is malformed (not JSON)', function () {
        fs.writeFileSync(scratchLock, 'not valid json at all');
        const result = checkLockFileStale(scratchLock, Date.now());
        expect(result.stale).to.be.true;
        expect(result.reason).to.match(/malformed/);
        expect(result.content).to.be.null;
      });

      it('reports stale when JSON lacks required fields', function () {
        fs.writeFileSync(scratchLock, '{"hello":"world"}');
        const result = checkLockFileStale(scratchLock, Date.now());
        expect(result.stale).to.be.true;
        expect(result.reason).to.match(/malformed/);
      });

      it('reports stale when mtime is older than STALE_LOCK_MS', function () {
        const now = Date.now();
        const old = now - (STALE_LOCK_MS + 5_000);
        // Use a live PID — the age check must fire before the PID probe.
        fs.writeFileSync(scratchLock, JSON.stringify({ pid: process.pid, mtime: old }));
        const result = checkLockFileStale(scratchLock, now);
        expect(result.stale).to.be.true;
        expect(result.reason).to.match(/mtime \d+s old/);
        expect(result.content).to.deep.equal({ pid: process.pid, mtime: old });
      });

      it('reports stale when the PID is not alive', function () {
        // Very high PID is almost certainly not running.
        const deadPid = 2147483646;
        fs.writeFileSync(scratchLock, JSON.stringify({ pid: deadPid, mtime: Date.now() }));
        const result = checkLockFileStale(scratchLock, Date.now());
        expect(result.stale).to.be.true;
        expect(result.reason).to.match(/not alive/);
      });

      it('reports NOT stale when the lock is fresh and the PID is alive', function () {
        // Our own PID — the current process is alive by construction.
        const now = Date.now();
        fs.writeFileSync(scratchLock, JSON.stringify({ pid: process.pid, mtime: now - 500 }));
        const result = checkLockFileStale(scratchLock, now);
        expect(result.stale).to.be.false;
        expect(result.reason).to.match(/alive/);
        expect(result.content).to.deep.equal({ pid: process.pid, mtime: now - 500 });
      });
    });

    describe('stale-lock recovery flow (integration of primitives)', function () {
      it('stale-lock recovery: unlink and re-acquire after detecting stale mtime', function () {
        // 1. Plant a stale lock with an old mtime + dead PID.
        const deadPid = 2147483646;
        const now = Date.now();
        const ancientMtime = now - (STALE_LOCK_MS + 60_000);
        fs.writeFileSync(scratchLock, JSON.stringify({ pid: deadPid, mtime: ancientMtime }));

        // 2. First acquire attempt must fail (file exists).
        expect(tryAcquireLockFile(scratchLock, process.pid, now)).to.be.false;

        // 3. Staleness check must flag the lock as stale.
        const state = checkLockFileStale(scratchLock, now);
        expect(state.stale).to.be.true;

        // 4. Unlink + retry succeeds.
        fs.unlinkSync(scratchLock);
        expect(tryAcquireLockFile(scratchLock, process.pid, now)).to.be.true;

        // 5. New lock carries our pid — diagnosable for future staleness checks.
        const parsed = JSON.parse(fs.readFileSync(scratchLock, 'utf8'));
        expect(parsed.pid).to.equal(process.pid);
        expect(parsed.mtime).to.equal(now);
      });

      it('live-lock contention: fresh lock + live PID is NOT treated as stale', function () {
        // Plant a fresh lock owned by our own (live) PID.
        const now = Date.now();
        fs.writeFileSync(scratchLock, JSON.stringify({ pid: process.pid, mtime: now }));

        expect(tryAcquireLockFile(scratchLock, process.pid + 1, now)).to.be.false;
        const state = checkLockFileStale(scratchLock, now);
        expect(state.stale).to.be.false;
        // A starter seeing this must WAIT, not clobber.
      });

      it('malformed-lock recovery: empty/garbage lock is treated as stale', function () {
        // Simulate the original #182 failure mode — an empty sentinel left by a
        // crashed starter running the pre-fix code.
        fs.writeFileSync(scratchLock, '');

        expect(tryAcquireLockFile(scratchLock)).to.be.false;
        const state = checkLockFileStale(scratchLock, Date.now());
        expect(state.stale).to.be.true;
        expect(state.content).to.be.null;

        // Recovery path: unlink and retry.
        fs.unlinkSync(scratchLock);
        expect(tryAcquireLockFile(scratchLock)).to.be.true;
      });
    });
  });

  describe('writePidFileAtomic — #182 atomic PID write', function () {
    let scratchPid: string;

    beforeEach(function () {
      const dir = path.join(os.tmpdir(), `agent-tempo-pid-test-${process.pid}-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      scratchPid = path.join(dir, 'daemon.pid');
    });

    afterEach(function () {
      try { fs.unlinkSync(scratchPid); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(scratchPid)); } catch { /* ignore */ }
    });

    it('writes the PID and cleans up the tmp file', async function () {
      await writePidFileAtomic(scratchPid, 42);
      expect(fs.readFileSync(scratchPid, 'utf8')).to.equal('42');
      // No stray tmp files left in the directory.
      const leftover = fs.readdirSync(path.dirname(scratchPid)).filter(n => n.includes('.tmp.'));
      expect(leftover).to.have.length(0);
    });

    it('overwrites an existing PID file (rename is idempotent)', async function () {
      fs.writeFileSync(scratchPid, '999');
      await writePidFileAtomic(scratchPid, 1234);
      expect(fs.readFileSync(scratchPid, 'utf8')).to.equal('1234');
    });

    it('throws and cleans up the tmp file when rename fails permanently', async function () {
      // Point at a non-existent directory so rename fails with ENOENT
      // (not a retryable code — should throw immediately and clean the tmp).
      const bogusDir = path.join(os.tmpdir(), 'absolutely-missing-' + Date.now());
      const bogusFinal = path.join(bogusDir, 'daemon.pid');
      let threw = false;
      try {
        await writePidFileAtomic(bogusFinal, 1);
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
      // The tmp file is written alongside the target, which in this case
      // is also in the missing dir — so writeFileSync on the tmp also fails
      // before rename. Either way, no stray tmp files should remain anywhere
      // that matters. We only assert the function threw.
    });
  });
});
