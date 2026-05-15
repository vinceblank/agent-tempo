/**
 * Unit tests for pure utility functions with no Temporal dependency.
 *
 * These tests run without a TestWorkflowEnvironment and complete in
 * milliseconds — no Temporal dev server required.
 *
 * Covers:
 *   - parseDuration (src/utils/duration.ts)
 *   - parseTemporalYaml (src/config.ts)
 *   - getConfig priority chain (src/config.ts)
 *   - getConfigWithSources source labels (src/config.ts)
 */
import { expect } from 'chai';
import * as fs from 'fs';
import { parseDuration } from '../src/utils/duration';
import {
  parseTemporalYaml,
  getConfig,
  getConfigWithSources,
  ENV,
  AGENT_TEMPO_HOME,
  CONFIG_FILE_PATH,
} from '../src/config';

// ─────────────────────────────────────────────
// parseDuration
// ─────────────────────────────────────────────

describe('parseDuration', function () {

  describe('valid inputs', function () {
    it('"30s" returns 30000', function () {
      expect(parseDuration('30s')).to.equal(30_000);
    });

    it('"10m" returns 600000', function () {
      expect(parseDuration('10m')).to.equal(600_000);
    });

    it('"2h" returns 7200000', function () {
      expect(parseDuration('2h')).to.equal(7_200_000);
    });

    it('"1d" returns 86400000', function () {
      expect(parseDuration('1d')).to.equal(86_400_000);
    });

    it('"1.5h" returns 5400000 (decimal values are supported)', function () {
      expect(parseDuration('1.5h')).to.equal(5_400_000);
    });

    it('"0s" returns 0 (zero is a valid parse result; callers enforce minimums)', function () {
      expect(parseDuration('0s')).to.equal(0);
    });

    it('"10S" returns 10000 (unit suffix is case-insensitive)', function () {
      expect(parseDuration('10S')).to.equal(10_000);
    });

    it('"10M" returns 600000 (uppercase M)', function () {
      expect(parseDuration('10M')).to.equal(600_000);
    });

    it('"1 h" returns 3600000 (space between number and unit is allowed)', function () {
      // The regex uses \s* between the number and the unit suffix.
      expect(parseDuration('1 h')).to.equal(3_600_000);
    });

    it('"10 m" returns 600000 (space between number and unit)', function () {
      expect(parseDuration('10 m')).to.equal(600_000);
    });
  });

  describe('invalid inputs → null', function () {
    it('empty string returns null', function () {
      expect(parseDuration('')).to.be.null;
    });

    it('"10" (no unit suffix) returns null', function () {
      expect(parseDuration('10')).to.be.null;
    });

    it('"10x" (unsupported suffix) returns null', function () {
      expect(parseDuration('10x')).to.be.null;
    });

    it('"abc" (no leading digits) returns null', function () {
      expect(parseDuration('abc')).to.be.null;
    });

    it('"-5m" (negative value) returns null', function () {
      // The regex requires \d+ at the start; a minus sign is not a digit.
      expect(parseDuration('-5m')).to.be.null;
    });

    it('" 10m" (leading space) returns null', function () {
      // ^ anchors the match — a leading space fails immediately.
      expect(parseDuration(' 10m')).to.be.null;
    });
  });

  describe('boundary values', function () {
    it('"9s" returns 9000 — valid parse even though schedule tool rejects every < 10s', function () {
      // parseDuration itself does not enforce the 10s minimum; that check
      // lives in the schedule tool. Confirm the parse returns a value, not null.
      expect(parseDuration('9s')).to.equal(9_000);
    });

    it('"10s" returns 10000 — at the schedule tool minimum', function () {
      expect(parseDuration('10s')).to.equal(10_000);
    });
  });
});

// ─────────────────────────────────────────────
// parseTemporalYaml
// ─────────────────────────────────────────────

