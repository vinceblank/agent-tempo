/**
 * SSE event → TUI store dispatch mapping for PR-4a (#94/#95).
 *
 * Pure projection from `TempoEvent` (wire shape, see `src/http/event-types.ts`)
 * to `TuiAction`. Kept in its own module so the mapping can be tested without
 * mounting the full `App` tree.
 *
 * Design notes:
 * - `event: snapshot` resets the ensemble slice (full state replace),
 *   matching what the legacy 2 s poll loop did per tick.
 * - `event: player.*` and `event: chat.appended` apply incrementally —
 *   that's the latency win from streaming over polling.
 * - `event: gap` re-fetches the same set of slices the snapshot covers
 *   via `TempoClient` directly. Per `docs/SSE-PROTOCOL.md` §7.5 the gap
 *   event surfaces to the consumer; the spec leaves the recovery shape
 *   to the consumer (we keep it conservative — refresh, don't tear down
 *   the subscription).
 * - `event: chat.compressed` is a soft gap scoped to chat (§7.6) — we
 *   re-fetch the chat slice only, leaving everything else untouched.
 * - Heartbeats, throttle notices, host-profile + global-stream events
 *   are not relevant to the per-ensemble TUI view; they're noops here.
 */
import type { Dispatch } from 'react';
import type {
  AttachmentPhase,
  MaestroPlayerInfo,
  ScheduleEntry,
} from '../types';
import type { TempoClient } from '../client';
import type { PlayerSummaryV1, TempoEvent } from '../http/event-types';
import type { TuiAction } from './store';
import { toConversationEntry } from './store';

/**
 * Project a wire `PlayerSummaryV1` into the in-memory `MaestroPlayerInfo`
 * shape. The wire type carries two extra ISO timestamps
 * (`lastHeartbeatAt`, `processingSince`) the TUI doesn't render today;
 * dropping them avoids a type cast at the call site.
 */
export function toMaestroPlayerInfo(p: PlayerSummaryV1): MaestroPlayerInfo {
  return {
    playerId: p.playerId,
    ensemble: p.ensemble,
    hostname: p.hostname,
    isConductor: p.isConductor,
    agentType: p.agentType,
    ...(p.playerType !== undefined ? { playerType: p.playerType } : {}),
    ...(p.phase !== undefined ? { phase: p.phase as AttachmentPhase } : {}),
    part: p.part,
    workDir: p.workDir,
    ...(p.gitBranch !== undefined ? { gitBranch: p.gitBranch } : {}),
  };
}

/**
 * The minimum `TempoClient` surface this handler depends on. Narrowed so
 * tests don't have to construct a full client — only the gap/compressed
 * recovery paths use it.
 */
export interface SseRefetchClient {
  getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]>;
  getEnsembleChat(
    ensemble: string,
    offset?: number,
    limit?: number,
  ): ReturnType<TempoClient['getEnsembleChat']>;
  getSchedules(ensemble: string): Promise<ScheduleEntry[]>;
  isMaestroPaused(ensemble: string): Promise<boolean>;
  isAnySessionHeld(ensemble: string): Promise<boolean>;
}

/**
 * Apply one SSE event to the TUI store. Returns a Promise so callers can
 * `await` the gap / chat.compressed re-fetches; for purely-synchronous
 * events (every other kind) the returned promise is already resolved.
 */
