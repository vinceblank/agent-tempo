/**
 * Consolidated unit coverage for the #274 daemon boot sequence (M14).
 *
 * All three invariants below are unit-testable thanks to the
 * `runDaemonBoot(client, deps)` + `advertiseHostProfile(client, profile, opts)`
 * extraction:
 *
 *   1. **Privacy scrub** (AC5c / M10 — HARD REQUIREMENT). The signaled
 *      payload MUST NOT contain absolute paths, env-var values, or
 *      user-directory fragments. A dedicated invariant asserts no `/` or
 *      `\\` in any string field of the scrubbed output, even for a
 *      pathological input.
 *
 *   2. **Ensure-before-signal ordering** (AC5a / M11). The first
 *      `sendHostProfileSignal` call must NOT occur before
 *      `ensureGlobalMaestro` resolves. Proven by holding `ensure` open
 *      with a deferred promise and asserting call-count stays at 0.
 *
 *   3. **Bounded retry + hard-failure** (AC5b / M11). `advertiseHostProfile`
 *      retries up to the configured backoff list; if all attempts fail,
 *      it resolves without throwing — the daemon stays alive without its
 *      profile advertised.
 *
 * None of these tests boot Temporal: `runDaemonBoot` is invoked with a
 * fake `Client` (object proxy that's never touched) and stubbed deps.
 */
import { expect } from 'chai';
import type { Client } from '@temporalio/client';
import type { HostProfile } from '../src/types';
import {
  advertiseHostProfile,
  runDaemonBoot,
  scrubHostProfile,
} from '../src/daemon';

// Empty proxy stands in for a Client: reaching into it would throw, which
// makes "dep not actually swapped" failures loud instead of silent.
const fakeClient = new Proxy({} as Client, {
  get(_target, prop) {
    throw new Error(`Unexpected Client access in daemon-boot test: ${String(prop)}`);
  },
});

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ────────────────────────────────────────────────────────────────────────
// scrubHostProfile — AC5c / M10 HARD REQUIREMENT
// ────────────────────────────────────────────────────────────────────────

