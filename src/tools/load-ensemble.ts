import { z } from 'zod';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, CLAUDE_TEMPO_HOME, schedulerWorkflowId, ENV } from '../config';
import { AgentType } from '../types';
import { loadBlueprint } from '../ensemble/loader';
import { readSavedBlueprint } from '../ensemble/saver';
import { resolveSession } from './resolve';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { defineTool } from './helpers';

const log = (...args: unknown[]) => console.error('[claude-tempo:load-ensemble]', ...args);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a duration string like "30s", "10m", "2h", "1d" into milliseconds. */
function parseDuration(dur: string): number | null {
  const match = dur.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

export function registerLoadEnsembleTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  ownAgentType: AgentType = 'claude',
) {
  defineTool(
    server,
    'load_ensemble',
    'Load an ensemble blueprint — recruits players and creates schedules.',
    {
      name: z.string().optional().describe('Name of a saved blueprint (from ~/.claude-tempo/ensembles/)'),
      path: z.string().optional().describe('Explicit file path to a blueprint YAML file'),
    },
    async (args) => {
      const blueprintName = (args as any).name as string | undefined;
      const blueprintPath = (args as any).path as string | undefined;

      if (!blueprintName && !blueprintPath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Provide either `name` (saved blueprint) or `path` (file path). Exactly one is required.',
          }],
          isError: true,
        };
      }
      if (blueprintName && blueprintPath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Provide either `name` or `path`, not both.',
          }],
          isError: true,
        };
      }

      try {
        // Resolve the file path
        let filePath: string;
        if (blueprintPath) {
          filePath = blueprintPath;
        } else {
          // Try to find saved blueprint by name
          const savedContent = readSavedBlueprint(blueprintName!);
          if (!savedContent) {
            return {
              content: [{
                type: 'text' as const,
                text: `No saved blueprint found with name "${blueprintName}". Check ~/.claude-tempo/ensembles/.`,
              }],
              isError: true,
            };
          }
          // readSavedBlueprint returns content, but loadBlueprint wants a path.
          // Construct the path directly.
          const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
          // Try both extensions
          const { existsSync } = require('fs');
          filePath = join(ensemblesDir, `${blueprintName}.yaml`);
          if (!existsSync(filePath)) {
            filePath = join(ensemblesDir, `${blueprintName}.yml`);
          }
        }

        const blueprint = loadBlueprint(filePath);
        const recruited: string[] = [];
        const failed: string[] = [];

        // Recruit players sequentially
        for (const player of blueprint.players) {
          const playerName = player.name;
          const workDir = player.workDir || process.cwd();
          const agentType: AgentType = player.agent === 'copilot' ? 'copilot' : 'claude';
          const isCustomAgent = player.agent && player.agent !== 'default' && player.agent !== 'copilot';
          const systemPrompt = isCustomAgent ? player.agent : undefined;

          // Skip if already active
          const existing = await resolveSession(client, config.ensemble, playerName);
          if (existing) {
            log(`Player "${playerName}" already active — skipping recruit`);
            recruited.push(`${playerName} (already active)`);
            // Still send instructions if provided
            if (player.instructions) {
              try {
                await existing.signal('receiveMessage', {
                  from: getPlayerId(),
                  text: player.instructions,
                });
              } catch {
                // best effort
              }
            }
            continue;
          }

          // Record existing workflows to detect the new one
          const existingIds = new Set<string>();
          const listQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
          for await (const wf of client.workflow.list({ query: listQuery })) {
            existingIds.add(wf.workflowId);
          }

          // Spawn
          try {
            if (agentType === 'copilot') {
              spawnCopilotBridge({
                name: playerName,
                ensemble: config.ensemble,
                temporalAddress: config.temporalAddress,
                temporalNamespace: config.temporalNamespace,
                temporalApiKey: config.temporalApiKey,
                temporalTlsCertPath: config.temporalTlsCertPath,
                temporalTlsKeyPath: config.temporalTlsKeyPath,
                isConductor: false,
                workDir,
              });
            } else {
              const spawnArgs = [
                '--dangerously-skip-permissions',
                '--dangerously-load-development-channels', 'server:claude-tempo',
                '-n', playerName,
                ...(systemPrompt ? ['--system-prompt', systemPrompt] : []),
              ];
              const envVars: Record<string, string> = {
                [ENV.ENSEMBLE]: config.ensemble,
                [ENV.CONDUCTOR]: '',
                [ENV.PLAYER_NAME]: playerName,
                [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
                [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
              };
              if (config.temporalApiKey) envVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
              if (config.temporalTlsCertPath) envVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
              if (config.temporalTlsKeyPath) envVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;
              spawnInTerminal(spawnArgs, workDir, envVars);
            }
          } catch (err) {
            failed.push(`${playerName}: spawn failed — ${err}`);
            continue;
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
            failed.push(`${playerName}: spawned but did not register within 15s`);
            continue;
          }

          // Send initial instructions if provided
          if (player.instructions) {
            try {
              const newHandle = client.workflow.getHandle(newWorkflowId);
              await newHandle.signal('receiveMessage', {
                from: getPlayerId(),
                text: player.instructions,
              });
            } catch {
              // best effort
            }
          }

          recruited.push(playerName);
          log(`Recruited "${playerName}" in ${workDir}`);
        }

        // Create schedules
        const schedulesCreated: string[] = [];
        if (blueprint.schedules && blueprint.schedules.length > 0) {
          for (const sched of blueprint.schedules) {
            try {
              const now = Date.now();
              let nextFireAt: number;
              let interval: number | undefined;

              if (sched.at) {
                nextFireAt = Date.parse(sched.at);
              } else if (sched.delay) {
                const ms = parseDuration(sched.delay);
                if (!ms) throw new Error(`Invalid delay: ${sched.delay}`);
                nextFireAt = now + ms;
              } else if (sched.every) {
                const ms = parseDuration(sched.every);
                if (!ms) throw new Error(`Invalid interval: ${sched.every}`);
                nextFireAt = now + ms;
                interval = ms;
              } else {
                throw new Error('No timing specified');
              }

              const scheduleEntry = {
                name: sched.name,
                message: sched.message,
                target: sched.target,
                type: sched.every ? 'interval' : 'once',
                nextFireAt: new Date(nextFireAt).toISOString(),
                interval,
                until: sched.until,
                remainingCount: sched.count,
                firedCount: 0,
                createdBy: getPlayerId(),
              };

              const wfId = schedulerWorkflowId(config.ensemble);
              try {
                const handle = client.workflow.getHandle(wfId);
                await handle.describe();
                await handle.signal('addSchedule', scheduleEntry);
              } catch {
                await client.workflow.start('claudeSchedulerWorkflow', {
                  workflowId: wfId,
                  taskQueue: config.taskQueue,
                  args: [{ ensemble: config.ensemble, entries: [scheduleEntry] }],
                  workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
                  searchAttributes: {
                    ClaudeTempoEnsemble: [config.ensemble],
                  },
                });
              }

              schedulesCreated.push(sched.name);
            } catch (err) {
              failed.push(`schedule "${sched.name}": ${err}`);
            }
          }
        }

        // Build summary
        const lines: string[] = [`Loaded blueprint **${blueprint.name}**.`];
        if (recruited.length > 0) {
          lines.push(`Recruited: ${recruited.join(', ')}`);
        }
        if (schedulesCreated.length > 0) {
          lines.push(`Schedules created: ${schedulesCreated.join(', ')}`);
        }
        if (failed.length > 0) {
          lines.push(`Failures:\n${failed.map(f => `  - ${f}`).join('\n')}`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to load blueprint: ${err}` }],
          isError: true,
        };
      }
    },
  );
}
