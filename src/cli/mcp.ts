import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/** Check if claude-tempo is registered in `claude mcp list` (global user scope). */
export function isGlobalMcpRegistered(): boolean {
  try {
    const output = execFileSync('claude', ['mcp', 'list', '-s', 'user'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\bclaude-tempo\b/.test(output);
  } catch {
    return false;
  }
}

/** Register claude-tempo globally via `claude mcp add`. */
export function addGlobalMcp(): boolean {
  try {
    execFileSync('claude', [
      'mcp', 'add', 'claude-tempo', '-s', 'user',
      '--', 'claude-tempo-server',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Remove claude-tempo from global MCP config via `claude mcp remove`. */
export function removeGlobalMcp(): boolean {
  try {
    execFileSync('claude', [
      'mcp', 'remove', 'claude-tempo', '-s', 'user',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Check if claude-tempo MCP is configured (global or project-level). */
export function isMcpConfigured(projectDir: string): boolean {
  if (isGlobalMcpRegistered()) return true;
  const mcpPath = join(projectDir, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      return !!mcp?.mcpServers?.['claude-tempo'];
    } catch { /* invalid json */ }
  }
  return false;
}
