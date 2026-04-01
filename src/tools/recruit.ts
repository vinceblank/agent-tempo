import * as path from 'path';

import { spawn } from 'child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { spawnInTerminal } from '../spawn';
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
) {
  defineTool(
    server,
    'recruit',
    'Start a new named session in a directory. Rejects if the name is already active. Supports Claude Code or Copilot CLI agents.',
    {
      workDir: z.string().describe('The working directory for the new session'),
      name: z.string().describe('Name for the new session'),
      initialMessage: z.string().optional()
        .describe('Optional task or message for the new session (sent after it sets its name)'),
      agent: z.enum(['claude', 'copilot']).default('claude')
        .describe('Which agent to use: "claude" (default) or "copilot" (GitHub Copilot CLI via SDK)'),
    },
    async (args) => {
      const { workDir, name, initialMessage, agent } = args as {
        workDir: string;
        name: string;
        initialMessage?: string;
        agent: 'claude' | 'copilot';
      };
      // Validate name to prevent search attribute query injection
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid name "${name}". Names must contain only letters, numbers, hyphens, and underscores.`,
          }],
          isError: true,
        };
      }

      try {
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
        const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${config.ensemble}"`;
        for await (const wf of client.workflow.list({ query: listQuery })) {
          existingIds.add(wf.workflowId);
        }

        // Spawn the session using the selected backend
        if (agent === 'copilot') {
          // Use ts-node in dev, compiled JS in production
          const isDev = __filename.endsWith('.ts');
          const cmd = isDev ? 'npx' : 'node';
          const cmdArgs = isDev
            ? ['ts-node', path.resolve(__dirname, '..', 'src', 'copilot-bridge.ts')]
            : [path.resolve(__dirname, '..', 'copilot-bridge.js')];
          const child = spawn(cmd, cmdArgs, {
            cwd: workDir,
            detached: true,
            stdio: 'ignore',
            env: {
              ...process.env,
              CLAUDE_TEMPO_ENSEMBLE: config.ensemble,
              COPILOT_BRIDGE_NAME: name,
              TEMPORAL_ADDRESS: config.temporalAddress,
            },
          });
          child.unref();
          log(`Spawned copilot-bridge (pid ${child.pid}) in ${workDir} as "${name}"`);
        } else {
          const spawnArgs = [
            '--dangerously-skip-permissions',
            '--dangerously-load-development-channels', 'server:claude-tempo',
            '-n', name,
          ];
          const { pid } = spawnInTerminal(spawnArgs, workDir, {
            CLAUDE_TEMPO_ENSEMBLE: config.ensemble,
            CLAUDE_TEMPO_CONDUCTOR: '',
          });
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

        // For copilot agent, the bridge handles set_name automatically.
        // For claude agent, send a message instructing it to set its name.
        if (agent === 'claude') {
          const nameInstruction = `You have been recruited as "${name}". Call set_name("${name}") immediately.`;
          const fullMessage = initialMessage
            ? `${nameInstruction}\n\nThen: ${initialMessage}`
            : nameInstruction;

          await newHandle.signal('receiveMessage', {
            from: getPlayerId(),
            text: fullMessage,
          });
        } else if (initialMessage) {
          // For copilot, just send the initial task (name is set by the bridge)
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
