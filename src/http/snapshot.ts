/**
 * Snapshot builder for `/v1/state/:ensemble`.
 *
 * **PR-1 strategy**: project the existing TempoClient queries through HTTP
 * without an aggregate. PR-2 will replace this with a 750 ms aggregate
 * poll loop that diffs and emits events; the snapshot endpoint stays
 * stable across that swap because the projection lives in the client
 * surface, not the SSE infrastructure.
 *
 * **Ensemble existence gate**: `listEnsembles()` is the one query that
 * cleanly distinguishes "ensemble doesn't exist" from "ensemble exists
 * but is empty". Calling it first lets us return `404 ensemble-not-found`
 * (SSE-PROTOCOL.md §9) before we fan out the rest of the queries.
 *
 * **Atomicity** (§4.3 contract): in PR-1 the snapshot reflects whatever
 * Temporal queries returned at the time of fan-out. The `lastEventId` is
 * the sentinel `"0:0"` — PR-2 subscribers passing it back will hit
 * `epoch-mismatch` and re-fetch, which is the right behavior since the
 * PR-1 snapshot has no provable atomicity against an event log that
 * doesn't yet exist.
 */
import type { TempoClient } from '../client/interface';
import type { MaestroPlayerInfo, AttachmentPhase } from '../types';
import {
  PR1_SENTINEL_EVENT_ID,
  type EnsembleStateV1,
  type PlayerSummaryV1,
} from './event-types';

/**
 * Maximum chat messages embedded in the snapshot. Larger paging is left
 * to the explicit `getEnsembleChat` query / `recall` tool — the snapshot
 * is a steady-state view, not a paginator.
 */
export const SNAPSHOT_CHAT_LIMIT = 50;

/** Thrown when the ensemble doesn't exist; route handler maps to 404. */
export class EnsembleNotFoundError extends Error {
  constructor(public readonly ensemble: string) {
    super(`ensemble not found: ${ensemble}`);
    this.name = 'EnsembleNotFoundError';
  }
}

/**
 * Fan-out helper — run all client queries in parallel and tolerate
 * per-query failures (an empty array / `false` is the right fallback for
 * every soft-failure case the existing TempoClient already returns).
 */
async function fanOut<T extends Record<string, () => Promise<unknown>>>(
  queries: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> | undefined }> {
  const keys = Object.keys(queries) as (keyof T)[];
  const results = await Promise.all(
    keys.map((key) =>
      queries[key]().catch(() => undefined),
    ),
  );
  const out = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> | undefined };
  keys.forEach((key, i) => {
    (out as Record<keyof T, unknown>)[key] = results[i];
  });
  return out;
}

/**
 * Per-player wire-extension fields layered on top of `toPlayerSummaryV1`.
 * Issue #399 W2 — `getPlayerWireMeta` fans out 3 session queries; the
 * resulting object is merged into the projection here. `null` (session
 * unreachable) drops the whole wire-meta block rather than emitting
 * half-populated fields.
 */
export interface PlayerWireMeta {
  runId?: string;
  messaging?: { received: number; sent: number; outbox: string };
  lease?: { expiresAt: number | null; leaseMs: number | null };
}

/**
 * Project a `MaestroPlayerInfo` into the wire-stable `PlayerSummaryV1`.
 * Drops fields that aren't part of the v1 contract; coerces `agentType`
 * from the open-string MaestroPlayerInfo to the `'claude' | 'copilot'`
 * union (anything unknown defaults to `'claude'` — the v1 contract
 * doesn't expose third-party adapters yet).
 *
 * `wireMeta` is the session-level projection from
 * `TempoClient.getPlayerWireMeta` (Issue #399 W2). Pass `null` (or omit)
 * when the session workflow couldn't be queried — the projection then
 * carries no `runId` / `messaging` / `lease` fields and the dashboard
 * renders `—` placeholders.
 *
 * `activityCount` passes through from `MaestroPlayerInfo` (Q5.6).
 * `MaestroPlayerInfo.lastActivityAt` maps to the wire field
 * `PlayerSummaryV1.lastHeartbeatAt` — same data, rename happens at the
 * wire boundary so consumers read one canonical name.
 */
