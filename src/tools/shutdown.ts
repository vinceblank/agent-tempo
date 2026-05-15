/**
 * `shutdown` — graceful ensemble-wide teardown (#287).
 *
 * Fan-out peer to `pause` / `play`: walks every session in the ensemble and
 * requests a graceful detach, then pauses the scheduler + maestro so no new
 * work fires while the adapters drain. Workflows survive — pair with
 * `restore` to reattach, or `destroy` (ensemble-scope) for terminal teardown.
 *
 * The per-session fan-out uses `signalAllSessions` so every detach runs in
 * parallel; a slow / dead session can't block peers from draining.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { requestDetachSignal } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { MAX_DETACH_DEADLINE_MS, DEFAULT_RESTART_DETACH_DEADLINE_MS } from '../utils/validation';
import { pauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[agent-tempo:shutdown]', ...args);

export function registerShutdownTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'shutdown',
    'Gracefully shut down the ensemble: request detach on every session, pause the scheduler, and pause the maestro. Workflows survive in `detached` phase. Pair with `restore` to come back up, or `destroy` (no player arg) to terminate. Does not touch your own session.',
    {
      deadlineMs: z.number().min(0).max(MAX_DETACH_DEADLINE_MS).optional().describe(
        `Max drain time per session before force-detach (default ${DEFAULT_RESTART_DETACH_DEADLINE_MS}, max ${MAX_DETACH_DEADLINE_MS}).`,
      ),
    },
    async (args) => {
      const { deadlineMs = DEFAULT_RESTART_DETACH_DEADLINE_MS } = args as { deadlineMs?: number };
      const callerId = getPlayerId();

      try {
        // Pause maestro + scheduler in parallel with the session fan-out —
        // they're independent and draining adapters won't mind if the
        // scheduler keeps firing for a few ms longer.
        const [toggle, fanout] = await Promise.all([
          pauseMaestroAndScheduler(client, config.ensemble),
          signalAllSessions(
            client,
            config.ensemble,
            requestDetachSignal.name,
            { reason: 'user-stop', deadlineMs },
            { skip: (playerId) => playerId === callerId },
          ),
        ]);

        const summaryLine = `${fanout.sent} detaching, ${fanout.skipped} skipped, ${fanout.failed} failed`;
        const bits: string[] = [`Ensemble **${config.ensemble}** shutting down.`, summaryLine];
        if (toggle.maestro) bits.push('maestro paused');
        if (toggle.scheduler) bits.push('scheduler paused');
        if (fanout.failed > 0) {
          const errs = fanout.perSession
            .filter((p) => p.outcome === 'failed')
            .map((p) => `  - ${p.playerId}: ${'error' in p ? p.error : ''}`);
          bits.push(`Errors:\n${errs.join('\n')}`);
        }

        log(`Shutdown requested by ${callerId} in "${config.ensemble}": ${summaryLine}`);
        return ok(bits.join('\n'));
      } catch (err) {
        return fail(`Failed to shut down ensemble: ${formatError(err)}`);
      }
    },
  );
}
