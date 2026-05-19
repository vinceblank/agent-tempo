/**
 * TanStack Query hooks for the dashboard — PR-4 of #340.
 *
 * The hooks ride on top of the browser-mode {@link DashboardTempoClient}.
 * `queryKey`s are stable arrays so SSE projection in
 * {@link ../lib/sse.ts} can target the same cache slot.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  EnsembleStateV1,
  EnsembleSummary,
  HealthV1,
  OrphansV1,
} from 'agent-tempo/http/event-types';
import type { HostInfo } from 'agent-tempo/types';
import { logEvent } from './log';
import type { AgentTypeRow, DashboardTempoClient, LineupRow } from './client';
import { getDashboardClient } from './client-singleton';

/** Stable query key for the daemon health snapshot. */
export const HEALTH_QUERY_KEY = ['health'] as const;
export type HealthQueryKey = typeof HEALTH_QUERY_KEY;

/** Stable query key for the ensemble list. Exported for cache invalidation. */
export const ENSEMBLES_QUERY_KEY = ['ensembles'] as const;
export type EnsemblesQueryKey = typeof ENSEMBLES_QUERY_KEY;

/** Stable query key for the host list. */
export const HOSTS_QUERY_KEY = ['hosts'] as const;
export type HostsQueryKey = typeof HOSTS_QUERY_KEY;

/**
 * #579 — query key for the cluster-wide orphans listing. Includes the
 * ensemble filter so `useOrphans('foo')` and `useOrphans()` get
 * independent cache slots and refetch on filter change.
 */
export const ORPHANS_QUERY_KEY = ['orphans'] as const;
export function orphansQueryKey(ensemble?: string): readonly unknown[] {
  return ensemble ? [...ORPHANS_QUERY_KEY, ensemble] : [...ORPHANS_QUERY_KEY, '__all__'];
}

/** Stable query key for the agent-type catalog (#400). */
export const AGENT_TYPES_QUERY_KEY = ['agent-types'] as const;
export type AgentTypesQueryKey = typeof AGENT_TYPES_QUERY_KEY;

/** Stable query key for the lineup catalog (#400). */
export const LINEUPS_QUERY_KEY = ['lineups'] as const;
export type LineupsQueryKey = typeof LINEUPS_QUERY_KEY;

/** Stable query key prefix for per-ensemble snapshots. */
export const ENSEMBLE_QUERY_KEY = ['ensemble'] as const;
export type EnsembleQueryKey = readonly ['ensemble', string];

/** Build the per-ensemble query key. Single source of truth shared with `sse.ts`. */
export function ensembleQueryKey(ensemble: string): EnsembleQueryKey {
  return [...ENSEMBLE_QUERY_KEY, ensemble];
}

export interface QueriesOptions {
  /** Override the client (tests). */
  client?: DashboardTempoClient;
}

/**
 * Internal helper — collapses the "fetch + log on error + standard
 * staleTime/refetchInterval" pattern shared by every dashboard
 * catalog query. Each public hook (`useHosts`, `useAgentTypes`, etc.)
 * supplies its query key + fetcher closure + `resource` tag (used as
 * the `snapshot.error` log discriminator). Centralised so a tweak to
 * the cadence or the log shape ripples to all callers.
 */
function useCatalogQuery<TData>(
  queryKey: readonly unknown[],
  fetcher: () => Promise<TData>,
  resource: string,
  extra: { ensemble?: string; enabled?: boolean; refetchOnWindowFocus?: boolean } = {},
): UseQueryResult<TData, Error> {
  const { enabled, refetchOnWindowFocus = true, ...logExtra } = extra;
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await fetcher();
      } catch (err) {
        logEvent('snapshot.error', {
          resource,
          ...logExtra,
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus,
    ...(enabled !== undefined && { enabled }),
  });
}

/**
 * `GET /v1/health` — daemon health and connection metadata.
 * Used by the Settings Connection panel to surface the live
 * namespace and version without hard-coding defaults. Polled at
 * 30 s; stale-while-revalidate. The endpoint is never authenticated
 * so it always responds even when the bearer token is absent.
 */
export function useHealth(opts: QueriesOptions = {}): UseQueryResult<HealthV1, Error> {
  const client = opts.client ?? getDashboardClient();
  return useCatalogQuery(HEALTH_QUERY_KEY, () => client.health(), 'health');
}

