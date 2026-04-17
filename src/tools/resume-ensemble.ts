import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
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
    'Resume all paused sessions in the ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries will be dispatched. Pass `release: true` to also release any held sessions (deliver deferred task messages and unlock their outboxes) in the same call.',
    {
      release: z.boolean().optional().describe('Also release any held sessions (deliver deferred task messages and unlock outboxes). Safe to call when no sessions are held — it is a no-op on those. Default: false.'),
    },
    async (args) => {
      const release = (args as { release?: boolean }).release === true;

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

        // 2. Signal all active sessions — unpause, and release held ones if opted in.
        // `releaseHeld` is idempotent on sessions that aren't holding (no heldMessage,
        // outboxLocked: false already), so it's safe to fan out unconditionally when
        // `release: true`. See `src/workflows/session.ts` releaseHeldSignal handler.
        const sessions = await scanEnsembleSessions(client, config.ensemble);
        let sessionCount = 0;
        let releasedCount = 0;
        for (const session of sessions) {
          try {
            const sessionHandle = client.workflow.getHandle(session.workflowId);
            await sessionHandle.signal('setPaused', false);
            sessionCount++;
            if (release) {
              try {
                await sessionHandle.signal('releaseHeld');
                releasedCount++;
              } catch (err) {
                errors.push(`${session.playerId} release: ${formatError(err)}`);
              }
            }
          } catch (err) {
            errors.push(`${session.playerId}: ${formatError(err)}`);
          }
        }
        results.push(`${sessionCount} session(s) resumed`);
        if (release) {
          results.push(`${releasedCount} session(s) signalled for release`);
        }

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

        log(`Resumed ensemble "${config.ensemble}" by ${getPlayerId()}${release ? ' (with release)' : ''}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to resume ensemble: ${formatError(err)}`);
      }
    },
  );
}
