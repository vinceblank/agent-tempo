/**
 * `configSet`/`configShow` cost-profile support (#765).
 *
 * The #763 window-B forensics: the T0.1 cost-profile axis was resolvable
 * from config.json but had NO operator write path — `config set
 * costProfile cloud` exited 1 with "Unknown config key", and `config show`
 * never displayed it, so a cloud deploy silently ran 'local' across three
 * measurement windows. These tests pin the operator path.
 *
 * Mirrors the harness of config-set-default-agent.test.ts (config-file I/O
 * + CLI output mocked; no real ~/.agent-tempo/config.json touched).
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
import { configSet } from '../../src/cli/config-command';

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

describe('configSet costProfile (#765)', () => {
  it('accepts "cloud" and persists it', () => {
    configSet('costProfile', 'cloud');
    expect(saved).toHaveLength(1);
    expect(saved[0].costProfile).toBe('cloud');
    expect(errors).toHaveLength(0);
  });

  it('accepts "local" and the kebab-case alias', () => {
    configSet('costProfile', 'local');
    configSet('cost-profile', 'cloud');
    expect(saved.map((c) => c.costProfile)).toEqual(['local', 'cloud']);
  });

  it('rejects garbage values loudly at SET time (no silent local fallback later)', () => {
    const { threw } = withExitGuard(() => configSet('costProfile', 'clout'));
    expect(threw).toBe(true);
    expect(errors.some((e) => e.includes('Invalid cost profile'))).toBe(true);
    expect(saved).toHaveLength(0);
  });
});
