import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, maestroWorkflowId, schedulerWorkflowId } from '../config';
import { scanEnsembleSessions } from '../activities/resolve';
import { defineTool, ok, fail, formatError } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:resume]', ...args);

export function registerResumeEnsembleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'resume_ensemble',
    'Resume all paused sessions in the ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries will be dispatched.',
    {},
    async () => {
      try {
        const results: string[] = [];
        const errors: string[] = [];

        // 1. Signal maestro with unpaused state (ground truth)
        try {
          const maestroId = maestroWorkflowId(config.ensemble);
          const maestroHandle = client.workflow.getHandle(maestroId);
          await maestroHandle.signal('maestroSetPaused', false);
          results.push('maestro resumed');
        } catch {
          // Maestro may not be running
        }

        // 2. Signal all active sessions
        const sessions = await scanEnsembleSessions(client, config.ensemble);
        let sessionCount = 0;
        for (const session of sessions) {
          try {
            const sessionHandle = client.workflow.getHandle(session.workflowId);
            await sessionHandle.signal('setPaused', false);
            sessionCount++;
          } catch (err) {
            errors.push(`${session.playerId}: ${formatError(err)}`);
          }
        }
        results.push(`${sessionCount} session(s) resumed`);

        // 3. Signal scheduler
        try {
          const schedulerId = schedulerWorkflowId(config.ensemble);
          const schedulerHandle = client.workflow.getHandle(schedulerId);
          await schedulerHandle.signal('setSchedulerPaused', false);
          results.push('scheduler resumed');
        } catch {
          // Scheduler may not be running
        }

        const lines = [`Ensemble **${config.ensemble}** resumed.`, results.join(', ')];
        if (errors.length > 0) {
          lines.push(`Errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
        }

        log(`Resumed ensemble "${config.ensemble}" by ${getPlayerId()}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to resume ensemble: ${formatError(err)}`);
      }
    },
  );
}
