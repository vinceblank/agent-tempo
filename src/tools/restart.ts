/**
 * `restart` — reap the current attachment, claim a fresh one, spawn a new adapter.
 *
 * Implements the design §8.2 restart algorithm. Replaces `encore`, `recruit --force`,
 * and `stop`-then-`recruit` with a single verb. The algorithm runs entirely through
 * existing PR-A/B/C primitives — `attachmentInfoQuery`, `requestDetachSignal`,
 * `forceDetachUpdate`, `claimAttachmentUpdate`, `receiveMessageSignal`,
 * `enqueueSpawnUpdate`. No new wire surface.
 *
 * Steps (mirror design §8.2 pseudocode):
 *   1. Resolve target handle. `gone` → error (use recruit).
 *   2. Reap current attachment via `requestDetach` (graceful) + `forceDetach` (with --force).
 *   3. Read adapter routing from `getMetadata`.
 *   4. Claim fresh attachment.
 *   5. Optional context replay via `receiveMessage`.
 *   6. `enqueueSpawn` on target — target's own outbox runs spawn + §8.4 rollback.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import type { AdapterClass, AttachmentInfo, SessionMetadata, Message } from '../types';
import { resolveSession } from './resolve';
import {
  attachmentInfoQuery,
  requestDetachSignal,
  forceDetachUpdate,
  claimAttachmentUpdate,
  enqueueSpawnUpdate,
  getMetadataQuery,
  getPartQuery,
  allMessagesQuery,
  receiveMessageSignal,
} from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, PREVIEW_MAX_LENGTH, validatePlayerName } from '../utils/validation';

const DEFAULT_DETACH_DEADLINE_MS = 5_000;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_CONTEXT_MESSAGES = 10;

export interface RestartArgs {
  playerId: string;
  /** Target host; defaults to `preferredHost` → `metadata.hostname`. */
  host?: string;
  /** Skip context replay when true (default false). */
  fresh?: boolean;
  /** When true, steal a live attachment via `forceDetach` (default false). */
  force?: boolean;
  /** Number of recent messages to include in context (default 10). */
  contextMessages?: number;
}

export interface RestartResult {
  ok: true;
  playerId: string;
  host: string;
  attachmentId: string;
  spawnEntryId: string;
  phaseBefore: string;
  contextReplayed: boolean;
}

/**
 * Shared §8.2 restart algorithm. Both `restart` and `migrate` (sugar for
 * `restart --host=<h>`) delegate here. Throws on error so callers can format
 * both successful and error MCP tool results uniformly.
 */
