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
import type { DashboardTempoClient } from './client';
import { getDashboardClient } from './client-singleton';

/** Stable query key for the ensemble list. Exported for cache invalidation. */
export const ENSEMBLES_QUERY_KEY = ['ensembles'] as const;
export type EnsemblesQueryKey = typeof ENSEMBLES_QUERY_KEY;

/** Stable query key for the host list. */
export const HOSTS_QUERY_KEY = ['hosts'] as const;
export type HostsQueryKey = typeof HOSTS_QUERY_KEY;

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
 * `GET /v1/ensembles` — list every live ensemble. Polled at 30 s as a
 * fallback when SSE isn't carrying ensemble create/destroy events
 * (`/v1/events/:ensemble` is per-ensemble; cluster lifecycle rides
 * `/v1/events`, not yet wired in PR-4). Stale-while-revalidate.
 */
export function useEnsembleList(opts: QueriesOptions = {}): UseQueryResult<EnsembleSummary[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useQuery({
    queryKey: ENSEMBLES_QUERY_KEY,
    queryFn: async () => {
      try {
        const list = await client.listEnsembles();
        return list;
      } catch (err) {
        logEvent('snapshot.error', {
          resource: 'ensembles',
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /v1/hosts` — host profiles. The daemon caches the underlying
 * `listHosts` for 3 s; we add a 30 s `refetchInterval` so the dashboard
 * Hosts screen surfaces freshness changes without spamming the daemon.
 */
export function useHosts(opts: QueriesOptions = {}): UseQueryResult<HostInfo[], Error> {
  const client = opts.client ?? getDashboardClient();
  return useQuery({
    queryKey: HOSTS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await client.hosts();
      } catch (err) {
        logEvent('snapshot.error', {
          resource: 'hosts',
          error: err instanceof Error ? err.message : String(err),
        }, 'warn');
        throw err;
      }
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
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
