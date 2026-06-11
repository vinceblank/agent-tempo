/**
 * Mission-control board model + reducers (3f) — PURE, no Pi/daemon/IO.
 *
 * Builds an in-memory view of the ensemble from the daemon's coarse SSE stream
 * (`TempoEvent` over `/v1/events/:ensemble`) and a fine inner-loop tail
 * (`InnerFrame` over `/v1/players/:e/:p/inner`) for the SELECTED player. The
 * extension applies events here, then renders the model on a throttled tick —
 * decoupling event-rate from render-rate (decision 3). Pure so it unit-tests
 * without Pi or the daemon.
 */
import type { TempoEvent, PlayerSummaryV1, AttachmentPhase } from '../../http/event-types';
import type { InnerFrame } from '../inner-loop-publisher';

/** One row on the board — the coarse, always-on view of a player. */
export interface PlayerRow {
  playerId: string;
  isConductor: boolean;
  /**
   * Daemon host the player runs on (carried from `PlayerSummaryV1.hostname`,
   * 3f/H3a). Undefined on older pre-hostname snapshots → treated as tailable
   * (never block on absent data). Drives {@link tailability}.
   */
  hostname?: string;
  phase?: AttachmentPhase;
  part: string;
  /** Tool currently executing (3c coarse), `null`/undefined = idle. */
  currentTool?: string | null;
  /** Context-window usage fraction/percent (3c coarse). */
  contextPercent?: number;
  /** ISO timestamp of the last coarse activity. */
  lastActivityAt?: string;
}

/** Default cap on the retained fine-tail frames for the selected player. */
export const DEFAULT_TAIL_LIMIT = 200;

export interface BoardModel {
  ensemble: string;
  /** playerId → row, insertion-ordered by the Map. */
  players: Map<string, PlayerRow>;
  /** The player whose fine inner-loop tail is shown, or null. */
  selected: string | null;
  /** Bounded ring of the selected player's recent inner frames (oldest→newest). */
  innerTail: InnerFrame[];
  /** Max retained tail frames. */
  tailLimit: number;
  /** Monotonic counter — bumped on every mutation so the render tick can skip no-op ticks. */
  revision: number;
  /**
   * #752 — ensemble-wide pause flag. Seeded from the snapshot
   * (`flags.paused`, OR'd with the authoritative `state === 'paused'`
   * classification) and kept live by `flags.changed`. Drives the loud
   * PAUSED banner in the renderer — the board previously DROPPED these
   * flags, the exact gap behind the 5h silent-wedge incident.
   */
  paused: boolean;
  /** #752 — any session in the ensemble is held (warm hold, outbox locked). */
  held: boolean;
}

export function initBoard(ensemble: string, tailLimit = DEFAULT_TAIL_LIMIT): BoardModel {
  return {
    ensemble,
    players: new Map(),
    selected: null,
    innerTail: [],
    tailLimit,
    revision: 0,
    paused: false,
    held: false,
  };
}

/** Project a PlayerSummaryV1 (snapshot / player.added) into a row. */
function rowFromSummary(p: PlayerSummaryV1): PlayerRow {
  return {
    playerId: p.playerId,
    isConductor: p.isConductor,
    // H3a: carry the host through — the board previously DROPPED it. Drives
    // cross-host tail refusal in `tailability`.
    ...(p.hostname !== undefined ? { hostname: p.hostname } : {}),
    ...(p.phase !== undefined ? { phase: p.phase } : {}),
    part: p.part ?? '',
    ...(p.currentTool !== undefined ? { currentTool: p.currentTool } : {}),
    ...(p.contextPercent !== undefined ? { contextPercent: p.contextPercent } : {}),
    ...(p.lastActivityAt !== undefined ? { lastActivityAt: p.lastActivityAt } : {}),
  };
}

/**
 * Fold one coarse `TempoEvent` into the board (mutates + bumps revision). Unknown
 * event kinds are ignored — the board only tracks the player set + phase + the
 * 3c coarse activity fields.
 */
