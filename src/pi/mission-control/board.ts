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

/**
 * #823 — coarse-SSE connection state, the PRIMARY signal that the board's view
 * is trustworthy. Owned entirely by the extension's stream loop (`startCoarse`)
 * via {@link setConnection} — the reducer's event cases never touch it. Four
 * states (design note Part 2.2, Ruling B), discriminated by how `createSubscribe`
 * surfaces a failure (it HARD-errors on 401/404 with no retry, but silently
 * auto-retries transient drops):
 *
 * - `'connecting'` — initial / post-rebind, before the first coarse event lands.
 * - `'live'` — at least one coarse event has arrived on the current connection.
 * - `'reconnecting'` — the coarse stream ended OR went silent past the watchdog
 *   threshold (#826), and the board is RE-ARMING. Rows are KEPT (rendered stale,
 *   not cleared). #828: the extension now auto-re-subscribes with bounded
 *   equal-jitter backoff (genuine transient blips are still swallowed INSIDE
 *   `createSubscribe`, so the board only reaches here on a real stream-death).
 *   The variant is carried on `connectionDetail` (no new enum value): an arming
 *   detail → `[RECONNECTING]`, a settled detail (re-arm capped at 30s) →
 *   `[STREAM DOWN]`, and the 401-auth path (which does NOT auto-re-arm — a
 *   re-sub would just 401 again) keeps the `[STREAM ENDED]` + set-token hint.
 * - `'gone'` — a hard 404 on the per-ensemble stream: the ensemble's maestro is
 *   gone. {@link setConnection} CLEARS the player list on this transition and the
 *   extension STOPS the stream; the renderer shows "ENSEMBLE DESTROYED".
 *
 * Per the design note: `ensemble.destroyed` is a CLUSTER event, NOT carried on
 * the per-ensemble `/v1/events/:ensemble` stream the board consumes, so
 * destruction surfaces here as a `gone` connection drop — never as a reducer
 * case. A board-initiated `/ensemble-down --destroy` ALSO clears the model
 * optimistically on its 2xx (see the extension), covering the brief pre-404
 * window of the 750 ms poll-driven stream.
 */
export type BoardConnection = 'connecting' | 'live' | 'reconnecting' | 'gone';

/** A short operator-facing reason for the current {@link BoardConnection}, shown
 *  in the connection banner (e.g. the 401 "set AGENT_TEMPO_HTTP_ADMIN_TOKEN" hint). */
export type ConnectionDetail = string;

/** Outcome level of a write command's result line (#821 — drives the glyph). */
export type CommandLevel = 'ok' | 'warn' | 'fail';

/** One persisted command-result line (#821 — folded into the widget so an ack
 *  doesn't vanish like the prior ephemeral `ui.notify` toast). */
export interface CommandLogEntry {
  text: string;
  level: CommandLevel;
}

/** How many recent command results the board retains + renders (bounded footer). */
export const COMMAND_LOG_LIMIT = 4;

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
  /**
   * #823 — coarse-SSE liveness, the primary trust signal for the view. Owned by
   * the extension's stream loop via {@link setConnection}; the reducer never
   * mutates it. See {@link BoardConnection}.
   */
  connection: BoardConnection;
  /**
   * #823 — optional operator-facing reason for a non-`live` connection (e.g. the
   * 401 auth hint), rendered in the connection banner. Cleared on reconnect.
   */
  connectionDetail?: ConnectionDetail;
  /**
   * #821 — bounded ring of recent write-command results (oldest→newest), folded
   * into the widget by {@link pushCommandLog} so an ack/⚠/failure PERSISTS on
   * the board instead of scrolling away as an ephemeral toast (gap A). Capped at
   * {@link COMMAND_LOG_LIMIT}.
   */
  commandLog: CommandLogEntry[];
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
    connection: 'connecting',
    commandLog: [],
  };
}

/**
 * #821 — append a write-command result to the persistent board log (bounded
 * drop-oldest), bumping revision so the throttled render shows it. This is the
 * single chokepoint that makes EVERY operator command's ack/⚠/failure persist
 * in the widget rather than flashing past in an ephemeral `ui.notify` toast.
 */
export function pushCommandLog(model: BoardModel, text: string, level: CommandLevel): void {
  model.commandLog.push({ text, level });
  if (model.commandLog.length > COMMAND_LOG_LIMIT) {
    model.commandLog.splice(0, model.commandLog.length - COMMAND_LOG_LIMIT);
  }
  model.revision++;
}

/**
 * #790 — re-key the board to a NEW ensemble, IN PLACE (the extension's render
 * tick and the planner's `observe_board` hold the model reference — replacing
 * the object would strand them on the old board). Everything ensemble-scoped
 * resets (players, selection, tail, flags); the next coarse `snapshot` event
 * from the re-opened SSE repopulates authoritatively. Bumps revision so the
 * throttled render shows the empty re-bound board immediately rather than the
 * stale one.
 */
export function rebindBoard(model: BoardModel, ensemble: string): void {
  model.ensemble = ensemble;
  model.players = new Map();
  model.selected = null;
  model.innerTail = [];
  model.paused = false;
  model.held = false;
  // #823 — a re-bind is a fresh observation target: back to `connecting` until
  // the re-opened coarse SSE delivers the new ensemble's first event (which
  // flips it to `live`), or hard-errors (→ reconnecting / gone).
  model.connection = 'connecting';
  model.connectionDetail = undefined;
  // #821 — the old ensemble's command acks are irrelevant on the new binding.
  model.commandLog = [];
  model.revision++;
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
      // NOTE (#823): connection liveness is owned by the extension's stream loop
      // (it calls `setConnection('live')` on the first event), NOT seeded here —
      // a snapshot replayed into the model in a test must not silently assert the
      // stream is live. `ensemble.destroyed`/`ensemble.created` are CLUSTER events
      // and never arrive on this per-ensemble stream, so they're intentionally
      // absent from this switch (design note Part 2.2).
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

/**
 * #823 — set the coarse-SSE connection state (owned by the extension's stream
 * loop; see {@link BoardConnection}). The reducer's event cases never call this.
 *
 * Transitioning to `'gone'` (a hard per-ensemble 404 — the maestro is gone)
 * CLEARS the player list + selection + tail + suspension flags, so the board
 * converges to "no ensemble" instead of freezing on the pre-destroy roster (the
 * #823 symptom). Other transitions keep the last-known rows (rendered stale
 * under the connection banner). `detail` is an optional operator hint (e.g. the
 * 401 auth message) shown in the banner.
 *
 * Skips the revision bump only when nothing actually changed, so a steady stream
 * re-asserting `'live'` doesn't thrash the render tick.
 */
export function setConnection(
  model: BoardModel,
  connection: BoardConnection,
  detail?: ConnectionDetail,
): void {
  const unchanged = model.connection === connection && model.connectionDetail === detail;
  if (unchanged) return;
  model.connection = connection;
  model.connectionDetail = detail;
  if (connection === 'gone') {
    model.players = new Map();
    model.selected = null;
    model.innerTail = [];
    model.paused = false;
    model.held = false;
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
