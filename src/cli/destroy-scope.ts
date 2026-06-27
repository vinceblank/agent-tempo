/**
 * Pure helpers for `down --destroy` workflow targeting (#907 Problem B).
 *
 * `down --destroy` used to enumerate and terminate workflows across EVERY
 * ensemble, then derive a confirmation list by parsing ensemble names out of
 * session workflow IDs. Both were wrong:
 *
 *   1. SCOPE — destroying every ensemble (plus the GLOBAL maestro) is the
 *      wrong default on a shared cluster. We now scope to a single ensemble by
 *      default; `--all-ensembles` restores the wide behavior behind a louder
 *      confirm.
 *   2. DISPLAY — `agent-session-<ensemble>-<playerId>` cannot be split back
 *      into (ensemble, player) because BOTH segments contain hyphens, so the
 *      old regex mislabeled players as ensembles (e.g. `cll-cll`). Maestro IDs
 *      (`agent-maestro-<ensemble>`, one per ensemble) are unambiguous, so the
 *      display list is derived from those instead.
 *
 * Kept Temporal-free and side-effect-free so the targeting decision is unit
 * testable without a live cluster.
 */

/** Enumerated workflow IDs for the destroy step, by type. Sessions are scoped
 *  at the query level (see {@link sessionDestroyQuery}), so they are not
 *  re-filtered here. */
export interface EnumeratedDestroyTargets {
  maestroIds: string[];
  schedulerIds: string[];
  globalMaestroIds: string[];
}

/** Result of scoping the enumerated targets to an ensemble (or keeping all). */
export interface ScopedDestroyTargets {
  maestroIds: string[];
  schedulerIds: string[];
  globalMaestroIds: string[];
  /** Ensemble names for the confirmation list (display only). */
  displayEnsembles: string[];
}

const SESSION_TYPE = 'agentSessionWorkflow';
const RUNNING = 'ExecutionStatus = "Running"';

/**
 * Build the Temporal visibility query enumerating running session workflows
 * for the destroy step. When `ensemble` is provided (scoped mode), the query
 * is narrowed by the `AgentTempoEnsemble` search attribute — the only reliable
 * way to scope sessions, since their workflow IDs cannot be parsed back into
 * (ensemble, player) unambiguously.
 */
export function sessionDestroyQuery(ensemble?: string): string {
  const base = `WorkflowType = "${SESSION_TYPE}" AND ${RUNNING}`;
  return ensemble ? `${base} AND AgentTempoEnsemble = "${ensemble}"` : base;
}

/** Parse the ensemble name out of an (unambiguous) maestro workflow ID, or
 *  null for the global maestro / a non-maestro ID. Tolerates the legacy
 *  `claude-maestro-` prefix. */
export function ensembleFromMaestroId(id: string): string | null {
  const m = id.match(/^(?:agent|claude)-maestro-(.+)$/);
  if (m && m[1] !== 'global') return m[1];
  return null;
}

/**
 * Scope the enumerated maestro/scheduler/global-maestro IDs to a single
 * ensemble, or pass them through when `allEnsembles` is set.
 *
 * Scoped mode (default):
 *   - maestro / scheduler kept only on an EXACT ID match for the target
 *     ensemble (`agent-maestro-<ens>` / `agent-scheduler-<ens>`; legacy
 *     `claude-` prefixes tolerated). Exact match avoids the hyphen-prefix
 *     ambiguity a `startsWith` would introduce (`cll` vs `cll-x`).
 *   - the GLOBAL maestro is NEVER targeted — it is shared across all ensembles.
 *   - the confirmation list shows exactly the target ensemble.
 *
 * All-ensembles mode (`--all-ensembles`):
 *   - every enumerated ID is kept (including the global maestro).
 *   - the confirmation list is derived from maestro IDs (unambiguous).
 */
export function scopeDestroyTargets(
  input: EnumeratedDestroyTargets,
  opts: { ensemble: string; allEnsembles: boolean },
): ScopedDestroyTargets {
  if (opts.allEnsembles) {
    const displayEnsembles = [
      ...new Set(input.maestroIds.map(ensembleFromMaestroId).filter((e): e is string => e !== null)),
    ].sort();
    return {
      maestroIds: input.maestroIds,
      schedulerIds: input.schedulerIds,
      globalMaestroIds: input.globalMaestroIds,
      displayEnsembles,
    };
  }

  const ens = opts.ensemble;
  const maestroMatch = (id: string) => id === `agent-maestro-${ens}` || id === `claude-maestro-${ens}`;
  const schedulerMatch = (id: string) =>
    id === `agent-scheduler-${ens}` || id === `claude-scheduler-${ens}`;

  return {
    maestroIds: input.maestroIds.filter(maestroMatch),
    schedulerIds: input.schedulerIds.filter(schedulerMatch),
    // Scoped destroy never touches the shared global maestro.
    globalMaestroIds: [],
    displayEnsembles: [ens],
  };
}
