/**
 * Shared factories for vitest tests. Keeps `makePlayer()`, `makeMsg()`,
 * and other shape-builders in one place so PR-5 + PR-6 + future tests
 * can stay consistent without each file inventing its own boilerplate.
 *
 * `makeSnapshot` lives next door in `mock-client.ts` (export-aliased
 * here for ergonomics).
 */
import type {
  EnsembleChatMessage,
  EnsembleStateV1,
  PlayerSummaryV1,
} from 'claude-tempo/http/event-types';
export { makeSnapshot } from './mock-client';
export type { EnsembleStateV1 };

/**
 * Minimal-but-typed `PlayerSummaryV1` builder for tests. Defaults
 * paint a non-conductor `tempo-eng` on `host` running an attached
 * Claude session out of `/work`.
 */
export function makePlayer(overrides: Partial<PlayerSummaryV1> = {}): PlayerSummaryV1 {
  return {
    playerId: 'tempo-eng',
    ensemble: 'demo',
    hostname: 'host',
    isConductor: false,
    agentType: 'claude',
    phase: 'attached',
    part: '',
    workDir: '/work',
    ...overrides,
  };
}

/**
 * Builder for `EnsembleChatMessage`. Defaults paint a
 * `maestro-out` to `alice`. Pass a `broadcastId` to opt into the
 * #357 fold key.
 */
export function makeChatMessage(
  overrides: Partial<EnsembleChatMessage> = {},
): EnsembleChatMessage {
  return {
    id: overrides.id ?? 'm1',
    from: overrides.from ?? 'maestro',
    to: overrides.to ?? 'alice',
    text: overrides.text ?? 'hello',
    timestamp: overrides.timestamp ?? '2026-04-27T12:00:00.000Z',
    role: overrides.role ?? 'maestro-out',
    ...(overrides.broadcastId !== undefined ? { broadcastId: overrides.broadcastId } : {}),
  };
}
