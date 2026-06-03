import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { releaseHeldSignal, setPausedSignal } from '../workflows/signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { unpauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[agent-tempo:play]', ...args);

export function buildPlayTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'play',
    description: 'Resume all paused sessions in the ensemble — unlocks outbox dispatch and resumes the scheduler. Buffered outbox entries will be dispatched. Pass `release: true` to also release any held sessions (deliver deferred task messages and unlock their outboxes) in the same call.',
    params: {
      release: z.boolean().optional().describe('Also release any held sessions (deliver deferred task messages and unlock outboxes). Safe to call when no sessions are held — it is a no-op on those. Default: false.'),
    },
    handler: async (args) => {
      const release = (args as { release?: boolean }).release === true;

      try {
        // Unpause everything in parallel: maestro + scheduler + every session.
        const [toggle, sessions] = await Promise.all([
          unpauseMaestroAndScheduler(client, config.ensemble),
          signalAllSessions(client, config.ensemble, setPausedSignal.name, false),
        ]);

        // `releaseHeld` is idempotent — safe to fan out to everyone. Keep it
        // AFTER the unpause so sessions aren't releasing while paused.
        let releasedCount = 0;
        const releaseErrors: string[] = [];
        if (release) {
          const released = await signalAllSessions(
            client,
            config.ensemble,
            // typed constant → `'releaseHeld'` string name, matches the session handler
            releaseHeldSignal.name,
            undefined,
          );
          releasedCount = released.sent;
          for (const p of released.perSession) {
            if (p.outcome === 'failed') releaseErrors.push(`${p.playerId} release: ${'error' in p ? p.error : ''}`);
          }
        }

        const bits: string[] = [
          `Ensemble **${config.ensemble}** resumed.`,
          `${sessions.sent} session(s) resumed`,
        ];
        if (release) bits.push(`${releasedCount} session(s) signalled for release`);
        if (toggle.maestro) bits.push('maestro resumed');
        if (toggle.scheduler) bits.push('scheduler resumed');

        const failedUnpause = sessions.perSession
          .filter((p) => p.outcome === 'failed')
          .map((p) => `  - ${p.playerId}: ${'error' in p ? p.error : ''}`);
        const allErrors = [...failedUnpause, ...releaseErrors.map((e) => `  - ${e}`)];
        if (allErrors.length > 0) bits.push(`Errors:\n${allErrors.join('\n')}`);

        log(`Resumed ensemble "${config.ensemble}" by ${getPlayerId()}${release ? ' (with release)' : ''}`);
        return ok(bits.join('\n'));
      } catch (err) {
        return fail(`Failed to resume ensemble: ${formatError(err)}`);
      }
    },
  };
}
