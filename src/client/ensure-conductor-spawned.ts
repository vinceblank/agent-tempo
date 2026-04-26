/**
 * Shared helper for restore-after-shutdown: make sure a conductor terminal
 * is attached to an ensemble before `/restore` completes. Called by the
 * TUI `/restore` slash command (`App.tsx`, `commands.ts`).
 *
 * NOTE: This file lives in `src/client/` because the CLI `restore` command
 * was expected to adopt it. If no CLI consumer adopts within 2 PRs after
 * #308 merges, move to `src/tui/utils/` — current consumers are TUI-only.
 *
 * Returns a structured outcome so callers can render a summary without
 * parsing strings. Never throws — callers should treat a missing conductor
 * as a soft failure.
 */
import type { TempoClientWithSpawn } from './interface';

export type EnsureConductorSpawnedOutcome =
  | { spawned: false; reason: 'alreadyLive' }
  | { spawned: true }
  | { spawned: false; reason: 'spawnFailed'; error: string };

/**
 * If the ensemble already has a conductor session in a live phase, no-op.
 * Otherwise shell out via {@link TempoClientWithSpawn.spawnConductor} to
 * open a conductor terminal. The `claude-tempo up` path is idempotent at
 * the workflow layer, so a benign race (two restores in flight) converges
 * on one workflow.
 *
 * Typed against `TempoClientWithSpawn` (not `TempoClient` alias) so the
 * spawn dependency is explicit at the call site (#308 follow-up).
 */
export async function ensureConductorSpawned(
  ensemble: string,
  client: TempoClientWithSpawn,
): Promise<EnsureConductorSpawnedOutcome> {
  try {
    const info = await client.attachmentInfo(ensemble, 'conductor');
    const phase = info.phase;
    const alreadyLive = phase === 'attached' || phase === 'processing'
      || phase === 'awaiting' || phase === 'booting';
    if (alreadyLive) return { spawned: false, reason: 'alreadyLive' };
  } catch {
    // No conductor session / query failed — fall through to spawn.
  }

  try {
    await client.spawnConductor({ ensemble });
    return { spawned: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // #306: `/restore` runs two parallel paths that can both spawn the
    // conductor — `restoreOrphansOnce` reattaches the orphan adapter via
    // `deliverRestart`, and this helper falls through to a fresh spawn when
    // the attachment-info query returns a non-live phase. If the orphan
    // reattach wins the race, our spawn (`claude-tempo up <ensemble>`)
    // throws "A conductor is already running for ensemble" — which is the
    // success condition for THIS helper. Swallow the race and report alive.
    if (/conductor is already running/i.test(message)) {
      return { spawned: false, reason: 'alreadyLive' };
    }
    return {
      spawned: false,
      reason: 'spawnFailed',
      error: message,
    };
  }
}
