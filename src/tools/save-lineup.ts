import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { saveLineup } from '../ensemble/saver';
import { defineTool } from './helpers';

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
      name: z.string().optional().describe('Lineup name (defaults to ensemble name)'),
      path: z.string().optional().describe('Explicit file path to save to'),
    },
    async (args) => {
      if (!isConductor) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Only the conductor can save ensemble lineups.',
          }],
          isError: true,
        };
      }

      const lineupName = (args as any).name as string | undefined;
      const filePath = (args as any).path as string | undefined;

      try {
        // Pass lineupName as optional name override for the output filename.
        // If no name or path is provided, saveLineup defaults to ensemble name.
        const outputPath = await saveLineup(client, config.ensemble, filePath, lineupName);
        log(`Saved lineup to ${outputPath}`);

        return {
          content: [{
            type: 'text' as const,
            text: `Ensemble lineup saved to **${outputPath}**.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to save ensemble: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
