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
import { isDaemonRunning, getDaemonStatus, stopDaemon, DAEMON_PID_PATH } from '../src/cli/daemon';

// Use a temp directory for test PID files to avoid interfering with a real daemon
const ORIGINAL_PID_PATH = DAEMON_PID_PATH;
let tmpDir: string;

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
      // Write our own PID — we know this process is alive
      const dir = path.dirname(DAEMON_PID_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));

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
      const dir = path.dirname(DAEMON_PID_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, String(deadPid));

      const status = getDaemonStatus();
      expect(status.running).to.be.false;
      expect(status.pid).to.be.undefined;

      // PID file should have been cleaned up
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });

    it('handles corrupt PID file gracefully', function () {
      const dir = path.dirname(DAEMON_PID_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, 'not-a-number');

      const status = getDaemonStatus();
      expect(status.running).to.be.false;

      // Corrupt PID file should have been cleaned up
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });
  });

  describe('isDaemonRunning', function () {
    it('returns false when no PID file exists', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      expect(isDaemonRunning()).to.be.false;
    });

    it('returns true when PID file contains a living process', function () {
      const dir = path.dirname(DAEMON_PID_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));

      try {
        expect(isDaemonRunning()).to.be.true;
      } finally {
        try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      }
    });
  });

  describe('stopDaemon', function () {
    it('returns false when daemon is not running', function () {
      try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
      expect(stopDaemon()).to.be.false;
    });

    it('removes PID file when stopping', function () {
      // Write a stale PID — stopDaemon should clean it up regardless
      const deadPid = 2147483646;
      const dir = path.dirname(DAEMON_PID_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DAEMON_PID_PATH, String(deadPid));

      // stopDaemon checks status first — dead PID means not running
      const result = stopDaemon();
      // Since the process is dead, getDaemonStatus will return false and clean up
      expect(result).to.be.false;
      expect(fs.existsSync(DAEMON_PID_PATH)).to.be.false;
    });
  });
});
