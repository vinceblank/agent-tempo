import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, maestroWorkflowId, schedulerWorkflowId } from '../config';
import { scanEnsembleSessions } from '../activities/resolve';
import { defineTool, ok, fail, formatError } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:pause]', ...args);

export function registerPauseEnsembleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'pause_ensemble',
    'Pause all sessions in the ensemble — locks outbox dispatch and pauses the scheduler. Stop commands still go through. Use resume_ensemble to unpause.',
    {},
    async () => {
      try {
        const results: string[] = [];
        const errors: string[] = [];

        // 1. Signal maestro with paused state (ground truth)
        try {
          const maestroId = maestroWorkflowId(config.ensemble);
          const maestroHandle = client.workflow.getHandle(maestroId);
          await maestroHandle.signal('maestroSetPaused', true);
          results.push('maestro paused');
        } catch {
          // Maestro may not be running
        }

        // 2. Signal all active sessions
        const sessions = await scanEnsembleSessions(client, config.ensemble);
        let sessionCount = 0;
        for (const session of sessions) {
          try {
            const sessionHandle = client.workflow.getHandle(session.workflowId);
            await sessionHandle.signal('setPaused', true);
            sessionCount++;
          } catch (err) {
            errors.push(`${session.playerId}: ${formatError(err)}`);
          }
        }
        results.push(`${sessionCount} session(s) paused`);

        // 3. Signal scheduler
        try {
          const schedulerId = schedulerWorkflowId(config.ensemble);
          const schedulerHandle = client.workflow.getHandle(schedulerId);
          await schedulerHandle.signal('setSchedulerPaused', true);
          results.push('scheduler paused');
        } catch {
          // Scheduler may not be running
        }

        const lines = [`Ensemble **${config.ensemble}** paused.`, results.join(', ')];
        if (errors.length > 0) {
          lines.push(`Errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
        }

        log(`Paused ensemble "${config.ensemble}" by ${getPlayerId()}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to pause ensemble: ${formatError(err)}`);
      }
    },
  );
}
