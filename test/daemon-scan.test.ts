/**
 * Unit tests for {@link scanAgentTempoDaemons} — the OS process-list
 * helper that detects orphaned agent-tempo daemon processes by command-
 * line match (issue #157).
 *
 * No real shell-out — callers inject a stub executor so the tests run
 * identically on all CI matrix entries regardless of platform.
 */
import { expect } from 'chai';
import {
  scanAgentTempoDaemons,
  selectOrphans,
  parseDaemonEntryScript,
  isPathVerifiedDaemonScript,
  type DaemonProcessInfo,
} from '../src/cli/daemon';

describe('scanAgentTempoDaemons', function () {
  describe('POSIX (ps) scanner', function () {
    const posix: NodeJS.Platform = 'linux';

    it('matches a global-install daemon path', function () {
      const stub = () =>
        '  PID COMMAND\n' +
        '12345 node /usr/local/lib/node_modules/agent-tempo/dist/daemon.js\n' +
        '67890 node /some/other/script.js\n';
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result).to.have.length(1);
      expect(result[0].pid).to.equal(12345);
      expect(result[0].commandLine).to.include('agent-tempo');
      expect(result[0].commandLine).to.include('daemon.js');
    });

    it('matches a dev-tree daemon path', function () {
      const stub = () =>
        'PID COMMAND\n' +
        '54321 /usr/bin/node /home/dev/repos/agent-tempo/dist/daemon.js\n';
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result).to.have.length(1);
      expect(result[0].pid).to.equal(54321);
    });

    it('excludes unrelated node processes', function () {
      const stub = () =>
        'PID COMMAND\n' +
        '11111 node /tmp/my-app/dist/server.js\n' +
        '22222 node /opt/other-tool/index.js\n';
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result).to.deep.equal([]);
    });

    it('excludes the current test process even if its command line happens to match', function () {
      // Stub injects our own pid with a matching command line — filter must drop it.
      const stub = () =>
        `PID COMMAND\n${process.pid} node /tmp/agent-tempo/dist/daemon.js\n12345 node /other/agent-tempo/dist/daemon.js\n`;
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result.map((p) => p.pid)).to.deep.equal([12345]);
    });

    it('matches multiple daemons when several are running', function () {
      const stub = () =>
        'PID COMMAND\n' +
        '11111 node /usr/local/lib/node_modules/agent-tempo/dist/daemon.js\n' +
        '22222 node /home/dev/agent-tempo/dist/daemon.js\n' +
        '33333 node /opt/unrelated/daemon.js\n';
      const result = scanAgentTempoDaemons(stub, posix);
      const pids = result.map((p) => p.pid).sort();
      expect(pids).to.deep.equal([11111, 22222]);
    });

    it('returns [] when the scanner executor throws', function () {
      const stub = () => {
        throw new Error('ps: command not found');
      };
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result).to.deep.equal([]);
    });

    it('does not match non-daemon agent-tempo processes (e.g. the CLI itself)', function () {
      // CLI entry is `dist/cli.js`, not `dist/daemon.js`. Pattern must be
      // strict about the `daemon.js` leaf to avoid killing a live CLI.
      const stub = () =>
        'PID COMMAND\n' +
        '11111 node /usr/local/lib/node_modules/agent-tempo/dist/cli.js daemon stop\n' +
        '22222 node /usr/local/lib/node_modules/agent-tempo/dist/server.js\n';
      const result = scanAgentTempoDaemons(stub, posix);
      expect(result).to.deep.equal([]);
    });
  });

  describe('Windows (PowerShell CSV) scanner', function () {
    const win: NodeJS.Platform = 'win32';
    // PowerShell `ConvertTo-Csv` escapes internal quotes by DOUBLING them
    // (`""`), not by backslash-escaping. Literal backslashes in paths stay
    // as single backslashes. These fixtures mirror real PowerShell output.

    it('parses a PowerShell CSV row and matches a global-install daemon', function () {
      const stub = () =>
        '"ProcessId","CommandLine"\r\n' +
        '"12345","""C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\vince\\AppData\\Roaming\\npm\\node_modules\\agent-tempo\\dist\\daemon.js"""\r\n';
      const result = scanAgentTempoDaemons(stub, win);
      expect(result).to.have.length(1);
      expect(result[0].pid).to.equal(12345);
      expect(result[0].commandLine).to.match(/agent-tempo/);
      expect(result[0].commandLine).to.match(/daemon\.js/);
    });

    it('parses multiple rows and filters non-daemon node processes', function () {
      const stub = () =>
        '"ProcessId","CommandLine"\r\n' +
        '"11111","""C:\\nodejs\\node.exe"" ""C:\\some\\other\\app.js"""\r\n' +
        '"22222","""C:\\nodejs\\node.exe"" ""C:\\repos\\agent-tempo\\dist\\daemon.js"""\r\n' +
        '"33333","""C:\\nodejs\\node.exe"" ""C:\\unrelated\\daemon.js"""\r\n';
      const result = scanAgentTempoDaemons(stub, win);
      const pids = result.map((p) => p.pid);
      expect(pids).to.deep.equal([22222]);
    });

    it('falls back to wmic if PowerShell throws', function () {
      let call = 0;
      const stub = (cmd: string) => {
        call++;
        if (call === 1) throw new Error('powershell not found');
        // wmic CSV format: Node,CommandLine,ProcessId (on Windows). Our permissive parser
        // grabs the first plausible pid token that's adjacent to a comma/line boundary.
        expect(cmd).to.equal('wmic');
        return (
          'Node,CommandLine,ProcessId\r\n' +
          'HOST1,"""C:\\nodejs\\node.exe"" ""C:\\repos\\agent-tempo\\dist\\daemon.js""",22222\r\n'
        );
      };
      const result = scanAgentTempoDaemons(stub, win);
      expect(result).to.have.length(1);
      expect(result[0].pid).to.equal(22222);
    });

    it('returns [] when both PowerShell and wmic fail', function () {
      const stub = () => {
        throw new Error('not found');
      };
      const result = scanAgentTempoDaemons(stub, win);
      expect(result).to.deep.equal([]);
    });
  });
});