export async function performRestart(
  client: Client,
  config: Config,
  invokerPlayerId: string,
  args: RestartArgs,
): Promise<RestartResult> {
  const { playerId, host, fresh = false, force = false, contextMessages = DEFAULT_CONTEXT_MESSAGES } = args;

  const resolved = await resolveSession(client, config.ensemble, playerId);
  if (!resolved) {
    throw new Error(`No workflow for "${playerId}". Use recruit to start a fresh session.`);
  }

  // Step 1 — inspect phase. `gone` means the workflow COMPLETEd; a restart
  // would have to recruit a brand-new workflow ID, which is out of scope.
  const info = await resolved.query(attachmentInfoQuery) as AttachmentInfo;
  if (info.phase === 'gone') {
    throw new Error(`"${playerId}" was destroyed. Use recruit to start a fresh session.`);
  }

  const phaseBefore = info.phase;

  // Step 2 — reap current attachment. Graceful detach first on attached/awaiting/processing;
  // re-query; force-detach if still not detached AND --force.
  if (info.phase !== 'detached' && info.phase !== 'booting') {
    if (info.phase === 'attached' || info.phase === 'awaiting' || info.phase === 'processing') {
      try {
        await resolved.signal(requestDetachSignal, {
          reason: 'restart',
          deadlineMs: DEFAULT_DETACH_DEADLINE_MS,
        });
      } catch {
        // Signal may be best-effort on a crashing workflow; force path handles it.
      }
    }

    const info2 = await resolved.query(attachmentInfoQuery) as AttachmentInfo;
    if (info2.phase !== 'detached' && info2.phase !== 'booting') {
      if (!force) {
        const holder = info2.currentAttachment?.hostname ?? 'unknown host';
        throw new Error(
          `"${playerId}" has a live attachment on ${holder} (phase: ${info2.phase}). ` +
          `Use force=true to steal the lease.`,
        );
      }
      await resolved.executeUpdate(forceDetachUpdate, {
        args: [{
          reason: 'restart',
          ...(info2.currentAttachment ? { expectedAttachmentId: info2.currentAttachment.attachmentId } : {}),
          gracePeriodMs: 0,
        }],
      });
    }
  }

  // Step 3 — metadata for adapter routing + host defaulting.
  const metadata = await resolved.query(getMetadataQuery) as SessionMetadata;
  const agentType = (metadata.agentType as string) === 'copilot' ? 'copilot' : 'claude';
  const adapterId = metadata.adapterId || (agentType === 'copilot' ? 'copilot' : 'claude-code');
  const adapterClass: AdapterClass = agentType === 'copilot' ? 'sdk' : 'interactive';
  const targetHost = host ?? info.preferredHost ?? metadata.hostname;

  // Step 4 — claim fresh attachment atomically.
  const token = await resolved.executeUpdate(claimAttachmentUpdate, {
    args: [{
      host: targetHost,
      adapterId,
      adapterClass,
      leaseMs: DEFAULT_LEASE_MS,
    }],
  });

  // Step 5 — optional context replay for continuity (skipped under `fresh`).
  let contextReplayed = false;
  if (!fresh) {
    const [part, allMessages] = await Promise.all([
      resolved.query(getPartQuery) as Promise<string>,
      resolved.query(allMessagesQuery) as Promise<Message[]>,
    ]);
    const recent = allMessages.slice(-contextMessages);
    const summary = recent.length > 0
      ? recent.map((m) => `[${m.from}] ${m.text.slice(0, PREVIEW_MAX_LENGTH)}`).join('\n')
      : '(no recent messages)';
    const contextMessage = [
      `🎵 **Restart** — you've been revived by ${invokerPlayerId}.`,
      part ? `Your last status: ${part}` : '',
      `Recent messages (last ${recent.length}):`,
      summary,
      '',
      'Resume where you left off. Use `ensemble` to see who is active.',
    ].filter(Boolean).join('\n');
    await resolved.signal(receiveMessageSignal, {
      from: invokerPlayerId,
      text: contextMessage,
      responseRequested: false,
    });
    contextReplayed = true;
  }

  // Step 6 — enqueue the spawn on the target. The target's `case 'spawn':` dispatch
  // fires the spawnProcess activity; §8.4 rollback force-detaches on spawn failure.
  const { spawnEntryId } = await resolved.executeUpdate(enqueueSpawnUpdate, {
    args: [{
      host: targetHost,
      attachmentId: token.attachmentId,
      runId: token.runId,
      resume: !fresh,
      ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
      adapterId,
    }],
  });

  return {
    ok: true,
    playerId,
    host: targetHost,
    attachmentId: token.attachmentId,
    spawnEntryId,
    phaseBefore,
    contextReplayed,
  };
}

export function registerRestartTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'restart',
    'Restart a session — reap the current attachment (gracefully, or with force=true), claim a fresh attachment, spawn a new adapter, and optionally replay recent context. Replaces `encore`, `recruit --force`, and `stop`-then-`recruit`.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name to restart'),
      host: z.string().optional().describe('Target host (defaults to session\'s preferredHost or last-known hostname)'),
      fresh: z.boolean().optional().describe('Skip context replay — spawn a clean slate (default false)'),
      force: z.boolean().optional().describe('Steal a live attachment via forceDetach (default false; graceful detach is tried first regardless)'),
      contextMessages: z.number().min(0).max(50).optional().describe(`Number of recent messages to include in context (default ${DEFAULT_CONTEXT_MESSAGES})`),
    },
    async (args) => {
      const input = args as RestartArgs;

      const nameError = validatePlayerName(input.playerId);
      if (nameError) return fail(nameError);

      try {
        const result = await performRestart(client, config, getPlayerId(), input);
        return ok(
          `**${result.playerId}** restarting on ${result.host}` +
          ` (phase was: ${result.phaseBefore}${result.contextReplayed ? '; context replayed' : '; fresh'}).` +
          ` attachmentId: \`${result.attachmentId.slice(0, 8)}…\`, spawnEntryId: \`${result.spawnEntryId.slice(0, 8)}…\`.`,
        );
      } catch (err) {
        return fail(`Failed to restart: ${formatError(err)}`);
      }
    },
  );
}

// Re-export primitives for the restart-CLI path so it doesn't need its own imports.
export { resolveSession };
export type { WorkflowHandle };
