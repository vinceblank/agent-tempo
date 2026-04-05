import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, conductorWorkflowId } from '../config';
import { AgentType } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool } from './helpers';
import { resolveAgentType, listAgentTypes } from '../ensemble/agent-types';
import { PLAYER_NAME_MAX, MESSAGE_MAX, PATH_MAX, validatePlayerName } from '../utils/validation';

export function registerRecruitTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
  ownAgentType: AgentType = 'claude',
) {
  defineTool(
    server,
    'recruit',
    `Start a new named session in a directory. Rejects if the name is already active. Supports Claude Code or Copilot CLI agents. Defaults to "${ownAgentType}" (same as this session).`,
    {
      workDir: z.string().max(PATH_MAX).describe('The working directory for the new session'),
      name: z.string().max(PLAYER_NAME_MAX).describe('Name for the new session'),
      conductor: z.boolean().optional()
        .describe('Whether this session is a conductor (default: false)'),
      initialMessage: z.string().max(MESSAGE_MAX).optional()
        .describe('Optional task or message for the new session (sent after it sets its name)'),
      agent: z.enum(['claude', 'copilot']).optional()
        .describe(`Which agent to use (default: "${ownAgentType}", same as this session)`),
      type: z.string().optional()
        .describe('Agent type name — references a Claude Code agent definition (e.g., "tempo-soloist")'),
      systemPrompt: z.string().optional()
        .describe('Path to a .md file to use as custom agent system prompt (--system-prompt)'),
      host: z.string().optional()
        .describe('Target hostname for cross-machine recruiting. Omit for local spawn.'),
    },
    async (args) => {
      const { workDir, name, initialMessage } = args as {
        workDir: string;
        name: string;
        conductor?: boolean;
        initialMessage?: string;
        agent?: AgentType;
        type?: string;
        systemPrompt?: string;
        host?: string;
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = (args as any).agent || ownAgentType;
      const agentTypeName = (args as any).type as string | undefined;
      const systemPrompt = (args as any).systemPrompt as string | undefined;
      const host = (args as any).host as string | undefined;

      // Resolve agent type if provided
      let agentDefinition: string | undefined;
      let agentDefinitionPath: string | undefined;
      let agentDefinitionDescription: string | undefined;
      let nativeResolvable: boolean | undefined;
      if (agentTypeName) {
        const info = resolveAgentType(agentTypeName);
        if (!info) {
          const available = listAgentTypes().map(t => t.name);
          return {
            content: [{
              type: 'text' as const,
              text: `Unknown agent type "${agentTypeName}". Available types: ${available.length ? available.join(', ') : '(none)'}`,
            }],
            isError: true,
          };
        }
        agentDefinition = info.name;
        agentDefinitionPath = info.path;
        agentDefinitionDescription = info.description;
        nativeResolvable = info.nativeResolvable;
      }

      // Validate name
      const nameError = validatePlayerName(name);
      if (nameError) {
        return {
          content: [{
            type: 'text' as const,
            text: nameError,
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
                  text: `A conductor is already running in ensemble "${config.ensemble}". Use \`claude-tempo conduct --replace\` from the CLI to replace it, or \`stop\` it first.`,
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
              text: `Session **${name}** is already active. Use \`cue\` to send it a message, or \`stop\` it first.`,
            }],
            isError: true,
          };
        }

        const entry = {
          type: 'recruit',
          targetName: name,
          workDir,
          isConductor,
          initialMessage,
          agent,
          systemPrompt: agentDefinition ? undefined : systemPrompt,
          targetHostname: host,
          agentDefinition,
          agentDefinitionPath,
          agentDefinitionDescription,
          nativeResolvable,
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return {
          content: [{
            type: 'text' as const,
            text: `Recruit request submitted for **${name}** in ${workDir}. The session will be spawned shortly. (outbox: ${entryId})`,
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
