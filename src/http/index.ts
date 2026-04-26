/**
 * Barrel re-exports for the daemon HTTP/SSE event source (#94, #95).
 *
 * - PR-1 (this file's first revision): snapshot endpoints + bearer/CORS
 *   middleware + port-file lifecycle. Drives `/v1/health`, `/v1/ensembles`,
 *   `/v1/state/:ensemble`, `/v1/hosts`.
 * - PR-2 (future): `EnsembleEventBus`, ring buffer, `/v1/events*` SSE.
 * - PR-3 (future, eng-4): `TempoClient.subscribe` AsyncIterable.
 *
 * Public surface kept narrow on purpose — implementation modules are the
 * source of truth.
 */
export {
  startHttpServer,
  DEFAULT_BIND_ADDR,
  DEFAULT_PORT,
  type HttpServerOptions,
  type HttpServerHandle,
} from './server';
export {
  PR1_SENTINEL_EVENT_ID,
  SSE_EVENT_KINDS,
  type SseEventKind,
  type TempoEvent,
  type SubscribeOptions,
  type SubscribeTopic,
  type EnsembleStateV1,
  type PlayerSummaryV1,
  type HealthV1,
} from './event-types';
export {
  DAEMON_PORT_PATH,
  readPortFile,
  removePortFile,
  writePortFileAtomic,
} from './port-file';
export {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
  toPlayerSummaryV1,
  SNAPSHOT_CHAT_LIMIT,
} from './snapshot';
