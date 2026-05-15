import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { scanEnsembleSessions } from '../activities/resolve';
import { attachmentInfoQuery, submitOutboxUpdate } from '../workflows/signals';
import { queryHandleWithTimeout } from '../utils/query-timeout';
import type { AttachmentInfo, AttachmentPhase, OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import {
  PLAYER_NAME_MAX,
  MESSAGE_MAX,
  COAT_CHECK_TICKET_MAX,
  COAT_CHECK_TICKET_REGEX,
  validatePlayerName,
} from '../utils/validation';

/**
 * Max Levenshtein distance for a fuzzy-match candidate to surface in the
 * unknown-player suggestion. Three insertions/deletions/substitutions covers
 * common typos (transposed chars, dropped chars, off-by-one) without
 * surfacing wildly unrelated names. #560 acceptance criterion 3.
 */
const FUZZY_MATCH_MAX_DISTANCE = 3;
/** Cap on suggestions shown in the error to keep the message readable. */
const FUZZY_MATCH_MAX_SUGGESTIONS = 3;

/**
 * Phases where the target session has no live adapter — the workflow inbox
 * still queues the signal and auto-redelivers on re-attach, but the
 * operator's "Message sent to X" success line is misleading because no
 * human-readable surface processes the message *now*. #562 surfaces the
 * gap.
 *
 * `draining` is NOT included — it's a brief mid-shutdown state and the
 * adapter is still consuming pending messages; flagging it as undeliverable
 * would false-positive during normal teardown.
 */
const UNDELIVERABLE_PHASES: ReadonlySet<AttachmentPhase> =
  new Set<AttachmentPhase>(['detached', 'gone']);

/**
 * Cue pre-flight timeout. Half of {@link DEFAULT_QUERY_TIMEOUT_MS} —
 * `cue` is operator-interactive, so a slow target shouldn't make the
 * user wait the full 2s default before falling through to the best-
 * effort path. 1s strikes the balance between catching the common
 * detached-player case and not wedging the operator.
 */
const CUE_PHASE_PREFLIGHT_TIMEOUT_MS = 1000;

/**
 * Build the operator-facing error message when the cue target is in an
 * undeliverable phase. Lists three actionable next steps per the issue
 * body's AC #3.
 *
 * Exported for unit testing.
 */
export function formatDetachedDeliveryError(
  playerId: string,
  phase: AttachmentPhase,
): string {
  return (
    `Player "${playerId}" is currently '${phase}' — no live adapter to receive. ` +
    `Message NOT delivered. Options: ` +
    `(1) use 'recall' to view their message history, ` +
    `(2) 'restart' to re-attach the session and retry the cue, ` +
    `(3) the workflow inbox queues the signal and auto-delivers on re-attach.`
  );
}

export function registerCueTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'cue',
    'Send a message to another Claude Code session by player name. Delivered instantly via Temporal signal. For content larger than ~100 KB, use `coat_check_put` to stash the body and pass the returned ticket via `attachmentTicket` — the cue body itself should carry a short summary the recipient can act on without fetching.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name of the target session'),
      message: z.string().max(MESSAGE_MAX).describe('The message to send'),
      attachmentTicket: z.string().regex(COAT_CHECK_TICKET_REGEX).max(COAT_CHECK_TICKET_MAX).optional().describe(
        'Optional coat-check ticket (#318). Reference content stashed via `coat_check_put`; the receiver sees the ticket on their `recall` message and can pull the body via `coat_check_get`. Backward-compatible — omit for normal cues.',
      ),
    },
    async (args) => {
      const { playerId, message, attachmentTicket } = args as {
        playerId: string;
        message: string;
        attachmentTicket?: string;
      };

      const nameError = validatePlayerName(playerId);
      if (nameError) return fail(nameError);

      try {
        const resolved = await resolveSession(client, config.ensemble, playerId);
        if (!resolved) {
          // #560: replace the generic "no active session found" with an
          // actionable error — active-player list + fuzzy-match suggestion
          // + Agent-tool surface hint. We pay the extra `scanEnsembleSessions`
          // round-trip ONLY on the error path, so the success path is
          // unchanged.
          const sessions = await scanEnsembleSessions(client, config.ensemble);
          const activePlayers = sessions.map((s) => s.playerId).sort();
          return fail(formatUnknownPlayerError(playerId, activePlayers));
        }

        // #562: phase pre-flight. Resolves the gap where `cue` to a
        // detached/gone player returns "Message sent" — wire-truthful (the
        // signal IS delivered to the workflow inbox), but operator-
        // misleading because no live adapter surfaces the message.
        let phase: AttachmentPhase | undefined;
        try {
          const info = await queryHandleWithTimeout<AttachmentInfo>(
            resolved,
            attachmentInfoQuery,
            { timeoutMs: CUE_PHASE_PREFLIGHT_TIMEOUT_MS },
          );
          phase = info.phase;
        } catch (err) {
          // Query timed out or threw — workflow may be wedged. Don't
          // penalize the operator: fall through to best-effort submit.
          // Auto-redelivery on re-attach still applies. Stderr log keeps
          // the observability trail without surfacing noise to the user.
          console.error(
            `[agent-tempo:cue] phase pre-flight failed for "${playerId}" — proceeding best-effort:`,
            err instanceof Error ? err.message : err,
          );
        }

        if (phase && UNDELIVERABLE_PHASES.has(phase)) {
          return fail(formatDetachedDeliveryError(playerId, phase));
        }

        const entry = {
          type: 'cue',
          targetPlayerId: playerId,
          message,
          ...(attachmentTicket !== undefined ? { attachmentTicket } : {}),
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Message sent to ${playerId}. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to send message to ${playerId}: ${formatError(err)}`);
      }
    },
  );
}

/**
 * Format the cue tool's "unknown player" error with actionable suggestions.
 * Exported for direct unit testing — the production path passes the active
 * player list from `scanEnsembleSessions`.
 *
 * The message disambiguates the two common causes per the issue body (#560):
 *   1. Typo / destroyed player → fuzzy-match suggestion (Levenshtein ≤ 3),
 *      active-player listing, hint about `recall` for destroyed targets.
 *   2. Agent-tool sub-agent confusion → explicit note that Claude Code
 *      `subagent_type:` agents run in the spawner's process and are NOT
 *      addressable via `cue`; `recruit` is the cross-process surface.
 *
 * Returns a multi-line string. Caller wraps in {@link fail}.
 */
export function formatUnknownPlayerError(target: string, activePlayers: string[]): string {
  const lines: string[] = [
    `Player "${target}" is not registered with this tempo ensemble.`,
  ];

  const closest = findClosestPlayers(target, activePlayers);
  if (closest.length > 0) {
    lines.push('');
    lines.push(`Did you mean: ${closest.map((p) => `"${p}"`).join(', ')}?`);
  }

  lines.push('');
  if (activePlayers.length > 0) {
    lines.push(`Active players: ${activePlayers.join(', ')}`);
  } else {
    lines.push('No active players in this ensemble. Use `recruit` to start one.');
  }

  lines.push('');
  lines.push(
    "Note: Claude Code Agent-tool sub-agents (e.g. spawned via " +
    "`subagent_type: tempo-*`) are NOT tempo players — they run in the " +
    "spawner's process and aren't addressable via `cue`. Use `recruit` " +
    "for a cross-process player, or `ensemble` to list current players.",
  );

  return lines.join('\n');
}

/**
 * Find the closest matching player names by Levenshtein distance.
 * Returns the top-N nearest within {@link FUZZY_MATCH_MAX_DISTANCE},
 * sorted by ascending distance then alphabetically. Empty array if no
 * candidate is close enough.
 *
 * Exported for unit testing.
 */
export function findClosestPlayers(target: string, candidates: string[]): string[] {
  if (!target || candidates.length === 0) return [];
  const scored = candidates
    .map((c) => ({ name: c, distance: levenshtein(target, c) }))
    .filter((entry) => entry.distance <= FUZZY_MATCH_MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, FUZZY_MATCH_MAX_SUGGESTIONS).map((e) => e.name);
}

/**
 * Plain Levenshtein edit distance — single-row DP, O(|a| · |b|) time,
 * O(min) space. No library dependency.
 *
 * Exported for unit testing.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter string to keep the row small.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
