/**
 * `hosts` — MCP tool for surfacing daemons polling the Temporal namespace (#274).
 *
 * Joins two sources of truth and returns a formatted text payload:
 *   - Temporal's own poller registry (`describeTaskQueue`), filtered to
 *     identities parseable as `agent-tempo:<host>:<pid>:<version>` or
 *     the legacy `<pid>@<hostname>` SDK default.
 *   - The `hostProfiles` projection maintained by the global maestro
 *     from daemon boot signals.
 *
 * Consumes the shared formatter from `src/utils/format-hosts.ts`, so
 * CLI `agent-tempo hosts` and TUI `/hosts` produce the same text.
 * Thin wrapper — all the logic is in `listHosts`.
 */
import { z } from 'zod';
import { Client } from '@temporalio/client';
import { Config } from '../config';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { listHosts } from '../utils/hosts';
import { formatHostList } from '../utils/format-hosts';

export function buildHostsTool(client: Client, config: Config): TempoToolDescriptor {
  return {
    name: 'hosts',
    description: 'Show all daemons polling this Temporal namespace, with their advertised capabilities. Returns liveness (live/stale), recruit-readiness, and each daemon\'s profile (default agent, available player types, platform) when it signaled one at boot. Read-only diagnostic.',
    params: {
      includeStale: z.boolean().optional().describe('Include hosts not seen in the last minute (default: false).'),
      force: z.boolean().optional().describe('Bypass the 3-second result cache (default: false).'),
    },
    handler: async (args) => {
      const { includeStale, force } = args as { includeStale?: boolean; force?: boolean };
      try {
        const hosts = await listHosts(client, {
          force: Boolean(force),
          namespace: config.temporalNamespace,
          taskQueue: config.taskQueue,
        });
        return ok(formatHostList(hosts, { includeStale: Boolean(includeStale) }));
      } catch (err) {
        return fail(`Failed to list hosts: ${formatError(err)}`);
      }
    },
  };
}
