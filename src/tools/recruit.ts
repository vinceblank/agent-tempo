import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, conductorWorkflowId, isDevMode } from '../config';
import { AgentType } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput, HostInfo } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { resolveAgentType, listAgentTypes } from '../ensemble/agent-types';
import { PLAYER_NAME_MAX, MESSAGE_MAX, PATH_MAX, validatePlayerName } from '../utils/validation';

const toolLog = (...args: unknown[]) => console.error('[claude-tempo:recruit]', ...args);

/**
 * #274 M15 — dep-injection surface on the recruit tool registrar.
 *
 * `listHostsFn` lets tests stub host discovery without touching
 * `TestWorkflowEnvironment` internals. Production callers (`src/server.ts`)
 * omit this; the default pulls in `src/utils/hosts.ts` lazily.
 */
export interface RegisterRecruitToolDeps {
  listHostsFn?: (client: Client) => Promise<HostInfo[]>;
}

export function registerRecruitTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
  ownAgentType: AgentType = 'claude',
  deps: RegisterRecruitToolDeps = {},
) {
  // Lazy default — only imports utils/hosts when actually called, so the
  // MCP server's module load graph doesn't drag the whole join layer
  // into every consumer at import time.
  const listHostsFn: NonNullable<RegisterRecruitToolDeps['listHostsFn']> =
    deps.listHostsFn ?? (async (c) => {
      const { listHosts } = await import('../utils/hosts');
      return listHosts(c, {
        force: true, // pre-flight wants "right now" — no cached snapshot
        namespace: config.temporalNamespace,
        taskQueue: config.taskQueue,
      });
    });
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
      agent: z.enum(['claude', 'copilot', 'mock']).optional()
        .describe(`Which agent to use (default: "${ownAgentType}", same as this session). "mock" requires dev mode (--dev).`),
      type: z.string().optional()
        .describe('Agent type name — references a Claude Code agent definition (e.g., "tempo-soloist")'),
      systemPrompt: z.string().optional()
        .describe('Path to a .md file to use as custom agent system prompt (--system-prompt)'),
      host: z.string().optional()
        .describe('Target hostname for cross-machine recruiting. Omit for local spawn.'),
      force: z.boolean().optional()
        .describe('Force-terminate any existing session with this name before recruiting. Use when a previous session is orphaned or stuck.'),
      mockMode: z.enum(['echo', 'scripted']).optional()
        .describe('Dev-mode only (agent: "mock"). Mock adapter mode. Default: "echo".'),
      mockScenario: z.string().optional()
        .describe('Dev-mode only (agent: "mock", mockMode: "scripted"). Bare scenario name (resolved against shipped scenarios/) or absolute path to a scenario YAML.'),
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
        force?: boolean;
        mockMode?: 'echo' | 'scripted';
        mockScenario?: string;
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = (args as any).agent || ownAgentType;
      const agentTypeName = (args as any).type as string | undefined;
      const systemPrompt = (args as any).systemPrompt as string | undefined;
      const host = (args as any).host as string | undefined;
      const force = (args as any).force === true;
      const mockMode = (args as any).mockMode as 'echo' | 'scripted' | undefined;
      const mockScenario = (args as any).mockScenario as string | undefined;

      // ADR 0014 §7 gate 3 — recruit-time rejection of `agent: 'mock'`
      // outside dev mode. Defense-in-depth: even if a hand-edited install
      // had `dist/adapters/mock/` present (gate 1 bypassed) AND somehow
      // got the registry to register the descriptor (gate 2 bypassed),
      // this rejects the request with a clear, actionable error.
      if (agent === 'mock' && !isDevMode()) {
        return fail(
          `agent: "mock" is only available in dev mode. Restart claude-tempo with --dev (or set CLAUDE_TEMPO_DEV_MODE=1) to enable.`,
        );
      }
      // mockMode / mockScenario are only meaningful with the mock adapter —
      // reject silently-ignored params so users learn the right flag shape.
      if (mockMode != null && agent !== 'mock') {
        return fail(`mockMode is only valid when agent: "mock" (got agent: "${agent}").`);
      }
      if (mockScenario != null && agent !== 'mock') {
        return fail(`mockScenario is only valid when agent: "mock" (got agent: "${agent}").`);
      }
      if (agent === 'mock' && mockMode === 'scripted' && !mockScenario) {
        return fail(`mockMode: "scripted" requires mockScenario (a bare scenario name or path to a YAML file).`);
      }

      // Resolve agent type if provided
      let agentDefinition: string | undefined;
      let agentDefinitionPath: string | undefined;
      let agentDefinitionDescription: string | undefined;
      let nativeResolvable: boolean | undefined;
      let allowedTools: string[] | undefined;
      if (agentTypeName) {
        const info = resolveAgentType(agentTypeName);
        if (!info) {
          const available = listAgentTypes().map(t => t.name);
          return fail(`Unknown agent type "${agentTypeName}". Available types: ${available.length ? available.join(', ') : '(none)'}`);
        }
        agentDefinition = info.name;
        agentDefinitionPath = info.path;
        agentDefinitionDescription = info.description;
        nativeResolvable = info.nativeResolvable;
        allowedTools = info.allowedTools;
      }

      // Validate name
      const nameError = validatePlayerName(name);
      if (nameError) {
        return fail(nameError);
      }
      if (name === 'conductor' && !isConductor) {
        return fail(`The name "conductor" is reserved for conductor sessions. Use a different name, or set conductor: true.`);
      }

      // ── #274 AC12 — cross-host recruit pre-flight ──
      //
      // When `host` is specified, verify that the target is live + has
      // the requested agent runtime available BEFORE submitting to the
      // outbox. Otherwise `recruit --host foo` could queue forever on a
      // per-host task queue nobody's listening on (the exact failure
      // mode #274 set out to close).
      //
      // `force: true` bypasses pre-flight entirely (AC12d) — covers the
      // scripted-recruit-on-about-to-boot-daemon case plus any other
      // "I know what I'm doing" override. RPC failure during pre-flight
      // falls through with a warning (AC12e) so today's recruit
      // availability characteristics are preserved.
      if (host && !force) {
        try {
          const hosts = await listHostsFn(client);
          const preflightError = checkHostPreflight(hosts, host, agent);
          if (preflightError) return fail(preflightError);
        } catch (err) {
          toolLog(
            `Host pre-flight RPC failed for "${host}"; proceeding without validation (use --force to silence this warning): ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      try {
        // Check if a conductor already exists when recruiting a conductor
        if (isConductor) {
          try {
            const conductorWfId = conductorWorkflowId(config.ensemble);
            const conductorHandle = client.workflow.getHandle(conductorWfId);
            const desc = await conductorHandle.describe();
            if (desc.status.name === 'RUNNING') {
              if (force) {
                await conductorHandle.terminate(`Force-terminated for re-recruit by ${getPlayerId()}`);
              } else {
                return fail(`A conductor is already running in ensemble "${config.ensemble}". Use \`claude-tempo conduct --replace\` from the CLI to replace it, \`stop\` it first, or use \`force: true\` to replace it.`);
              }
            }
          } catch {
            // No existing conductor — proceed
          }
        }

        // Check if a session with this name is already active
        const existing = await resolveSession(client, config.ensemble, name);
        if (existing) {
          if (force) {
            // Force-terminate the existing session before recruiting
            await existing.terminate(`Force-terminated for re-recruit by ${getPlayerId()}`);
            // Best-effort notify conductor
            try {
              const condId = conductorWorkflowId(config.ensemble);
              const condHandle = client.workflow.getHandle(condId);
              await condHandle.signal('receiveMessage', {
                from: 'system',
                text: `Session "${name}" was force-terminated for re-recruit by ${getPlayerId()}.`,
                responseRequested: false,
              });
            } catch {
              // Conductor may not exist — that's fine
            }
          } else {
            return fail(`Session **${name}** is already active. Use \`cue\` to send it a message, \`stop\` it first, or use \`force: true\` to replace it.`);
          }
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
          allowedTools,
          claudeBin: config.claudeBin,
          ...(agent === 'mock' ? { mockMode: mockMode ?? 'echo' } : {}),
          ...(agent === 'mock' && mockScenario ? { mockScenario } : {}),
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Recruit request submitted for **${name}** in ${workDir}. The session will be spawned shortly. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to recruit: ${formatError(err)}`);
      }
    },
  );
}

// ────────────────────────────────────────────────────────────────────────
// #274 AC12 — host pre-flight validation (exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

/**
 * Given a host liveness+profile snapshot, validate that `targetHost` is
 * (a) known, (b) recruit-ready, and (c) advertises support for
 * `requestedAgent`. Returns a user-facing error string when validation
 * fails, or `null` when all checks pass.
 *
 * Profile-missing is treated as a soft pass (the daemon is alive but
 * didn't signal a profile, e.g. rolling-upgrade scenario or global
 * maestro was unreachable at its boot). We fall through rather than
 * fail — M10 / AC11c says operational UX beats strict enforcement when
 * information is genuinely absent.
 *
 * Exported for unit testing per the M15 dep-injection pattern.
 */
export function checkHostPreflight(
  hosts: HostInfo[],
  targetHost: string,
  requestedAgent: AgentType,
): string | null {
  const match = hosts.find((h) => h.hostname === targetHost);
  if (!match) {
    const knownNames = hosts.map((h) => h.hostname);
    const suggestion = nearestHostname(targetHost, knownNames);
    const available = knownNames.length > 0 ? knownNames.join(', ') : '(none — no daemons currently polling)';
    const hint = suggestion && suggestion !== targetHost ? ` Did you mean "${suggestion}"?` : '';
    return `Unknown host "${targetHost}".${hint} Available: ${available}. Use \`force: true\` to bypass this check.`;
  }
  if (match.freshness !== 'live' || !match.recruitReady) {
    return `Host "${targetHost}" is not recruit-ready right now (freshness=${match.freshness}, recruitReady=${match.recruitReady}). Wait for the daemon to signal again, or use \`force: true\` to bypass.`;
  }
  // Profile-missing → soft pass. Daemon is alive + recruit-ready; we
  // just don't have capability info. Log-level guidance could be added
  // later; for now we accept to avoid false-negative rejection.
  if (match.profile && match.profile.availableAgentTypes) {
    if (!match.profile.availableAgentTypes.includes(requestedAgent)) {
      const supports = match.profile.availableAgentTypes.length > 0
        ? match.profile.availableAgentTypes.join(', ')
        : '(none advertised)';
      return `Host "${targetHost}" cannot run \`${requestedAgent}\` (supports: ${supports}). Use \`force: true\` to bypass this check.`;
    }
  }
  return null;
}

/**
 * Pick the closest hostname to `target` by Levenshtein distance. Returns
 * `null` when `candidates` is empty OR the nearest match is so distant
 * (edit distance ≥ half the longer string's length) that suggesting it
 * would be misleading. Exported for tests.
 */
export function nearestHostname(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  let best: { name: string; dist: number } | null = null;
  for (const cand of candidates) {
    const dist = levenshtein(target, cand);
    if (best === null || dist < best.dist) best = { name: cand, dist };
  }
  if (!best) return null;
  const ratioThreshold = Math.max(target.length, best.name.length) / 2;
  return best.dist < ratioThreshold ? best.name : null;
}

/** Iterative O(n·m) Levenshtein distance. 15 lines, no dep. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // previous row of distances
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}
