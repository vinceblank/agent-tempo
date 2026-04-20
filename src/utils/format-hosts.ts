/**
 * Shared formatter for the #274 `hosts` surface.
 *
 * Single source of truth consumed by:
 *   - `src/tools/hosts.ts` (MCP tool) — formatted text in `ok(...)` payload
 *   - `src/cli/commands.ts` (CLI `hosts` command) — stdout table
 *   - `src/tui/commands.ts` (TUI `/hosts` slash) — overlay content
 *
 * Pure: no Temporal, no I/O, no ANSI colors (the CLI can wrap lines in
 * color downstream if desired; the formatter emits plain strings so
 * tests can assert exact output without stripping escape codes).
 */
import type { HostInfo } from '../types';

export interface FormatHostsOpts {
  /**
   * Include hosts whose freshness is `'stale'`. Default `false`:
   * CLI/TUI hide them by default; `--all` opts in.
   */
  includeStale?: boolean;
}

export function formatHostList(hosts: HostInfo[], opts: FormatHostsOpts = {}): string {
  const includeStale = opts.includeStale ?? false;
  const visible = includeStale ? hosts : hosts.filter((h) => h.freshness === 'live');

  if (visible.length === 0) {
    if (!includeStale && hosts.length > 0) {
      return 'No live hosts connected. Pass `--all` to include stale hosts.';
    }
    return 'No hosts connected.';
  }

  const lines: string[] = [];
  lines.push(`${visible.length} host${visible.length === 1 ? '' : 's'} connected:`);
  lines.push('');
  for (const host of visible) {
    lines.push(...formatSingleHost(host));
    lines.push('');
  }
  // Drop the final empty line so consumers don't have to `.trim()`.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function formatSingleHost(host: HostInfo): string[] {
  const lines: string[] = [];
  const tag = host.freshness === 'live' ? '' : ' (stale)';
  const recruit = host.recruitReady ? 'recruit-ready' : 'not recruit-ready';
  lines.push(`**${host.hostname}**${tag} — ${recruit}`);

  // Instance(s). One-liner per pid.
  for (const inst of host.instances) {
    const bits: string[] = [`pid ${inst.pid}`, `version ${inst.version}`];
    const workerBits: string[] = [];
    if (inst.hasWorkflowWorker) workerBits.push('wf');
    if (inst.hasActivityWorker) workerBits.push('act');
    if (inst.hasHostQueueWorker) workerBits.push('host');
    bits.push(`workers: ${workerBits.length > 0 ? workerBits.join('+') : 'none'}`);
    if (inst.lastAccessTime) bits.push(`last seen ${inst.lastAccessTime}`);
    if (inst.legacy) bits.push('legacy-identity');
    lines.push(`  - ${bits.join(' · ')}`);
  }

  // Profile (capability).
  if (host.profile) {
    const p = host.profile;
    const profileBits: string[] = [];
    if (p.platform) profileBits.push(`platform: ${p.platform}`);
    if (p.defaultAgent) profileBits.push(`default agent: ${p.defaultAgent}`);
    if (p.claudeBin) profileBits.push(`claude bin: ${p.claudeBin}`);
    if (profileBits.length > 0) lines.push(`  profile · ${profileBits.join(' · ')}`);
    if (p.availableAgentTypes && p.availableAgentTypes.length > 0) {
      lines.push(`    available agents: ${p.availableAgentTypes.join(', ')}`);
    }
    if (p.availablePlayerTypes && p.availablePlayerTypes.length > 0) {
      lines.push(`    available player types: ${p.availablePlayerTypes.join(', ')}`);
    }
    if (host.profileStaleness === 'stale') {
      lines.push(`    ⚠ profile version disagrees with live identity — awaiting re-signal`);
    }
  } else if (host.profileStaleness === 'missing') {
    lines.push(`  (profile unavailable)`);
  }

  return lines;
}
