/**
 * Unit tests for the #336 daemon memory reporter.
 *
 * Covers the pure helpers exposed by `src/daemon.ts`:
 *   - `formatMemoryUsage` — byte→MB string formatter
 *   - `startMemoryReporter` — tick scheduling, immediate baseline, stop fn
 *
 * No Temporal server, no spawned daemon — pure logic with injected
 * sampler + log fn for deterministic assertions.
 */
import { expect } from 'chai';
import { formatMemoryUsage, startMemoryReporter } from '../src/daemon';

describe('formatMemoryUsage (#336)', function () {
  it('formats every field as `key=NNNmb` rounded to whole MB', function () {
    const usage: NodeJS.MemoryUsage = {
      rss: 100 * 1024 * 1024,
      heapTotal: 50 * 1024 * 1024,
      heapUsed: 40 * 1024 * 1024,
      external: 5 * 1024 * 1024,
      arrayBuffers: 2 * 1024 * 1024,
    };
    expect(formatMemoryUsage(usage)).to.equal(
      'rss=100mb heapUsed=40mb heapTotal=50mb external=5mb arrayBuffers=2mb',
    );
  });

  it('rounds half-MB upward', function () {
    // 1.6 MB → 2 MB (Math.round)
    const usage: NodeJS.MemoryUsage = {
      rss: Math.round(1.6 * 1024 * 1024),
      heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0,
    };
    expect(formatMemoryUsage(usage)).to.include('rss=2mb');
  });

  it('handles zero-byte fields gracefully', function () {
    const usage: NodeJS.MemoryUsage = {
      rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0,
    };
    expect(formatMemoryUsage(usage)).to.equal(
      'rss=0mb heapUsed=0mb heapTotal=0mb external=0mb arrayBuffers=0mb',
    );
  });
});

describe('startMemoryReporter (#336)', function () {
  it('emits an immediate baseline log + reschedules at the configured interval', function (done) {
    const logs: string[] = [];
    const sampler = (() => {
      let i = 0;
      return (): NodeJS.MemoryUsage => {
        i++;
        return {
          rss: i * 1024 * 1024,
          heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0,
        };
      };
    })();

    const stop = startMemoryReporter(
      50, // 50 ms interval — fast enough for a test, large enough not to flake
      (msg: unknown) => { logs.push(String(msg)); },
      sampler,
    );

    // Baseline log fires synchronously inside startMemoryReporter so the
    // first sample is in `logs` before any timer tick.
    expect(logs).to.have.length(1);
    expect(logs[0]).to.match(/^memory: rss=1mb/);

    setTimeout(() => {
      stop();
      // After ~120 ms we expect at least 2 ticks beyond the baseline. Use
      // `>=2` rather than `===` to allow for timer scheduling jitter on
      // loaded CI hosts.
      expect(logs.length).to.be.greaterThanOrEqual(3);
      expect(logs.every((l) => l.startsWith('memory: rss='))).to.equal(true);
      done();
    }, 120);
  });

  it('catches sampler failures and logs them without throwing', function () {
    const logs: string[] = [];
    const stop = startMemoryReporter(
      60_000, // long interval — only the immediate baseline tick should fire
      (msg: unknown, ...rest: unknown[]) => {
        logs.push([msg, ...rest].map((x) => String(x)).join(' '));
      },
      () => { throw new Error('sampler exploded'); },
    );
    stop();
    expect(logs).to.have.length(1);
    expect(logs[0]).to.match(/^memory: sample failed/);
    expect(logs[0]).to.include('sampler exploded');
  });

  it('stop() prevents further ticks', function (done) {
    const logs: string[] = [];
    const stop = startMemoryReporter(
      30,
      (msg: unknown) => { logs.push(String(msg)); },
      () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    );
    stop(); // immediately cancel
    const baseline = logs.length;
    expect(baseline).to.equal(1); // baseline already fired
    setTimeout(() => {
      expect(logs.length).to.equal(baseline); // no further ticks
      done();
    }, 100);
  });
});
