import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { defineTool, ok, fail, formatError } from './helpers';
import { pauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[claude-tempo:pause]', ...args);

export function registerPauseTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'pause',
    'Pause all sessions in the ensemble — locks outbox dispatch and pauses the scheduler. Stop commands still go through. Use `play` to unpause.',
    {},
    async () => {
      try {
        const [toggle, sessions] = await Promise.all([
          pauseMaestroAndScheduler(client, config.ensemble),
          signalAllSessions(client, config.ensemble, 'setPaused', true),
        ]);

        const bits: string[] = [
          `Ensemble **${config.ensemble}** paused.`,
          `${sessions.sent} session(s) paused`,
        ];
        if (toggle.maestro) bits.push('maestro paused');
        if (toggle.scheduler) bits.push('scheduler paused');
        if (sessions.failed > 0) {
          const errs = sessions.perSession
            .filter((p) => p.outcome === 'failed')
            .map((p) => `  - ${p.playerId}: ${'error' in p ? p.error : ''}`);
          bits.push(`Errors:\n${errs.join('\n')}`);
        }

        log(`Paused ensemble "${config.ensemble}" by ${getPlayerId()}`);
        return ok(bits.join('\n'));
      } catch (err) {
        return fail(`Failed to pause ensemble: ${formatError(err)}`);
      }
    },
  );
}
