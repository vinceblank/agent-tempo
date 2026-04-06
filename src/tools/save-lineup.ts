import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { saveLineup } from '../ensemble/saver';
import { safeLineupPath } from '../utils/safe-path';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, PATH_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[claude-tempo:save-lineup]', ...args);

export function registerSaveLineupTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  isConductor: boolean,
) {
  defineTool(
    server,
    'save_lineup',
    'Save the current ensemble state as a YAML lineup. Only available to the conductor.',
    {
      name: z.string().max(PLAYER_NAME_MAX).optional().describe('Lineup name (defaults to ensemble name)'),
      path: z.string().max(PATH_MAX).optional().describe('Explicit file path to save to'),
    },
    async (args) => {
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
  );
}
