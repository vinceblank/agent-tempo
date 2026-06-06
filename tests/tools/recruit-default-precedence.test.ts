/**
 * #676 FIX-1 — recruit agent precedence (resolveRecruitAgent, src/tools/recruit.ts).
 * Precedence: explicit args.agent > operator-SET config.defaultAgent > ownAgentType.
 * The source distinguishes an operator-set default (flag/env/config/temporal-cli)
 * from the built-in 'claude' default ('default') / truly-unset ('none'/undefined).
 */
import { describe, it, expect } from 'vitest';
import { resolveRecruitAgent } from '../../src/tools/recruit';

describe('resolveRecruitAgent (#676 FIX-1 precedence)', () => {
  it('explicit args.agent wins over everything', () => {
    expect(resolveRecruitAgent('copilot', 'pi', 'config', 'claude')).toBe('copilot');
    expect(resolveRecruitAgent('mock', 'claude', undefined, 'pi')).toBe('mock');
  });

  it('operator-SET config.defaultAgent (source flag/env/config/temporal-cli) wins over ownAgentType', () => {
    for (const src of ['flag', 'env', 'config', 'temporal-cli'] as const) {
      expect(resolveRecruitAgent(undefined, 'copilot', src, 'claude'), src).toBe('copilot');
    }
  });

  it('falls back to ownAgentType (the mirror) when the default is NOT operator-set', () => {
    expect(resolveRecruitAgent(undefined, 'claude', 'default', 'pi')).toBe('pi');   // built-in default
    expect(resolveRecruitAgent(undefined, 'claude', 'none', 'copilot')).toBe('copilot'); // truly unset
    expect(resolveRecruitAgent(undefined, 'claude', undefined, 'pi')).toBe('pi');   // source not threaded
  });

  it('THE FIX: a pi conductor (defaultAgent unset → source "default") recruits pi (mirror), NOT the claude default', () => {
    // Pre-FIX-1 `args.agent || config.defaultAgent('claude')` regressed this to 'claude'.
    expect(resolveRecruitAgent(undefined, 'claude', 'default', 'pi')).toBe('pi');
    expect(resolveRecruitAgent(undefined, 'claude', 'default', 'copilot')).toBe('copilot');
  });
});
