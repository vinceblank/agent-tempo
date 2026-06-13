/**
 * #811 — port-ownership liveness fallback for daemon detection.
 *
 * Regression coverage for the 2026-06-12 incident: a stop→start race
 * unlinked `daemon.pid` after a new daemon bound the port, so
 * `isDaemonRunning()` reported false and every MCP spawn tried to start
 * ANOTHER daemon → EADDRINUSE → 15s wait → handshake timeout (~2h outage).
 *
 * `portOwnershipLiveness` is fully injectable (no real fs / port probe);
 * the `getDaemonStatus` wiring tests manipulate the real pid path with
 * save/restore (mirroring test/daemon.test.ts) and inject the fallback
 * result so a live daemon on the test box can't interfere.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  portOwnershipLiveness,
  isDaemonRunning,
  DAEMON_PID_PATH,
  type DaemonStatus,
  type DaemonPortSource,
} from '../src/cli/daemon';

describe('#811 portOwnershipLiveness', function () {
  const deps = (
    source: DaemonPortSource,
    owner: number | null,
    port = 8473,
  ) => ({
    resolvePortInfo: () => ({ port, source }),
    findPortOwner: () => owner,
    heartbeatAge: () => 1234,
  });

  it('FILE-sourced port that is owned → running via fallback, owner pid + portFallback flag', function () {
    const r = portOwnershipLiveness(deps('file', 20268));
    expect(r).to.deep.equal({ running: true, pid: 20268, portFallback: true, heartbeatAge: 1234 });
  });

  it('ENV-sourced port that is owned → running (operator-pinned port is trusted)', function () {
    const r = portOwnershipLiveness(deps('env', 30001));
    expect(r?.running).to.equal(true);
    expect(r?.pid).to.equal(30001);
    expect(r?.portFallback).to.equal(true);
  });

  it('DEFAULT-sourced port → null even when owned (no port file / pin — not verifiably our daemon)', function () {
    // The incident always had a daemon.port file; a random process squatting
    // the 8473 default must NOT be reported as our daemon (false-positive
    // would wedge `daemon start`). Same trust tiering as the #758/#775 sweep.
    expect(portOwnershipLiveness(deps('default', 9999))).to.equal(null);
  });

  it('FILE-sourced but port NOT owned → null (daemon genuinely down, stale port file)', function () {
    expect(portOwnershipLiveness(deps('file', null))).to.equal(null);
  });

  it('does not probe the owner when the port source is default (short-circuits before findPortOwner)', function () {
    let probed = false;
    portOwnershipLiveness({
      resolvePortInfo: () => ({ port: 8473, source: 'default' }),
      findPortOwner: () => { probed = true; return 1; },
    });
    expect(probed, 'findPortOwner must not run for a default-sourced port').to.equal(false);
  });
});

describe('#811 isDaemonRunning — port-ownership fallback wiring (the spawn gate)', function () {
  // Save/restore any real pid file so a dev box isn't disturbed (mirrors
  // test/daemon.test.ts).
  let saved: string | null = null;
  beforeEach(function () {
    saved = fs.existsSync(DAEMON_PID_PATH) ? fs.readFileSync(DAEMON_PID_PATH, 'utf8') : null;
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* absent — fine */ }
  });
  afterEach(function () {
    if (saved !== null) {
      fs.mkdirSync(path.dirname(DAEMON_PID_PATH), { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, saved);
    } else {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* fine */ }
    }
  });

  const running: DaemonStatus = { running: true, pid: 20268, portFallback: true, heartbeatAge: 0 };

  it('no pid file + fallback finds the port owner → running (the incident fix: no duplicate spawn)', function () {
    // pid file already removed in beforeEach — pre-#811 this returned false
    // and the MCP path spawned a second daemon into EADDRINUSE.
    expect(isDaemonRunning(() => running)).to.equal(true);
  });

  it('no pid file + fallback finds nothing → not running', function () {
    expect(isDaemonRunning(() => null)).to.equal(false);
  });

  it('dead pid file + fallback finds the port owner → running (and getDaemonStatus cleaned the stale file)', function () {
    fs.mkdirSync(path.dirname(DAEMON_PID_PATH), { recursive: true });
    fs.writeFileSync(DAEMON_PID_PATH, '2147483646'); // a pid that is not alive
    expect(isDaemonRunning(() => running)).to.equal(true);
    // getDaemonStatus (consulted first) removes the stale pid file.
    expect(fs.existsSync(DAEMON_PID_PATH), 'stale pid file must be cleaned up').to.equal(false);
  });

  it('live pid file → running via pid; fallback NOT consulted (short-circuit)', function () {
    fs.mkdirSync(path.dirname(DAEMON_PID_PATH), { recursive: true });
    fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
    let consulted = false;
    const result = isDaemonRunning(() => { consulted = true; return running; });
    expect(result).to.equal(true);
    expect(consulted, 'fallback must not run when the pid file is live').to.equal(false);
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* fine */ }
  });
});
