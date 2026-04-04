import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, conductorWorkflowId } from '../config';
import { AgentType } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool } from './helpers';

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
        systemPrompt?: string;
        host?: string;
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = (args as any).agent || ownAgentType;
      const systemPrompt = (args as any).systemPrompt as string | undefined;
      const host = (args as any).host as string | undefined;

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
          systemPrompt,
          targetHostname: host,
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
