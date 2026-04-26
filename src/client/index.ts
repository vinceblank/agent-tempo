/**
 * Public entry point for the `TempoClient` family.
 *
 * Two factories ship side by side after the #308 follow-up split (see ADR
 * 0007 and `docs/design/tempoclient-core-spawn-split.md`):
 *
 * - {@link createTempoClientCore} — pure Temporal RPC, headless-safe
 *   (daemon, MCP server, SSE event source, future SDK consumers).
 * - {@link createTempoClientWithSpawn} — the TTY-bound superset adding
 *   `createEnsemble` and `spawnConductor`. Use from the TUI/CLI only.
 *
 * `createTempoClient` is preserved as a permanent alias for
 * `createTempoClientWithSpawn` so every existing call site keeps the same
 * return shape — no codemod required at adoption.
 */
import type { Client } from '@temporalio/client';
import { createTempoClientWithSpawn, type CreateTempoClientOpts } from './with-spawn';
import type { TempoClientWithSpawn } from './interface';

export { createTempoClientCore } from './core';
export { createTempoClientWithSpawn, type CreateTempoClientOpts } from './with-spawn';

// Re-export public types for consumers
export type {
  TempoClient,
  TempoClientCore,
  TempoClientWithSpawn,
  EnsembleSummary,
  EnsembleShutdownSummary,
  EnsembleShutdownDetail,
  EnsembleDestroySummary,
  EnsembleDestroyDetail,
  RecruitClientOpts,
  RecruitClientResult,
  ReleaseClientResult,
} from './interface';

// SSE subscribe surface (PR-3 of #94/#95)
export type { SubscribeOptions, SubscribeTopic, TempoEvent } from '../http/event-types';
export { SubscribeHttpError, type SubscribeDeps } from './subscribe';

/**
 * Backwards-compatible alias for {@link createTempoClientWithSpawn}. The
 * `TempoClient` type alias resolves to `TempoClientWithSpawn`, so every
 * existing `createTempoClient(client)` call site keeps its current shape.
 *
 * **New headless consumers should call {@link createTempoClientCore}
 * directly** — the type system then forbids accidental TTY dependencies.
 */
export function createTempoClient(
  client: Client,
  opts: CreateTempoClientOpts = {},
): TempoClientWithSpawn {
  return createTempoClientWithSpawn(client, opts);
}
