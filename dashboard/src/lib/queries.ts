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
} from 'claude-tempo/http/event-types';
import type { HostInfo } from 'claude-tempo/types';
import { logEvent } from './log';
import type { AgentTypeRow, DashboardTempoClient, LineupRow } from './client';
import { getDashboardClient } from './client-singleton';

/** Stable query key for the ensemble list. Exported for cache invalidation. */
export const ENSEMBLES_QUERY_KEY = ['ensembles'] as const;
export type EnsemblesQueryKey = typeof ENSEMBLES_QUERY_KEY;

/** Stable query key for the host list. */
export const HOSTS_QUERY_KEY = ['hosts'] as const;
export type HostsQueryKey = typeof HOSTS_QUERY_KEY;

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

