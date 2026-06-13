import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/** Check if agent-tempo is registered in `claude mcp list` (global user scope). */
export function isGlobalMcpRegistered(): boolean {
  try {
    const output = execFileSync('claude', ['mcp', 'list', '-s', 'user'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Match either the new (`agent-tempo`) or legacy (`agent-tempo`) registration —
    // dual-bin in `package.json` keeps the old name working through the migration window.
    return /\bagent-tempo\b/.test(output) || /\bagent-tempo\b/.test(output);
  } catch {
    return false;
  }
}

/** Result of {@link addGlobalMcp} — `ok` plus the captured failure reason. */
export interface AddGlobalMcpResult {
  ok: boolean;
  /**
   * #818 — when `ok` is false, the captured failure detail (the `claude mcp add`
   * stderr, or the error message). Lets the caller surface WHY global registration
   * failed instead of a bare "fell back to project .mcp.json" with no diagnosis.
   */
  error?: string;
}

/** Pull the most useful failure detail off a thrown execFileSync error. */
function execFailureDetail(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr;
  if (stderr) {
    const s = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr)).trim();
    if (s) return s;
  }
  return e?.message ? String(e.message).trim() : String(err);
}

/**
 * Register agent-tempo globally via `claude mcp add -s user`.
 *
 * #818 — global registration was observed FAILING on a fresh published-package
 * install (Windows), and the old `catch { return false }` swallowed the reason,
 * leaving the silent project-`.mcp.json` fallback undiagnosable. We now capture the
 * `claude mcp add` stderr and return it so the caller can surface it; a DEBUG-gated
 * breadcrumb (`[agent-tempo:mcp]`) records the full detail for `DEBUG=1` runs.
 *
 * Windows hypothesis (worth confirming when reproducing): `claude mcp add -s user`
 * may fail to resolve/write the user-scope config — e.g. the `claude` shim on PATH
 * resolves to a `.cmd`/`.ps1` wrapper that execFileSync can't invoke directly, or
 * the user-scope config path under `%APPDATA%`/`%USERPROFILE%` isn't writable in
 * that shell. The captured stderr is the first concrete signal to disambiguate.
 */
export function addGlobalMcp(): AddGlobalMcpResult {
  try {
    execFileSync('claude', [
      'mcp', 'add', 'agent-tempo', '-s', 'user',
      '--', 'agent-tempo-server',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const error = execFailureDetail(err);
    if (process.env.DEBUG) {
      console.error('[agent-tempo:mcp] `claude mcp add -s user` failed:', error);
    }
    return { ok: false, error };
  }
}

/** Remove agent-tempo from global MCP config via `claude mcp remove`. */
export function removeGlobalMcp(): boolean {
  try {
    execFileSync('claude', [
      'mcp', 'remove', 'agent-tempo', '-s', 'user',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Check if agent-tempo MCP is configured (global or project-level). */
export function isMcpConfigured(projectDir: string): boolean {
  if (isGlobalMcpRegistered()) return true;
  const mcpPath = join(projectDir, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      return !!mcp?.mcpServers?.['agent-tempo'];
    } catch { /* invalid json */ }
  }
  return false;
}
