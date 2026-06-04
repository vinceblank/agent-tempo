/**
 * Mission-control (3f) — a Pi extension that turns one interactive Pi TUI into
 * an ensemble mission-control board + operator controller. Observer-only,
 * HTTP-driven, throttled render. See ./extension.ts.
 *
 * The default export is the loadable Pi extension.
 */
export { default, createMissionControlExtension, Controller } from './extension';
export type { MissionControlDeps } from './extension';
export {
  initBoard,
  applyTempoEvent,
  applyInnerFrame,
  selectPlayer,
  sortedPlayerIds,
  DEFAULT_TAIL_LIMIT,
} from './board';
export type { BoardModel, PlayerRow } from './board';
export { renderBoard } from './render';
export { MissionControlActions, ADMIN_TOKEN_ENV } from './actions';
export type { ActionResult } from './actions';
export { parseInnerSse, openInnerTail } from './inner-tail';
