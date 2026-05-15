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

/** Register agent-tempo globally via `claude mcp add`. */
export function addGlobalMcp(): boolean {
  try {
    execFileSync('claude', [
      'mcp', 'add', 'agent-tempo', '-s', 'user',
      '--', 'agent-tempo-server',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
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
