/**
 * #818 — `addGlobalMcp` used to `catch { return false }`, silently eating the
 * reason global MCP registration failed on a fresh published-package install. It
 * now returns `{ ok, error }`, capturing the `claude mcp add` stderr (or the error
 * message) so the caller can surface WHY the fallback to a project `.mcp.json` fired.
 *
 * `execFileSync` is mocked so both the success and the failure-detail-capture paths
 * are deterministic without a real `claude` binary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSyncMock = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

// Import AFTER the mock is registered.
import { addGlobalMcp } from '../../src/cli/mcp';

describe('addGlobalMcp — #818 {ok, error} contract', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    delete process.env.DEBUG;
  });
  afterEach(() => {
    delete process.env.DEBUG;
  });

  it('success → { ok: true }, invokes `claude mcp add -s user`', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const result = addGlobalMcp();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    const [bin, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('claude');
    expect(args).toEqual(['mcp', 'add', 'agent-tempo', '-s', 'user', '--', 'agent-tempo-server']);
  });

  it('failure with stderr Buffer → { ok: false } capturing the trimmed stderr', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('  user scope config not writable\n'),
    });
    execFileSyncMock.mockImplementation(() => { throw err; });
    const result = addGlobalMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('user scope config not writable');
  });

  it('failure with stderr string → captures it', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('x'), { stderr: 'unknown flag: -s' });
    });
    expect(addGlobalMcp().error).toBe('unknown flag: -s');
  });

  it('failure with NO stderr (e.g. ENOENT) → falls back to the error message', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('spawn claude ENOENT');
    });
    const result = addGlobalMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });
});
