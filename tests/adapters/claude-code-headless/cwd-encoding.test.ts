/**
 * Pin Claude Code's per-cwd JSONL filename encoding scheme.
 *
 * Issue #520 PR-3 (post-review patch). `encodeCwd` is load-bearing for
 * session resume — `claude -p --resume <uuid>` only finds the JSONL
 * file when the per-cwd encoded directory matches Claude Code's own
 * scheme. If the CLI ever changes the scheme in a minor bump, this
 * test catches it before users hit silent session-fork bugs (each new
 * turn would start a fresh session JSONL instead of resuming).
 *
 * Cases were captured empirically during the §11.2 spike check (issue
 * #520, 2026-05-02): on Windows, `C:\Users\vince\AppData\Local\Temp\...`
 * resolved to `C--Users-vince-AppData-Local-Temp-...` in
 * `~/.claude/projects/`, confirming the `[\/\\:]` → `-` replacement.
 */
import { describe, it, expect } from 'vitest';
import { encodeCwd } from '../../../src/adapters/claude-code-headless/adapter';

describe('encodeCwd', () => {
  it('POSIX path → all slashes replaced with dashes', () => {
    expect(encodeCwd('/home/user/repo')).toBe('-home-user-repo');
  });

  it('Windows path → C:\\ becomes C-- (confirmed spike §11.2)', () => {
    expect(encodeCwd('C:\\repos\\foo')).toBe('C--repos-foo');
  });

  it('mixed separators (git-bash style C:/repos/...) — confirmed spike §11.2', () => {
    expect(encodeCwd('C:/repos/foo')).toBe('C--repos-foo');
  });

  it('deep Windows path with username — full spike-fixture round-trip', () => {
    // From the §11.2 spike: `/tmp/claude-headless-spike` (git-bash mount)
    // resolved to `C:\Users\vince\AppData\Local\Temp\claude-headless-spike`,
    // which encoded as `C--Users-vince-AppData-Local-Temp-claude-headless-spike`.
    expect(encodeCwd('C:\\Users\\vince\\AppData\\Local\\Temp\\claude-headless-spike'))
      .toBe('C--Users-vince-AppData-Local-Temp-claude-headless-spike');
  });

  it('repeated separators collapse appropriately (no special handling — each char becomes one dash)', () => {
    // The CLI does not collapse repeated separators; `//` becomes `--`.
    // Documenting current behaviour so a future "normalize to single dash"
    // change to either side would surface here.
    expect(encodeCwd('/a//b')).toBe('-a--b');
  });

  it('empty cwd → empty string', () => {
    expect(encodeCwd('')).toBe('');
  });

  it('cwd with no separators → unchanged', () => {
    expect(encodeCwd('simple')).toBe('simple');
  });
});
