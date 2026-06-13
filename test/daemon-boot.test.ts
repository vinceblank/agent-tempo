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
  computeHostProfile,
  runDaemonBoot,
  scrubHostProfile,
  warnIfDevNamespaceDrift,
} from '../src/daemon';
import type { Config } from '../src/config';
import { DEV_TEMPORAL_NAMESPACE, ENV } from '../src/config';

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
// computeHostProfile — copilot probe (#532 PR-2)
// ────────────────────────────────────────────────────────────────────────
//
// Asserts the host-profile probe correctly advertises 'copilot' in
// `availableAgentTypes` when the SDK is installed, and excludes it
// when the SDK is missing. The probe itself lives in
// `src/daemon-adapter-versions.ts:resolveCopilotSdkVersionSync`; here
// we exercise the daemon-side glue via the `ComputeHostProfileDeps`
// dep-injection seam that #532 PR-2 added to keep `computeHostProfile`
// synchronous (matching the existing `claude-code-headless` block).

describe('computeHostProfile copilot probe (#532 PR-2)', function () {
  // Minimal Config — `computeHostProfile` only reads `defaultAgent`
  // and `claudeBin` from it. Everything else can stay undefined.
  const baseConfig = {
    defaultAgent: 'claude' as const,
    claudeBin: 'claude',
  } as unknown as Config;

  it('advertises `copilot` in availableAgentTypes when the SDK probe returns a version', function () {
    const profile = computeHostProfile(baseConfig, {
      resolveCopilotSdkVersionSync: () => '0.2.0',
    });
    expect(profile.availableAgentTypes).to.include('copilot');
  });

  it('excludes `copilot` from availableAgentTypes when the SDK probe returns undefined', function () {
    const profile = computeHostProfile(baseConfig, {
      resolveCopilotSdkVersionSync: () => undefined,
    });
    expect(profile.availableAgentTypes).to.not.include('copilot');
  });

  // Tripwire — `resolveCopilotSdkVersionSync` is contracted to never
  // throw (it swallows MODULE_NOT_FOUND etc.), but `computeHostProfile`
  // is on the daemon-boot critical path and must survive any surprise
  // from a future loosening of that guard.
  it('does NOT crash when the SDK probe throws — `copilot` is excluded', function () {
    const profile = computeHostProfile(baseConfig, {
      resolveCopilotSdkVersionSync: () => {
        throw new Error('synthetic failure');
      },
    });
    expect(profile.availableAgentTypes).to.not.include('copilot');
  });

  it('does not double-add `copilot` when it is also the configured defaultAgent', function () {
    const profile = computeHostProfile(
      { ...baseConfig, defaultAgent: 'copilot' as const } as unknown as Config,
      { resolveCopilotSdkVersionSync: () => '0.2.0' },
    );
    const copilotEntries = (profile.availableAgentTypes ?? []).filter(
      (a) => a === 'copilot',
    );
    expect(copilotEntries).to.have.length(1);
  });

  it('uses the production helper when no `resolveCopilotSdkVersionSync` dep is passed (smoke test)', function () {
    // Production callers omit `deps` entirely. We don't assert on the
    // outcome (host environment may or may not have @github/copilot-sdk
    // installed), only that the call doesn't crash and returns a
    // well-shaped profile. The DI seam is what's under test — the
    // default fall-through path is critical for the daemon-boot path.
    const profile = computeHostProfile(baseConfig);
    expect(profile.availableAgentTypes).to.be.an('array');
    expect(profile.availableAgentTypes).to.include('claude'); // defaultAgent always present
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeHostProfile — pi / opencode / claude-api probes (#819)
// ────────────────────────────────────────────────────────────────────────
//
// Asserts that the daemon's host-profile advertisement includes optional
// adapter types when their dep-injection probes report availability.
// Uses the same DI seam pattern as the copilot probe tests above: the
// production defaults call the real filesystem/process probes; here we
// inject stubs to make the tests deterministic without touching the host.

describe('computeHostProfile pi probe (#819)', function () {
  const baseConfig = {
    defaultAgent: 'claude' as const,
    claudeBin: 'claude',
  } as unknown as Config;

  it('advertises `pi` in availableAgentTypes when probe returns { available: true }', function () {
    const profile = computeHostProfile(baseConfig, {
      probePiSync: () => ({ available: true }),
    });
    expect(profile.availableAgentTypes).to.include('pi');
  });

  it('excludes `pi` from availableAgentTypes when probe returns { available: false }', function () {
    const profile = computeHostProfile(baseConfig, {
      probePiSync: () => ({ available: false }),
    });
    expect(profile.availableAgentTypes).to.not.include('pi');
  });

  it('does NOT crash when probe throws — `pi` is excluded (boot critical path)', function () {
    const profile = computeHostProfile(baseConfig, {
      probePiSync: () => { throw new Error('synthetic failure'); },
    });
    expect(profile.availableAgentTypes).to.not.include('pi');
  });

  it('does not double-add `pi` when it is also the configured defaultAgent', function () {
    const profile = computeHostProfile(
      { ...baseConfig, defaultAgent: 'pi' as const } as unknown as Config,
      { probePiSync: () => ({ available: true }) },
    );
    const piEntries = (profile.availableAgentTypes ?? []).filter((a) => a === 'pi');
    expect(piEntries).to.have.length(1);
  });
});

describe('computeHostProfile opencode probe (#819)', function () {
  const baseConfig = {
    defaultAgent: 'claude' as const,
    claudeBin: 'claude',
  } as unknown as Config;

  it('advertises `opencode` when probe returns true', function () {
    const profile = computeHostProfile(baseConfig, {
      probeOpencodeSync: () => true,
    });
    expect(profile.availableAgentTypes).to.include('opencode');
  });

  it('excludes `opencode` when probe returns false', function () {
    const profile = computeHostProfile(baseConfig, {
      probeOpencodeSync: () => false,
    });
    expect(profile.availableAgentTypes).to.not.include('opencode');
  });

  it('does NOT crash when probe throws — `opencode` is excluded', function () {
    const profile = computeHostProfile(baseConfig, {
      probeOpencodeSync: () => { throw new Error('synthetic failure'); },
    });
    expect(profile.availableAgentTypes).to.not.include('opencode');
  });

  it('does not double-add `opencode` when it is also the configured defaultAgent', function () {
    const profile = computeHostProfile(
      { ...baseConfig, defaultAgent: 'opencode' as const } as unknown as Config,
      { probeOpencodeSync: () => true },
    );
    const entries = (profile.availableAgentTypes ?? []).filter((a) => a === 'opencode');
    expect(entries).to.have.length(1);
  });
});

describe('computeHostProfile claude-api probe (#819)', function () {
  const baseConfig = {
    defaultAgent: 'claude' as const,
    claudeBin: 'claude',
  } as unknown as Config;

  it('advertises `claude-api` when probe returns true', function () {
    const profile = computeHostProfile(baseConfig, {
      probeClaudeApiSync: () => true,
    });
    expect(profile.availableAgentTypes).to.include('claude-api');
  });

  it('excludes `claude-api` when probe returns false (SDK missing or key absent)', function () {
    const profile = computeHostProfile(baseConfig, {
      probeClaudeApiSync: () => false,
    });
    expect(profile.availableAgentTypes).to.not.include('claude-api');
  });

  it('does NOT crash when probe throws — `claude-api` is excluded', function () {
    const profile = computeHostProfile(baseConfig, {
      probeClaudeApiSync: () => { throw new Error('synthetic failure'); },
    });
    expect(profile.availableAgentTypes).to.not.include('claude-api');
  });

  it('does not double-add `claude-api` when it is also the configured defaultAgent', function () {
    const profile = computeHostProfile(
      { ...baseConfig, defaultAgent: 'claude-api' as const } as unknown as Config,
      { probeClaudeApiSync: () => true },
    );
    const entries = (profile.availableAgentTypes ?? []).filter((a) => a === 'claude-api');
    expect(entries).to.have.length(1);
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

// ────────────────────────────────────────────────────────────────────────
// warnIfDevNamespaceDrift — #423 PR-A Fix 3 runtime drift detector
// ────────────────────────────────────────────────────────────────────────

describe('warnIfDevNamespaceDrift (#423 PR-A Fix 3)', function () {
  let savedDevMode: string | undefined;

  beforeEach(function () {
    savedDevMode = process.env[ENV.DEV_MODE];
    delete process.env[ENV.DEV_MODE];
  });

  afterEach(function () {
    if (savedDevMode == null) delete process.env[ENV.DEV_MODE];
    else process.env[ENV.DEV_MODE] = savedDevMode;
  });

  it('does NOT warn when dev mode is off (production daemons are unaffected)', function () {
    // The drift detector is dev-only. Production daemons connect to whatever
    // namespace the operator configured — that's not "drift", that's the
    // happy path.
    const calls: unknown[][] = [];
    const fired = warnIfDevNamespaceDrift(
      { temporalNamespace: 'whatever-prod-ns' },
      (...args) => calls.push(args),
    );
    expect(fired).to.equal(false);
    expect(calls).to.have.lengthOf(0);
  });

  it('does NOT warn when dev mode is on AND namespace matches the dev default', function () {
    // Happy path — `[DEV MODE]` banner says `agent-tempo-dev`, daemon
    // connects to `agent-tempo-dev`, no log noise.
    process.env[ENV.DEV_MODE] = '1';
    const calls: unknown[][] = [];
    const fired = warnIfDevNamespaceDrift(
      { temporalNamespace: DEV_TEMPORAL_NAMESPACE },
      (...args) => calls.push(args),
    );
    expect(fired).to.equal(false);
    expect(calls).to.have.lengthOf(0);
  });

  it('WARNS when dev mode is on but the namespace is NOT the dev default', function () {
    // Load-bearing diagnostic. The detector's whole reason for existing is
    // to catch this case — an operator with a typo'd `config.json` or
    // a regression in the env-var carve-out (Fix 1) would otherwise see
    // the dev banner cheerfully announce isolation while the daemon
    // connects somewhere else.
    process.env[ENV.DEV_MODE] = '1';
    const calls: unknown[][] = [];
    const fired = warnIfDevNamespaceDrift(
      { temporalNamespace: 'default' },
      (...args) => calls.push(args),
    );
    expect(fired).to.equal(true);
    expect(calls).to.have.lengthOf(1);
    // The message must be greppable enough that an operator scanning
    // `daemon.log` for "WARNING" sees it. The `[dev-mode]` prefix matches
    // the existing dev-mode log convention.
    const message = String(calls[0][0]);
    expect(message).to.include('[dev-mode]');
    expect(message).to.include('WARNING');
    expect(message).to.include('namespace drift');
    expect(message).to.include('default'); // the actual resolved value
    expect(message).to.include(DEV_TEMPORAL_NAMESPACE); // the expected default
  });

  it('uses the default `log` sink when no log fn is passed (smoke check)', function () {
    // Production callers omit the log arg. The function must not throw
    // when defaulting to the module-level `log`. We can't easily capture
    // its output without monkey-patching console — settle for a no-throw
    // assertion plus the `fired` return value.
    process.env[ENV.DEV_MODE] = '1';
    const fired = warnIfDevNamespaceDrift({ temporalNamespace: 'something-else' });
    expect(fired).to.equal(true);
  });
});