describe('parseTemporalYaml', function () {

  describe('active-env selection', function () {
    it('reads the environment named by active-env', function () {
      const yaml = `
active-env: prod
env:
  local:
    address: local-host:7233
    namespace: local-ns
  prod:
    address: prod-host:443
    namespace: prod-ns
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('prod-host:443');
      expect(result.temporalNamespace).to.equal('prod-ns');
    });

    it('does not pick up values from other environments', function () {
      const yaml = `
active-env: staging
env:
  local:
    address: local-host:7233
  staging:
    address: staging-host:7233
  prod:
    address: prod-host:443
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('staging-host:7233');
    });
  });

  describe('first-env fallback (no active-env)', function () {
    it('uses the first environment when active-env is absent', function () {
      const yaml = `
env:
  alpha:
    address: alpha-host:7233
  beta:
    address: beta-host:7233
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('alpha-host:7233');
    });
  });

  describe('single environment', function () {
    it('returns values from the only env when no active-env specified', function () {
      const yaml = `
env:
  myenv:
    address: myhost:7233
    namespace: mynamespace
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('myhost:7233');
      expect(result.temporalNamespace).to.equal('mynamespace');
    });
  });

  describe('all supported fields', function () {
    it('maps all five fields correctly', function () {
      const yaml = `
active-env: full
env:
  full:
    address: full-host:7233
    namespace: full-ns
    api-key: my-api-key
    tls-cert-path: /certs/client.pem
    tls-key-path: /certs/client.key
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('full-host:7233');
      expect(result.temporalNamespace).to.equal('full-ns');
      expect(result.temporalApiKey).to.equal('my-api-key');
      expect(result.temporalTlsCertPath).to.equal('/certs/client.pem');
      expect(result.temporalTlsKeyPath).to.equal('/certs/client.key');
    });
  });

  describe('quote stripping', function () {
    it('strips single quotes from values', function () {
      const yaml = `
env:
  q:
    address: 'quoted-host:7233'
    namespace: 'quoted-ns'
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('quoted-host:7233');
      expect(result.temporalNamespace).to.equal('quoted-ns');
    });

    it('strips double quotes from values', function () {
      const yaml = `
env:
  q:
    address: "double-quoted:7233"
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('double-quoted:7233');
    });

    it('passes through unquoted values unchanged', function () {
      const yaml = `
env:
  q:
    address: no-quotes:7233
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('no-quotes:7233');
    });
  });

  describe('CRLF normalization', function () {
    it('parses correctly when file uses Windows CRLF line endings', function () {
      const yaml = 'active-env: win\r\nenv:\r\n  win:\r\n    address: win-host:7233\r\n    namespace: win-ns\r\n';
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('win-host:7233');
      expect(result.temporalNamespace).to.equal('win-ns');
    });
  });

  describe('env names with special characters', function () {
    it('handles env names containing dots and colons (e.g. "my-ns.abc123")', function () {
      // The regex for env name detection allows [a-zA-Z0-9_.:-]+
      const yaml = `
active-env: my-ns.abc123
env:
  my-ns.abc123:
    address: dotted-host:7233
`;
      const result = parseTemporalYaml(yaml);
      expect(result.temporalAddress).to.equal('dotted-host:7233');
    });
  });

  describe('empty and missing content', function () {
    it('returns {} for empty string', function () {
      expect(parseTemporalYaml('')).to.deep.equal({});
    });

    it('returns {} when there is no env: block', function () {
      expect(parseTemporalYaml('active-env: local\n')).to.deep.equal({});
    });

    it('returns {} when active-env names a non-existent environment', function () {
      const yaml = `
active-env: ghost
env:
  real:
    address: real-host:7233
`;
      const result = parseTemporalYaml(yaml);
      // ghost env doesn't exist, no values should be populated
      expect(result.temporalAddress).to.be.undefined;
    });
  });
});

// ─────────────────────────────────────────────
// getConfig priority chain
// ─────────────────────────────────────────────