// ── #771 — structural matcher + install-signature trust tiers ──
describe('#771 structural daemon-entry matcher', function () {
  describe('parseDaemonEntryScript', function () {
    it('REPRO #771: matches the local-repo Windows command line the old regex missed', function () {
      const script = parseDaemonEntryScript(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repos\\claude-tempo\\dist\\daemon.js',
      );
      expect(script).to.equal('C:\\repos\\claude-tempo\\dist\\daemon.js');
    });

    it('matches an arbitrary repo path (no package-name marker required)', function () {
      expect(parseDaemonEntryScript('node /code/my-fork/dist/daemon.js')).to.equal(
        '/code/my-fork/dist/daemon.js',
      );
    });

    it('matches a relative entry path and skips node flags', function () {
      expect(parseDaemonEntryScript('node dist\\daemon.js')).to.equal('dist\\daemon.js');
      expect(parseDaemonEntryScript('node --inspect /repo/dist/daemon.js')).to.equal(
        '/repo/dist/daemon.js',
      );
    });

    it('QA false-positive (#769 review): rejects a viewer whose ARGUMENT is a daemon path', function () {
      // First non-flag script is log-viewer.js — the daemon path is just data.
      expect(
        parseDaemonEntryScript('node /tools/log-viewer.js /x/agent-tempo/dist/daemon.js'),
      ).to.equal(null);
    });

    it('QA false-positive: rejects a non-node executable even with node + the path in its argv', function () {
      expect(
        parseDaemonEntryScript('grep node.*agent-tempo/dist/daemon.js /var/log/daemon.log'),
      ).to.equal(null);
    });

    it('rejects daemon.js outside a dist directory, and other dist scripts', function () {
      expect(parseDaemonEntryScript('node /opt/unrelated/daemon.js')).to.equal(null);
      expect(parseDaemonEntryScript('node /repo/dist/cli.js daemon stop')).to.equal(null);
    });
  });

  describe('isPathVerifiedDaemonScript', function () {
    it('verifies agent-tempo and pre-rebrand claude-tempo package/repo paths', function () {
      expect(isPathVerifiedDaemonScript('/usr/lib/node_modules/agent-tempo/dist/daemon.js')).to.equal(true);
      expect(isPathVerifiedDaemonScript('C:\\repos\\claude-tempo\\dist\\daemon.js')).to.equal(true);
    });

    it('verifies THIS install\'s own entry path, slash- and case-insensitively', function () {
      expect(
        isPathVerifiedDaemonScript('c:/code/MY-FORK/dist/daemon.js', 'C:\\code\\my-fork\\dist\\daemon.js'),
      ).to.equal(true);
    });

    it('does not verify a foreign repo path', function () {
      expect(
        isPathVerifiedDaemonScript('/code/other-project/dist/daemon.js', '/somewhere/else/dist/daemon.js'),
      ).to.equal(false);
    });
  });

  describe('scanner pathVerified tiering', function () {
    it('POSIX: a foreign-path daemon is matched but NOT pathVerified; install-entry match IS', function () {
      const stub = () =>
        'PID COMMAND\n' +
        '11111 node /code/other-project/dist/daemon.js\n' +
        '22222 node /home/dev/my-fork/dist/daemon.js\n';
      const result = scanAgentTempoDaemons(stub, 'linux', '/home/dev/my-fork/dist/daemon.js');
      expect(result.map((p) => [p.pid, p.pathVerified])).to.deep.equal([
        [11111, false],
        [22222, true],
      ]);
    });

    it('Windows: REPRO #771 — the incident CSV row is matched and verified (claude-tempo marker)', function () {
      const stub = () =>
        '"ProcessId","CommandLine"\r\n' +
        '"9284","""C:\\Program Files\\nodejs\\node.exe"" C:\\repos\\claude-tempo\\dist\\daemon.js"\r\n';
      const result = scanAgentTempoDaemons(stub, 'win32');
      expect(result).to.have.length(1);
      expect(result[0].pid).to.equal(9284);
      expect(result[0].pathVerified).to.equal(true);
    });

    it('Windows: QA false-positive row (daemon path as a viewer argument) is rejected', function () {
      const stub = () =>
        '"ProcessId","CommandLine"\r\n' +
        '"4242","""C:\\nodejs\\node.exe"" C:\\tools\\log-viewer.js C:\\x\\agent-tempo\\dist\\daemon.js"\r\n';
      expect(scanAgentTempoDaemons(stub, 'win32')).to.deep.equal([]);
    });
  });
});

