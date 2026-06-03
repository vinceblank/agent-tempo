import { Client } from '@temporalio/client';
import { Config } from '../config';
import { setPausedSignal } from '../workflows/signals';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { pauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';

const log = (...args: unknown[]) => console.error('[agent-tempo:pause]', ...args);

export function buildPauseTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'pause',
    description: 'Pause all sessions in the ensemble — locks outbox dispatch and pauses the scheduler. Stop commands still go through. Use `play` to unpause.',
    params: {},
    handler: async () => {
      try {
        const [toggle, sessions] = await Promise.all([
          pauseMaestroAndScheduler(client, config.ensemble),
          signalAllSessions(client, config.ensemble, setPausedSignal.name, true),
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
  };
}
