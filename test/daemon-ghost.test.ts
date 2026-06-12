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
  resolveDaemonPort,
  DAEMON_PID_PATH,
  type DaemonProcessInfo,
} from '../src/cli/daemon';
import { DEV_DAEMON_PORT, ENV, PROD_DAEMON_PORT } from '../src/config';

const GHOST_PID = 2800; // the incident's actual ghost pid
const PORT = 8473;

const daemonProc = (pid: number): DaemonProcessInfo => ({
  pid,
  commandLine: 'C:\\Program Files\\nodejs\\node.exe C:\\repos\\agent-tempo\\dist\\daemon.js',
  pathVerified: true,
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

  it('REPRO #771: an UNVERIFIED structural match owning the port IS swept (local-repo daemon)', function () {
    // The #771 incident class: a daemon at a path without an install
    // signature (e.g. an arbitrarily-named local checkout). The reaper must
    // not touch it on match alone — but once it owns OUR profile-scoped
    // port, the sweep's PID cross-verify makes it ours and it must die.
    const forceKilled: number[] = [];
    const result = stopDaemon({
      scan: () => [
        { pid: GHOST_PID, commandLine: 'node /code/my-fork/dist/daemon.js', pathVerified: false },
      ],
      killer: () => { throw new Error('graceful killer must not be reached — unverified matches are not reaped'); },
      isOtherProfileLikelyRunning: () => false, // reaper active, but skips the unverified match
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([GHOST_PID]);
    expect(result).to.equal(true);
  });

  it('#771: an unverified structural match NOT owning the port is left completely alone', function () {
    const forceKilled: number[] = [];
    const signalled: number[] = [];
    const result = stopDaemon({
      scan: () => [
        { pid: GHOST_PID, commandLine: 'node /code/my-fork/dist/daemon.js', pathVerified: false },
      ],
      killer: (pid) => { signalled.push(Number(pid)); },
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePort: () => PORT,
      findPortOwner: () => null, // port free — no cross-verification possible
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(signalled).to.deep.equal([]);
    expect(forceKilled).to.deep.equal([]);
    expect(result).to.equal(false);
  });

  it('#775 provenance gate: DEFAULT-sourced port + unverified match → warned, NOT killed', function () {
    // No port file, no env — the resolved port is just the profile
    // fallback. A foreign project's daemon coincidentally squatting 8473
    // must not die on structural match alone.
    const forceKilled: number[] = [];
    const result = stopDaemon({
      scan: () => [
        { pid: GHOST_PID, commandLine: 'node /code/my-fork/dist/daemon.js', pathVerified: false },
      ],
      killer: () => {},
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePortInfo: () => ({ port: PORT, source: 'default' as const }),
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([]);
    expect(result).to.equal(false);
  });

  it('#775 provenance gate: DEFAULT-sourced port + VERIFIED match → still swept', function () {
    const forceKilled: number[] = [];
    stopDaemon({
      scan: () => [daemonProc(GHOST_PID)], // agent-tempo path → pathVerified
      killer: () => {},
      isOtherProfileLikelyRunning: () => true, // reaper suppressed — sweep is the only path
      getOtherProfilePid: () => undefined,
      resolvePortInfo: () => ({ port: PORT, source: 'default' as const }),
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([GHOST_PID]);
  });

  it('#775 provenance gate: FILE-sourced port + unverified match → swept (the #771 repro path)', function () {
    const forceKilled: number[] = [];
    stopDaemon({
      scan: () => [
        { pid: GHOST_PID, commandLine: 'node /code/my-fork/dist/daemon.js', pathVerified: false },
      ],
      killer: () => { throw new Error('unverified matches are not reaped'); },
      isOtherProfileLikelyRunning: () => false,
      getOtherProfilePid: () => undefined,
      resolvePortInfo: () => ({ port: PORT, source: 'file' as const }),
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([GHOST_PID]);
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

describe('#758 cross-profile safety (architect must-fix on #769)', function () {
  it("the OTHER profile's TRACKED daemon is never swept, even when port resolution lands on its port", function () {
    // Defense-in-depth half (a): a stale/corrupt port file (or any other
    // resolution accident) aims the sweep at the prod port from a dev
    // stop. The prod daemon's cmdline matches a daemon, so only the
    // exclusion set protects it.
    const forceKilled: number[] = [];
    stopDaemon({
      scan: () => [daemonProc(GHOST_PID)],
      killer: () => {},
      isOtherProfileLikelyRunning: () => true,
      getOtherProfilePid: () => GHOST_PID, // the other profile TRACKS this pid
      resolvePort: () => PORT,
      findPortOwner: () => GHOST_PID,
      forceKiller: (pid) => { forceKilled.push(pid); return true; },
    });
    expect(forceKilled).to.deep.equal([]);
  });

  describe('resolveDaemonPort dev carve-out — half (b): the UNTRACKED prod daemon is protected by never probing its port', function () {
    const saved: Record<string, string | undefined> = {};
    beforeEach(function () {
      for (const k of [ENV.DAEMON_PORT, ENV.DEV_MODE]) saved[k] = process.env[k];
    });
    afterEach(function () {
      for (const [k, v] of Object.entries(saved)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('ATTACK SCENARIO: shell AGENT_TEMPO_DAEMON_PORT=8473 + dev mode + no port file → resolves the DEV port, not prod', function () {
      process.env[ENV.DAEMON_PORT] = String(PROD_DAEMON_PORT);
      process.env[ENV.DEV_MODE] = '1';
      expect(resolveDaemonPort(() => null)).to.equal(DEV_DAEMON_PORT);
    });

    it('prod mode still honors the env override', function () {
      process.env[ENV.DAEMON_PORT] = '9999';
      delete process.env[ENV.DEV_MODE];
      expect(resolveDaemonPort(() => null)).to.equal(9999);
    });

    it("the port FILE (the dev daemon's actually-bound port) still wins in dev mode", function () {
      process.env[ENV.DAEMON_PORT] = String(PROD_DAEMON_PORT);
      process.env[ENV.DEV_MODE] = '1';
      expect(resolveDaemonPort(() => 9001)).to.equal(9001);
    });

    it('no file, no env → profile default', function () {
      delete process.env[ENV.DAEMON_PORT];
      delete process.env[ENV.DEV_MODE];
      expect(resolveDaemonPort(() => null)).to.equal(PROD_DAEMON_PORT);
      process.env[ENV.DEV_MODE] = '1';
      expect(resolveDaemonPort(() => null)).to.equal(DEV_DAEMON_PORT);
    });
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
