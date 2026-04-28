/**
 * Unit coverage for `probeAdapterVersions()` (#399 Q5.4).
 *
 * Stubs both spawn (`runCommand`) and the SDK package.json resolver so
 * the suite never spawns a real `claude` / `gh` binary, never reads a
 * real package.json, and finishes in <50 ms even on slow CI shards.
 *
 * Invariants under test:
 *   - claude-code: regex parse, leading-`v` tolerance, multi-line
 *     greeting tolerance, fail-then-omit on spawn rejection / no match
 *   - copilot: package.json version pass-through, omit when SDK absent
 *   - both adapters fail → empty map (NOT throw)
 *   - both adapters succeed in parallel (ordering doesn't matter)
 */
import { expect } from 'chai';
import { probeAdapterVersions } from '../src/daemon-adapter-versions';

const noLog = () => {};

describe('probeAdapterVersions (#399 Q5.4)', function () {
  it('parses claude --version output (plain semver)', async function () {
    const out = await probeAdapterVersions({
      runCommand: async (cmd) => {
        if (cmd === 'claude') return '1.2.4\n';
        throw new Error('unexpected cmd');
      },
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({ 'claude-code': '1.2.4' });
  });

  it('tolerates a leading `v` and trailing pre-release suffix', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => 'v0.5.2-rc.1 (Claude Code beta)\n',
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({ 'claude-code': '0.5.2-rc.1' });
  });

  it('tolerates a multi-line greeting and picks the FIRST semver triple', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => 'Claude Code\nCopyright 2026\nVersion 2.0.1 (build 8841)\n',
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({ 'claude-code': '2.0.1' });
  });

  it('omits claude-code when --version output has no MAJOR.MINOR.PATCH match', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => 'something completely garbled — no version here',
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });

  it('omits claude-code when the spawn rejects (binary missing, ENOENT, timeout)', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => {
        const err = new Error('spawn ENOENT');
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      },
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });

  it('passes copilot SDK package.json version through verbatim', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => { throw new Error('skip'); },
      resolveCopilotSdkVersion: async () => '0.5.2',
      log: noLog,
    });
    expect(out).to.deep.equal({ copilot: '0.5.2' });
  });

  it('omits copilot when the SDK is not installed (resolver returns undefined)', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => { throw new Error('skip'); },
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });

  it('omits copilot when the SDK package.json version is unparseable', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => { throw new Error('skip'); },
      resolveCopilotSdkVersion: async () => 'not-a-version',
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });

  it('omits copilot when the resolver throws (defensive — never propagate)', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => { throw new Error('skip'); },
      resolveCopilotSdkVersion: async () => { throw new Error('require failed'); },
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });

  it('returns both keys when both probes succeed (parallel — ordering does not matter)', async function () {
    // Track call order to assert parallelism — both probes start before
    // the slower one resolves.
    const startOrder: string[] = [];
    const out = await probeAdapterVersions({
      runCommand: async () => {
        startOrder.push('claude:start');
        // Yield to let copilot probe also start before we resolve.
        await new Promise((r) => setImmediate(r));
        startOrder.push('claude:resolve');
        return '1.2.4';
      },
      resolveCopilotSdkVersion: async () => {
        startOrder.push('copilot:start');
        return '0.5.2';
      },
      log: noLog,
    });
    expect(out).to.deep.equal({ 'claude-code': '1.2.4', copilot: '0.5.2' });
    // Both probes started before claude resolved — confirms parallel.
    const claudeStartIdx = startOrder.indexOf('claude:start');
    const copilotStartIdx = startOrder.indexOf('copilot:start');
    const claudeResolveIdx = startOrder.indexOf('claude:resolve');
    expect(claudeStartIdx).to.be.lessThan(claudeResolveIdx);
    expect(copilotStartIdx).to.be.lessThan(claudeResolveIdx);
  });

  it('returns an empty map when both probes fail (never throws)', async function () {
    const out = await probeAdapterVersions({
      runCommand: async () => { throw new Error('claude gone'); },
      resolveCopilotSdkVersion: async () => undefined,
      log: noLog,
    });
    expect(out).to.deep.equal({});
  });
});
