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
import { buildPiResourceLoaderOptions } from '../src/pi/headless';

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
