/**
 * Unit tests for the #768 HTTP bind retry-with-beacon.
 *
 * Posture under test (operator-ratified on #768): when the daemon's HTTP
 * listener cannot bind its port, Temporal workers stay up, the bind
 * retries indefinitely with capped backoff, and the degraded state
 * beacons via a rate-limited log line + the additive `httpDegraded`
 * hostProfile flag.
 *
 * Everything here is pure / injected — no sockets, no timers, no Temporal.
 */
import { expect } from 'chai';
import {
  httpBindRetryDelayMs,
  runHttpBindRetryLoop,
  scrubHostProfile,
  HTTP_BIND_BEACON_INTERVAL_MS,
} from '../src/daemon';
import { formatHostList } from '../src/utils/format-hosts';
import type { HostInfo } from '../src/types';

describe('#768 httpBindRetryDelayMs', function () {
  it('doubles from the base and caps at 30s by default', function () {
    expect(httpBindRetryDelayMs(0)).to.equal(1_000);
    expect(httpBindRetryDelayMs(1)).to.equal(2_000);
    expect(httpBindRetryDelayMs(4)).to.equal(16_000);
    expect(httpBindRetryDelayMs(5)).to.equal(30_000);
    expect(httpBindRetryDelayMs(100)).to.equal(30_000); // no overflow at huge retry counts
  });

  it('honours custom base and cap', function () {
    expect(httpBindRetryDelayMs(0, 10, 80)).to.equal(10);
    expect(httpBindRetryDelayMs(3, 10, 80)).to.equal(80);
  });

  it('default beacon cadence is 5 minutes', function () {
    expect(HTTP_BIND_BEACON_INTERVAL_MS).to.equal(300_000);
  });
});

describe('#768 runHttpBindRetryLoop', function () {
  /** Fake-clock harness: sleep advances the clock; no real timers. */
  function harness() {
    let clock = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    return {
      sleeps,
      logs,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      log: (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      },
      warnings: () => logs.filter((l) => l.includes('WARNING: serving no HTTP')).length,
    };
  }

  it('retries with capped backoff until the bind succeeds, firing onDegraded once and onRecovered once', async function () {
    const h = harness();
    let attempts = 0;
    let degraded = 0;
    let recovered: number | null = null;
    const result = await runHttpBindRetryLoop({
      attemptStart: async () => {
        attempts++;
        if (attempts <= 3) throw new Error('EADDRINUSE: address already in use');
      },
      isShuttingDown: () => false,
      onDegraded: () => { degraded++; },
      onRecovered: (n) => { recovered = n; },
      sleep: h.sleep,
      now: h.now,
      log: h.log,
      baseDelayMs: 10,
      maxDelayMs: 80,
    });
    expect(result).to.equal('recovered');
    expect(attempts).to.equal(4);
    expect(degraded).to.equal(1);
    expect(recovered).to.equal(4);
    // Capped exponential: 10, 20, 40, 80 — the 4th sleep precedes the success.
    expect(h.sleeps).to.deep.equal([10, 20, 40, 80]);
    expect(h.logs.some((l) => l.includes('HTTP recovered after 4 bind retries'))).to.equal(true);
  });

  it('exits with "shutdown" before any attempt when the daemon is already draining', async function () {
    const h = harness();
    let attempts = 0;
    const result = await runHttpBindRetryLoop({
      attemptStart: async () => { attempts++; },
      isShuttingDown: () => true,
      sleep: h.sleep,
      now: h.now,
      log: h.log,
    });
    expect(result).to.equal('shutdown');
    expect(attempts).to.equal(0);
  });

  it('exits with "shutdown" mid-loop and stops attempting', async function () {
    const h = harness();
    let attempts = 0;
    let shuttingDown = false;
    const result = await runHttpBindRetryLoop({
      attemptStart: async () => {
        attempts++;
        if (attempts === 2) shuttingDown = true; // drain begins after the 2nd failure
        throw new Error('EADDRINUSE');
      },
      isShuttingDown: () => shuttingDown,
      sleep: h.sleep,
      now: h.now,
      log: h.log,
      baseDelayMs: 10,
      maxDelayMs: 80,
    });
    expect(result).to.equal('shutdown');
    expect(attempts).to.equal(2);
  });

  it('rate-limits the WARNING beacon: first failure always, then at most once per interval', async function () {
    const h = harness();
    let attempts = 0;
    await runHttpBindRetryLoop({
      attemptStart: async () => {
        attempts++;
        if (attempts <= 6) throw new Error('EADDRINUSE');
      },
      isShuttingDown: () => false,
      sleep: h.sleep,
      now: h.now,
      log: h.log,
      baseDelayMs: 10,
      maxDelayMs: 80,
      beaconIntervalMs: 100,
    });
    // Failure clock marks: 10, 30, 70, 150, 230, 310.
    // Beacons: 10 (first), 150 (≥100 since 10), 310 (≥100 since 150) → 3,
    // NOT 6 — the suppressed failures at 30 / 70 / 230 stay quiet.
    expect(h.warnings()).to.equal(3);
  });

  it('beacon line names the failure and the steady-state cadence', async function () {
    const h = harness();
    let attempts = 0;
    await runHttpBindRetryLoop({
      attemptStart: async () => {
        attempts++;
        if (attempts === 1) throw new Error('EADDRINUSE: 0.0.0.0:8473');
      },
      isShuttingDown: () => false,
      sleep: h.sleep,
      now: h.now,
      log: h.log,
    });
    const warning = h.logs.find((l) => l.includes('WARNING: serving no HTTP'));
    expect(warning).to.include('EADDRINUSE: 0.0.0.0:8473');
    expect(warning).to.include('Temporal workers remain up');
    expect(warning).to.include('≤30s');
  });
});

describe('#768 httpDegraded — scrub passthrough + hosts beacon', function () {
  const baseProfile = {
    hostname: 'devbox',
    version: '1.8.0',
    capabilities: [],
  };

  it('scrubHostProfile carries httpDegraded true AND false; omits when absent', function () {
    expect(scrubHostProfile({ ...baseProfile, httpDegraded: true }).httpDegraded).to.equal(true);
    // Explicit false must survive — it clears a consumer's earlier `true`.
    expect(scrubHostProfile({ ...baseProfile, httpDegraded: false }).httpDegraded).to.equal(false);
    expect('httpDegraded' in scrubHostProfile({ ...baseProfile })).to.equal(false);
  });

  const hostInfo = (httpDegraded?: boolean): HostInfo =>
    ({
      hostname: 'devbox',
      freshness: 'live',
      recruitReady: true,
      instances: [],
      profile: { hostname: 'devbox', platform: 'win32', ...(httpDegraded !== undefined ? { httpDegraded } : {}) },
      profileStaleness: 'fresh',
    }) as unknown as HostInfo;

  it('formatHostList shows the degraded beacon when httpDegraded is true', function () {
    const out = formatHostList([hostInfo(true)]);
    expect(out).to.include('HTTP DEGRADED');
    expect(out).to.include('Temporal workers are up');
  });

  it('formatHostList stays quiet when the flag is false or absent', function () {
    expect(formatHostList([hostInfo(false)])).to.not.include('HTTP DEGRADED');
    expect(formatHostList([hostInfo()])).to.not.include('HTTP DEGRADED');
  });
});