export function applyTempoEvent(model: BoardModel, ev: TempoEvent): void {
  switch (ev.type) {
    case 'snapshot': {
      // Authoritative rebuild from the snapshot's player list.
      model.players = new Map(ev.payload.players.map((p) => [p.playerId, rowFromSummary(p)]));
      // Drop a selection that no longer exists.
      if (model.selected && !model.players.has(model.selected)) {
        model.selected = null;
        model.innerTail = [];
      }
      // #752 — seed the suspension flags. `state === 'paused'` is the
      // authoritative classification; `flags.paused` is the SSE projection
      // (mirrors the dashboard's EnsembleCard treatment). Optional-chained
      // defensively — a pre-flags payload must not wedge the reducer.
      model.paused = (ev.payload.flags?.paused ?? false) || ev.payload.state === 'paused';
      model.held = ev.payload.flags?.held ?? false;
      break;
    }
    case 'player.added': {
      model.players.set(ev.payload.playerId, rowFromSummary(ev.payload));
      break;
    }
    case 'player.removed': {
      model.players.delete(ev.payload.playerId);
      if (model.selected === ev.payload.playerId) {
        model.selected = null;
        model.innerTail = [];
      }
      break;
    }
    case 'player.phase_changed': {
      const row = model.players.get(ev.payload.playerId);
      if (row) {
        row.phase = ev.payload.phase;
        row.lastActivityAt = ev.payload.at;
      }
      break;
    }
    case 'player.activity': {
      const row = model.players.get(ev.payload.playerId);
      if (row) {
        row.currentTool = ev.payload.currentTool;
        if (ev.payload.contextPercent !== undefined) row.contextPercent = ev.payload.contextPercent;
        row.lastActivityAt = ev.payload.at;
      }
      break;
    }
    case 'flags.changed': {
      // #752 — live pause/hold transitions (pause/play/release verbs).
      model.paused = ev.payload.paused;
      model.held = ev.payload.held;
      break;
    }
    default:
      return; // not board-relevant — no revision bump
  }
  model.revision++;
}

/** Append a fine inner-loop frame for the selected player (bounded ring). */
export function applyInnerFrame(model: BoardModel, frame: InnerFrame): void {
  model.innerTail.push(frame);
  if (model.innerTail.length > model.tailLimit) {
    model.innerTail.splice(0, model.innerTail.length - model.tailLimit);
  }
  model.revision++;
}

/** Select a player for the fine tail (clears the prior tail). No-op if absent. */
export function selectPlayer(model: BoardModel, playerId: string | null): boolean {
  if (playerId !== null && !model.players.has(playerId)) return false;
  model.selected = playerId;
  model.innerTail = [];
  model.revision++;
  return true;
}

/**
 * Sentinel hostname the TUI's own maestro/dashboard session stamps on its
 * metadata (see `ensureMaestroSession` in `client/core.ts`). It's a UI player
 * with NO /inner stream — non-tailable, but NOT a cross-host case (the sentinel
 * is not a real daemon host). Mirrored locally to avoid a client→mission-control
 * import; the maestro-tail test trips if it ever drifts. (H5)
 */
const UI_PLAYER_HOSTNAME = 'dashboard';

/** Result of a {@link tailability} check — whether the operator can open a fine /inner tail. */
export type Tailability =
  | { ok: true }
  | { ok: false; reason: 'no-such-player' }
  | { ok: false; reason: 'ui-player' }
  | { ok: false; reason: 'cross-host'; playerHost: string };

/**
 * Pure: can the local operator open `playerId`'s fine inner-loop tail? The 3f
 * inner-loop tail is DAEMON-LOCAL — only players on this daemon's host are
 * tailable.
 *
 * - missing player → `no-such-player`
 * - the maestro/dashboard UI player (no /inner stream) → `ui-player` (H5; checked
 *   BEFORE the host comparison so its `dashboard` sentinel isn't mis-framed as
 *   cross-host)
 * - a real player on another host → `cross-host` (carrying `playerHost`); actual
 *   cross-host routing is the deferred H3(b) (#645)
 * - a missing/older-snapshot `hostname` (undefined) → tailable; never block on
 *   absent data
 */
export function tailability(model: BoardModel, playerId: string, localHost: string): Tailability {
  const row = model.players.get(playerId);
  if (!row) return { ok: false, reason: 'no-such-player' };
  if (row.hostname === UI_PLAYER_HOSTNAME) return { ok: false, reason: 'ui-player' };
  if (row.hostname && row.hostname !== localHost) {
    return { ok: false, reason: 'cross-host', playerHost: row.hostname };
  }
  return { ok: true };
}

/** Sorted player ids — conductor first, then alphabetical (stable board ordering). */
export function sortedPlayerIds(model: BoardModel): string[] {
  return [...model.players.values()]
    .sort((a, b) => {
      if (a.isConductor !== b.isConductor) return a.isConductor ? -1 : 1;
      return a.playerId.localeCompare(b.playerId);
    })
    .map((r) => r.playerId);
}