describe('getConfig', function () {
  // ── env var save/restore ──

  const ENV_KEYS_UNDER_TEST = [
    ENV.TEMPORAL_ADDRESS,
    ENV.TEMPORAL_NAMESPACE,
    ENV.TEMPORAL_API_KEY,
    ENV.TEMPORAL_TLS_CERT_PATH,
    ENV.TEMPORAL_TLS_KEY_PATH,
    ENV.DEFAULT_AGENT,
    ENV.TASK_QUEUE,
    ENV.ENSEMBLE,
  ];

  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    savedEnv = {};
    for (const key of ENV_KEYS_UNDER_TEST) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(function () {
    for (const key of ENV_KEYS_UNDER_TEST) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ── CLI flag overrides ──

  describe('CLI flag overrides', function () {
    it('CLI temporalAddress beats env var', function () {
      process.env[ENV.TEMPORAL_ADDRESS] = 'env-host:7233';
      const cfg = getConfig({ temporalAddress: 'flag-host:7233' });
      expect(cfg.temporalAddress).to.equal('flag-host:7233');
    });

    it('CLI temporalNamespace beats env var', function () {
      process.env[ENV.TEMPORAL_NAMESPACE] = 'env-ns';
      const cfg = getConfig({ temporalNamespace: 'flag-ns' });
      expect(cfg.temporalNamespace).to.equal('flag-ns');
    });

    it('CLI temporalApiKey beats env var', function () {
      process.env[ENV.TEMPORAL_API_KEY] = 'env-key';
      const cfg = getConfig({ temporalApiKey: 'flag-key' });
      expect(cfg.temporalApiKey).to.equal('flag-key');
    });
  });

  // ── env var overrides ──

  describe('env var overrides', function () {
    it('TEMPORAL_ADDRESS env var is used when set', function () {
      process.env[ENV.TEMPORAL_ADDRESS] = 'env-host:7233';
      const cfg = getConfig();
      expect(cfg.temporalAddress).to.equal('env-host:7233');
    });

    it('TEMPORAL_NAMESPACE env var is used when set', function () {
      process.env[ENV.TEMPORAL_NAMESPACE] = 'env-namespace';
      const cfg = getConfig();
      expect(cfg.temporalNamespace).to.equal('env-namespace');
    });

    it('TEMPORAL_API_KEY env var is used when set', function () {
      process.env[ENV.TEMPORAL_API_KEY] = 'env-api-key';
      const cfg = getConfig();
      expect(cfg.temporalApiKey).to.equal('env-api-key');
    });

    it('TEMPORAL_TLS_CERT_PATH env var is used when set', function () {
      process.env[ENV.TEMPORAL_TLS_CERT_PATH] = '/certs/cert.pem';
      const cfg = getConfig();
      expect(cfg.temporalTlsCertPath).to.equal('/certs/cert.pem');
    });
  });

  // ── config file layer ──

  describe('config file layer', function () {
    let originalConfigContent: string | null = null;

    before(function () {
      // Snapshot the real config file (may or may not exist)
      try {
        originalConfigContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
      } catch {
        originalConfigContent = null;
      }
    });

    after(function () {
      // Restore original state
      if (originalConfigContent !== null) {
        fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
        fs.writeFileSync(CONFIG_FILE_PATH, originalConfigContent);
      } else {
        try { fs.unlinkSync(CONFIG_FILE_PATH); } catch { /* didn't exist */ }
      }
    });

    beforeEach(function () {
      // Write a known config for each test (env vars are cleared by the outer beforeEach)
      fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({
        temporalAddress: 'config-file-host:7233',
        temporalNamespace: 'config-file-ns',
      }));
    });

    it('reads temporalAddress from config file when no env var or CLI override is set', function () {
      const cfg = getConfig();
      expect(cfg.temporalAddress).to.equal('config-file-host:7233');
    });

    it('env var beats config file', function () {
      process.env[ENV.TEMPORAL_ADDRESS] = 'env-beats-config:7233';
      const cfg = getConfig();
      expect(cfg.temporalAddress).to.equal('env-beats-config:7233');
    });

    it('CLI flag beats config file', function () {
      const cfg = getConfig({ temporalAddress: 'flag-beats-config:7233' });
      expect(cfg.temporalAddress).to.equal('flag-beats-config:7233');
    });
  });

  // ── env-only defaults (taskQueue, ensemble) ──

  describe('env-only defaults', function () {
    it('taskQueue defaults to "claude-tempo" when env var is not set', function () {
      const cfg = getConfig();
      expect(cfg.taskQueue).to.equal('claude-tempo');
    });

    it('AGENT_TEMPO_TASK_QUEUE env var overrides taskQueue default', function () {
      process.env[ENV.TASK_QUEUE] = 'custom-queue';
      const cfg = getConfig();
      expect(cfg.taskQueue).to.equal('custom-queue');
    });

    it('ensemble defaults to "default" when env var is not set', function () {
      const cfg = getConfig();
      expect(cfg.ensemble).to.equal('default');
    });

    it('AGENT_TEMPO_ENSEMBLE env var sets ensemble', function () {
      process.env[ENV.ENSEMBLE] = 'my-band';
      const cfg = getConfig();
      expect(cfg.ensemble).to.equal('my-band');
    });
  });

  // ── defaultAgent validation ──

  describe('defaultAgent validation', function () {
    it('defaults to "claude" when no agent is specified', function () {
      const cfg = getConfig();
      expect(cfg.defaultAgent).to.equal('claude');
    });

    it('"copilot" is accepted as a valid agent type', function () {
      const cfg = getConfig({ defaultAgent: 'copilot' });
      expect(cfg.defaultAgent).to.equal('copilot');
    });

    it('unknown agent string throws with actionable error', function () {
      // Invalid agent values error rather than silently falling back.
      expect(() => getConfig({ defaultAgent: 'gpt-4o' as any }))
        .to.throw(/Invalid agent "gpt-4o"/);
    });
  });

  // ── ensemble name validation ──

  describe('ensemble name validation', function () {
    it('throws when AGENT_TEMPO_ENSEMBLE contains invalid characters', function () {
      process.env[ENV.ENSEMBLE] = 'bad ensemble!';
      expect(() => getConfig()).to.throw(/Invalid ensemble name/);
    });

    it('throws when ensemble name starts with a hyphen', function () {
      process.env[ENV.ENSEMBLE] = '-bad-start';
      expect(() => getConfig()).to.throw(/Invalid ensemble name/);
    });

    it('accepts a valid ensemble name with hyphens and dots', function () {
      process.env[ENV.ENSEMBLE] = 'my-project.v2';
      const cfg = getConfig();
      expect(cfg.ensemble).to.equal('my-project.v2');
    });
  });

  // ── optional fields absent when not provided ──

  describe('optional fields', function () {
    it('temporalApiKey is undefined when not set anywhere', function () {
      // Write a config file with no apiKey so file layer returns undefined too
      fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({}));
      const cfg = getConfig();
      expect(cfg.temporalApiKey).to.be.undefined;
    });

    it('temporalTlsCertPath is undefined when not set anywhere', function () {
      fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({}));
      const cfg = getConfig();
      expect(cfg.temporalTlsCertPath).to.be.undefined;
    });
  });
});

