/**
 * `configSet` default-agent validation (#666).
 *
 * The CLI `config set defaultAgent` guard must accept the conductor-capable
 * PRODUCTION agents (claude / copilot / pi) and reject anything else with a
 * message listing the valid set. The bug: it previously hard-coded
 * claude/copilot, so `pi` (the new interactive Pi conductor default) was
 * rejected. We drive `configSet` with the config-file I/O + CLI output mocked,
 * so no real `~/.agent-tempo/config.json` is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saved: Record<string, unknown>[] = [];
const errors: string[] = [];
const successes: string[] = [];

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return {
    ...actual,
    loadConfigFile: () => ({}),
    saveConfigFile: (c: Record<string, unknown>) => { saved.push({ ...c }); },
  };
});

vi.mock('../../src/cli/output', () => ({
  error: (m: string) => errors.push(m),
  success: (m: string) => successes.push(m),
  log: () => {},
  warn: () => {},
  heading: () => {},
  dim: (s: string) => s,
}));

// Imported AFTER the mocks so config-command binds the mocked deps.
import { configSet, VALID_DEFAULT_AGENTS } from '../../src/cli/config-command';

beforeEach(() => {
  saved.length = 0;
  errors.length = 0;
  successes.length = 0;
});

/** Stub `process.exit` to throw so the rejection path is observable. */
function withExitGuard(fn: () => void): { threw: boolean } {
  const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = (err as Error).message === 'exit:1';
    if (!threw) throw err;
  } finally {
    spy.mockRestore();
  }
  return { threw };
}

describe('VALID_DEFAULT_AGENTS (#666)', () => {
  it('is exactly the conductor-capable production set (claude, copilot, pi)', () => {
    expect([...VALID_DEFAULT_AGENTS]).toEqual(['claude', 'copilot', 'pi']);
  });

  it('excludes dev-only mock and the non-conductor headless adapters', () => {
    for (const a of ['mock', 'claude-api', 'opencode', 'claude-code-headless']) {
      expect(VALID_DEFAULT_AGENTS).not.toContain(a);
    }
  });
});

describe('configSet defaultAgent (#666)', () => {
  it('accepts pi and persists it', () => {
    configSet('defaultAgent', 'pi');
    expect(saved).toHaveLength(1);
    expect(saved[0].defaultAgent).toBe('pi');
    expect(errors).toHaveLength(0);
    expect(successes.some((s) => s.includes('pi'))).toBe(true);
  });

  it('accepts the kebab-case alias `default-agent`', () => {
    configSet('default-agent', 'pi');
    expect(saved[0].defaultAgent).toBe('pi');
  });

  it('still accepts claude and copilot', () => {
    configSet('defaultAgent', 'claude');
    configSet('defaultAgent', 'copilot');
    expect(saved.map((s) => s.defaultAgent)).toEqual(['claude', 'copilot']);
  });

  it('rejects an invalid agent with the updated message listing the valid set', () => {
    const { threw } = withExitGuard(() => configSet('defaultAgent', 'gpt-4o'));
    expect(threw).toBe(true); // process.exit(1)
    expect(errors.some((e) => e.includes('gpt-4o'))).toBe(true);
    expect(errors.some((e) => e.includes('claude, copilot, pi'))).toBe(true);
    expect(saved).toHaveLength(0); // never persisted
  });

  it('rejects mock as a persistent default (dev-only, not conductor-capable)', () => {
    const { threw } = withExitGuard(() => configSet('defaultAgent', 'mock'));
    expect(threw).toBe(true);
    expect(saved).toHaveLength(0);
  });
});
