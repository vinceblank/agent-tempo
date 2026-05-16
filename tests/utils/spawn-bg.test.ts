/**
 * #596 / ADR 0016 — unit coverage for `spawnClaudeBg` arg ordering and
 * env-var passthrough.
 *
 * We stub `child_process.spawn` to capture the args and env that would be
 * passed to the real claude binary, then assert:
 *   - `--bg` is first
 *   - `--session-id <uuid>` is second/third
 *   - user-supplied args come after
 *   - process env is merged with caller envVars (caller wins on collision)
 *   - `detached: true`, `stdio: 'ignore'`, `unref()` are wired correctly
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process.spawn before the spawn.ts module loads it
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as mockedSpawn } from 'child_process';
import { spawnClaudeBg } from '../../src/spawn';

describe('spawnClaudeBg — ADR 0016 arg + env contract', () => {
  let unref: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unref = vi.fn();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      pid: 12345,
      unref,
    });
  });

  it('prepends --bg then --session-id <uuid> before user args', () => {
    spawnClaudeBg(['-n', 'tempo-eng', '--agent', 'my-tempo-engineer'], '/work', {}, {
      claudeBin: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--bg',
      '--session-id',
      '550e8400-e29b-41d4-a716-446655440000',
      '-n',
      'tempo-eng',
      '--agent',
      'my-tempo-engineer',
    ]);
  });

  it('merges process.env with caller env (caller wins on collision)', () => {
    const origPath = process.env.PATH;
    process.env.AGENT_TEMPO_TEST_COLLISION = 'from-process';
    try {
      spawnClaudeBg([], '/work', {
        AGENT_TEMPO_ENSEMBLE: 'jam',
        AGENT_TEMPO_TEST_COLLISION: 'from-caller',
      }, {
        claudeBin: 'claude',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      const [, , opts] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.env.PATH).toBe(origPath);
      expect(opts.env.AGENT_TEMPO_ENSEMBLE).toBe('jam');
      // Caller wins — that's the documented contract (matches spawnInTerminal).
      expect(opts.env.AGENT_TEMPO_TEST_COLLISION).toBe('from-caller');
    } finally {
      delete process.env.AGENT_TEMPO_TEST_COLLISION;
    }
  });

  it('spawns detached with stdio: ignore and calls unref()', () => {
    spawnClaudeBg([], '/work', {}, {
      claudeBin: 'claude',
      sessionId: 'cafef00d-1234-5678-9abc-def012345678',
    });
    const [, , opts] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.cwd).toBe('/work');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('returns the spawned PID', () => {
    const result = spawnClaudeBg([], '/work', {}, {
      claudeBin: 'claude',
      sessionId: 'cafef00d-1234-5678-9abc-def012345678',
    });
    expect(result.pid).toBe(12345);
  });
});
