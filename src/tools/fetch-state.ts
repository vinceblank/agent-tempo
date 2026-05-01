/**
 * `fetch_state` — read a saved state slot for self or any peer in the
 * ensemble (#334 PR-1, ADR 0011).
 *
 * Permissions are by-design open for reads — the architect's design §5.4
 * mirrors `recall` / `attachment_info` ergonomics: any player in the
 * ensemble can read any other player's saved state. Audit identity lives
 * on the entry's `savedBy` field. Writes/clears remain owner-only by
 * structure (no `playerId` arg on `save_state` / `clear_state`).
 *
 * Implementation note: peer reads go through `resolveSession()` (the
 * codebase convention), NOT a raw `client.workflow.getHandle(...)`. This
 * matches every other peer-targeting tool (`cue`, `attachment_info`,
 * `recall`) and inherits their resilience to workflow-id format drift.
 *
 * Phase=gone behavior: Temporal continues to serve queries against
 * completed workflows (returning the last-known query state from history).
 * `fetch_state` therefore returns the slot's final value even after
 * `destroy` — useful for post-mortem inspection. If the workflow has been
 * fully GC'd or never existed, `resolveSession` returns null and the tool
 * surfaces a "no session found" error.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowHandle, Client } from '@temporalio/client';
import { Config } from '../config';
import { resolveSession } from './resolve';
import { playerStateQuery } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import type { PlayerStateEntry } from '../types';
import {
  PLAYER_NAME_MAX,
  validatePlayerName,
  PLAYER_STATE_KEY_REGEX,
  PLAYER_STATE_KEY_MAX,
  PLAYER_STATE_DEFAULT_KEY,
} from '../utils/validation';

/**
 * Return type is monomorphic by design: `{ content, savedAt, savedBy } | null`.
 * ADR 0011 §Alternatives explicitly rejected a `list: boolean` flag because
 * the overloaded return shape (slot vs `string[]`) would force union-narrowing
 * on every downstream consumer (TUI, dashboard, future TempoClient). Slot
 * enumeration is reachable for operators via `temporal workflow query <id>
 * playerStateKeys`; v2 can graduate a dedicated `list_state` MCP tool if
 * telemetry shows real demand.
 */
export function registerFetchStateTool(
  server: McpServer,
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'fetch_state',
    `Read a saved-state slot for yourself or a peer. Defaults to your own "${PLAYER_STATE_DEFAULT_KEY}" slot.

Pass \`playerId\` to read a peer's slot (any player in the ensemble can read any other player's state — audit identity is recorded on each slot via \`savedBy\`). Returns a "(no state saved …)" message when the slot is empty.`,
    {
      key: z.string().regex(PLAYER_STATE_KEY_REGEX).max(PLAYER_STATE_KEY_MAX).optional().describe(
        `Slot name (default "${PLAYER_STATE_DEFAULT_KEY}").`,
      ),
      playerId: z.string().max(PLAYER_NAME_MAX).optional().describe(
        'Target player name (default: self).',
      ),
    },
    async (args) => {
      const { key, playerId } = args as { key?: string; playerId?: string };
      const targetId = playerId ?? getPlayerId();

      // Validate any explicit playerId — `getPlayerId()` is trusted (set by
      // the MCP server) and skips this check.
      if (playerId !== undefined) {
        const nameError = validatePlayerName(playerId);
        if (nameError) return fail(nameError);
      }

      try {
        // Self-targeted reads use the cached own-session handle directly;
        // peer reads go through `resolveSession` (the codebase convention,
        // not a raw `client.workflow.getHandle`) so workflow-id format
        // changes only need to be tracked in one place.
        const targetHandle: WorkflowHandle | null = targetId === getPlayerId()
          ? handle
          : await resolveSession(client, config.ensemble, targetId);
        if (!targetHandle) {
          return fail(`No session found with name "${targetId}".`);
        }

        const slotKey = key ?? PLAYER_STATE_DEFAULT_KEY;
        const result = await targetHandle.query(playerStateQuery, { key: slotKey }) as PlayerStateEntry | null;
        if (!result) {
          return ok(`(no state saved at slot "${slotKey}" for ${targetId})`);
        }
        return ok(
          `Slot **"${slotKey}"** — saved by **${result.savedBy}** at ${result.savedAt}\n\n${result.content}`,
        );
      } catch (err) {
        return fail(`Failed to fetch state: ${formatError(err)}`);
      }
    },
  );
}
