/**
 * #596 / ADR 0016 (erratum: stdout discovery) — unit coverage for
 * `spawnClaudeBg` arg ordering, env passthrough, and the supervisor short-id
 * stdout-parse path.
 *
 * Empirical finding that drove the erratum: `claude 2.1.140`'s supervisor
 * ignores `--session-id` under `--bg` (emits the warning `"--bg manages the
 * session id; ignoring --session-id"`), invents its own UUID, and prints the
 * 8-char short id to stdout as `"backgrounded · <shortId> (idle …)"`.
 * `spawnClaudeBg` therefore omits `--session-id` from the arg list and
 * recovers the short id by regex-parsing stdout.
 *
 * Covers:
 *   - args: `--bg` first, then user args; NO `--session-id` ever emitted
 *   - env merge: process.env + caller envVars, caller wins on collision
 *   - stdio: stdout/stderr piped (no `'ignore'`) so we can parse the banner
 *   - shortId returned when stdout contains the `backgrounded · <id>` pattern
 *   - shortId is `undefined` when stdout doesn't match; stdoutDiagnostic
 *     populated for the spawn-process activity's error message
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process.spawn before the spawn.ts module loads it
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as mockedSpawn } from 'child_process';
import { spawnClaudeBg, BG_SHORT_ID_PATTERN } from '../../src/spawn';

/**
 * Build a fake ChildProcess EventEmitter exposing `.stdout` / `.stderr`
 * streams as inner EventEmitters and `.pid`. Helpers below script the
 * lifecycle (emit stdout chunks, then `exit`).
 */
function fakeChild(pid: number | undefined = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('spawnClaudeBg — ADR 0016 erratum (stdout discovery)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits --session-id from args and puts --bg first', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const promise = spawnClaudeBg(['-n', 'tempo-eng', '--agent', 'my-tempo-engineer'], '/work', {});
    // Emit a valid banner so the promise resolves
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · 5b7e4f5b (idle — send a prompt to start)\n'));
      child.emit('exit', 0);
    });
    await promise;

    const [, args] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual([
      '--bg',
      '-n',
      'tempo-eng',
      '--agent',
      'my-tempo-engineer',
    ]);
    // Explicitly: no --session-id
    expect(args).not.toContain('--session-id');
  });

  it('parses the supervisor short id from stdout and returns it', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const promise = spawnClaudeBg([], '/work', {});
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · 5b7e4f5b (idle — send a prompt to start)\n  more lines\n'));
      child.emit('exit', 0);
    });
    const result = await promise;
    expect(result.shortId).toBe('5b7e4f5b');
    expect(result.pid).toBe(12345);
  });

  it('handles split stdout chunks (banner straddles emit boundary)', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const promise = spawnClaudeBg([], '/work', {});
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · 5b7'));
      child.stdout.emit('data', Buffer.from('e4f5b (idle)\n'));
      child.emit('exit', 0);
    });
    const result = await promise;
    expect(result.shortId).toBe('5b7e4f5b');
  });

  it('returns shortId undefined + stdoutDiagnostic when banner is missing', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const promise = spawnClaudeBg([], '/work', {});
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('something else entirely\n'));
      child.emit('exit', 1);
    });
    const result = await promise;
    expect(result.shortId).toBeUndefined();
    expect(result.stdoutDiagnostic).toContain('something else');
  });

  it('merges process.env with caller env (caller wins on collision)', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    process.env.AGENT_TEMPO_TEST_COLLISION = 'from-process';
    try {
      const promise = spawnClaudeBg([], '/work', {
        AGENT_TEMPO_ENSEMBLE: 'jam',
        AGENT_TEMPO_TEST_COLLISION: 'from-caller',
      });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('backgrounded · aaaaaaaa (idle)\n'));
        child.emit('exit', 0);
      });
      await promise;
      const [, , opts] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.env.AGENT_TEMPO_ENSEMBLE).toBe('jam');
      expect(opts.env.AGENT_TEMPO_TEST_COLLISION).toBe('from-caller');
    } finally {
      delete process.env.AGENT_TEMPO_TEST_COLLISION;
    }
  });

  it('pipes stdout/stderr (NOT ignore) so the banner is parseable', async () => {
    const child = fakeChild();
    (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const promise = spawnClaudeBg([], '/work', {});
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafef00d (idle)\n'));
      child.emit('exit', 0);
    });
    await promise;
    const [, , opts] = (mockedSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.cwd).toBe('/work');
  });

  it('regex pattern is exported and matches Anthropic\'s banner format', () => {
    expect('backgrounded · 5b7e4f5b (idle — send a prompt to start)'.match(BG_SHORT_ID_PATTERN)?.[1]).toBe('5b7e4f5b');
    expect('backgrounded·aaaaaaaa (idle)'.match(BG_SHORT_ID_PATTERN)?.[1]).toBe('aaaaaaaa');
    // Tolerant of the alt middle-dot codepoint • (U+2022)
    expect('backgrounded • 12345678 (idle)'.match(BG_SHORT_ID_PATTERN)?.[1]).toBe('12345678');
    expect('something-else'.match(BG_SHORT_ID_PATTERN)).toBeNull();
  });
});
