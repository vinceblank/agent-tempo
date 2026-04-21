/**
 * `restore` — ensemble-wide revive (#287).
 *
 * Counterpart to `shutdown`:
 *   1. Reattach every local orphan (delegates to the shared
 *      `restoreOrphansOnce` helper from `src/reconcile/orphans.ts`, which
 *      is the same code the daemon runs at boot and the CLI resume flow
 *      runs on `up` option 2 / `conduct --resume`).
 *   2. Unpause the maestro + scheduler so new work flows again.
 *
 * Scope note: conductor-auto-spawn is intentionally NOT handled here
 * (#287 product decision). MCP tools run inside the daemon worker; opening
 * a GUI terminal from that context is platform-fragile and surprising for
 * headless / programmatic callers. The CLI `restore` surface (S4 of #285)
 * owns terminal spawning where a TTY context is available.
 */
import { hostname as osHostname } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import {
  restoreOrphansOnce,
  formatRestoreOutcome,
  type RestoreOrphansSummary,
} from '../reconcile/orphans';
import { defineTool, ok, fail, formatError } from './helpers';
import { unpauseMaestroAndScheduler } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[claude-tempo:restore]', ...args);

export function registerRestoreTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'restore',
    'Revive the ensemble after `shutdown`: reattach all orphaned sessions on this host and unpause the maestro + scheduler. Returns per-player outcome + counts. Does NOT spawn a conductor terminal — use the CLI for that.',
    {},
    async () => {
      try {
        let summary: RestoreOrphansSummary;
        try {
          summary = await restoreOrphansOnce(
            client,
            {
              hostname: osHostname(),
              invokerPlayerId: getPlayerId(),
              policy: 'auto',
            },
            log,
          );
        } catch (err) {
          return fail(`Failed to scan for orphans: ${formatError(err)}`);
        }

        const toggle = await unpauseMaestroAndScheduler(client, config.ensemble);

        const lines: string[] = [
          `Ensemble **${config.ensemble}** restored.`,
          `${summary.reattached} reattached, ${summary.skipped} skipped, ${summary.failed} failed`,
        ];
        if (summary.details.length > 0) {
          lines.push(
            ...summary.details.map(
              (d) => `  - ${d.playerId} (${d.ensemble}): ${formatRestoreOutcome(d.outcome)}`,
            ),
          );
        }
        const unpausedBits: string[] = [];
        if (toggle.maestro) unpausedBits.push('maestro');
        if (toggle.scheduler) unpausedBits.push('scheduler');
        if (unpausedBits.length > 0) lines.push(`Unpaused: ${unpausedBits.join(', ')}`);

        log(
          `Restore by ${getPlayerId()} in "${config.ensemble}": ` +
          `${summary.reattached}/${summary.skipped}/${summary.failed}`,
        );
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to restore ensemble: ${formatError(err)}`);
      }
    },
  );
}