/**
 * `GET /v1/ensembles` — list every live ensemble. Polled at 30 s as a
 * fallback when SSE isn't carrying ensemble create/destroy events
 * (`/v1/events/:ensemble` is per-ensemble; cluster lifecycle rides
 * `/v1/events`, not yet wired in PR-4). Stale-while-revalidate.
 */
export function useEnsembleList(opts: QueriesOptions = {}): UseQueryResult<EnsembleSummary[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useCatalogQuery(ENSEMBLES_QUERY_KEY, () => client.listEnsembles(), 'ensembles');
}

/**
 * `GET /v1/hosts` — host profiles. The daemon caches the underlying
 * `listHosts` for 3 s; we add a 30 s `refetchInterval` so the dashboard
 * Hosts screen surfaces freshness changes without spamming the daemon.
 */
export function useHosts(opts: QueriesOptions = {}): UseQueryResult<HostInfo[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useCatalogQuery(HOSTS_QUERY_KEY, () => client.hosts(), 'hosts');
}

/**
 * #579 — `GET /v1/orphans[?ensemble=<name>]`. Daemon caches the
 * underlying read for 3 s; we use a 10 s `staleTime` (matching brief)
 * and 30 s `refetchInterval`. Query key includes the ensemble filter
 * so a filter change triggers a refetch instead of returning the
 * previously-cached unfiltered list.
 */
export function useOrphans(ensemble?: string, opts: QueriesOptions = {}): UseQueryResult<OrphansV1, Error> {
  const client = opts.client ?? getDashboardClient();
  return useQuery({
    queryKey: orphansQueryKey(ensemble),
    queryFn: async () => {
      try {
        return await client.orphans(ensemble ? { ensemble } : undefined);
      } catch (err) {
        logEvent('snapshot.error', {
          resource: 'orphans',
          ...(ensemble ? { ensemble } : {}),
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * #579 — lighter-weight count-only hook for the sidebar badge. Same
 * endpoint, longer refetch (60 s) so the badge poll doesn't compete
 * with the full-list refresh when the operator is on the screen. Falls
 * back to 0 on error (badge hides gracefully without disrupting the
 * sidebar).
 */
export function useOrphanCount(opts: QueriesOptions = {}): UseQueryResult<number, Error> {
  const client = opts.client ?? getDashboardClient();
  return useQuery({
    queryKey: [...ORPHANS_QUERY_KEY, '__count__'],
    queryFn: async () => {
      try {
        const body = await client.orphans();
        return body.orphans.length;
      } catch (err) {
        logEvent('snapshot.error', {
          resource: 'orphans-count',
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /v1/agent-types` — available player-type catalog (#400). Used
 * by the Recruit wizard's player-type picker and the PlayerTypes
 * library screen. The catalog is filesystem-backed on the daemon side
 * (three-tier project → user → shipped lookup); a 30 s
 * `refetchInterval` picks up new agent-type files without spamming
 * the daemon.
 */
export function useAgentTypes(opts: QueriesOptions = {}): UseQueryResult<AgentTypeRow[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useCatalogQuery(AGENT_TYPES_QUERY_KEY, () => client.agentTypes(), 'agent-types');
}

/**
 * `GET /v1/lineups` — available lineup catalog (#400). Used by the
 * CreateEnsemble wizard's lineup picker and the Loadouts library
 * screen. Same filesystem-scan posture as `useAgentTypes`.
 */
export function useLineups(opts: QueriesOptions = {}): UseQueryResult<LineupRow[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useCatalogQuery(LINEUPS_QUERY_KEY, () => client.lineups(), 'lineups');
}

/**
 * `GET /v1/state/:ensemble` — single-ensemble snapshot. Co-located in
 * the cache with the SSE projection (see `lib/sse.ts`); the snapshot
 * fetch seeds the cache, then SSE `setQueryData` updates apply diffs.
 */
export function useEnsembleSnapshot(
  ensemble: string | null,
  opts: QueriesOptions = {},
): UseQueryResult<EnsembleStateV1, Error> {
  const client = opts.client ?? getDashboardClient();
  return useQuery({
    queryKey: ensembleQueryKey(ensemble ?? ''),
    queryFn: async () => {
      if (!ensemble) throw new Error('ensemble required');
      try {
        return await client.state(ensemble);
      } catch (err) {
        logEvent('snapshot.error', {
          resource: 'ensemble-snapshot',
          ensemble,
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    enabled: !!ensemble,
    staleTime: 5_000,
    refetchOnWindowFocus: false, // SSE keeps the cache fresh
  });
}

