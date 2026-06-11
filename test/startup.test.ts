/**
 * Integration-ish tests for the #289 bootstrap state machine.
 *
 * These exercise the real `bootstrap()` entry point end-to-end with
 * stubbed `fetchLatestVersion` + a temp cache dir. The Temporal target is
 * deliberately remote-and-unreachable so:
 *   - Step 3 (temporal reach) fails with a "remote unreachable" message
 *     (auto-start path gated to local addresses — we don't accidentally
 *     spawn a real dev server here).
 *   - Step 4 (search attrs) skips because step 3 failed.
 *   - Step 6 (badges) degrades to zero-count / empty-list (Temporal
 *     connect fails inside the try/catch).
 *
 * Unit-level coverage for cache + semver policy lives in
 * `tests/cli/startup.test.ts` (Vitest).
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config } from '../src/config';
import { bootstrap, type BootstrapResult } from '../src/cli/startup';

function tmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-startup-mocha-'));
}

/** Non-local, guaranteed-closed port — the Temporal gRPC connect fails
 *  fast (ECONNREFUSED) instead of waiting for a DNS timeout. `127.0.0.2`
 *  is NOT in `isLocalAddress`'s allowlist, so the step-3 auto-start path
 *  is skipped and we exercise the "remote unreachable" branch. */
const DEAD_REMOTE_ADDRESS = '127.0.0.2:1';

function baseConfig(): Config {
  return {
    temporalAddress: DEAD_REMOTE_ADDRESS,
    temporalNamespace: 'default',
    taskQueue: 'agent-tempo',
    ensemble: 'bootstrap-mocha-test',
    defaultAgent: 'claude',
    costProfile: 'local',
  };
}

describe('bootstrap() — degraded path (Temporal unreachable)', function () {
  this.timeout(20_000);
  let cacheDir: string;

  beforeEach(function () {
    cacheDir = tmpCacheDir();
  });
  afterEach(function () {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns a BootstrapResult even when Temporal is unreachable', async function () {
    const result: BootstrapResult = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      // Silent-offline fetch so the <500ms budget isn't touched.
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });

    expect(result.durationMs).to.be.a('number').greaterThan(0);
    expect(result.cwd).to.be.a('string').with.length.greaterThan(0);
    expect(result.ensembles).to.be.an('array');
    expect(result.badges.orphanCount).to.equal(0);
    // npm fetch mocked to null → no outdated badge.
    expect(result.badges.outdatedVersion).to.be.undefined;
  });

  it('populates every step key on `steps`', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    const expectedKeys = ['legacyHomeMigration', 'preflight', 'mcpConfig', 'temporalReach', 'searchAttrs', 'daemonBoot', 'badgeCollection'];
    for (const k of expectedKeys) {
      expect(result.steps, `missing step "${k}"`).to.have.property(k);
      const outcome = (result.steps as any)[k];
      expect(outcome.status).to.be.oneOf(['ok', 'skipped', 'action-taken', 'failed']);
      expect(outcome.durationMs).to.be.a('number');
    }
  });

  it('step 3 (temporalReach) fails when remote Temporal is unreachable', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.steps.temporalReach.status).to.equal('failed');
    expect(result.steps.temporalReach.detail).to.match(/remote Temporal|unreachable/i);
  });

  it('step 4 (searchAttrs) skips when step 3 failed (skipping temporal-dependent work)', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.steps.searchAttrs.status).to.equal('skipped');
  });

  it('cache is written after a bootstrap run', async function () {
    await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    const cachePath = path.join(cacheDir, '.bootstrap-cache.json');
    expect(fs.existsSync(cachePath)).to.be.true;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(parsed.schemaVersion).to.equal(1);
    expect(parsed.binaryVersion).to.equal('0.26.0');
  });

  it('second bootstrap run on the same cache skips preflight (24h TTL hit)', async function () {
    // First run populates the cache.
    await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    // Second run within TTL — preflight should be skipped.
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.steps.preflight.status).to.equal('skipped');
  });

  it('binaryVersion bump invalidates the cache (upgrade path)', async function () {
    await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    // New binary version → cache wiped → preflight re-runs.
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.27.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.steps.preflight.status).to.not.equal('skipped');
  });

  it('records outdatedVersion badge when fetcher returns a later minor', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.25.0',
      fetchLatestVersion: async () => '0.26.0',
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.badges.outdatedVersion).to.deep.equal({ latest: '0.26.0', severity: 'minor' });
  });

  it('silent on patch-behind (no badge)', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => '0.26.1',
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.badges.outdatedVersion).to.be.undefined;
  });

  it('npm fetch timeout (null) leaves outdatedVersion undefined AND skips cache update', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
    });
    expect(result.badges.outdatedVersion).to.be.undefined;
    // Cache file should exist, but `npmVersionCheck` should NOT have an entry
    // so the next bootstrap tries again immediately (no 24h lockout on a
    // transient network failure).
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, '.bootstrap-cache.json'), 'utf8'));
    expect(parsed.steps.npmVersionCheck).to.be.undefined;
  });

  // PR-2 of the v1.0 rebrand — step 0 (legacy home migration) wiring.
  it('legacyHomeMigration step runs before preflight and surfaces its StepOutcome', async function () {
    const callOrder: string[] = [];
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => {
        callOrder.push('daemonBoot');
        return { status: 'skipped', durationMs: 0 };
      },
      isTemporalReachable: async () => {
        callOrder.push('isTemporalReachable');
        return false;
      },
      legacyHomeMigration: async () => {
        callOrder.push('legacyHomeMigration');
        return { status: 'action-taken', durationMs: 1, detail: 'migrated 3 files' };
      },
    });
    expect(callOrder[0]).to.equal('legacyHomeMigration');
    expect(result.steps.legacyHomeMigration.status).to.equal('action-taken');
    expect(result.steps.legacyHomeMigration.detail).to.equal('migrated 3 files');
  });

  it('legacyHomeMigration failure does not block the rest of bootstrap', async function () {
    const result = await bootstrap({
      config: baseConfig(),
      cacheDir,
      binaryVersion: '0.26.0',
      fetchLatestVersion: async () => null,
      daemonBoot: async () => ({ status: 'skipped', durationMs: 0 }),
      isTemporalReachable: async () => false,
      legacyHomeMigration: async () => ({
        status: 'failed',
        durationMs: 2,
        detail: 'simulated permission error',
      }),
    });
    expect(result.steps.legacyHomeMigration.status).to.equal('failed');
    // Subsequent steps still produced outcomes — bootstrap didn't short-circuit.
    expect(result.steps.preflight).to.have.property('status');
    expect(result.steps.badgeCollection).to.have.property('status');
  });
});
