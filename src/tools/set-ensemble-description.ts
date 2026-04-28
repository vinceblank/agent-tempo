/**
 * `set_ensemble_description` MCP tool — #399 W1 (Q5.1).
 *
 * Updates the per-ensemble maestro's mission-flavor description string,
 * surfaced on the dashboard EnsembleCard. Conductors are encouraged to
 * keep updates milestone-flavored (~80 chars) — see
 * `examples/agents/tempo-conductor.md`.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, maestroWorkflowId } from '../config';
import { setEnsembleDescriptionSignal } from '../workflows/maestro-signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { ENSEMBLE_DESCRIPTION_MAX } from '../utils/validation';

export function registerSetEnsembleDescriptionTool(
  server: McpServer,
  client: Client,
  config: Config,
) {
  defineTool(
    server,
    'set_ensemble_description',
    "Update the ensemble's mission-flavor description (≤100 chars). Surfaces on the dashboard EnsembleCard. Empty string clears it. Refresh at milestone boundaries — don't update for trivial changes.",
    {
      description: z
        .string()
        .max(ENSEMBLE_DESCRIPTION_MAX)
        .describe('Short summary of what the ensemble is currently working on (≤100 chars).'),
    },
    async (args) => {
      const { description } = args as { description: string };
      try {
        const handle = client.workflow.getHandle(maestroWorkflowId(config.ensemble));
        await handle.signal(setEnsembleDescriptionSignal.name, description);
        if (description.trim().length === 0) {
          return ok(`Ensemble **${config.ensemble}** description cleared.`);
        }
        return ok(`Ensemble **${config.ensemble}** description updated: "${description}"`);
      } catch (err) {
        return fail(`Failed to set ensemble description: ${formatError(err)}`);
      }
    },
  );
}
