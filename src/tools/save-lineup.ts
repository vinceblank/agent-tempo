import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { saveLineup } from '../ensemble/saver';
import { safeLineupPath } from '../utils/safe-path';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { PLAYER_NAME_MAX, PATH_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[agent-tempo:save-lineup]', ...args);

export function buildSaveLineupTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
  isConductor: boolean,
): TempoToolDescriptor {
  return {
    name: 'save_lineup',
    description: 'Save the current ensemble state as a YAML lineup. Only available to the conductor.',
    params: {
      name: z.string().max(PLAYER_NAME_MAX).optional().describe('Lineup name (defaults to ensemble name)'),
      path: z.string().max(PATH_MAX).optional().describe('Explicit file path to save to'),
    },
    handler: async (args) => {
      if (!isConductor) {
        return fail('Only the conductor can save ensemble lineups.');
      }

      const lineupName = (args as any).name as string | undefined;
      const filePath = (args as any).path as string | undefined;

      try {
        // Validate user-supplied path if provided
        let validatedPath = filePath;
        if (validatedPath) {
          validatedPath = safeLineupPath(validatedPath, process.cwd());
        }
        // Pass lineupName as optional name override for the output filename.
        // If no name or path is provided, saveLineup defaults to ensemble name.
        const outputPath = await saveLineup(client, config.ensemble, validatedPath, lineupName);
        log(`Saved lineup to ${outputPath}`);

        return ok(`Ensemble lineup saved to **${outputPath}**.`);
      } catch (err) {
        return fail(`Failed to save ensemble: ${formatError(err)}`);
      }
    },
  };
}
