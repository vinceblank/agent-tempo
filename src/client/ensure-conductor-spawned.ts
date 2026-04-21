/**
 * Shared helper for restore-after-shutdown: make sure a conductor terminal
 * is attached to an ensemble before `/restore` completes. Called by the
 * TUI `/restore` slash command and the CLI `restore <ensemble>` path (when
 * the latter adopts it in a follow-up).
 *
 * Returns a structured outcome so callers can render a summary without
 * parsing strings. Never throws — callers should treat a missing conductor
 * as a soft failure.
 */
import type { TempoClient } from './interface';

export type EnsureConductorSpawnedOutcome =
  | { spawned: false; reason: 'alreadyLive' }
  | { spawned: true }
  | { spawned: false; reason: 'spawnFailed'; error: string };

/**
 * If the ensemble already has a conductor session in a live phase, no-op.
 * Otherwise shell out via {@link TempoClient.spawnConductor} to open a
 * conductor terminal. The `claude-tempo up` path is idempotent at the
 * workflow layer, so a benign race (two restores in flight) converges on
 * one workflow.
 */
export async function ensureConductorSpawned(
  ensemble: string,
  client: TempoClient,
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
    return {
      spawned: false,
      reason: 'spawnFailed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