describe('selectOrphans (#157 PR B)', function () {
  const proc = (pid: number): DaemonProcessInfo => ({
    pid,
    commandLine: `node /path/agent-tempo/dist/daemon.js`,
    pathVerified: true,
  });

  it('returns the full scanner result when no tracked pid is provided', function () {
    const scanned = [proc(111), proc(222), proc(333)];
    expect(selectOrphans(scanned, undefined).map((p) => p.pid)).to.deep.equal([111, 222, 333]);
  });

  it('filters out the tracked pid from the scanner result', function () {
    const scanned = [proc(111), proc(222), proc(333)];
    expect(selectOrphans(scanned, 222).map((p) => p.pid)).to.deep.equal([111, 333]);
  });

  it('returns the full list when the tracked pid is not in the scanner result', function () {
    // Mismatch can happen when pid file is stale — tracked pid is dead + not
    // reported by scanner; all scanned pids are real orphans.
    const scanned = [proc(111), proc(222)];
    expect(selectOrphans(scanned, 999).map((p) => p.pid)).to.deep.equal([111, 222]);
  });

  it('returns [] when scanner is empty regardless of tracked pid', function () {
    expect(selectOrphans([], undefined)).to.deep.equal([]);
    expect(selectOrphans([], 111)).to.deep.equal([]);
  });

  it('returns [] when the only scanned process is the tracked pid', function () {
    expect(selectOrphans([proc(111)], 111)).to.deep.equal([]);
  });
});
