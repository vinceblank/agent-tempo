/**
 * Security regression test for S2 (MD-C deny-list soundness) —
 * `buildPiResourceLoaderOptions` (src/pi/headless.ts).
 *
 * The `restricted` tool gate is a DENY-LIST over shell/exec tool NAMES. That
 * "restricted = no host execution" guarantee holds ONLY IF Pi loads no
 * third-party extension that could register an un-blacklisted execution tool.
 * Verified against Pi SDK 0.78 source: `DefaultResourceLoader.reload()` loads
 * DISK/package extensions (`~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`,
 * installed packages) UNLESS `noExtensions: true` — and that flag defaults to
 * `false`. So the loader options MUST set `noExtensions: true` and MUST NOT add
 * `additionalExtensionPaths`, or the deny-list silently becomes bypassable.
 *
 * This test locks both invariants. Pure — no Pi SDK required (the helper just
 * shapes an options object; the SDK consumes it at runtime).
 */
import { expect } from 'chai';
import { buildPiResourceLoaderOptions, computeExcludeTools } from '../src/pi/headless';
import { EXEC_TOOLS } from '../src/security/tool-capability';

describe('Pi headless — resource-loader options (S2 deny-list soundness)', () => {
  const factory = (_pi: never): void => {
    /* inline agent-tempo extension — not invoked here */
  };
  const opts = buildPiResourceLoaderOptions({
    cwd: '/work/dir',
    agentDir: '/home/user/.pi/agent',
    extensionFactory: factory,
  });

  it('sets noExtensions:true — hard-excludes all disk/package extensions', () => {
    expect(opts.noExtensions).to.equal(true);
  });

  it('does NOT set additionalExtensionPaths — that would re-open the exec vector', () => {
    expect(opts).to.not.have.property('additionalExtensionPaths');
  });

  it('loads exactly the one inline factory (our agent-tempo extension)', () => {
    expect(opts.extensionFactories).to.be.an('array').with.length(1);
    expect((opts.extensionFactories as unknown[])[0]).to.equal(factory);
  });

  it('passes cwd and agentDir through unchanged', () => {
    expect(opts.cwd).to.equal('/work/dir');
    expect(opts.agentDir).to.equal('/home/user/.pi/agent');
  });
});

describe('Pi headless — #715 registration-level exec/act exclusion (computeExcludeTools)', () => {
  // Names the exclusion MUST NEVER touch: the agent-tempo MCP coordination tools
  // (registered via renderToPi as extension tools — excludeTools is name-matched
  // against built-ins AND extension tools, so a stray name here would silence
  // coordination). Plus the Pi READ built-ins (kept for observe-only).
  const AGENT_TEMPO_COORD = ['cue', 'report', 'recall', 'ensemble', 'who_am_i', 'recruit', 'destroy'];
  const READ_BUILTINS = ['read', 'grep', 'glob', 'ls'];

  it("toolAccess='restricted' → excludes the canonical EXEC_TOOLS set (exec registration-absent)", () => {
    const ex = computeExcludeTools('restricted', 'autonomous');
    for (const t of EXEC_TOOLS) expect(ex, t).to.include(t);
    expect(ex).to.include('bash');
  });

  it("restricted exclusion never touches read built-ins or agent-tempo coordination tools", () => {
    const ex = computeExcludeTools('restricted', 'autonomous');
    for (const t of [...READ_BUILTINS, ...AGENT_TEMPO_COORD]) expect(ex, t).to.not.include(t);
  });

  it("restricted drives exec-exclusion regardless of policy (restricted + supervised still excludes exec)", () => {
    const ex = computeExcludeTools('restricted', 'supervised');
    expect(ex).to.include('bash');
    // supervised does NOT additionally exclude the act built-ins (those stay gated).
    expect(ex).to.not.include('write');
    expect(ex).to.not.include('edit');
  });

  it("standard/full + supervised|monitored|autonomous → NO exclusion (exec present + gated by #712)", () => {
    expect(computeExcludeTools('standard', 'supervised')).to.deep.equal([]);
    expect(computeExcludeTools('standard', 'monitored')).to.deep.equal([]);
    expect(computeExcludeTools('standard', 'autonomous')).to.deep.equal([]);
    expect(computeExcludeTools('full', 'autonomous')).to.deep.equal([]);
    expect(computeExcludeTools('full', 'supervised')).to.deep.equal([]);
  });

  it("guardrailPolicy='observe-only' → excludes EXEC + the Pi built-in ACT tools (write/edit/multiedit)", () => {
    const ex = computeExcludeTools('standard', 'observe-only');
    expect(ex).to.include('bash');
    for (const t of ['write', 'edit', 'multiedit']) expect(ex, t).to.include(t);
  });

  it("observe-only KEEPS the read built-ins and never excludes agent-tempo coordination tools (those stay handler-gated)", () => {
    const ex = computeExcludeTools('standard', 'observe-only');
    for (const t of [...READ_BUILTINS, ...AGENT_TEMPO_COORD]) expect(ex, t).to.not.include(t);
  });

  it("restricted + observe-only → union (EXEC + act built-ins), de-duplicated", () => {
    const ex = computeExcludeTools('restricted', 'observe-only');
    expect(ex).to.include('bash');
    for (const t of ['write', 'edit', 'multiedit']) expect(ex, t).to.include(t);
    expect(new Set(ex).size, 'no duplicate names').to.equal(ex.length);
  });

  it("treats an absent guardrailPolicy as autonomous (restricted still excludes exec; standard excludes nothing)", () => {
    expect(computeExcludeTools('restricted', undefined)).to.include('bash');
    expect(computeExcludeTools('standard', undefined)).to.deep.equal([]);
  });
});
