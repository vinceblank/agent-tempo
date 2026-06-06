/**
 * Unit tests for `AGENT_TEMPO_DEFAULT_AGENT` resolution and validation.
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
import { AGENT_TYPES } from '../../src/types';

describe('parseAgent', () => {
  it('returns "claude" for undefined and empty string', () => {
    expect(parseAgent(undefined, 'flag')).toBe('claude');
    expect(parseAgent('', 'flag')).toBe('claude');
  });

  // #683: parseAgent must accept EVERY AGENT_TYPES member (it's a pure
  // type-validity check; capability subsetting is downstream). The former
  // hardcoded ['claude','copilot'] list rejected `pi` (+ claude-api/opencode/
  // claude-code-headless/mock) at config LOAD, poisoning every command.
  it.each([...AGENT_TYPES])('accepts the canonical agent type "%s"', (agent) => {
    expect(parseAgent(agent, 'flag')).toBe(agent);
  });

  it('accepts "pi" specifically (the #683 regression)', () => {
    expect(parseAgent('pi', 'config')).toBe('pi');
  });

  it('throws with the source label from each origin', () => {
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/--agent CLI flag/);
    expect(() => parseAgent('gpt-4o', 'env')).toThrow(/AGENT_TEMPO_DEFAULT_AGENT env var/);
    expect(() => parseAgent('gpt-4o', 'config')).toThrow(/config\.json/);
  });

  it('throws with the offending value and the FULL list of valid values (incl pi)', () => {
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/Invalid agent "gpt-4o"/);
    // The error now lists the canonical AGENT_TYPES — pi must appear.
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(/pi/);
    expect(() => parseAgent('gpt-4o', 'flag')).toThrow(new RegExp(AGENT_TYPES.join(', ')));
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
    expect(() => getConfig()).toThrow(/AGENT_TEMPO_DEFAULT_AGENT env var/);
  });

  it('invalid CLI flag throws and names the flag', () => {
    expect(() => getConfig({ defaultAgent: 'gpt-4o' as any })).toThrow(/--agent CLI flag/);
  });
});
