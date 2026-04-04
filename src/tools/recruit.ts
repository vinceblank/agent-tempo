import * as os from 'os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, ENV, conductorWorkflowId, sessionWorkflowId } from '../config';
import { AgentType, SessionInput } from '../types';
import { getGitInfo } from '../git-info';
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
      systemPrompt: z.string().optional()
        .describe('Path to a .md file to use as custom agent system prompt (--system-prompt)'),
    },
    async (args) => {
      const { workDir, name, initialMessage } = args as {
        workDir: string;
        name: string;
        conductor?: boolean;
        initialMessage?: string;
        agent?: AgentType;
        systemPrompt?: string;
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = (args as any).agent || ownAgentType;
      const systemPrompt = (args as any).systemPrompt as string | undefined;
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

        // Pre-create the Temporal workflow so the initial message is already loaded
        const workflowId = isConductor
          ? conductorWorkflowId(config.ensemble)
          : sessionWorkflowId(config.ensemble, name);

        const { gitRoot, gitBranch } = getGitInfo(workDir);

        const sessionInput: SessionInput = {
          metadata: {
            playerId: name,
            ensemble: config.ensemble,
            hostname: os.hostname(),
            workDir,
            gitRoot,
            gitBranch,
            isConductor,
            agentType: agent,
            status: 'pending',
          },
          autoSummary: `Session in ${require('path').basename(workDir)}`,
          disableStaleDetection: true,
          ...(initialMessage ? {
            messages: [{
              id: require('crypto').randomUUID(),
              from: getPlayerId(),
              text: initialMessage,
              timestamp: new Date().toISOString(),
              delivered: false,
            }],
          } : {}),
        };

        await client.workflow.start('claudeSessionWorkflow', {
          workflowId,
          taskQueue: config.taskQueue,
          args: [sessionInput],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          searchAttributes: {
            ...(gitRoot ? { ClaudeTempoGitRoot: [gitRoot] } : {}),
            ClaudeTempoHostname: [os.hostname()],
            ClaudeTempoEnsemble: [config.ensemble],
            ClaudeTempoPlayerId: [name],
          },
        });
        log(`Pre-created workflow ${workflowId} for recruit "${name}"`);

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
            ...(systemPrompt ? ['--system-prompt', systemPrompt] : []),
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

        // Brief poll (5s) to confirm the session connected, but don't fail if it hasn't
        const handle = client.workflow.getHandle(workflowId);
        let confirmed = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          await sleep(500);
          try {
            const desc = await handle.describe();
            if (desc.status.name === 'RUNNING') {
              confirmed = true;
              break;
            }
          } catch { /* not ready yet */ }
        }

        return {
          content: [{
            type: 'text' as const,
            text: confirmed
              ? `Recruited session **${name}** in ${workDir}. Workflow running.${initialMessage ? ' Initial task pre-loaded.' : ''}`
              : `Recruited session **${name}** in ${workDir}. Workflow pre-created, session still starting up.${initialMessage ? ' Initial task pre-loaded.' : ''}`,
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
