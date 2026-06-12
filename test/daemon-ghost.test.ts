/**
 * #758 — ghost-daemon PID/port hygiene.
 *
 * The incident class (3 occurrences on 2026-06-11): a daemon WITHOUT a PID
 * file survives `daemon stop` (the §5.6 cross-profile guard also skips the
 * cmdline zombie reaper), `daemon start` spawns a new process that silently
 * fails to bind, and `daemon status` tracks the phantom new pid while all
 * HTTP traffic + Temporal polling stays on the stale ghost.
 *
 * These tests simulate the exact repro with injected port/scan/kill deps
 * (the established daemon.test.ts harness — no real spawns):
 *   - missing PID file + cross-profile reaper skip + port owned by a
 *     daemon-looking pid → the ghost MUST still die (port-based sweep);
 *   - a non-daemon process squatting the port is warned about, never killed;
 *   - a tracked daemon that was just gracefully signalled is NOT force-killed
 *     while it drains;
 *   - `daemon start`'s pre-flight waits out a draining prior daemon, then
 *     refuses with an actionable error naming the owner;
 *   - the Windows netstat parser handles the repro's exact output shape.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import {
  stopDaemon,
  assertDaemonPortFree,
  parseWindowsNetstatOwner,
  classifyPortDivergence,
  DAEMON_PID_PATH,
  type DaemonProcessInfo,
} from '../src/cli/daemon';

const GHOST_PID = 2800; // the incident's actual ghost pid
const PORT = 8473;

const daemonProc = (pid: number): DaemonProcessInfo => ({
  pid,
  commandLine: 'C:\\Program Files\\nodejs\\node.exe C:\\repos\\agent-tempo\\dist\\daemon.js',
});

/** Save/restore any real PID file so dev boxes aren't disturbed. */
let savedPidFile: string | null = null;
beforeEach(function () {
  savedPidFile = fs.existsSync(DAEMON_PID_PATH)
    ? fs.readFileSync(DAEMON_PID_PATH, 'utf8')
    : null;
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* absent — fine */ }
});
afterEach(function () {
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* absent — fine */ }
  if (savedPidFile !== null) fs.writeFileSync(DAEMON_PID_PATH, savedPidFile);
});

