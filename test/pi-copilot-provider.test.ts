/**
 * Unit tests for the Phase-3 / 3b Copilot-provider pure pieces:
 *   B1 — parsePiProviderModel (src/config.ts): recruit "provider/model" → parts.
 *   B2 — probeCopilotPiPreflight + meetsVersionFloor (src/pi/probe.ts) and the
 *        findSdkPackageJson / readSdkPackageVersion refactor (src/utils/sdk-probe.ts).
 *
 * All pure / injectable — no live Pi install, no real ~/.pi, no Temporal.
 */
import { expect } from 'chai';
import { parsePiProviderModel } from '../src/config';
import {
  meetsVersionFloor,
  probeCopilotPiPreflight,
  PI_PACKAGE,
  PI_AI_PACKAGE,
  PI_VERSION_FLOOR,
} from '../src/pi/probe';
import { findSdkPackageJson, probeSdkInstall, readSdkPackageVersion } from '../src/utils/sdk-probe';

describe('B1 parsePiProviderModel — valid selectors', () => {
  it('splits "github-copilot/gpt-4o" into { provider, model }', () => {
    expect(parsePiProviderModel('github-copilot/gpt-4o')).to.deep.equal({
      provider: 'github-copilot',
      model: 'gpt-4o',
    });
  });

  it('passes the provider through verbatim (no normalization)', () => {
    const r = parsePiProviderModel('github-copilot/claude-sonnet-4');
    expect(r).to.deep.equal({ provider: 'github-copilot', model: 'claude-sonnet-4' });
  });

  it('is provider-agnostic (anthropic, openai, …)', () => {
    expect(parsePiProviderModel('anthropic/claude-opus-4-7')).to.deep.equal({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
  });

  it('splits on the FIRST "/" — a model id may itself contain "/"', () => {
    expect(parsePiProviderModel('openrouter/anthropic/claude-3.5')).to.deep.equal({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePiProviderModel('  github-copilot/gpt-4o  ')).to.deep.equal({
      provider: 'github-copilot',
      model: 'gpt-4o',
    });
  });
});

describe('B1 parsePiProviderModel — fail-loud (no silent default)', () => {
  const errOf = (input: string): string => {
    const r = parsePiProviderModel(input);
    expect(r, `expected { error } for ${JSON.stringify(input)}`).to.have.property('error');
    return (r as { error: string }).error;
  };

  it('rejects a bare provider with no "/"', () => {
    expect(errOf('github-copilot')).to.contain('no "/"');
  });

  it('rejects an empty provider before "/"', () => {
    expect(errOf('/gpt-4o')).to.contain('empty provider');
  });

  it('rejects an empty model after "/"', () => {
    expect(errOf('github-copilot/')).to.contain('empty model');
  });

  it('rejects whitespace-only model after "/"', () => {
    expect(errOf('github-copilot/   ')).to.contain('empty model');
  });

  it('error messages echo the offending input', () => {
    expect(errOf('bogus')).to.contain('"bogus"');
  });
});

describe('B2 meetsVersionFloor', () => {
  it('accepts exactly the floor', () => {
    expect(meetsVersionFloor('0.78.0', '0.78.0')).to.equal(true);
  });

  it('accepts versions above the floor (patch / minor / major)', () => {
    expect(meetsVersionFloor('0.78.1')).to.equal(true);
    expect(meetsVersionFloor('0.79.0')).to.equal(true);
    expect(meetsVersionFloor('1.0.0')).to.equal(true);
  });

  it('rejects versions below the floor', () => {
    expect(meetsVersionFloor('0.77.9')).to.equal(false);
    expect(meetsVersionFloor('0.77.0')).to.equal(false);
    expect(meetsVersionFloor('0.0.1')).to.equal(false);
  });

  it('ignores a pre-release/build suffix at/above the floor', () => {
    expect(meetsVersionFloor('0.79.0-beta.1')).to.equal(true);
    expect(meetsVersionFloor('1.0.0+sha.abc')).to.equal(true);
  });

  it('tolerates a leading "v" and a missing patch', () => {
    expect(meetsVersionFloor('v0.78')).to.equal(true);
    expect(meetsVersionFloor('v0.77')).to.equal(false);
  });

  it('treats an unparseable version as below the floor (conservative)', () => {
    expect(meetsVersionFloor('')).to.equal(false);
    expect(meetsVersionFloor('not-a-version')).to.equal(false);
  });
});

describe('B2 probeCopilotPiPreflight — injected deps', () => {
  /** Build deps for the all-good baseline, overridable per test. */
  const goodDeps = (over: Partial<Parameters<typeof probeCopilotPiPreflight>[0]> = {}) => ({
    isInstalled: () => true,
    installedVersion: () => '0.78.0',
    env: { COPILOT_GITHUB_TOKEN: 'gho_test' } as NodeJS.ProcessEnv,
    authFileExists: () => false,
    ...over,
  });

  it('passes when deps installed, version meets floor, auth via env', () => {
    expect(probeCopilotPiPreflight(goodDeps()).available).to.equal(true);
  });

  it('passes when auth is via the mounted ~/.pi/agent/auth.json (no env token)', () => {
    const r = probeCopilotPiPreflight(goodDeps({ env: {}, authFileExists: () => true }));
    expect(r.available).to.equal(true);
  });

  it('fails when the Pi SDK package is missing', () => {
    const r = probeCopilotPiPreflight(goodDeps({ isInstalled: (p) => p !== PI_PACKAGE }));
    expect(r.available).to.equal(false);
    expect(r.reason).to.contain(PI_PACKAGE);
  });

  it('fails when the pi-ai package is missing', () => {
    const r = probeCopilotPiPreflight(goodDeps({ isInstalled: (p) => p !== PI_AI_PACKAGE }));
    expect(r.available).to.equal(false);
    expect(r.reason).to.contain(PI_AI_PACKAGE);
  });

  it('fails when the version is below the floor', () => {
    const r = probeCopilotPiPreflight(goodDeps({ installedVersion: () => '0.77.9' }));
    expect(r.available).to.equal(false);
    expect(r.reason).to.contain(PI_VERSION_FLOOR);
  });

  it('fails when the version is unreadable (null)', () => {
    const r = probeCopilotPiPreflight(goodDeps({ installedVersion: () => null }));
    expect(r.available).to.equal(false);
    expect(r.reason).to.contain('version');
  });

  it('fails when neither COPILOT_GITHUB_TOKEN nor auth.json is present', () => {
    const r = probeCopilotPiPreflight(goodDeps({ env: {}, authFileExists: () => false }));
    expect(r.available).to.equal(false);
    expect(r.reason).to.contain('Copilot auth');
  });

  it('every failure reason mentions the force:true bypass', () => {
    const r = probeCopilotPiPreflight(goodDeps({ env: {}, authFileExists: () => false }));
    expect(r.reason).to.contain('force: true');
  });
});

describe('B2 sdk-probe refactor — findSdkPackageJson / readSdkPackageVersion', () => {
  // `chai` is a real installed dependency — a stable fixture for the fs walk.
  it('findSdkPackageJson resolves an installed package to its package.json path', () => {
    const p = findSdkPackageJson('chai');
    expect(p).to.be.a('string');
    expect(p!.replace(/\\/g, '/')).to.contain('node_modules/chai/package.json');
  });

  it('findSdkPackageJson returns null for a non-existent package', () => {
    expect(findSdkPackageJson('@no-such-scope/definitely-not-installed-xyz')).to.equal(null);
  });

  it('probeSdkInstall behavior is preserved (true for installed, false otherwise)', () => {
    expect(probeSdkInstall('chai')).to.equal(true);
    expect(probeSdkInstall('@no-such-scope/definitely-not-installed-xyz')).to.equal(false);
  });

  it('readSdkPackageVersion returns a dotted version for an installed package', () => {
    const v = readSdkPackageVersion('chai');
    expect(v).to.be.a('string');
    expect(v).to.match(/^\d+\.\d+\.\d+/);
  });

  it('readSdkPackageVersion returns null for a non-existent package', () => {
    expect(readSdkPackageVersion('@no-such-scope/definitely-not-installed-xyz')).to.equal(null);
  });
});
