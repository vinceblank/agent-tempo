import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { saveBlueprint } from '../ensemble/saver';
import { defineTool } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:save-ensemble]', ...args);

export function registerSaveEnsembleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  isConductor: boolean,
) {
  defineTool(
    server,
    'save_ensemble',
    'Save the current ensemble state as a YAML blueprint. Only available to the conductor.',
    {
      name: z.string().optional().describe('Blueprint name (defaults to ensemble name)'),
      path: z.string().optional().describe('Explicit file path to save to'),
    },
    async (args) => {
      if (!isConductor) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Only the conductor can save ensemble blueprints.',
          }],
          isError: true,
        };
      }

      const blueprintName = (args as any).name as string | undefined;
      const filePath = (args as any).path as string | undefined;

      try {
        // If a custom name is provided but no path, we don't override —
        // saveBlueprint uses the ensemble name for the default path.
        // We pass filePath through directly.
        const outputPath = await saveBlueprint(client, config.ensemble, filePath);
        log(`Saved blueprint to ${outputPath}`);

        return {
          content: [{
            type: 'text' as const,
            text: `Ensemble blueprint saved to **${outputPath}**.`,
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
