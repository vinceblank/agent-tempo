import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { scanEnsembleSessions } from '../activities/resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput } from '../types';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, MESSAGE_MAX, validatePlayerName } from '../utils/validation';

/**
 * Max Levenshtein distance for a fuzzy-match candidate to surface in the
 * unknown-player suggestion. Three insertions/deletions/substitutions covers
 * common typos (transposed chars, dropped chars, off-by-one) without
 * surfacing wildly unrelated names. #560 acceptance criterion 3.
 */
const FUZZY_MATCH_MAX_DISTANCE = 3;
/** Cap on suggestions shown in the error to keep the message readable. */
const FUZZY_MATCH_MAX_SUGGESTIONS = 3;

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
    'Send a message to another Claude Code session by player name. Delivered instantly via Temporal signal.',
    {
      playerId: z.string().max(PLAYER_NAME_MAX).describe('The player name of the target session'),
      message: z.string().max(MESSAGE_MAX).describe('The message to send'),
    },
    async (args) => {
      const { playerId, message } = args as { playerId: string; message: string };

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

        const entry = {
          type: 'cue',
          targetPlayerId: playerId,
          message,
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
