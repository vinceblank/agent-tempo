import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import { Cron } from 'croner';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, CLAUDE_TEMPO_HOME, schedulerWorkflowId, ENV } from '../config';
import { AgentType } from '../types';
import { loadLineup } from '../ensemble/loader';
import { loadAndResolveLineup, resolveAgentType } from '../ensemble/agent-types';
import { readSavedLineup } from '../ensemble/saver';
import { resolveSession } from './resolve';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { parseDuration } from '../utils/duration';
import { safeLineupPath } from '../utils/safe-path';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, PATH_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[claude-tempo:load-lineup]', ...args);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerLoadLineupTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  ownAgentType: AgentType = 'claude',
  handle?: WorkflowHandle,
  setPlayerId?: (id: string) => void,
  isConductor?: boolean,
) {
  defineTool(
    server,
    'load_lineup',
    'Load an ensemble lineup — recruits players and creates schedules.',
    {
      name: z.string().max(PLAYER_NAME_MAX).optional().describe('Name of a saved lineup (from ~/.claude-tempo/ensembles/)'),
      path: z.string().max(PATH_MAX).optional().describe('Explicit file path to a lineup YAML file'),
    },
    async (args) => {
      const lineupName = (args as any).name as string | undefined;
      const lineupPath = (args as any).path as string | undefined;

      if (!lineupName && !lineupPath) {
        return fail('Provide either `name` (saved lineup) or `path` (file path). Exactly one is required.');
      }
      if (lineupName && lineupPath) {
        return fail('Provide either `name` or `path`, not both.');
      }

      try {
        // Resolve the file path
        let filePath: string;
        if (lineupPath) {
          filePath = lineupPath;
        } else {
          // Try to find saved lineup by name
          const savedContent = readSavedLineup(lineupName!);
          if (!savedContent) {
            return fail(`No saved lineup found with name "${lineupName}". Check ~/.claude-tempo/ensembles/.`);
          }
          // readSavedLineup returns content, but loadLineup wants a path.
          // Construct the path directly.
          const ensemblesDir = join(CLAUDE_TEMPO_HOME, 'ensembles');
          // Try both extensions
          filePath = join(ensemblesDir, `${lineupName}.yaml`);
          if (!existsSync(filePath)) {
            filePath = join(ensemblesDir, `${lineupName}.yml`);
          }
        }

        // Validate the resolved path is within allowed roots
        filePath = safeLineupPath(filePath, process.cwd());

        const lineup = loadAndResolveLineup(filePath);
        const recruited: string[] = [];
        const failed: string[] = [];
        const conductorActions: string[] = [];

        // Apply conductor section if present and this session is the conductor
        if (lineup.conductor && isConductor && handle) {
          // Apply conductor name
          if (lineup.conductor.name && lineup.conductor.name !== getPlayerId()) {
            try {
              // Check if the name is already taken
              const existing = await resolveSession(client, config.ensemble, lineup.conductor.name);
              if (existing && existing.workflowId !== handle.workflowId) {
                failed.push(`conductor name "${lineup.conductor.name}": already taken by another session`);
              } else {
                await handle.signal('setName', lineup.conductor.name);
                if (setPlayerId) setPlayerId(lineup.conductor.name);
                conductorActions.push(`name → ${lineup.conductor.name}`);
                log(`Conductor name set to "${lineup.conductor.name}"`);
              }
            } catch (err) {
              failed.push(`conductor name: ${err}`);
            }
          }

          // Apply conductor type (update metadata)
          if (lineup.conductor.type) {
            try {
              const typeInfo = resolveAgentType(lineup.conductor.type);
              if (typeInfo) {
                await handle.signal('updateMetadata', {
                  playerType: typeInfo.name,
                  playerTypeDescription: typeInfo.description || '',
                });
                conductorActions.push(`type → ${typeInfo.name}`);
                log(`Conductor type set to "${typeInfo.name}"`);
              } else {
                failed.push(`conductor type "${lineup.conductor.type}": agent type not found`);
              }
            } catch (err) {
              failed.push(`conductor type: ${err}`);
            }
          }

          // Send conductor instructions
          if (lineup.conductor.instructions) {
            try {
              await handle.signal('receiveMessage', {
                from: 'lineup',
                text: lineup.conductor.instructions,
              });
              conductorActions.push('instructions delivered');
              log('Conductor instructions delivered');
            } catch (err) {
              failed.push(`conductor instructions: ${err}`);
            }
          }
        }

        // Recruit players sequentially
        for (const player of lineup.players) {
          const playerName = player.name;
          const workDir = player.workDir || process.cwd();
          const agentType: AgentType = player.agent === 'copilot' ? 'copilot' : 'claude';
          const isCustomAgent = player.agent && player.agent !== 'default' && player.agent !== 'copilot';
          const systemPrompt = player._agentDefinition ? undefined : (isCustomAgent ? player.agent : undefined);
          const agentDefinition = player._agentDefinition;
          const agentDefinitionPath = player._agentDefinitionPath;

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
              } catch (err) {
                log(`Failed to send instructions to already-active player "${playerName}":`, err);
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
                // Secrets read from config (env/file), not workflow state
                temporalApiKey: config.temporalApiKey,
                temporalTlsCertPath: config.temporalTlsCertPath,
                temporalTlsKeyPath: config.temporalTlsKeyPath,
                isConductor: false,
                workDir,
              });
            } else {
              // Determine agent flags: --agent for natively resolvable types, --system-prompt for shipped/custom
              let agentFlags: string[] = [];
              if (agentDefinition) {
                const typeInfo = resolveAgentType(agentDefinition);
                if (!typeInfo) {
                  log(`Warning: agent type "${agentDefinition}" not found at spawn time — spawning without type`);
                }
                if (typeInfo?.nativeResolvable) {
                  agentFlags = ['--agent', agentDefinition];
                } else if (agentDefinitionPath) {
                  agentFlags = ['--system-prompt', agentDefinitionPath];
                }
              } else if (systemPrompt) {
                agentFlags = ['--system-prompt', systemPrompt];
              }

              // Build --allowedTools flag from agent definition or lineup
              const allowedToolsFlags = player.allowedTools && player.allowedTools.length > 0
                ? ['--allowedTools', ...player.allowedTools]
                : [];

              const spawnArgs = [
                '--dangerously-skip-permissions',
                '--dangerously-load-development-channels', 'server:claude-tempo',
                '-n', playerName,
                ...agentFlags,
                ...allowedToolsFlags,
              ];
              const envVars: Record<string, string> = {
                [ENV.ENSEMBLE]: config.ensemble,
                [ENV.CONDUCTOR]: '',
                [ENV.PLAYER_NAME]: playerName,
                [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
                [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
              };
              if (agentDefinition) envVars[ENV.PLAYER_TYPE] = agentDefinition;
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
            } catch (err) {
              log(`Failed to send instructions to newly recruited player "${playerName}":`, err);
            }
          }

          recruited.push(playerName);
          log(`Recruited "${playerName}" in ${workDir}`);
        }

        // Create schedules
        const schedulesCreated: string[] = [];
        const scheduleWarnings: string[] = [];
        if (lineup.schedules && lineup.schedules.length > 0) {
          // Build valid target set from lineup player names + special values
          const validTargets = new Set<string>(lineup.players.map((p) => p.name));
          validTargets.add('conductor');
          validTargets.add('all');

          for (const sched of lineup.schedules) {
            try {
              // Validate schedule target against known player names
              if (!validTargets.has(sched.target)) {
                scheduleWarnings.push(
                  `schedule "${sched.name}": target "${sched.target}" does not match any player in this lineup (known: ${[...validTargets].join(', ')})`
                );
              }

              const now = Date.now();
              let nextFireAt: number;
              let interval: number | undefined;
              let cronExpression: string | undefined;
              let timezone: string | undefined;

              if (sched.at) {
                nextFireAt = Date.parse(sched.at);
                // Support at + every: use `at` as the initial fire time, `every` as the interval
                if (sched.every) {
                  const ms = parseDuration(sched.every);
                  if (!ms) throw new Error(`Invalid interval: ${sched.every}`);
                  interval = ms;
                }
              } else if (sched.delay) {
                const ms = parseDuration(sched.delay);
                if (!ms) throw new Error(`Invalid delay: ${sched.delay}`);
                nextFireAt = now + ms;
              } else if (sched.every) {
                const ms = parseDuration(sched.every);
                if (!ms) throw new Error(`Invalid interval: ${sched.every}`);
                nextFireAt = now + ms;
                interval = ms;
              } else if (sched.cron) {
                cronExpression = sched.cron;
                timezone = sched.timezone || 'UTC';
                const job = new Cron(cronExpression, { timezone });
                const next = job.nextRun();
                if (!next) throw new Error(`Cron expression "${sched.cron}" has no upcoming fire time`);
                nextFireAt = next.getTime();
              } else {
                throw new Error('No timing specified');
              }

              const type = sched.cron ? 'cron' as const : (sched.every || interval) ? 'interval' as const : 'once' as const;
              const scheduleEntry = {
                name: sched.name,
                message: sched.message,
                target: sched.target,
                type,
                nextFireAt: new Date(nextFireAt).toISOString(),
                interval,
                cronExpression,
                timezone,
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
        const lines: string[] = [`Loaded lineup **${lineup.name}**.`];
        if (conductorActions.length > 0) {
          lines.push(`Conductor: ${conductorActions.join(', ')}`);
        }
        if (recruited.length > 0) {
          lines.push(`Recruited: ${recruited.join(', ')}`);
        }
        if (schedulesCreated.length > 0) {
          lines.push(`Schedules created: ${schedulesCreated.join(', ')}`);
        }
        if (scheduleWarnings.length > 0) {
          lines.push(`⚠ Schedule target warnings:\n${scheduleWarnings.map(w => `  - ${w}`).join('\n')}`);
        }
        if (failed.length > 0) {
          lines.push(`Failures:\n${failed.map(f => `  - ${f}`).join('\n')}`);
        }

        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to load lineup: ${formatError(err)}`);
      }
    },
  );
}
