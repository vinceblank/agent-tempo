/**
 * Unit tests for the opencode adapter's config-synthesis layer.
 *
 * `synthesizeOpenCodeConfig` is the no-side-effect function that builds
 * the inline `OPENCODE_CONFIG_CONTENT` env value from recruit args. The
 * design's security mitigations (loopback bind, mDNS-off) and the
 * provider auto-detection branches are easy to regress accidentally —
 * pin them here.
 *
 * Companion to `tests/adapters/claude-api/helpers.test.ts` — same shape:
 * pure helper, dependency-injected env, no Temporal involvement.
 */
import { describe, it, expect } from 'vitest';
import {
  detectProviderEnvFromModel,
  synthesizeOpenCodeConfig,
} from '../../../src/adapters/opencode/config';
import { isVersionMatch, redactSecrets } from '../../../src/adapters/opencode/helpers';

describe('detectProviderEnvFromModel', () => {
  it('extracts the prefix before the first slash', () => {
    expect(detectProviderEnvFromModel('anthropic/claude-opus-4-7')).toBe('anthropic');
    expect(detectProviderEnvFromModel('openai/gpt-4o')).toBe('openai');
    expect(detectProviderEnvFromModel('ollama/llama3.1:70b')).toBe('ollama');
  });

  it('returns null for legacy bare ids (claude-api shape)', () => {
    expect(detectProviderEnvFromModel('claude-opus-4-7')).toBeNull();
    expect(detectProviderEnvFromModel('claude-sonnet-4-6')).toBeNull();
  });

  it('returns null for empty / leading-slash inputs', () => {
    expect(detectProviderEnvFromModel('')).toBeNull();
    expect(detectProviderEnvFromModel('/no-prefix')).toBeNull();
  });

  it('lowercases the provider id (defensive — matches PROVIDER_ENV_MAP keys)', () => {
    expect(detectProviderEnvFromModel('ANTHROPIC/claude-opus-4-7')).toBe('anthropic');
    expect(detectProviderEnvFromModel('OpenAI/gpt-4o')).toBe('openai');
  });
});

describe('synthesizeOpenCodeConfig — security invariants (ADR 0015 §53, §82)', () => {
  const baseOpts = {
    model: 'anthropic/claude-opus-4-7',
    port: 4732,
    mcpServerPath: '/abs/path/to/dist/server.js',
    ensemble: 'tempo-impl',
    playerName: 'opencode-test',
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  };

  it('always sets server.hostname=127.0.0.1 (loopback hardcoded)', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig(baseOpts));
    expect(out.server.hostname).toBe('127.0.0.1');
  });

  it('always sets server.mdns=false (no Bonjour leak)', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig(baseOpts));
    expect(out.server.mdns).toBe(false);
  });

  it('passes the probed port through verbatim', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({ ...baseOpts, port: 65432 }));
    expect(out.server.port).toBe(65432);
  });
});

describe('synthesizeOpenCodeConfig — provider env auto-detection', () => {
  const baseOpts = {
    model: 'anthropic/claude-opus-4-7',
    port: 4096,
    mcpServerPath: '/server.js',
    ensemble: 'e',
    playerName: 'p',
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
  };

  it('emits provider.anthropic.options when ANTHROPIC_API_KEY is set', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({ ...baseOpts, env: { ANTHROPIC_API_KEY: 'sk-ant' } }));
    expect(out.provider.anthropic.options.apiKey).toBe('{env:ANTHROPIC_API_KEY}');
    // Anthropic-specific cache opt-in
    expect(out.provider.anthropic.options.setCacheKey).toBe(true);
  });

  it('emits provider.openai.options for openai/* models', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({
      ...baseOpts,
      model: 'openai/gpt-4o',
      env: { OPENAI_API_KEY: 'sk-oai' },
    }));
    expect(out.provider.openai.options.apiKey).toBe('{env:OPENAI_API_KEY}');
    // setCacheKey is anthropic-only
    expect(out.provider.openai.options.setCacheKey).toBeUndefined();
  });

  it('omits provider block when the env var is missing', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({
      ...baseOpts,
      model: 'openai/gpt-4o',
      env: {}, // OPENAI_API_KEY not set
    }));
    expect(out.provider).toBeUndefined();
  });

  it('omits provider block for ollama (no API key — local server)', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({
      ...baseOpts,
      model: 'ollama/llama3',
      env: { OLLAMA_API_KEY: 'irrelevant' },
    }));
    expect(out.provider).toBeUndefined();
  });

  it('omits provider block for bedrock (uses AWS env chain, not bearer)', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({
      ...baseOpts,
      model: 'bedrock/anthropic.claude-opus-4-7-v1:0',
      env: { AWS_ACCESS_KEY_ID: 'irrelevant', AWS_SECRET_ACCESS_KEY: 'irrelevant' },
    }));
    expect(out.provider).toBeUndefined();
  });

  it('omits provider block for legacy bare claude-api ids (no provider prefix)', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig({
      ...baseOpts,
      model: 'claude-opus-4-7',
      env: { ANTHROPIC_API_KEY: 'sk-ant' },
    }));
    expect(out.provider).toBeUndefined();
  });
});

