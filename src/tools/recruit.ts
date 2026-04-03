import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config, ENV, conductorWorkflowId } from '../config';
import { AgentType } from '../types';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { resolveSession } from './resolve';
import { defineTool } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:recruit]', ...args);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerRecruitTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  ownAgentType: AgentType = 'claude',
) {
  defineTool(
    server,
    'recruit',
    `Start a new named session in a directory. Rejects if the name is already active. Supports Claude Code or Copilot CLI agents. Defaults to "${ownAgentType}" (same as this session).`,
    {
      workDir: z.string().describe('The working directory for the new session'),
      name: z.string().describe('Name for the new session'),
      conductor: z.boolean().optional()
        .describe('Whether this session is a conductor (default: false)'),
      initialMessage: z.string().optional()
        .describe('Optional task or message for the new session (sent after it sets its name)'),
      agent: z.enum(['claude', 'copilot']).optional()
        .describe(`Which agent to use (default: "${ownAgentType}", same as this session)`),
    },
    async (args) => {
      const { workDir, name, initialMessage } = args as {
        workDir: string;
        name: string;
        conductor?: boolean;
        initialMessage?: string;
        agent?: AgentType;
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = (args as any).agent || ownAgentType;
      // Validate name
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid name "${name}". Names must contain only letters, numbers, hyphens, and underscores.`,
          }],
          isError: true,
        };
      }
      if (name === 'conductor' && !isConductor) {
        return {
          content: [{
            type: 'text' as const,
            text: `The name "conductor" is reserved for conductor sessions. Use a different name, or set conductor: true.`,
          }],
          isError: true,
        };
      }

      try {
        // Check if a conductor already exists when recruiting a conductor
        if (isConductor) {
          try {
            const conductorWfId = conductorWorkflowId(config.ensemble);
            const conductorHandle = client.workflow.getHandle(conductorWfId);
            const desc = await conductorHandle.describe();
            if (desc.status.name === 'RUNNING') {
              return {
                content: [{
                  type: 'text' as const,
                  text: `A conductor is already running in ensemble "${config.ensemble}". Use \`claude-tempo conduct --replace\` from the CLI to replace it, or \`terminate\` it first.`,
                }],
                isError: true,
              };
            }
          } catch {
            // No existing conductor — proceed
          }
        }

        // Check if a session with this name is already active
        const existing = await resolveSession(client, config.ensemble, name);
        if (existing) {
          return {
            content: [{
              type: 'text' as const,
              text: `Session **${name}** is already active. Use \`cue\` to send it a message, or \`terminate\` it first.`,
            }],
            isError: true,
          };
        }

        // Record existing workflows so we can find the new one
        const existingIds = new Set<string>();
        const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
        for await (const wf of client.workflow.list({ query: listQuery })) {
          existingIds.add(wf.workflowId);
        }

        // Spawn the session using the selected backend
        if (agent === 'copilot') {
          const { pid } = spawnCopilotBridge({
            name,
            ensemble: config.ensemble,
            temporalAddress: config.temporalAddress,
            temporalNamespace: config.temporalNamespace,
            temporalApiKey: config.temporalApiKey,
            temporalTlsCertPath: config.temporalTlsCertPath,
            temporalTlsKeyPath: config.temporalTlsKeyPath,
            isConductor,
            workDir,
          });
          log(`Spawned copilot-bridge (pid ${pid}) in ${workDir} as "${name}"`);
        } else {
          const spawnArgs = [
            '--dangerously-skip-permissions',
            '--dangerously-load-development-channels', 'server:claude-tempo',
            '-n', name,
          ];
          const envVars: Record<string, string> = {
            [ENV.ENSEMBLE]: config.ensemble,
            [ENV.CONDUCTOR]: isConductor ? 'true' : '',
            [ENV.PLAYER_NAME]: name,
            [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
            [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
          };
          if (config.temporalApiKey) envVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
          if (config.temporalTlsCertPath) envVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
          if (config.temporalTlsKeyPath) envVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;
          const { pid } = spawnInTerminal(spawnArgs, workDir, envVars);
          log(`Spawned claude process (pid ${pid}) in ${workDir} as "${name}"`);
        }

        // Poll for the new workflow to appear (up to ~15s)
        let newWorkflowId: string | null = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          await sleep(500);
          for await (const wf of client.workflow.list({ query: listQuery })) {
            if (!existingIds.has(wf.workflowId)) {
              newWorkflowId = wf.workflowId;
              break;
            }
          }
          if (newWorkflowId) break;
        }

        if (!newWorkflowId) {
          return {
            content: [{
              type: 'text' as const,
              text: `Session "${name}" spawned but did not register within 15 seconds. It may still be starting up. Check \`ensemble\` shortly.`,
            }],
          };
        }

        const newHandle = client.workflow.getHandle(newWorkflowId);

        // Name is already set via CLAUDE_TEMPO_PLAYER_NAME env var at startup,
        // so we only need to send the initial task message if provided.
        // (Previously we sent a set_name instruction here, but that was redundant
        // and could cause confusion if the LLM renamed itself incorrectly.)
        if (initialMessage) {
          await newHandle.signal('receiveMessage', {
            from: getPlayerId(),
            text: initialMessage,
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Recruited session **${name}** in ${workDir}. It will set its name shortly.${initialMessage ? ' Initial task sent.' : ''}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to recruit: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
