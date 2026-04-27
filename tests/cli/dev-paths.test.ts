/**
 * Unit tests for `resolveTempoHome()` and the dev-mode-aware Config
 * defaults (ADR 0014 §5.1, §5.3).
 *
 *   - Dev mode flips the home dir to `~/.claude-tempo-dev/`.
 *   - `CLAUDE_TEMPO_HOME_OVERRIDE` wins over both prod and dev defaults.
 *   - `getConfig()` defaults `temporalNamespace` and `taskQueue` to the
 *     dev variants when `isDevMode()` is true.
 *   - Negative case: env unset → production paths/values everywhere.
 *
 * NOTE: `CLAUDE_TEMPO_HOME` is a module-load-time constant, so it can't
 * be re-evaluated by toggling env vars at test time. The constant path
 * is covered indirectly: `resolveTempoHome()` is exported so we can
 * exercise the three-tier precedence directly, and the live constant is
 * implicitly exercised by the CLI integration test that runs the binary
 * with `--dev` and inspects file-system side effects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  DEV_HOME_DIR_NAME,
  DEV_TASK_QUEUE,
  DEV_TEMPORAL_NAMESPACE,
  ENV,
  PROD_HOME_DIR_NAME,
  PROD_TASK_QUEUE,
  PROD_TEMPORAL_NAMESPACE,
  getConfig,
  resolveTempoHome,
} from '../../src/config';

describe('resolveTempoHome (ADR 0014 §5.3)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      DEV_MODE: process.env[ENV.DEV_MODE],
      DEV_HOME_OVERRIDE: process.env[ENV.DEV_HOME_OVERRIDE],
    };
    delete process.env[ENV.DEV_MODE];
    delete process.env[ENV.DEV_HOME_OVERRIDE];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = ENV[key as keyof typeof ENV];
      if (value == null) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it('returns the production home dir when dev mode is off', () => {
    expect(resolveTempoHome()).toBe(join(homedir(), PROD_HOME_DIR_NAME));
  });

  it('returns the dev home dir when CLAUDE_TEMPO_DEV_MODE=1', () => {
    process.env[ENV.DEV_MODE] = '1';
    expect(resolveTempoHome()).toBe(join(homedir(), DEV_HOME_DIR_NAME));
  });

  it('honors CLAUDE_TEMPO_HOME_OVERRIDE in production', () => {
    process.env[ENV.DEV_HOME_OVERRIDE] = '/tmp/scratch-prod';
    expect(resolveTempoHome()).toBe('/tmp/scratch-prod');
  });

  it('honors CLAUDE_TEMPO_HOME_OVERRIDE even in dev mode (highest precedence)', () => {
    // The override is the v1 escape hatch for triple-isolated envs (ADR
    // 0014 §5.3). It MUST win over the dev default, otherwise a power
    // user setting both can't actually point to a third profile.
    process.env[ENV.DEV_MODE] = '1';
    process.env[ENV.DEV_HOME_OVERRIDE] = '/tmp/scratch-staging';
    expect(resolveTempoHome()).toBe('/tmp/scratch-staging');
  });
});

describe('getConfig dev-aware defaults (ADR 0014 §5.1)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      DEV_MODE: process.env[ENV.DEV_MODE],
      TEMPORAL_NAMESPACE: process.env[ENV.TEMPORAL_NAMESPACE],
      TASK_QUEUE: process.env[ENV.TASK_QUEUE],
      ENSEMBLE: process.env[ENV.ENSEMBLE],
    };
    delete process.env[ENV.DEV_MODE];
    delete process.env[ENV.TEMPORAL_NAMESPACE];
    delete process.env[ENV.TASK_QUEUE];
    // Pin ensemble so the validator doesn't depend on the developer's
    // shell environment.
    process.env[ENV.ENSEMBLE] = 'test-ensemble';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = ENV[key as keyof typeof ENV];
      if (value == null) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  it('production defaults when dev mode is off', () => {
    const config = getConfig();
    expect(config.temporalNamespace).toBe(PROD_TEMPORAL_NAMESPACE);
    expect(config.taskQueue).toBe(PROD_TASK_QUEUE);
  });

  it('dev defaults when CLAUDE_TEMPO_DEV_MODE=1', () => {
    process.env[ENV.DEV_MODE] = '1';
    const config = getConfig();
    expect(config.temporalNamespace).toBe(DEV_TEMPORAL_NAMESPACE);
    expect(config.taskQueue).toBe(DEV_TASK_QUEUE);
  });

  it('explicit env-var overrides win over dev defaults', () => {
    process.env[ENV.DEV_MODE] = '1';
    process.env[ENV.TEMPORAL_NAMESPACE] = 'my-custom-ns';
    process.env[ENV.TASK_QUEUE] = 'my-custom-queue';
    const config = getConfig();
    expect(config.temporalNamespace).toBe('my-custom-ns');
    expect(config.taskQueue).toBe('my-custom-queue');
  });

  it('CLI overrides win over dev defaults (namespace)', () => {
    process.env[ENV.DEV_MODE] = '1';
    const config = getConfig({ temporalNamespace: 'cli-override-ns' });
    expect(config.temporalNamespace).toBe('cli-override-ns');
    // taskQueue still defaults to dev — it has no CLI override path.
    expect(config.taskQueue).toBe(DEV_TASK_QUEUE);
  });
});