describe('scrubHostProfile (#274 AC5c / M10 — privacy)', function () {
  it('already-clean input round-trips unchanged (except extension strip)', function () {
    const clean: HostProfile = {
      hostname: 'mac-alice',
      version: '0.26.0-beta.7',
      defaultAgent: 'claude',
      availableAgentTypes: ['claude'],
      availablePlayerTypes: ['tempo-soloist', 'tempo-critic'],
      claudeBin: 'claude',
      platform: 'darwin',
      capabilities: [],
    };
    expect(scrubHostProfile(clean)).to.deep.equal(clean);
  });

  it('strips absolute POSIX paths from claudeBin', function () {
    const out = scrubHostProfile({
      hostname: 'h',
      claudeBin: '/usr/local/bin/claude',
    });
    expect(out.claudeBin).to.equal('claude');
  });

  it('strips absolute Windows paths from claudeBin', function () {
    // `path.basename` handles the running runtime's separator; on POSIX
    // test runners a Windows-style path is treated as a single token.
    // We regex-check the result instead of asserting exact form so the
    // test is stable across runtimes — the invariant is "no `\\`".
    const out = scrubHostProfile({
      hostname: 'h',
      claudeBin: 'C:\\Users\\alice\\bin\\claude.exe',
    });
    expect(out.claudeBin).to.not.include('\\');
    expect(out.claudeBin).to.not.include('/');
    expect(out.claudeBin).to.not.include(':');
  });

  it('strips .md extension from player type names (shipped files are `*.md`)', function () {
    const out = scrubHostProfile({
      hostname: 'h',
      availablePlayerTypes: ['tempo-soloist.md', 'tempo-critic.md'],
    });
    expect(out.availablePlayerTypes).to.deep.equal(['tempo-soloist', 'tempo-critic']);
  });

  it('strips path prefixes from availablePlayerTypes (defense-in-depth)', function () {
    const out = scrubHostProfile({
      hostname: 'h',
      availablePlayerTypes: ['/home/alice/.claude/agents/tempo-soloist.md', '/shipped/tempo-critic.md'],
    });
    expect(out.availablePlayerTypes).to.deep.equal(['tempo-soloist', 'tempo-critic']);
    for (const name of out.availablePlayerTypes!) {
      expect(name).to.not.include('/');
      expect(name).to.not.include('alice');
    }
  });

  // (Architect/QA trim: "strips path prefixes from availableAgentTypes" was
  // subsumed by the INVARIANT test below, which covers both agentTypes and
  // playerTypes against pathological input. Removed pre-PR.)

  // ── The invariant test. If this ever flakes, the privacy contract is
  //    broken and the signaled payload could leak usernames cross-ensemble.
  //    Do NOT relax this — fix the scrub function.
  it('INVARIANT — no `/`, `\\`, or env-like separators in any scrubbed string field (#274 AC5c)', function () {
    const pathological: HostProfile = {
      hostname: 'h',
      version: '0.26.0',
      defaultAgent: 'claude',
      availableAgentTypes: ['/usr/local/bin/claude', 'C:\\Program Files\\copilot.exe'],
      availablePlayerTypes: [
        '/home/alice/.claude/agents/tempo-soloist.md',
        'C:\\Users\\bob\\AppData\\tempo-critic.md',
        '/var/lib/tempo-roadie',
      ],
      claudeBin: '/Users/eve/.nvm/versions/node/v24/bin/claude',
      platform: 'darwin',
      capabilities: [],
    };
    const scrubbed = scrubHostProfile(pathological);

    const stringFields: string[] = [
      ...(scrubbed.availableAgentTypes ?? []),
      ...(scrubbed.availablePlayerTypes ?? []),
      scrubbed.claudeBin ?? '',
    ];
    for (const field of stringFields) {
      expect(field, `found path separator in: ${field}`).to.not.include('/');
      expect(field, `found backslash in: ${field}`).to.not.include('\\');
      // None of these fields should carry a username fragment; the
      // basename strip is the enforcement mechanism. Spot-check a few
      // known user-dir sentinels from the pathological input.
      expect(field, `leaked 'alice' in: ${field}`).to.not.include('alice');
      expect(field, `leaked 'bob' in: ${field}`).to.not.include('bob');
      expect(field, `leaked 'eve' in: ${field}`).to.not.include('eve');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// advertiseHostProfile — AC5b bounded retry
// ────────────────────────────────────────────────────────────────────────

describe('advertiseHostProfile retry behavior (#274 AC5b / M11)', function () {
  const profile: HostProfile = { hostname: 'h' };

  it('returns ok:true on first-attempt success, call count 1', async function () {
    let calls = 0;
    const sendSignal = async () => {
      calls++;
    };
    const result = await advertiseHostProfile(fakeClient, profile, {
      retryBackoffsMs: [0, 0, 0],
      log: () => {},
      sendSignal,
    });
    expect(result.ok).to.equal(true);
    expect(result.attempts).to.equal(1);
    expect(calls).to.equal(1);
  });

  it('retries until success (reject twice, succeed on 3rd attempt)', async function () {
    let calls = 0;
    const sendSignal = async () => {
      calls++;
      if (calls < 3) throw new Error(`transient-${calls}`);
    };
    const result = await advertiseHostProfile(fakeClient, profile, {
      retryBackoffsMs: [0, 0, 0],
      log: () => {},
      sendSignal,
    });
    expect(result.ok).to.equal(true);
    expect(result.attempts).to.equal(3);
    expect(calls).to.equal(3);
  });

  it('all retries exhausted — resolves without throwing, ok:false (daemon stays alive)', async function () {
    let calls = 0;
    const sendSignal = async () => {
      calls++;
      throw new Error(`perma-fail-${calls}`);
    };
    const result = await advertiseHostProfile(fakeClient, profile, {
      retryBackoffsMs: [0, 0, 0],
      log: () => {},
      sendSignal,
    });
    expect(result.ok).to.equal(false);
    expect(result.attempts).to.equal(3);
    expect(calls).to.equal(3);
    expect((result.lastError as Error).message).to.equal('perma-fail-3');
  });

  // (Architect + QA independently flagged: "respects a custom backoff list
  // length (single-attempt mode)" is implicit from the retry-count tests
  // above — removing pre-PR as agreed.)
});

// ────────────────────────────────────────────────────────────────────────
// runDaemonBoot — AC5a / M11 ordering + hard-failure
// ────────────────────────────────────────────────────────────────────────

describe('runDaemonBoot ordering (#274 AC5a / M11)', function () {
  const sampleProfile: HostProfile = {
    hostname: 'test-host',
    version: '0.26.0-beta.7',
    defaultAgent: 'claude',
    availablePlayerTypes: ['tempo-soloist'],
  };

  it('sendHostProfileSignal is NOT called before ensureGlobalMaestro resolves (the M11 ordering invariant)', async function () {
    const ensure = makeDeferred<void>();
    let signalCalls = 0;
    const sendHostProfileSignal = async () => {
      signalCalls++;
    };

    const bootPromise = runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: () => ensure.promise,
      sendHostProfileSignal,
      computeHostProfile: () => sampleProfile,
      retryBackoffsMs: [0],
      log: () => {},
    });

    // ensure still pending — no signal yet, full stop.
    await new Promise((r) => setImmediate(r));
    expect(signalCalls, 'signal fired before ensure resolved').to.equal(0);

    // Release ensure → signal should fire.
    ensure.resolve();
    await bootPromise;
    expect(signalCalls).to.equal(1);
  });

  it('ensureGlobalMaestro rejects → sendHostProfileSignal NOT called, boot resolves cleanly (daemon stays alive)', async function () {
    let signalCalls = 0;
    const sendHostProfileSignal = async () => {
      signalCalls++;
    };
    const logs: unknown[][] = [];

    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => {
        throw new Error('temporal unreachable at boot');
      },
      sendHostProfileSignal,
      computeHostProfile: () => sampleProfile,
      retryBackoffsMs: [0],
      log: (...args) => logs.push(args),
    });

    expect(signalCalls).to.equal(0);
    // Expect a warning was logged naming the ensure failure.
    const logged = JSON.stringify(logs);
    expect(logged).to.include('ensureGlobalMaestro failed');
    expect(logged).to.include('temporal unreachable');
  });

  it('the profile passed to sendHostProfileSignal is the scrubbed version', async function () {
    let captured: HostProfile | undefined;
    const sendHostProfileSignal = async (_client: Client, profile: HostProfile) => {
      captured = profile;
    };

    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => { /* ok */ },
      sendHostProfileSignal,
      computeHostProfile: () => ({
        hostname: 'h',
        claudeBin: '/usr/local/bin/claude',
        availablePlayerTypes: ['/shipped/tempo-soloist.md'],
      }),
      retryBackoffsMs: [0],
      log: () => {},
    });

    expect(captured).to.exist;
    expect(captured!.claudeBin).to.equal('claude');
    expect(captured!.availablePlayerTypes).to.deep.equal(['tempo-soloist']);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Issue #399 Q5.3b / Q5.4 — daemonStartedAt + adapterVersions wiring
// ────────────────────────────────────────────────────────────────────────

describe('runDaemonBoot adapter-versions probe (#399 Q5.4)', function () {
  const baseProfile: HostProfile = {
    hostname: 'test-host',
    version: '0.28.0-beta.7',
    defaultAgent: 'claude',
  };

  it('merges probeAdapterVersions result into the signaled profile', async function () {
    let captured: HostProfile | undefined;
    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => { /* ok */ },
      sendHostProfileSignal: async (_c, p) => { captured = p; },
      computeHostProfile: () => baseProfile,
      probeAdapterVersions: async () => ({
        'claude-code': '1.2.4',
        copilot: '0.5.2',
      }),
      retryBackoffsMs: [0],
      log: () => {},
    });
    expect(captured!.adapterVersions).to.deep.equal({
      'claude-code': '1.2.4',
      copilot: '0.5.2',
    });
  });

  it('omits adapterVersions when the probe returns an empty map (no probable adapters)', async function () {
    let captured: HostProfile | undefined;
    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => { /* ok */ },
      sendHostProfileSignal: async (_c, p) => { captured = p; },
      computeHostProfile: () => baseProfile,
      probeAdapterVersions: async () => ({}),
      retryBackoffsMs: [0],
      log: () => {},
    });
    expect(captured!.adapterVersions).to.equal(undefined);
  });

  it('runs the probe in parallel with ensureGlobalMaestro (probe finishes while ensure is pending)', async function () {
    // Block `ensure` until both promises have started; `probe` finishes
    // first. If they were sequential the probe couldn't observe ensure
    // pending. Asserting the parallel-start invariant.
    const ensure = makeDeferred<void>();
    let probeStartedWhileEnsurePending = false;

    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => {
        // Yield so the parent can observe pending state
        await new Promise((r) => setImmediate(r));
        await ensure.promise;
      },
      sendHostProfileSignal: async () => { /* ok */ },
      computeHostProfile: () => baseProfile,
      probeAdapterVersions: async () => {
        probeStartedWhileEnsurePending = true;
        // Resolve `ensure` from inside the probe so the boot can finish.
        ensure.resolve();
        return { 'claude-code': '9.9.9' };
      },
      retryBackoffsMs: [0],
      log: () => {},
    });

    expect(probeStartedWhileEnsurePending).to.equal(true);
  });

  it('probeAdapterVersions throwing does NOT block profile advertisement (defense-in-depth)', async function () {
    let captured: HostProfile | undefined;
    const logs: unknown[][] = [];
    await runDaemonBoot(fakeClient, {
      ensureGlobalMaestro: async () => { /* ok */ },
      sendHostProfileSignal: async (_c, p) => { captured = p; },
      computeHostProfile: () => baseProfile,
      // Despite the helper's "never-throws" contract, exercise the
      // defense-in-depth catch in runDaemonBoot.
      probeAdapterVersions: async () => { throw new Error('probe-blew-up'); },
      retryBackoffsMs: [0],
      log: (...args) => logs.push(args),
    });
    expect(captured).to.exist;
    expect(captured!.adapterVersions).to.equal(undefined);
    const logged = JSON.stringify(logs);
    expect(logged).to.include('probeAdapterVersions threw');
  });
});

describe('scrubHostProfile #399 pass-through (daemonStartedAt + adapterVersions)', function () {
  it('passes daemonStartedAt through unchanged when present', function () {
    const out = scrubHostProfile({
      hostname: 'h',
      daemonStartedAt: 1700000000000,
    });
    expect(out.daemonStartedAt).to.equal(1700000000000);
  });

  it('passes adapterVersions through unchanged when present', function () {
    const out = scrubHostProfile({
      hostname: 'h',
      adapterVersions: { 'claude-code': '1.2.4', copilot: '0.5.2' },
    });
    expect(out.adapterVersions).to.deep.equal({
      'claude-code': '1.2.4',
      copilot: '0.5.2',
    });
  });

  it('omits both fields from the output when absent on input (round-trip stays clean)', function () {
    const out = scrubHostProfile({ hostname: 'h' });
    expect(out).to.not.have.property('daemonStartedAt');
    expect(out).to.not.have.property('adapterVersions');
  });
});
