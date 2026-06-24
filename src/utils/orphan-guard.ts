/**
 * #704 Item 1b — late-orphan self-tombstone discriminator (pure).
 *
 * A recruited process can launch LONG after its recruit was cancelled (a slow /
 * wedged cold start). When it finally boots and reaches the workflow-start site
 * (`server.ts`), this predicate decides whether it is an ORPHAN of a cancelled
 * recruit (→ self-exit, do not re-register) or a legitimate (re-)start (→ proceed).
 *
 * The discriminator is the **running-run × close-reason PAIR**:
 *   - If a RUNNING run exists for the derived id, this process is NOT an orphan —
 *     every managed re-creation (recruit / restart / migrate / up) pre-creates a
 *     RUNNING run before its process boots, so a legit reuse is seen as RUNNING and
 *     simply attaches via `USE_EXISTING`. Never self-exit.
 *   - Otherwise, the most-recent run is CLOSED. Self-exit ONLY when it closed with a
 *     typed tombstone reason (`destroyed` | `boot-timeout`) within a generous TTL.
 *     The TTL bounds a stale tombstone so a much-later legit manual reuse of the
 *     same name isn't blocked forever (the observed orphan spawn delay was ~100min).
 *
 * Pure + dependency-free so it unit-tests without a live Temporal env; `server.ts`
 * supplies the `describe()`-derived inputs.
 */
export interface OrphanTombstoneInput {
  /** `describe().status.name` — e.g. `'RUNNING'`, `'COMPLETED'`, `'TERMINATED'`. */
  statusName: string;
  /** `describe().memo?.[MEMO_KEYS.closeReason]` — the typed close reason, if any. */
  closeReason: unknown;
  /** `describe().closeTime?.getTime() ?? 0` — ms epoch of run close, `0` if open/unknown. */
  closeTimeMs: number;
}

/** Close reasons that tombstone a derived id against orphan re-registration. */
const TOMBSTONE_REASONS = new Set(['destroyed', 'boot-timeout']);

/**
 * Returns true iff the booting process should self-exit as a late orphan.
 *
 * @param input      the `describe()`-derived run state for the derived workflow id
 * @param ttlMs      how long a tombstone is honored (ms); `> 0`
 * @param nowMs      current wall-clock ms (`Date.now()`)
 */
export function shouldSelfExitAsOrphan(
  input: OrphanTombstoneInput,
  ttlMs: number,
  nowMs: number,
): boolean {
  // A running run means a legit (re-)creation already exists — attach, don't exit.
  if (input.statusName === 'RUNNING') return false;
  // Only a typed tombstone close-reason qualifies.
  if (typeof input.closeReason !== 'string' || !TOMBSTONE_REASONS.has(input.closeReason)) {
    return false;
  }
  // Bound staleness: a tombstone older than the TTL is released so a legit
  // much-later reuse of the same derived id isn't blocked.
  if (!(input.closeTimeMs > 0)) return false;
  return nowMs - input.closeTimeMs <= ttlMs;
}
