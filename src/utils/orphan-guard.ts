/**
 * #704 Item 1b / #897 (B2) — late-orphan self-tombstone discriminator (pure).
 *
 * A recruited process can launch LONG after its recruit was cancelled (a slow /
 * wedged cold start). When it finally boots and reaches the workflow-start site
 * (`server.ts`), this predicate decides whether it is an ORPHAN of a cancelled
 * recruit (→ self-exit, do not re-register) or a legitimate (re-)start (→ proceed).
 *
 * The discriminator is the **running-run × close-reason × sessionId-match TRIPLE**:
 *   - If a RUNNING run exists for the derived id, this process is NOT an orphan —
 *     every managed re-creation (recruit / restart / migrate / up) pre-creates a
 *     RUNNING run before its process boots, so a legit reuse is seen as RUNNING and
 *     simply attaches via `USE_EXISTING`. Never self-exit.
 *   - Otherwise, the most-recent run is CLOSED. Self-exit ONLY when it closed with a
 *     typed tombstone reason (`destroyed` | `boot-timeout`) AND the closed run's
 *     `sessionId` matches THIS process's own spawn `sessionId`.
 *
 * #897 replaces the #704 wall-clock TTL with this EXACT identity check — a fuzzy
 * "closed recently?" heuristic becomes "is this MY closed run?". A legit re-recruit
 * spawns a NEW sessionId → never matches → never false-exits, no matter how late;
 * the true orphan carries the SAME sessionId as its closed run → exits precisely,
 * regardless of delay. No TTL, no clock.
 *
 * Pure + dependency-free so it unit-tests without a live Temporal env; `server.ts`
 * supplies the `describe()`-derived inputs + this process's `mySessionId`.
 */
export interface OrphanTombstoneInput {
  /** `describe().status.name` — e.g. `'RUNNING'`, `'COMPLETED'`, `'TERMINATED'`. */
  statusName: string;
  /** `describe().memo?.[MEMO_KEYS.closeReason]` — the typed close reason, if any. */
  closeReason: unknown;
  /** `describe().memo?.[MEMO_KEYS.sessionId]` — the closed run's stamped sessionId, if any. */
  closedSessionId: unknown;
}

/** Close reasons that tombstone a derived id against orphan re-registration. */
const TOMBSTONE_REASONS = new Set(['destroyed', 'boot-timeout']);

/**
 * Returns true iff the booting process should self-exit as a late orphan.
 *
 * @param input         the `describe()`-derived run state for the derived workflow id
 * @param mySessionId   this booting process's own spawn sessionId
 *                      (`AGENT_TEMPO_SESSION_ID`); `undefined` when unset
 */
export function shouldSelfExitAsOrphan(
  input: OrphanTombstoneInput,
  mySessionId: string | undefined,
): boolean {
  // A running run means a legit (re-)creation already exists — attach, don't exit.
  if (input.statusName === 'RUNNING') return false;
  // Only a typed tombstone close-reason qualifies.
  if (typeof input.closeReason !== 'string' || !TOMBSTONE_REASONS.has(input.closeReason)) {
    return false;
  }
  // #897 — EXACT identity: self-exit only when the closed run's sessionId is the
  // one THIS process was spawned with. Missing on either side → can't confirm
  // identity → do NOT self-exit (conservative: a false-exit silently drops a
  // legit session, the worse failure mode). This also makes the guard a strict
  // no-op for sessions closed before #897 (no `sessionId` memo) and for legacy
  // spawns that don't forward `AGENT_TEMPO_SESSION_ID`.
  if (typeof input.closedSessionId !== 'string' || mySessionId === undefined) {
    return false;
  }
  return input.closedSessionId === mySessionId;
}
