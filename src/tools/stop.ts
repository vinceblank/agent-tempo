/**
 * `stop` — deprecation shim (PR-D).
 *
 * The `stop` verb is retired in v0.25 per design §8.1 "three verbs". Its two
 * distinct semantics are now separate tools:
 *   - graceful reap of the adapter, workflow survives → `detach`
 *   - terminal teardown of the workflow → `destroy`
 *
 * The MCP tool remains registered (so existing clients discover it via
 * ListTools) but returns an `isError` result pointing to the replacement.
 * The CLI-level `claude-tempo stop` command is unchanged — it's still useful
 * for bulk cleanup (ensemble-wide or `--all`).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../config';
import { defineTool, fail } from './helpers';

export function registerStopTool(
  _server: McpServer,
  _client: Client,
  _config: Config,
  _getPlayerId: () => string,
  _handle: WorkflowHandle,
) {
  defineTool(
    _server,
    'stop',
    '[deprecated in v0.25] The `stop` verb was split into `detach` (graceful adapter reap, workflow survives) and `destroy` (terminal teardown). This tool now returns an error pointing you to the right one.',
    {
      playerId: z.string().describe('The player name to stop'),
      force: z.boolean().optional().describe('Legacy force flag — no longer honored'),
    },
    async () => {
      return fail(
        'The `stop` tool is deprecated. Use:\n' +
        '  • `detach` — gracefully reap the adapter; workflow survives (use this for most cases)\n' +
        '  • `destroy` — terminally end the workflow; abandons in-flight outbox\n' +
        '  • `restart` — reap + claim a fresh adapter with context replay',
      );
    },
  );
}
