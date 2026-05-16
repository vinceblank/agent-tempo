/**
 * `GET /v1/orphans[?ensemble=<name>]` handler — surfaces cluster-wide
 * cross-host orphans to the dashboard (#579).
 *
 * Pipeline:
 *   1. `TempoClient.listAllOrphans` → `OrphanCandidate[]` (visibility query
 *      with `allHosts: true`, 3-second daemon-edge cache, partial-tolerant
 *      on per-candidate failures).
 *   2. `TempoClient.listHosts` → `HostInfo[]` for the freshness join
 *      (also independently cached for 3s).
 *   3. Map each candidate to the `OrphanV1` wire shape, joining
 *      `hostLiveness` from the hosts snapshot and rendering the operator
 *      `migrateCommand` via {@link renderMigrateCommand}.
 *
 * **NOT a wrapper around `restoreOrphansOnce`** — see ADR follow-up
 * 2026-05-16 (architect option 3): the readonly branch of that helper
 * collapses each candidate down to `{ playerId, ensemble, outcome }` and
 * loses the wire fields we need (`workflowId`, `phase`, `detachedSince`,
 * `lastHeartbeatAt`, `preferredHost`). The dashboard handler therefore
 * calls `queryOrphanedSessions` directly (via `listAllOrphansCached`)
 * and shares the cross-host detail formatter with the readonly branch
 * via {@link buildCrossHostDetail} so the two surfaces never drift.
 *
 * Auth: same bearer + CORS gates as every other `/v1/*` read — applied
 * at the dispatcher in `src/http/server.ts`, not here.
 */
import * as http from 'http';
import { jsonResponse } from './responses';
import type { OrphansV1, OrphanV1 } from './event-types';
import type { TempoClient } from '../client/interface';
import type { HostInfo, OrphanSummary } from '../types';
import type { OrphanCandidate } from '../reconcile/orphans';

/**
 * Render the TUI `/migrate` slash command the operator pastes into their
 * own session to recover an orphan. Wording mirrors
 * `src/tui/commands.ts:handleMigrate` exactly:
 *   - positional `<playerId> <host>`
 *   - flag form `--yes-steal=<currentHost>` (NOT `--confirm-steal-from-host`)
 *
 * When `preferredHost` is non-null the bot can target it directly: the
 * operator just runs `/migrate <player> <preferredHost>` from any
 * session. When it's null we don't know where the player was last seen,
 * so the rendered command targets `<dashboardHost>` and pre-fills the
 * steal guard with the candidate's last-known adapter host (from
 * `OrphanSummary.lastAdapter.hostname`) — falling through to the literal
 * `(unknown)` when even that's missing. The operator MUST edit the
 * placeholder before submit; rendering it literally guarantees the
 * `/migrate` validator catches the slip rather than silently steaming
 * ahead.
 */
export function renderMigrateCommand(args: {
  playerId: string;
  preferredHost: string | null;
  dashboardHost: string;
  lastAdapterHost: string | null;
}): string {
  const { playerId, preferredHost, dashboardHost, lastAdapterHost } = args;
  if (preferredHost) {
    return `/migrate ${playerId} ${preferredHost}`;
  }
  const stealFrom = lastAdapterHost ?? '(unknown)';
  return `/migrate ${playerId} ${dashboardHost} --force --yes-steal=${stealFrom}`;
}

/** Map host freshness → `OrphanV1.hostLiveness`. */
function deriveLiveness(
  preferredHost: string | null,
  hostsByName: Map<string, HostInfo>,
): 'live' | 'stale' | 'missing' {
  if (!preferredHost) return 'missing';
  const h = hostsByName.get(preferredHost);
  if (!h) return 'missing';
  return h.freshness === 'live' ? 'live' : 'stale';
}

/**
 * Map a single `OrphanCandidate` to its `OrphanV1` wire shape.
 *
 * Pure / side-effect-free — exposed for unit tests that want to exercise
 * the join logic without spinning up a Temporal client.
 */
export function buildOrphanRow(args: {
  candidate: OrphanCandidate;
  hostsByName: Map<string, HostInfo>;
  dashboardHost: string;
}): OrphanV1 {
  const { candidate, hostsByName, dashboardHost } = args;
  const summary: OrphanSummary = candidate.summary;
  const preferredHost = summary.preferredHost ?? null;
  const lastAdapterHost = summary.lastAdapter?.hostname ?? null;
  return {
    playerId: summary.playerId,
    ensemble: summary.ensemble,
    workflowId: candidate.workflowId,
    preferredHost,
    hostLiveness: deriveLiveness(preferredHost, hostsByName),
    phase: candidate.info.phase,
    detachedSince: summary.detachedSince ?? null,
    lastHeartbeatAt: candidate.info.currentAttachment?.lastHeartbeatAt ?? null,
    migrateCommand: renderMigrateCommand({
      playerId: summary.playerId,
      preferredHost,
      dashboardHost,
      lastAdapterHost,
    }),
  };
}

/** Build the full `OrphansV1` payload. Exposed for unit tests. */
export async function buildOrphansResponse(
  client: TempoClient,
  ensembleFilter: string | undefined,
  dashboardHost: string,
): Promise<OrphansV1> {
  // Fire both reads in parallel — independent caches, cheap join.
  const [candidates, hosts] = await Promise.all([
    client.listAllOrphans(ensembleFilter ? { ensemble: ensembleFilter } : {}),
    client.listHosts(),
  ]);
  const hostsByName = new Map<string, HostInfo>(hosts.map((h) => [h.hostname, h]));
  const orphans = candidates.map((candidate) =>
    buildOrphanRow({ candidate, hostsByName, dashboardHost }),
  );
  return {
    v: 1,
    capturedAt: new Date().toISOString(),
    orphans,
  };
}

/**
 * Request handler. Bearer + CORS already enforced upstream — by the time
 * we're called the caller is authorized.
 */
export async function handleOrphans(
  res: http.ServerResponse,
  ctx: { client: TempoClient; dashboardHost: string },
  ensembleFilter: string | undefined,
): Promise<void> {
  const payload = await buildOrphansResponse(ctx.client, ensembleFilter, ctx.dashboardHost);
  jsonResponse(res, 200, payload);
}
