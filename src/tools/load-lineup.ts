import { z } from 'zod';
import { Cron } from 'croner';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle, WorkflowIdConflictPolicy } from '@temporalio/client';
import { Config, schedulerWorkflowId } from '../config';
import { AgentType } from '../types';
import { loadAndResolveLineup, resolveAgentType } from '../ensemble/agent-types';
import { resolveLineupPath } from '../ensemble/loader';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { parseDuration } from '../utils/duration';
import { safeLineupPath } from '../utils/safe-path';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, PATH_MAX } from '../utils/validation';

const log = (...args: unknown[]) => console.error('[claude-tempo:load-lineup]', ...args);

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
      name: z.string().max(PLAYER_NAME_MAX).optional().describe('Name of a lineup — resolves saved lineups, then shipped examples (e.g. "tempo-dev-team")'),
      path: z.string().max(PATH_MAX).optional().describe('Explicit file path to a lineup YAML file'),
      hold: z.boolean().optional().describe('When true, create player workflows but do not spawn processes. Players stay in "held" status until explicitly released.'),
    },
    async (args) => {
      const lineupName = (args as any).name as string | undefined;
      const lineupPath = (args as any).path as string | undefined;
      const hold = (args as any).hold === true;

      if (!lineupName && !lineupPath) {
        return fail('Provide either `name` (saved lineup) or `path` (file path). Exactly one is required.');
      }
      if (lineupName && lineupPath) {
        return fail('Provide either `name` or `path`, not both.');
      }

      try {
        // Resolve the file path: saved → shipped examples → direct file path
        let filePath: string;
        if (lineupPath) {
          // User-provided path — validate against allowed roots
          filePath = safeLineupPath(lineupPath, process.cwd());
        } else {
          const resolution = resolveLineupPath(lineupName!);
          filePath = resolution.path;
          // Only validate user-facing paths (saved lineups, file paths).
          // Shipped examples are package-controlled and may live outside
          // allowed roots when globally installed.
          if (resolution.source !== 'shipped') {
            filePath = safeLineupPath(filePath, process.cwd());
          }
        }

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
                responseRequested: false,
              });
              conductorActions.push('instructions delivered');
              log('Conductor instructions delivered');
            } catch (err) {
              failed.push(`conductor instructions: ${err}`);
            }
          }
        }

        // When hold mode: tell conductor to wait for user direction.
        // This runs regardless of whether the lineup has a `conductor:` section —
        // what matters is that the caller IS the conductor and hold is active.
        if (hold && isConductor && handle) {
          try {
            await handle.signal('receiveMessage', {
              from: 'system',
              text: 'Ensemble is loading in hold mode — players are connecting but on standby. Wait for instructions from the user or maestro before directing the ensemble. When ready, use the `release` tool to deliver task assignments to all held players.',
              responseRequested: false,
            });
            conductorActions.push('hold mode standby');
          } catch (err) {
            failed.push(`conductor hold message: ${err}`);
          }
        }

        // Recruit players via outbox — no polling needed
        for (const player of lineup.players) {
          const playerName = player.name;
          const workDir = player.workDir || process.cwd();
          const agentType: AgentType = player.agent === 'copilot' ? 'copilot' : 'claude';
          const isCustomAgent = player.agent && player.agent !== 'default' && player.agent !== 'copilot';
          const systemPrompt = player._agentDefinition ? undefined : (isCustomAgent ? player.agent : undefined);
          const agentDefinition = player._agentDefinition;
          const agentDefinitionPath = player._agentDefinitionPath;

          // Skip if already active — send instructions via cue instead
          const existing = await resolveSession(client, config.ensemble, playerName);
          if (existing) {
            log(`Player "${playerName}" already active — skipping recruit`);
            recruited.push(`${playerName} (already active)`);
            if (player.instructions && handle) {
              try {
                const cueEntry = {
                  type: 'cue',
                  targetPlayerId: playerName,
                  message: player.instructions,
                } as OutboxEntryInput;
                await handle.executeUpdate(submitOutboxUpdate, { args: [cueEntry] });
              } catch (err) {
                log(`Failed to send instructions to already-active player "${playerName}":`, err);
              }
            }
            continue;
          }

          // Submit recruit via outbox — pre-creates workflow with pending status
          if (!handle) {
            failed.push(`${playerName}: load_lineup requires a workflow handle to recruit`);
            continue;
          }
          try {
            // Resolve full agent type info (description, nativeResolvable) if available
            const resolvedType = agentDefinition ? resolveAgentType(agentDefinition) : null;
            const entry = {
              type: 'recruit',
              targetName: playerName,
              workDir,
              isConductor: false,
              initialMessage: player.instructions,
              agent: agentType,
              systemPrompt: agentDefinition ? undefined : systemPrompt,
              agentDefinition: resolvedType?.name || agentDefinition,
              agentDefinitionPath: resolvedType?.path || agentDefinitionPath,
              agentDefinitionDescription: resolvedType?.description,
              nativeResolvable: resolvedType?.nativeResolvable,
              allowedTools: player.allowedTools,
              claudeBin: config.claudeBin,
              ...(hold ? { held: true } : {}),
            } as OutboxEntryInput;
            await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
            recruited.push(playerName);
            log(`Recruit request submitted for "${playerName}" in ${workDir}`);
          } catch (err) {
            failed.push(`${playerName}: recruit failed — ${err}`);
          }
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
          if (hold) {
            lines.push(`Held: ${recruited.join(', ')} — ${recruited.length} player(s) held. Use \`release\` to start them.`);
          } else {
            lines.push(`Recruited: ${recruited.join(', ')}`);
          }
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
