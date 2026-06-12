/**
 * costProfile resolution — env > config.json > 'local' (#765).
 *
 * The #763 window-B forensics exposed the plumbing gap class my unit tests
 * couldn't see: the AggregateRunner test injected `costProfile` directly,
 * so nothing asserted that a profile persisted in **config.json** actually
 * reaches `getConfig()` in a fresh process (the daemon's path). This file
 * closes that gap with a REAL config.json round-trip under an isolated
 * home (`AGENT_TEMPO_HOME_OVERRIDE` + module-cache reset, so the
 * module-load-time CONFIG_FILE_PATH points at the temp home).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MUTATED = [
  'AGENT_TEMPO_HOME_OVERRIDE',
  'AGENT_TEMPO_COST_PROFILE',
  'AGENT_TEMPO_ENSEMBLE',
  'AGENT_TEMPO_DEV_MODE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of MUTATED) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of MUTATED) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

/** Fresh-import getConfig with an isolated home dir containing `configJson`. */
async function resolveWithHome(
  configJson: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'at-costprofile-'));
  if (configJson) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(configJson));
  }
  for (const k of MUTATED) delete process.env[k];
  process.env.AGENT_TEMPO_HOME_OVERRIDE = home;
  process.env.AGENT_TEMPO_ENSEMBLE = 'test-ensemble';
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  const cfg = await import('../../src/config');
  return {
    config: cfg.getConfig(),
    withSources: cfg.getConfigWithSources(),
  };
}

describe('costProfile resolution (#765)', () => {
  it('config.json round-trip: a persisted costProfile reaches getConfig() (the daemon path)', async () => {
    const { config, withSources } = await resolveWithHome({ costProfile: 'cloud' }, {});
    expect(config.costProfile).toBe('cloud');
    // `config show` must report the same value + source (no path drift).
    expect(withSources.config.costProfile).toBe('cloud');
    expect(withSources.sources.costProfile).toBe('config');
  });

  it('env var beats config.json', async () => {
    const { config } = await resolveWithHome(
      { costProfile: 'cloud' },
      { AGENT_TEMPO_COST_PROFILE: 'local' },
    );
    expect(config.costProfile).toBe('local');
  });

  it('absent everywhere → local default', async () => {
    const { config, withSources } = await resolveWithHome(null, {});
    expect(config.costProfile).toBe('local');
    expect(withSources.sources.costProfile).toBe('default');
  });

  it('garbage in config.json falls back to local (lenient at READ time; set-time validation is configSet)', async () => {
    const { config } = await resolveWithHome({ costProfile: 'clout' }, {});
    expect(config.costProfile).toBe('local');
  });
});