// ─────────────────────────────────────────────
// getConfigWithSources
// ─────────────────────────────────────────────

describe('getConfigWithSources', function () {
  const ENV_KEYS_UNDER_TEST = [
    ENV.TEMPORAL_ADDRESS,
    ENV.TEMPORAL_NAMESPACE,
    ENV.TEMPORAL_API_KEY,
    ENV.TEMPORAL_TLS_CERT_PATH,
    ENV.TEMPORAL_TLS_KEY_PATH,
    ENV.DEFAULT_AGENT,
  ];

  let savedEnv: Record<string, string | undefined> = {};
  let originalConfigContent: string | null = null;

  before(function () {
    try {
      originalConfigContent = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
    } catch {
      originalConfigContent = null;
    }
    // Write empty config so file layer doesn't interfere with source detection
    fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({}));
  });

  after(function () {
    if (originalConfigContent !== null) {
      fs.mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
      fs.writeFileSync(CONFIG_FILE_PATH, originalConfigContent);
    } else {
      try { fs.unlinkSync(CONFIG_FILE_PATH); } catch { /* ok */ }
    }
  });

  beforeEach(function () {
    savedEnv = {};
    for (const key of ENV_KEYS_UNDER_TEST) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(function () {
    for (const key of ENV_KEYS_UNDER_TEST) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('source is "flag" when CLI override is provided', function () {
    const { sources } = getConfigWithSources({ temporalAddress: 'flag-host:7233' });
    expect(sources.temporalAddress).to.equal('flag');
  });

  it('source is "env" when value comes from environment variable', function () {
    process.env[ENV.TEMPORAL_ADDRESS] = 'env-host:7233';
    const { sources } = getConfigWithSources();
    expect(sources.temporalAddress).to.equal('env');
  });

  it('source is "default" when only the hardcoded default applies', function () {
    // With empty config file and no env var, address falls to default
    const { sources } = getConfigWithSources();
    expect(sources.temporalAddress).to.equal('default');
  });

  it('source is "none" when optional field is absent', function () {
    const { sources } = getConfigWithSources();
    expect(sources.temporalApiKey).to.equal('none');
    expect(sources.temporalTlsCertPath).to.equal('none');
    expect(sources.temporalTlsKeyPath).to.equal('none');
  });

  it('returned config matches getConfig() for same inputs', function () {
    process.env[ENV.TEMPORAL_ADDRESS] = 'check-host:7233';
    const { config } = getConfigWithSources();
    const plain = getConfig();
    expect(config.temporalAddress).to.equal(plain.temporalAddress);
    expect(config.temporalNamespace).to.equal(plain.temporalNamespace);
    expect(config.defaultAgent).to.equal(plain.defaultAgent);
  });
});