describe('synthesizeOpenCodeConfig — MCP block', () => {
  const baseOpts = {
    model: 'anthropic/claude-opus-4-7',
    port: 4096,
    mcpServerPath: '/abs/dist/server.js',
    ensemble: 'tempo-impl',
    playerName: 'opencode-test',
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    env: {},
  };

  it('registers agent-tempo as a type=local stdio child', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig(baseOpts));
    expect(out.mcp['agent-tempo'].type).toBe('local');
    expect(out.mcp['agent-tempo'].command).toEqual(['node', '/abs/dist/server.js']);
  });

  it('passes the standard env-var contract to the MCP child', () => {
    const out = JSON.parse(synthesizeOpenCodeConfig(baseOpts));
    const env = out.mcp['agent-tempo'].environment;
    // {env:VAR} markers — OpenCode resolves at config-read time so no
    // literal credentials appear in the synthesized JSON.
    expect(env.AGENT_TEMPO_ENSEMBLE).toBe('{env:AGENT_TEMPO_ENSEMBLE}');
    expect(env.AGENT_TEMPO_PLAYER_NAME).toBe('{env:AGENT_TEMPO_PLAYER_NAME}');
    expect(env.TEMPORAL_ADDRESS).toBe('{env:TEMPORAL_ADDRESS}');
    expect(env.TEMPORAL_NAMESPACE).toBe('{env:TEMPORAL_NAMESPACE}');
  });
});

describe('redactSecrets', () => {
  it('redacts long apiKey literal values', () => {
    const input = '{"apiKey":"sk-ant-1234567890123456789012345"}';
    const out = redactSecrets(input);
    expect(out).not.toContain('sk-ant-1234567890');
    expect(out).toContain('"apiKey":"***"');
  });

  it('preserves {env:VAR} substitution markers (config shape, not secret)', () => {
    const input = '{"apiKey":"{env:ANTHROPIC_API_KEY}"}';
    const out = redactSecrets(input);
    expect(out).toContain('{env:ANTHROPIC_API_KEY}');
    expect(out).not.toContain('***');
  });

  it('leaves short values untouched (below the 20-char threshold)', () => {
    const input = '{"apiKey":"short"}';
    const out = redactSecrets(input);
    expect(out).toBe(input);
  });

  it('redacts token / secret / bearer fields too', () => {
    const input = '{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}';
    const out = redactSecrets(input);
    expect(out).toContain('"token":"***"');
  });
});

describe('isVersionMatch — tilde-pin discipline', () => {
  it('matches same MAJOR.MINOR (different patch)', () => {
    expect(isVersionMatch('1.14.29', '~1.14.29')).toBe(true);
    expect(isVersionMatch('1.14.99', '~1.14.29')).toBe(true);
    expect(isVersionMatch('1.14.0', '~1.14.29')).toBe(true);
  });

  it('rejects a different MINOR (drift)', () => {
    expect(isVersionMatch('1.15.0', '~1.14.29')).toBe(false);
    expect(isVersionMatch('1.13.99', '~1.14.29')).toBe(false);
  });

  it('rejects a different MAJOR (drift)', () => {
    expect(isVersionMatch('2.14.29', '~1.14.29')).toBe(false);
    expect(isVersionMatch('0.14.29', '~1.14.29')).toBe(false);
  });

  it('returns true on unparseable inputs (avoid false-positive WARNINGs)', () => {
    expect(isVersionMatch('not-a-version', '~1.14.29')).toBe(true);
    expect(isVersionMatch('1.14.29', 'not-a-version')).toBe(true);
  });

  it('handles leading "v" and pre-release suffixes (matches the version regex)', () => {
    // Matches OpenCode's `v1.14.29-rc1` shape if encountered.
    expect(isVersionMatch('1.14.29-rc1', '~1.14.29')).toBe(true);
  });
});