export function toPlayerSummaryV1(
  p: MaestroPlayerInfo,
  wireMeta: PlayerWireMeta | null = null,
): PlayerSummaryV1 {
  const agentType: 'claude' | 'copilot' =
    p.agentType === 'copilot' ? 'copilot' : 'claude';
  return {
    playerId: p.playerId,
    ensemble: p.ensemble,
    hostname: p.hostname,
    isConductor: p.isConductor,
    agentType,
    ...(p.playerType !== undefined ? { playerType: p.playerType } : {}),
    ...(p.phase !== undefined ? { phase: p.phase as AttachmentPhase } : {}),
    part: p.part ?? '',
    workDir: p.workDir ?? '',
    ...(p.gitBranch !== undefined ? { gitBranch: p.gitBranch } : {}),
    // Issue #399 Q5.6 — pass-through from MaestroPlayerInfo.
    ...(p.activityCount !== undefined ? { activityCount: p.activityCount } : {}),
    // Wire-name rename: source `lastActivityAt` → contract `lastHeartbeatAt`
    // (#389 R3.P1.4). Aggregate's phase-change diff reads the wire name.
    ...(p.lastActivityAt !== undefined ? { lastHeartbeatAt: p.lastActivityAt } : {}),
    // Issue #399 W2 — session-query fan-out merged in when reachable.
    ...(wireMeta?.runId !== undefined ? { runId: wireMeta.runId } : {}),
    ...(wireMeta?.messaging !== undefined ? { messaging: wireMeta.messaging } : {}),
    ...(wireMeta?.lease !== undefined ? { lease: wireMeta.lease } : {}),
  };
}

/**
 * Build the `/v1/state/:ensemble` payload. Throws
 * {@link EnsembleNotFoundError} when the requested ensemble has no live
 * workflows; route handler turns that into a 404.
 */
export async function buildEnsembleSnapshot(
  client: TempoClient,
  ensemble: string,
  opts: { now?: () => Date } = {},
): Promise<EnsembleStateV1> {
  // Existence gate — `listEnsembles` is fast (single workflow.list scan)
  // and returns the canonical state classification (online/paused/offline).
  const ensembles = await client.listEnsembles().catch(() => []);
  const summary = ensembles.find((e) => e.name === ensemble);
  if (!summary) throw new EnsembleNotFoundError(ensemble);

  // Fan-out the rest in parallel. Each soft-fails to a sane default — the
  // PR-1 snapshot must NEVER 500 just because one downstream query glitched.
  // Issue #399 DB1a adds `meta` (4 maestro queries) to the ensemble-level
  // fan-out; per-player wire-meta is fanned out below once `players`
  // resolves so we know which session ids to query.
  const fanned = await fanOut({
    players: () => client.getPlayers(ensemble),
    chat: () => client.getEnsembleChat(ensemble, 0, SNAPSHOT_CHAT_LIMIT),
    schedules: () => client.getSchedules(ensemble),
    paused: () => client.isMaestroPaused(ensemble),
    held: () => client.isAnySessionHeld(ensemble),
    hosts: () => client.listHosts(),
    meta: () => client.getEnsembleMeta(ensemble),
  });

  // Issue #399 W2 — fan-out 3 session queries per player in parallel.
  // For a 12-player ensemble that's 36 queries; running them concurrently
  // keeps total snapshot latency bounded by the slowest single session
  // query, not the sum. `getPlayerWireMeta` returns `null` when the
  // session workflow can't be reached — `toPlayerSummaryV1` gracefully
  // omits the wire-meta fields in that case.
  const playerInfos = fanned.players ?? [];
  const wireMetas = await Promise.all(
    playerInfos.map((p) =>
      client.getPlayerWireMeta(ensemble, p.playerId).catch(() => null),
    ),
  );
  const players = playerInfos.map((p, i) => toPlayerSummaryV1(p, wireMetas[i]));

  const chat = fanned.chat ?? { messages: [], total: 0, hasMore: false, hasConductor: false };
  const schedules = fanned.schedules ?? [];
  const paused = fanned.paused === true;
  const held = fanned.held === true;
  const hostProfiles: Record<string, import('../types').HostProfile> = {};
  for (const h of fanned.hosts ?? []) {
    if (h.profile) hostProfiles[h.hostname] = h.profile;
  }
  // Issue #399 W1 — sentinel defaults when the maestro fan-out soft-failed
  // entirely. `getEnsembleMeta` already soft-fails individual queries to
  // their sentinels; this branch covers the outer `fanOut` swallow when
  // the whole call rejected.
  const meta = fanned.meta ?? {
    description: '',
    startedAt: '',
    currentBpm: 0,
    tempoSeries: [],
  };

  const capturedAt = (opts.now?.() ?? new Date()).toISOString();

  return {
    v: 1,
    ensemble,
    capturedAt,
    lastEventId: PR1_SENTINEL_EVENT_ID,
    state: summary.state ?? 'online',
    hasConductor: summary.hasConductor,
    flags: { paused, held },
    players,
    schedules,
    chat: {
      messages: chat.messages,
      total: chat.total,
      hasMore: chat.hasMore,
    },
    hostProfiles,
    description: meta.description,
    startedAt: meta.startedAt,
    currentBpm: meta.currentBpm,
    tempoSeries: meta.tempoSeries,
  };
}
