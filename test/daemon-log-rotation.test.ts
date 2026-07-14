/**
 * Unit tests for daemon.log size-based rotation (§4 of
 * docs/research/daemon-supervision-alerting-design.md — daemon.log was
 * observed unrotated at 286.9MB during the 2026-07-13 outage triage).
 *
 * Covers `rotateLogIfLarge` (src/cli/daemon.ts) in isolation against a temp
 * directory — no real daemon process involved.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { rotateLogIfLarge } from '../src/cli/daemon';

describe('rotateLogIfLarge', function () {
  let tmpDir: string;
  let logPath: string;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tempo-log-rotate-'));
    logPath = path.join(tmpDir, 'daemon.log');
  });

  afterEach(function () {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('no-ops when the log file does not exist', function () {
    expect(() => rotateLogIfLarge(logPath, 10, 3)).to.not.throw();
    expect(fs.existsSync(logPath)).to.be.false;
  });

  it('no-ops when the log is under the size threshold', function () {
    fs.writeFileSync(logPath, 'small');
    rotateLogIfLarge(logPath, 1024 * 1024, 3);
    expect(fs.existsSync(logPath)).to.be.true;
    expect(fs.existsSync(`${logPath}.1`)).to.be.false;
  });

  it('rotates the current log to .1 when over the threshold', function () {
    fs.writeFileSync(logPath, 'x'.repeat(100));
    rotateLogIfLarge(logPath, 50, 3);
    expect(fs.existsSync(logPath)).to.be.false; // renamed away
    expect(fs.existsSync(`${logPath}.1`)).to.be.true;
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).to.equal('x'.repeat(100));
  });

  it('shifts existing generations down the chain (.1 -> .2 -> .3)', function () {
    fs.writeFileSync(logPath, 'current');
    fs.writeFileSync(`${logPath}.1`, 'gen1');
    fs.writeFileSync(`${logPath}.2`, 'gen2');
    rotateLogIfLarge(logPath, 1, 3); // threshold of 1 byte forces rotation

    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).to.equal('current');
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).to.equal('gen1');
    expect(fs.readFileSync(`${logPath}.3`, 'utf8')).to.equal('gen2');
  });

  it('drops the oldest generation once at the retention cap', function () {
    fs.writeFileSync(logPath, 'current');
    fs.writeFileSync(`${logPath}.1`, 'gen1');
    fs.writeFileSync(`${logPath}.2`, 'gen2');
    fs.writeFileSync(`${logPath}.3`, 'gen3-oldest');
    rotateLogIfLarge(logPath, 1, 3);

    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).to.equal('current');
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).to.equal('gen1');
    expect(fs.readFileSync(`${logPath}.3`, 'utf8')).to.equal('gen2');
    // gen3-oldest is gone — dropped, not shifted to a nonexistent .4
    expect(fs.existsSync(`${logPath}.4`)).to.be.false;
  });

  it('is safe to call repeatedly across simulated daemon boots', function () {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(logPath, `boot-${i}`);
      rotateLogIfLarge(logPath, 1, 3);
    }
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).to.equal('boot-4');
    expect(fs.existsSync(`${logPath}.4`)).to.be.false;
  });
});
