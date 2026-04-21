/**
 * Unit tests for `CLAUDE_TEMPO_DEFAULT_AGENT` resolution and validation.
 *
 * Covers:
 *   - `parseAgent()` validates against the {@link AgentType} union.
 *   - Default is `'claude'` when no source provides a value.
 *   - Precedence: CLI flag > env var > config file > default.
 *   - Invalid values throw an actionable error naming the offending source.
 *
 * The config-file branch uses the same `parseAgent()` helper as the env
 * and CLI branches, so we cover it by unit-testing `parseAgent()` directly
 * rather than mocking the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, parseAgent, ENV } from '../../src/config';

describe('parseAgent', () => {
  it('returns "claude" for undefined and empty string', () => {
    expect(parseAgent(undefined, 'flag')).toBe('claude');
    expect(parseAgent('', 'flag')).toBe('claude');
  });

  it('accepts the two known agent types', () => {
    expect(parseAgent('claude', 'flag')).toBe('claude');
    expect(parseAgent('copilot', 'flag')).toBe('copilot');
  });

  it('throws with the source label from each origin', () => {
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/--agent CLI flag/);
    expect(() => parseAgent('gpt-4o', 'env')).toThrow(/CLAUDE_TEMPO_DEFAULT_AGENT env var/);
    expect(() => parseAgent('gpt-4o', 'config')).toThrow(/config\.json/);
  });

  it('throws with the offending value and the list of valid values', () => {
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/Invalid agent "gpt-4o"/);
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/claude, copilot/);
  });
});

describe('getConfig defaultAgent precedence', () => {
  let savedEnv: string | undefined;
  let savedEnsemble: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV.DEFAULT_AGENT];
    savedEnsemble = process.env[ENV.ENSEMBLE];
    delete process.env[ENV.DEFAULT_AGENT];
    // Pin ensemble so getConfig's name validator doesn't depend on the
    // developer's shell environment.
    process.env[ENV.ENSEMBLE] = 'test-ensemble';
  });

  afterEach(() => {
    if (savedEnv == null) delete process.env[ENV.DEFAULT_AGENT];
    else process.env[ENV.DEFAULT_AGENT] = savedEnv;
    if (savedEnsemble == null) delete process.env[ENV.ENSEMBLE];
    else process.env[ENV.ENSEMBLE] = savedEnsemble;
  });

  it('env var sets the agent', () => {
    process.env[ENV.DEFAULT_AGENT] = 'copilot';
    expect(getConfig().defaultAgent).toBe('copilot');
  });

  it('CLI flag wins over env var', () => {
    process.env[ENV.DEFAULT_AGENT] = 'copilot';
    expect(getConfig({ defaultAgent: 'claude' }).defaultAgent).toBe('claude');
  });

  it('invalid env var throws and names the env var', () => {
    process.env[ENV.DEFAULT_AGENT] = 'gpt-4o';
    expect(() => getConfig()).toThrow(/Invalid agent "gpt-4o"/);
    expect(() => getConfig()).toThrow(/CLAUDE_TEMPO_DEFAULT_AGENT env var/);
  });

  it('invalid CLI flag throws and names the flag', () => {
    expect(() => getConfig({ defaultAgent: 'gpt-4o' as any })).toThrow(/--agent CLI flag/);
  });
});