describe('#758 stopDaemon — port-based ghost sweep', function () {
  it('REPRO: missing PID file + cross-profile reaper skip → ghost still dies via port ownership', function () {
    // No PID file (deleted in beforeEach) — `status.running` is false, and
    // the §5.6 guard suppresses the cmdline reaper: pre-#758, stop reached
    // NOTHING. The port probe is the only path to the ghost.
    const forceKilled: number[] = [];
    const result = stopDaemon({
      scan: () => [daemonProc(GHOST_PID)],
      killer: () => { throw new Error('graceful killer must not be reached — nothing is tracked'); },
      isOtherProfileLikelyRunning: () => true, // the incident's exact state
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([GHOST_PID]);
    expect(result).to.equal(true);
  });

  it('a non-daemon process squatting the port is warned about, never killed', function () {
    const forceKilled: number[] = [];
    const result = stopDaemon({
      scan: () => [], // owner's cmdline does NOT match a daemon
      killer: () => {},
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => 4242,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([]);
    expect(result).to.equal(false);
  });

  it('does NOT force-kill the tracked daemon it just gracefully signalled (drain window)', function () {
    fs.writeFileSync(DAEMON_PID_PATH, String(process.pid)); // tracked + alive
    const gracefullySignalled: number[] = [];
    const forceKilled: number[] = [];
    stopDaemon({
      scan: () => [],
      killer: (pid) => { gracefullySignalled.push(Number(pid)); },
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      // The tracked daemon still owns the port while draining — expected.
      findPortOwner: () => process.pid,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(gracefullySignalled).to.deep.equal([process.pid]);
    expect(forceKilled).to.deep.equal([]);
  });

  it('free port → sweep is a no-op', function () {
    const forceKilled: number[] = [];
    const result = stopDaemon({
      scan: () => [],
      killer: () => {},
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => null,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([]);
    expect(result).to.equal(false);
  });

  it('a zombie found by the cmdline reaper is not double-killed by the port sweep', function () {
    const gracefullySignalled: number[] = [];
    const forceKilled: number[] = [];
    stopDaemon({
      scan: () => [daemonProc(GHOST_PID)],
      killer: (pid) => { gracefullySignalled.push(Number(pid)); },
      isOtherProfileLikelyRunning: () => false, // reaper ACTIVE this time
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => GHOST_PID, // still owns the port mid-drain
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(gracefullySignalled).to.deep.equal([GHOST_PID]);
    expect(forceKilled).to.deep.equal([]); // already signalled — drain window
  });
});

describe('#758 assertDaemonPortFree — daemon start pre-flight', function () {
  const noSleep = async () => {};

  it('free port → resolves', async function () {
    await assertDaemonPortFree({
      resolvePort: () => PORT,
      findPortOwner: () => null,
      scan: () => [],
    });
  });

  it('waits out a draining prior daemon (port released mid-wait)', async function () {
    let probes = 0;
    await assertDaemonPortFree({
      resolvePort: () => PORT,
      findPortOwner: () => (++probes <= 2 ? GHOST_PID : null),
      scan: () => [daemonProc(GHOST_PID)],
      waitMs: 1_000,
      pollMs: 1,
      sleep: noSleep,
    });
    expect(probes).to.be.greaterThan(2);
  });

  it('persistent ghost → rejects naming the pid as an UNTRACKED daemon', async function () {
    let caught: unknown;
    try {
      await assertDaemonPortFree({
        resolvePort: () => PORT,
        findPortOwner: () => GHOST_PID,
        scan: () => [daemonProc(GHOST_PID)],
        waitMs: 5,
        pollMs: 1,
        sleep: noSleep,
      });
    } catch (err) { caught = err; }
    expect(String(caught)).to.match(/owned by pid 2800/);
    expect(String(caught)).to.match(/UNTRACKED agent-tempo daemon/);
  });

  it('persistent non-daemon squatter → rejects with the free-the-port message', async function () {
    let caught: unknown;
    try {
      await assertDaemonPortFree({
        resolvePort: () => PORT,
        findPortOwner: () => 4242,
        scan: () => [],
        waitMs: 5,
        pollMs: 1,
        sleep: noSleep,
      });
    } catch (err) { caught = err; }
    expect(String(caught)).to.match(/owned by pid 4242/);
    expect(String(caught)).to.match(/does not look like an agent-tempo daemon/);
  });
});

describe('#758 classifyPortDivergence (daemon status)', function () {
  it('tracked daemon owning the port → ok', function () {
    expect(classifyPortDivergence({ running: true, pid: 100 }, PORT, 100))
      .to.deep.equal({ kind: 'ok', port: PORT, pid: 100 });
  });

  it('tracked daemon, free port → not-bound (HTTP down)', function () {
    expect(classifyPortDivergence({ running: true, pid: 100 }, PORT, null))
      .to.deep.equal({ kind: 'not-bound', port: PORT, pid: 100 });
  });

  it('REPRO: pid file says new pid, port owned by old → phantom', function () {
    expect(classifyPortDivergence({ running: true, pid: 2436 }, PORT, GHOST_PID))
      .to.deep.equal({ kind: 'phantom', port: PORT, pid: 2436, owner: GHOST_PID });
  });

  it('no tracked daemon, port owned → ghost', function () {
    expect(classifyPortDivergence({ running: false }, PORT, GHOST_PID))
      .to.deep.equal({ kind: 'ghost', port: PORT, owner: GHOST_PID });
  });

  it('no tracked daemon, free port → none', function () {
    expect(classifyPortDivergence({ running: false }, PORT, null))
      .to.deep.equal({ kind: 'none' });
  });
});

describe('#758 parseWindowsNetstatOwner', function () {
  const REPRO_OUTPUT = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1192',
    '  TCP    0.0.0.0:8473           0.0.0.0:0              LISTENING       2800',
    '  TCP    127.0.0.1:8473         127.0.0.1:52311        ESTABLISHED     2800',
    '  TCP    [::]:8474              [::]:0                 LISTENING       3111',
    '  TCP    192.168.1.10:52312     140.82.112.21:443      ESTABLISHED     7777',
  ].join('\r\n');

  it("finds the incident's LISTENING owner on 8473", function () {
    expect(parseWindowsNetstatOwner(REPRO_OUTPUT, 8473)).to.equal(2800);
  });

  it('handles IPv6 local-address rows', function () {
    expect(parseWindowsNetstatOwner(REPRO_OUTPUT, 8474)).to.equal(3111);
  });

  it('ignores ESTABLISHED rows and unrelated ports', function () {
    expect(parseWindowsNetstatOwner(REPRO_OUTPUT, 52312)).to.equal(null);
    expect(parseWindowsNetstatOwner(REPRO_OUTPUT, 9999)).to.equal(null);
  });

  it('returns null on empty/garbage output', function () {
    expect(parseWindowsNetstatOwner('', 8473)).to.equal(null);
    expect(parseWindowsNetstatOwner('not netstat output at all', 8473)).to.equal(null);
  });
});
