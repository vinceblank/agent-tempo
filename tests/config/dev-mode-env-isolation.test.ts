/**
 * Unit tests for the dev-mode env-var carve-out — #423 PR-A (ADR 0014 §5.1).
 *
 * The bug: a user with `export TEMPORAL_NAMESPACE=default` in their shell rc
 * runs `agent-tempo --dev …`. The daemon honors the env var, connects to
 * `default` namespace, and the supposedly-isolated dev profile ends up
 * coordinating with the user's prod ensembles. The dev banner says "namespace
 * agent-tempo-dev" while the worker is actually pointed at `default`.
 *
 * The fix: in dev mode, `TEMPORAL_NAMESPACE` and `TEMPORAL_ADDRESS` env vars
 * are ignored. CLI flags and the dev-mode `config.json` still win — those
 * are explicit per-invocation choices, not shell-wide leak vectors.
 *
 * Coverage:
 *   - Dev mode ignores `TEMPORAL_NAMESPACE` env var (resolves to dev default).
 *   - Dev mode ignores `TEMPORAL_ADDRESS` env var (resolves to localhost default).
 *   - Production mode still honors both env vars (regression guard).
 *   - `TEMPORAL_API_KEY` and `TEMPORAL_TLS_*` env vars remain honored in dev
 *     (per-credential, different concern — architect Q1).
 *   - CLI overrides win over the carve-out in dev mode.
 *   - `getConfigWithSources()` reports the same resolved value (no path
 *     drift between `daemon` and `config show`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_TEMPORAL_NAMESPACE,
  ENV,
  getConfig,
  getConfigWithSources,
} from '../../src/config';

const TEMPORAL_KEYS = [
  ENV.TEMPORAL_ADDRESS,
  ENV.TEMPORAL_NAMESPACE,
  ENV.TEMPORAL_API_KEY,
  ENV.TEMPORAL_TLS_CERT_PATH,
  ENV.TEMPORAL_TLS_KEY_PATH,
];

/** Snapshot + clear all env vars the test mutates so cases don't bleed. */
function withCleanEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...TEMPORAL_KEYS, ENV.DEV_MODE, ENV.ENSEMBLE]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Pin ensemble so getConfig's name validator doesn't depend on the
  // developer's shell environment.
  process.env[ENV.ENSEMBLE] = 'test-ensemble';
  return {
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

describe('dev-mode env-var carve-out (#423 PR-A)', () => {
  let cleanup: { restore: () => void };

  beforeEach(() => {
    cleanup = withCleanEnv();
  });

  afterEach(() => {
    cleanup.restore();
  });

  describe('getConfig — dev mode', () => {
    beforeEach(() => {
      process.env[ENV.DEV_MODE] = '1';
    });

    it('ignores TEMPORAL_NAMESPACE env var (resolves to dev default)', () => {
      process.env[ENV.TEMPORAL_NAMESPACE] = 'default';
      // The user's shell-wide `TEMPORAL_NAMESPACE=default` MUST NOT bleed
      // into dev mode. The dev profile owns its namespace.
      expect(getConfig().temporalNamespace).toBe(DEV_TEMPORAL_NAMESPACE);
    });

    it('ignores TEMPORAL_ADDRESS env var (resolves to localhost default)', () => {
      process.env[ENV.TEMPORAL_ADDRESS] = 'prod.tmprl.cloud:7233';
      // Same isolation guarantee for the address — a stale env from a
      // prod connection script must not silently retarget the dev daemon.
      expect(getConfig().temporalAddress).toBe('localhost:7233');
    });

    it('still honors CLI overrides over the env-var carve-out', () => {
      process.env[ENV.TEMPORAL_NAMESPACE] = 'default';
      process.env[ENV.TEMPORAL_ADDRESS] = 'prod.tmprl.cloud:7233';
      const cfg = getConfig({
        temporalNamespace: 'explicit-override',
        temporalAddress: 'override:7233',
      });
      // Per-invocation overrides are an explicit user choice — they win.
      expect(cfg.temporalNamespace).toBe('explicit-override');
      expect(cfg.temporalAddress).toBe('override:7233');
    });

    it('still honors TEMPORAL_API_KEY env var (per architect Q1)', () => {
      process.env[ENV.TEMPORAL_API_KEY] = 'secret-key';
      // Credentials are a different concern — they're per-credential, not
      // per-environment. Carving them out would force the user to either
      // duplicate credentials into the dev config.json or pass them on
      // every invocation. Architect Q1: leave them alone.
      expect(getConfig().temporalApiKey).toBe('secret-key');
    });

    it('still honors TEMPORAL_TLS_CERT_PATH / TEMPORAL_TLS_KEY_PATH env vars', () => {
      process.env[ENV.TEMPORAL_TLS_CERT_PATH] = '/path/to/cert.pem';
      process.env[ENV.TEMPORAL_TLS_KEY_PATH] = '/path/to/key.pem';
      const cfg = getConfig();
      expect(cfg.temporalTlsCertPath).toBe('/path/to/cert.pem');
      expect(cfg.temporalTlsKeyPath).toBe('/path/to/key.pem');
    });
  });

  describe('getConfig — production mode (regression guard)', () => {
    it('still honors TEMPORAL_NAMESPACE env var when not in dev mode', () => {
      // Negative case — the carve-out MUST be gated on dev mode. Otherwise
      // every prod operator suddenly loses their `TEMPORAL_NAMESPACE`
      // override.
      process.env[ENV.TEMPORAL_NAMESPACE] = 'my-prod-ns';
      expect(getConfig().temporalNamespace).toBe('my-prod-ns');
    });

    it('still honors TEMPORAL_ADDRESS env var when not in dev mode', () => {
      process.env[ENV.TEMPORAL_ADDRESS] = 'prod.tmprl.cloud:7233';
      expect(getConfig().temporalAddress).toBe('prod.tmprl.cloud:7233');
    });
  });

  describe('getConfigWithSources — dev/prod parity', () => {
    it('dev mode reports namespace source as "default" (env var ignored)', () => {
      process.env[ENV.DEV_MODE] = '1';
      process.env[ENV.TEMPORAL_NAMESPACE] = 'default';
      const { config, sources } = getConfigWithSources();
      // Both the value and the source must reflect the carve-out — otherwise
      // `config show` reports `env: default` while the daemon connects to
      // `agent-tempo-dev`, recreating the original drift bug for users
      // debugging via `config show`.
      expect(config.temporalNamespace).toBe(DEV_TEMPORAL_NAMESPACE);
      expect(sources.temporalNamespace).toBe('default');
    });

    it('dev mode reports address source as "default" (env var ignored)', () => {
      process.env[ENV.DEV_MODE] = '1';
      process.env[ENV.TEMPORAL_ADDRESS] = 'prod.tmprl.cloud:7233';
      const { config, sources } = getConfigWithSources();
      expect(config.temporalAddress).toBe('localhost:7233');
      expect(sources.temporalAddress).toBe('default');
    });

    it('prod mode reports namespace source as "env" (env var honored)', () => {
      process.env[ENV.TEMPORAL_NAMESPACE] = 'my-prod-ns';
      const { config, sources } = getConfigWithSources();
      expect(config.temporalNamespace).toBe('my-prod-ns');
      expect(sources.temporalNamespace).toBe('env');
    });
  });
});
