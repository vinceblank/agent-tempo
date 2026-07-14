/**
 * Unit tests for `src/utils/last-exit.ts` — the daemon.last-exit.json crash
 * marker (architect-ruled schema, docs/design/daemon-last-exit-schema.md +
 * docs/research/daemon-resilience-architect-ruling.md §2 Q3).
 *
 * Pure filesystem tests against a temp path — no Temporal, no real daemon.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeLastExitSync, readAndClearLastExit, type DaemonLastExit } from '../src/utils/last-exit';

describe('daemon.last-exit.json marker', function () {
  let tmpDir: string;
  let filePath: string;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tempo-last-exit-'));
    filePath = path.join(tmpDir, 'daemon.last-exit.json');
  });

  afterEach(function () {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('writeLastExitSync', function () {
    it('writes a well-formed marker with schemaVersion stamped', function () {
      const ok = writeLastExitSync(
        { reason: 'worker-give-up', worker: 'shared', restarts: 5, at: '2026-07-14T04:00:00.000Z', pid: 123 },
        filePath,
      );
      expect(ok).to.be.true;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DaemonLastExit;
      expect(raw.schemaVersion).to.equal(1);
      expect(raw.reason).to.equal('worker-give-up');
      expect(raw.worker).to.equal('shared');
      expect(raw.restarts).to.equal(5);
      expect(raw.pid).to.equal(123);
    });

    it('is first-writer-wins — a second write is a no-op and does not clobber', function () {
      writeLastExitSync({ reason: 'worker-give-up', restarts: 3, at: 't1', pid: 1 }, filePath);
      const secondWriteOk = writeLastExitSync(
        { reason: 'stale-pid-unexplained', restarts: 0, at: 't2', pid: 2 },
        filePath,
      );
      expect(secondWriteOk).to.be.false;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DaemonLastExit;
      // The FIRST writer's forensic detail survives — this is the exact bug
      // the architect ruling called out: "stale-pid-unexplained" must never
      // clobber a daemon-authored reason.
      expect(raw.reason).to.equal('worker-give-up');
      expect(raw.pid).to.equal(1);
    });

    it('truncates lastFatalMessage to 2KB', function () {
      const huge = 'x'.repeat(5000);
      writeLastExitSync({ reason: 'unhandled-fatal', restarts: 0, at: 't', pid: 1, lastFatalMessage: huge }, filePath);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DaemonLastExit;
      expect(raw.lastFatalMessage!.length).to.equal(2048);
    });

    it('creates the parent directory if missing', function () {
      const nested = path.join(tmpDir, 'nested', 'dir', 'daemon.last-exit.json');
      const ok = writeLastExitSync({ reason: 'drain-timeout', restarts: 0, at: 't', pid: 1 }, nested);
      expect(ok).to.be.true;
      expect(fs.existsSync(nested)).to.be.true;
    });

    it('leaves no .tmp file behind after a successful write', function () {
      writeLastExitSync({ reason: 'boot-guard-refused', restarts: 0, at: 't', pid: 1 }, filePath);
      const dirEntries = fs.readdirSync(tmpDir);
      expect(dirEntries.some((f) => f.includes('.tmp.'))).to.be.false;
    });
  });

  describe('readAndClearLastExit', function () {
    it('returns null when no marker exists', function () {
      expect(readAndClearLastExit(filePath)).to.be.null;
    });

    it('reads a well-formed marker and then deletes it (one-shot)', function () {
      writeLastExitSync({ reason: 'worker-give-up', worker: 'host', restarts: 2, at: 't', pid: 99 }, filePath);
      const marker = readAndClearLastExit(filePath);
      expect(marker).to.not.be.null;
      expect(marker!.reason).to.equal('worker-give-up');
      expect(marker!.worker).to.equal('host');
      expect(fs.existsSync(filePath)).to.be.false;

      // Second read (one-shot semantics) — nothing left to report.
      expect(readAndClearLastExit(filePath)).to.be.null;
    });

    it('never throws on malformed JSON — degrades to null', function () {
      fs.writeFileSync(filePath, '{not valid json');
      expect(() => readAndClearLastExit(filePath)).to.not.throw();
      expect(readAndClearLastExit(filePath)).to.be.null;
    });

    it('never throws and returns null on an unrecognized schemaVersion', function () {
      fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 999, reason: 'worker-give-up' }));
      expect(readAndClearLastExit(filePath)).to.be.null;
    });

    it('still deletes a malformed/unrecognized-version file (avoids repeating a broken marker forever)', function () {
      fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 999 }));
      readAndClearLastExit(filePath);
      expect(fs.existsSync(filePath)).to.be.false;
    });
  });

  describe('write -> read round trip', function () {
    it('preserves every optional field', function () {
      const input: Omit<DaemonLastExit, 'schemaVersion'> = {
        reason: 'worker-give-up',
        worker: 'shared',
        restarts: 5,
        at: '2026-07-14T04:00:00.000Z',
        pid: 34900,
        lastFatalMessage: 'IllegalStateError: boom',
        lastHeartbeatAt: '2026-07-13T12:32:53.000Z',
        bootedAt: '2026-07-13T09:00:00.000Z',
        version: '2.0.0-beta.2',
      };
      writeLastExitSync(input, filePath);
      const marker = readAndClearLastExit(filePath);
      expect(marker).to.deep.include(input);
      expect(marker!.schemaVersion).to.equal(1);
    });
  });
});
