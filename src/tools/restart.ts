/**
 * `restart` — reap the current attachment, claim a fresh one, spawn a new adapter.
 *
 * QA B3: enqueues a `RestartOutboxEntry` on the caller's workflow outbox
 * rather than running the multi-step §8.2 algorithm inline from tool code.
 * The session workflow's dispatch loop runs the `deliverRestart` activity on
 * the target, which owns the full algorithm:
 *
 *   graceful `requestDetach` → re-query phase → optional `forceDetach`
 *   → `claimAttachment` → optional `receiveMessage` context replay
 *   → `enqueueSpawn` on the target's outbox
 *
 * PR-F adds two cross-host pieces:
 *
 * 1. `host` param — routes the eventual `spawnProcess` to the
 *    `claude-tempo-{host}` task queue. Threaded through the existing
 *    `RestartOutboxEntry.host` → `deliverRestart` activity → `enqueueSpawn`
 *    update → `SpawnOutboxEntry.targetHostname` → `case 'spawn':`
 *    dispatcher → `getSpawnProxy(host)` → per-host task queue. All the
 *    plumbing already exists; this PR just surfaces the input.
 *
 * 2. `--yes-steal` guard (design §16.5 Option B) — when `force: true`
 *    AND the target's current attachment is on a different host, the
 *    caller must pass `confirmStealFromHost` matching that hostname.
 *    Client-side only; the workflow trusts the caller (P1 gotcha).
 *
 * Durability bonus: mid-algorithm failures surface as ApplicationFailures
 * and retry per the activity's policy. Design §8.2.
 */
import { z } from 'zod';
import { hostname as osHostname } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { OutboxEntryInput, AttachmentInfo } from '../types';
import { submitOutboxUpdate, attachmentInfoQuery } from '../workflows/signals';
import { resolveSession } from './resolve';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, RESTART_CONTEXT_MESSAGES_MAX, validatePlayerName } from '../utils/validation';

const DEFAULT_CONTEXT_MESSAGES = 10;

export interface RestartToolArgs {
  playerId: string;
  host?: string;
  fresh?: boolean;
  force?: boolean;
  contextMessages?: number;
  confirmStealFromHost?: string;
}

/**
 * Shared `--yes-steal` guard (design §16.5 Option B).
 *
 * Returns `null` if the call is allowed, or a user-facing error message
 * (matching the brief's copy-paste-friendly format) if not. Exported for
 * the `migrate` CLI command and unit tests.
 *
 * Only fires when BOTH:
 *   - caller passed `force: true`
 *   - target session currently has an attachment on a host other than ours
 *
 * Graceful (non-force) restarts always pass. Non-cross-host force restarts
 * always pass. Missing `confirmStealFromHost` + mismatched
 * `confirmStealFromHost` are both rejected with the same copy-paste format.
 */
export async function enforceYesStealGuard(
  client: Client,
  ensemble: string,
  playerId: string,
  args: { force?: boolean; confirmStealFromHost?: string },
  localHostname: string = osHostname(),
): Promise<string | null> {
  if (!args.force) return null;

  const resolved = await resolveSession(client, ensemble, playerId);
  if (!resolved) return null; // No target — downstream enqueue will handle the error.

  let info: AttachmentInfo;
  try {
    info = await resolved.query(attachmentInfoQuery) as AttachmentInfo;
  } catch {
    // If we can't read the phase, let the downstream algorithm handle the
    // state. Not our job to synthesize cross-host errors here.
    return null;
  }

  const currentHost = info.currentAttachment?.hostname;
  if (!currentHost || currentHost === localHostname) return null;

  // Cross-host force-restart detected — demand --yes-steal match.
  if (!args.confirmStealFromHost) {
    return (
      `session "${playerId}" is attached to host "${currentHost}". ` +
      `To force-restart from there, pass confirmStealFromHost: "${currentHost}". ` +
      `This safety flag prevents accidental cross-host session takeover.`
    );
  }
  if (args.confirmStealFromHost !== currentHost) {
    return (
      `confirmStealFromHost mismatch: session "${playerId}" is on ` +
      `"${currentHost}", not "${args.confirmStealFromHost}". ` +
      `Re-run with confirmStealFromHost: "${currentHost}".`
    );
  }

  return null;
}

export function registerRestartTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'restart',
    'Restart a session — reap the current attachment (gracefully, or with force=true), claim a fresh attachment, spawn a new adapter, and optionally replay recent context. Replaces `encore`, `recruit --force`, and `stop`-then-`recruit`. Pass `host` to restart on a different machine; when `force=true` AND the target is currently on a different host, pass `confirmStealFromHost` matching that hostname (design §16.5).',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to restart'),
      host: z.string().optional().describe('Target host for the new attachment (defaults to the session\'s preferredHost or last-known hostname). When set, the spawn is routed to the per-host task queue `claude-tempo-{host}`.'),
      fresh: z.boolean().optional().describe('Skip context replay — spawn a clean slate (default false)'),
      force: z.boolean().optional().describe('Steal a live attachment via forceDetach (default false; graceful detach is tried first regardless)'),
      contextMessages: z.number().min(0).max(RESTART_CONTEXT_MESSAGES_MAX).optional().describe(`Number of recent messages to include in context (default ${DEFAULT_CONTEXT_MESSAGES}, max ${RESTART_CONTEXT_MESSAGES_MAX})`),
      confirmStealFromHost: z.string().optional().describe('Required when `force=true` and the target\'s current attachment is on a different host. Must match the hostname currently holding the attachment (design §16.5 Option B).'),
    },
    async (args) => {
      const input = args as RestartToolArgs;

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      // Client-side --yes-steal guard (§16.5). Cross-host force-restart
      // requires an explicit confirmStealFromHost matching the current holder.
      const guardError = await enforceYesStealGuard(client, config.ensemble, input.playerId, input);
      if (guardError) return fail(guardError);

      try {
        const entry: OutboxEntryInput = {
          type: 'restart',
          targetPlayerId: input.playerId,
          invokerPlayerId: getPlayerId(),
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.fresh !== undefined ? { fresh: input.fresh } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.contextMessages !== undefined ? { contextMessages: input.contextMessages } : {}),
        };
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
        return ok(
          `Restart queued for **${input.playerId}**${input.host ? ` on ${input.host}` : ''}` +
          `${input.fresh ? ' (fresh)' : ''}${input.force ? ' (force)' : ''}. (outbox: ${entryId})`,
        );
      } catch (err) {
        return fail(`Failed to restart: ${formatError(err)}`);
      }
    },
  );
}
