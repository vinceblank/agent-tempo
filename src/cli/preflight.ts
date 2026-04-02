import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { getConfig, CliOverrides } from '../config';
import { createTemporalConnection } from '../connection';
import { resolveClaudePath } from '../spawn';
import * as out from './output';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function whichSync(cmd: string): string | null {
  const bin = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(bin, [cmd], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

export async function runPreflight(opts: CliOverrides & {
  dir: string;
}): Promise<PreflightResult> {
  const config = getConfig(opts);
  const errors: string[] = [];
  const warnings: string[] = [];

  out.heading('Preflight checks');

  // 1. Node.js version
  const major = parseInt(process.version.slice(1), 10);
  const nodeOk = major >= 18;
  out.check('Node.js >= 18', nodeOk, process.version);
  if (!nodeOk) errors.push(`Node.js 18+ required, found ${process.version}`);

  // 2. Temporal reachable
  let temporalOk = false;
  try {
    const conn = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    await conn.close();
    temporalOk = true;
  } catch { /* unreachable */ }
  out.check('Temporal reachable', temporalOk, config.temporalAddress);
  if (!temporalOk) errors.push(`Cannot connect to Temporal at ${config.temporalAddress}. Run: temporal server start-dev`);

  // 3. claude binary
  const claudePath = resolveClaudePath();
  const claudeOk = claudePath !== 'claude';
  out.check('claude binary found', claudeOk, claudeOk ? claudePath : 'not on PATH');
  if (!claudeOk) errors.push('claude binary not found on PATH. Install Claude Code first.');

  // 4. claude-tempo-server binary (the MCP server)
  const serverPath = whichSync('claude-tempo-server');
  const serverOk = !!serverPath;
  out.check('claude-tempo-server found', serverOk, serverOk ? serverPath! : 'not on PATH');
  if (!serverOk) errors.push('claude-tempo-server not found on PATH. Run: npm install -g claude-tempo');

  // 5. MCP config in project
  const mcpPath = join(opts.dir, '.mcp.json');
  let mcpOk = false;
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      mcpOk = !!mcp?.mcpServers?.['claude-tempo'];
    } catch { /* invalid json */ }
  }
  out.check('.mcp.json configured', mcpOk, mcpOk ? mcpPath : 'missing or no claude-tempo entry');
  if (!mcpOk) warnings.push(`No claude-tempo MCP config in ${opts.dir}. Run: claude-tempo init`);

  console.log();
  return { ok: errors.length === 0, errors, warnings };
}
