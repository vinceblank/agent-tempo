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
}

export function initBoard(ensemble: string, tailLimit = DEFAULT_TAIL_LIMIT): BoardModel {
  return { ensemble, players: new Map(), selected: null, innerTail: [], tailLimit, revision: 0 };
}

/** Project a PlayerSummaryV1 (snapshot / player.added) into a row. */
function rowFromSummary(p: PlayerSummaryV1): PlayerRow {
  return {
    playerId: p.playerId,
    isConductor: p.isConductor,
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

/** Sorted player ids — conductor first, then alphabetical (stable board ordering). */
export function sortedPlayerIds(model: BoardModel): string[] {
  return [...model.players.values()]
    .sort((a, b) => {
      if (a.isConductor !== b.isConductor) return a.isConductor ? -1 : 1;
      return a.playerId.localeCompare(b.playerId);
    })
    .map((r) => r.playerId);
}