export async function handleSseEvent(
  event: TempoEvent,
  dispatch: Dispatch<TuiAction>,
  ensemble: string,
  api: SseRefetchClient,
): Promise<void> {
  switch (event.type) {
    case 'snapshot': {
      const snap = event.payload;
      const players = snap.players.map(toMaestroPlayerInfo);
      dispatch({
        type: 'REFRESH_ENSEMBLE_DATA',
        players,
        messages: [],
        history: [],
        schedules: snap.schedules,
      });
      dispatch({
        type: 'SET_ENSEMBLE_CHAT',
        chat: {
          messages: snap.chat.messages,
          total: snap.chat.total,
          hasMore: snap.chat.hasMore,
          hasConductor: snap.hasConductor,
        },
      });
      dispatch({ type: 'SET_ENSEMBLE_PAUSED', paused: snap.flags.paused });
      dispatch({ type: 'SET_ENSEMBLE_HELD', held: snap.flags.held });
      const conductor = players.find((p) => p.isConductor);
      if (conductor) dispatch({ type: 'SET_CONDUCTOR', name: conductor.playerId });
      dispatch({
        type: 'SET_CONVERSATION',
        conversation: snap.chat.messages.map(toConversationEntry),
      });
      return;
    }

    case 'player.added':
      // Carries a full `PlayerSummaryV1` — project to the in-memory
      // shape and let the reducer merge by `playerId`.
      dispatch({ type: 'UPSERT_PLAYER', player: toMaestroPlayerInfo(event.payload) });
      return;

    case 'player.phase_changed':
      // The wire payload here is sparse — `{ playerId, ensemble, phase,
      // … timestamps }` per `src/http/event-types.ts`. Earlier this case
      // fell through to the same projection as `player.added`, which
      // synthesised empty `hostname` / `part` / `isConductor` defaults
      // and clobbered the snapshot-cached values via the reducer's
      // spread merge. Patching only `phase` keeps the rest intact. #351.
      dispatch({
        type: 'PATCH_PLAYER_PHASE',
        playerId: event.payload.playerId,
        phase: event.payload.phase,
      });
      return;

    case 'player.removed':
      dispatch({ type: 'REMOVE_PLAYER', playerId: event.payload.playerId });
      return;

    case 'chat.appended':
      dispatch({ type: 'APPEND_CHAT_MESSAGE', message: event.payload });
      return;

    case 'flags.changed':
      dispatch({ type: 'SET_ENSEMBLE_PAUSED', paused: event.payload.paused });
      dispatch({ type: 'SET_ENSEMBLE_HELD', held: event.payload.held });
      return;

    case 'schedules.changed':
      dispatch({ type: 'SET_SCHEDULES', schedules: event.payload.schedules });
      return;

    case 'gap': {
      // Hard gap (epoch-mismatch or overflow). Spec §7.2 says re-fetch
      // `/v1/state/:ensemble` and resume — we don't have a direct HTTP
      // hook for that here, so we fan out the same Temporal queries the
      // snapshot endpoint projects (matches the legacy poll's set). The
      // fetch wrapper continues yielding events after the gap; we just
      // don't want the consumer to render stale state until the next
      // event arrives.
      try {
        const [players, chat, schedules, paused, held] = await Promise.all([
          api.getPlayers(ensemble),
          api.getEnsembleChat(ensemble, 0, 50),
          api.getSchedules(ensemble),
          api.isMaestroPaused(ensemble),
          api.isAnySessionHeld(ensemble),
        ]);
        dispatch({
          type: 'REFRESH_ENSEMBLE_DATA',
          players,
          messages: [],
          history: [],
          schedules,
        });
        dispatch({ type: 'SET_ENSEMBLE_CHAT', chat });
        dispatch({ type: 'SET_ENSEMBLE_PAUSED', paused });
        dispatch({ type: 'SET_ENSEMBLE_HELD', held });
        dispatch({
          type: 'SET_CONVERSATION',
          conversation: chat.messages.map(toConversationEntry),
        });
      } catch (err) {
        console.error('[tui:sse] gap recovery failed:', err);
      }
      return;
    }

    case 'chat.compressed': {
      // Soft gap scoped to chat (§7.6) — re-fetch the chat slice only.
      try {
        const chat = await api.getEnsembleChat(ensemble, 0, 50);
        dispatch({ type: 'SET_ENSEMBLE_CHAT', chat });
        dispatch({
          type: 'SET_CONVERSATION',
          conversation: chat.messages.map(toConversationEntry),
        });
      } catch (err) {
        console.error('[tui:sse] chat.compressed recovery failed:', err);
      }
      return;
    }

    // Per-ensemble view doesn't render these — global stream events
    // (`ensemble.created`, `ensemble.destroyed`, `host_profile.changed`)
    // are consumed by the home view's separate refresh path; heartbeat
    // is connection-local; throttled is informational.
    case 'heartbeat':
    case 'throttled':
    case 'ensemble.created':
    case 'ensemble.destroyed':
    case 'host_profile.changed':
      return;
  }
}
