/**
 * P1 regression guard (2026-07-15 teardown incident): `agent-tempo down --help`
 * executed the REAL `down` — stopping the daemon + shared Temporal server
 * (~90s outage) and removing .mcp.json — because the positional-verb override
 * in `parseArgs` clobbered the `command = 'help'` set by the `--help` flag
 * branch. Same clobber applied to `--version` and to EVERY verb
 * (`destroy --help`, `up --help`, …).
 *
 * Contract pinned here: an explicit `--help` / `-h` / `--version` / `-v`
 * wins over any positional verb, in either argument order, and unknown flags
 * reject with exit 1 before any verb can run. Asking a destructive verb for
 * help must never run it.
 *
 * `parseArgs` is pure and exported for tests; `src/cli.ts`'s `main()` is
 * behind a `require.main` guard (same pattern as `src/daemon.ts`), so
 * importing it here executes nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs } from '../../src/cli';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs — help/version win over positional verbs', () => {
  const destructiveVerbs = ['down', 'destroy', 'shutdown', 'upgrade-to-2'];

  for (const verb of destructiveVerbs) {
    it(`'${verb} --help' resolves to the help command, not '${verb}'`, () => {
      expect(parseArgs([verb, '--help']).command).toBe('help');
      expect(parseArgs([verb, '-h']).command).toBe('help');
    });
  }

  it('flag order does not matter (--help before the verb)', () => {
    expect(parseArgs(['--help', 'down']).command).toBe('help');
  });

  it('--version / -v also win over a positional verb', () => {
    expect(parseArgs(['down', '--version']).command).toBe('version');
    expect(parseArgs(['destroy', '-v']).command).toBe('version');
  });

  it('non-destructive verbs get the same guard (class fix, not instance)', () => {
    expect(parseArgs(['up', '--help']).command).toBe('help');
    expect(parseArgs(['status', '--help']).command).toBe('help');
  });

  it('verbs without help flags still dispatch normally', () => {
    expect(parseArgs(['down']).command).toBe('down');
    expect(parseArgs(['down', '--destroy']).command).toBe('down');
    expect(parseArgs(['down', '--destroy']).destroy).toBe(true);
    expect(parseArgs(['status']).command).toBe('status');
  });

  it('bare --help / --version (no verb) keep working', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });
});

describe('parseArgs — unknown flags reject before any verb can run', () => {
  it("'down --anything-unknown' exits 1 without resolving a runnable command", () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    expect(() => parseArgs(['down', '--anything-unknown'])).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('single-dash typos of help also reject rather than executing the verb', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    expect(() => parseArgs(['down', '-help'])).toThrow('process.exit(1)');
  });
});
