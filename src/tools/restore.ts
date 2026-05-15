/**
 * `restore` — ensemble-wide revive (#287).
 *
 * Counterpart to `shutdown`:
 *   1. Reattach every local orphan (delegates to the shared
 *      `restoreOrphansOnce` helper from `src/reconcile/orphans.ts`, which
 *      is the same code the daemon runs at boot and the CLI resume flow
 *      runs on `up` option 2 / `conduct --resume`).
 *   2. Unpause the maestro + scheduler so new work flows again.
 *   3. Fan out `setPaused=false` to every session so per-session outbox
 *      dispatchers (gated on `!paused`) start delivering again. Mirrors
 *      `play()` and `TempoClient.restore()` — the maestro/scheduler hub
 *      toggle is necessary but not sufficient: a session that was paused
 *      via `/pause` keeps its own `paused=true` flag and the outbox loop
 *      `canDispatch = !outboxLocked && !paused && hasPendingOutbox()`
 *      silently swallows messages until the per-session flag clears.
 *
 * Scope note: conductor-auto-spawn is intentionally NOT handled here
 * (#287 product decision). MCP tools run inside the daemon worker; opening
 * a GUI terminal from that context is platform-fragile and surprising for
 * headless / programmatic callers. The CLI `restore` surface (S4 of #285)
 * owns terminal spawning where a TTY context is available.
 */
import { hostname as osHostname } from 'os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import {
  restoreOrphansOnce,
  formatRestoreOutcome,
  type RestoreOrphansSummary,
} from '../reconcile/orphans';
import { setPausedSignal } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { unpauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[agent-tempo:restore]', ...args);

export function registerRestoreTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'restore',
    'Revive the ensemble after `shutdown`: reattach orphaned sessions and unpause the maestro + scheduler. Defaults to scanning the local host; pass `hostname` to target a remote machine in distributed setups (per-host task queues). Does NOT spawn a conductor terminal — use the CLI for that.',
    {
      // #306 follow-up: cross-host restore. The default (omitted) preserves
      // the original behavior — scan the local daemon's host. When supplied,
      // we route the orphan-visibility query against the named host's
      // `ClaudeTempoAttachedHost`/`ClaudeTempoHostname` search attributes,
      // so an operator on host A can revive sessions parked on host B.
      // Surfaced from my own #306 review (regression risk #2): "MCP
      // restore hard-codes hostname: osHostname() — won't see orphans on
      // other hosts in distributed setups."
      hostname: z.string().min(1).max(253).optional().describe(
        'Target host whose orphans should be restored. Defaults to the local OS hostname. Use this when the conductor / TUI is on a different machine than the workers that owned the parked sessions.',
      ),
    },
    async (args) => {
      const { hostname: explicitHostname } = args as { hostname?: string };
      const targetHostname = explicitHostname ?? osHostname();

      try {
        let summary: RestoreOrphansSummary;
        try {
          summary = await restoreOrphansOnce(
            client,
            {
              hostname: targetHostname,
              invokerPlayerId: getPlayerId(),
              policy: 'auto',
              // #306: narrow to detached-only so a live attached/processing
              // session is never flagged as an orphan by user-invoked
              // `/restore`. Daemon reconcile-on-boot + CLI `up --resume`
              // keep the broad live-phase default (no PID memory after
              // crash → must treat every live phase as presumed orphan).
              phases: ['detached'],
            },
            log,
          );
        } catch (err) {
          return fail(`Failed to scan for orphans: ${formatError(err)}`);
        }

        // Maestro/scheduler hub unpause + per-session `setPaused=false`
        // fan-out run in parallel — independent calls and a slow session
        // shouldn't gate the hub toggle (or vice-versa).
        const [toggle, sessions] = await Promise.all([
          unpauseMaestroAndScheduler(client, config.ensemble),
          signalAllSessions(client, config.ensemble, setPausedSignal.name, false),
        ]);

        const hostSuffix = explicitHostname !== undefined
          ? ` (host: ${explicitHostname})`
          : '';
        const lines: string[] = [
          `Ensemble **${config.ensemble}** restored${hostSuffix}.`,
          `${summary.reattached} reattached, ${summary.skipped} skipped, ${summary.failed} failed`,
        ];
        if (summary.details.length > 0) {
          lines.push(
            ...summary.details.map(
              (d) => `  - ${d.playerId} (${d.ensemble}): ${formatRestoreOutcome(d.outcome)}`,
            ),
          );
        }
        if (sessions.sent > 0) {
          lines.push(`${sessions.sent} session(s) resumed`);
        }
        const unpausedBits: string[] = [];
        if (toggle.maestro) unpausedBits.push('maestro');
        if (toggle.scheduler) unpausedBits.push('scheduler');
        if (unpausedBits.length > 0) lines.push(`Unpaused: ${unpausedBits.join(', ')}`);
        if (sessions.failed > 0) {
          const errs = sessions.perSession
            .filter((p) => p.outcome === 'failed')
            .map((p) => `  - ${p.playerId}: ${'error' in p ? p.error : ''}`);
          lines.push(`Errors:\n${errs.join('\n')}`);
        }

        log(
          `Restore by ${getPlayerId()} in "${config.ensemble}" on host "${targetHostname}": ` +
          `${summary.reattached}/${summary.skipped}/${summary.failed}`,
        );
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to restore ensemble: ${formatError(err)}`);
      }
    },
  );
}
