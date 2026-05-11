/**
 * Orphan-session query — shared by `reconcileOnBoot()` in `src/daemon.ts` and
 * the `claude-tempo restore` CLI command (`src/cli/commands.ts`).
 *
 * Design §10.1: a session is an **orphan** when the workflow is `Running` but
 * no adapter process is alive to own its attachment. Two candidate shapes
 * matter:
 *
 *  1. **Active-host sessions** — `ClaudeTempoAttachedHost = local` AND phase
 *     is `attached` / `processing` / `awaiting` / `draining`. The attachment
 *     exists but the adapter process may have died.
 *  2. **Detached-home sessions** — `ClaudeTempoAttachmentState = detached` AND
 *     `ClaudeTempoHostname = local`. No adapter at all; the home host is us.
 *
 * For each candidate we query `attachmentInfo` + `orphanSummary`. If the
 * adapter process is alive (`isAdapterProcessAlive` returns true) we skip —
 * that's the daemon-restarted-under-a-live-adapter case, not an orphan.
 *
 * `isAdapterProcessAlive` is stubbed as `() => false` for v0.25.0-beta.1 per
 * PR-E engineer brief §8 answer 1. No adapter PID file convention exists yet
 * (only the daemon process has `daemon.pid`; Copilot bridges write their own
 * per-session file but Claude Code CLI does not). A conservative always-dead
 * stub is safe: false negatives cost an extra `claimAttachment` attempt,
 * which the caller catches as `AttachmentConflict` and backs off silently
 * (design §10.6). False positives — skipping a session that needs restore —
 * are the worse failure mode.
 */
import type { Client } from '@temporalio/client';
import type { AttachmentInfo, AttachmentPhase, OrphanSummary } from '../types';
import { attachmentInfoQuery, orphanSummaryQuery } from '../workflows/signals';
import { isEnsembleAllowed } from '../config';
import { createTempoClient } from '../client';
import { queryHandleWithTimeout } from '../utils/query-timeout';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

/**
 * Default broad phase set used by daemon reconcile-on-boot and CLI
 * `up --resume`. Both paths have no PID memory after a crash and must
 * treat every live phase as a presumed orphan — the post-query
 * `isAdapterProcessAlive` predicate (and, in practice, the restart outbox
 * raising `AttachmentConflict` against a live adapter) is what protects
 * genuinely-attached sessions from being torn down.
 *
 * Includes `'detached'` so the broad query emits both §10.1 clauses:
 *   - active-host live-phase (`ClaudeTempoAttachedHost = host AND state IN (...)`)
 *   - detached home-host (`state = "detached" AND ClaudeTempoHostname = host`)
 *
 * User-invoked `/restore` narrows this to `['detached']` via the `phases`
 * filter so a healthy live session is never flagged as an orphan candidate.
 */
const DEFAULT_ORPHAN_PHASES: AttachmentPhase[] = [
  'attached',
  'processing',
  'awaiting',
  'draining',
  'detached',
];

/**
 * A session workflow observed to be an orphan: the workflow is alive but no
 * adapter is owning its attachment on this host.
 */
export interface OrphanCandidate {
  workflowId: string;
  info: AttachmentInfo;
  summary: OrphanSummary;
}

/** Filter options for {@link queryOrphanedSessions}. */
export interface OrphanQueryFilter {
  /** Local hostname to match against `ClaudeTempoAttachedHost` / `ClaudeTempoHostname`. */
  hostname: string;
  /** Optional ensemble narrowing pushed into the visibility query. */
  ensemble?: string;
  /**
   * Restrict the visibility query to specific attachment phases. Defaults to
   * the broad live-phase set (`attached | processing | awaiting | draining`)
   * for daemon reconcile-on-boot, which must treat every live phase as
   * presumed-orphan (no PID memory post-crash). User-invoked `/restore`
   * narrows this to `['detached']` so a healthy attached session is never
   * flagged as an orphan candidate.
   *
   * The `detached` home-host clause is always included when `phases`
   * contains `'detached'`; the active-host clause is included when `phases`
   * contains any of the live phases.
   */
  phases?: AttachmentPhase[];
  /**
   * When set, override `isAdapterProcessAlive`. Default stub returns `false`
   * (always assume dead, conservative always-restore). Tests pass a custom
   * predicate; production callers omit.
   */
  isAdapterProcessAlive?: (hostname: string, workflowId: string) => boolean;
}

/** Options shape for {@link buildOrphanQuery}. */
export interface BuildOrphanQueryOpts {
  hostname: string;
  ensemble?: string;
  phases?: AttachmentPhase[];
}

/**
 * Stub per §8 answer 1 — always reports dead. Exported for test wiring even
 * though production callers use the default via {@link queryOrphanedSessions}.
 */
export function isAdapterProcessAliveStub(): boolean {
  return false;
}

/**
 * Escape a value for interpolation into a Temporal visibility query string.
 * Mirrors the helper in `src/client/index.ts`.
 */
function sanitizeQueryValue(value: string): string {
  return value.replace(/["\\\n\r]/g, '');
}

/**
 * Build the visibility-query string matching the §10.1 candidate set for the
 * given hostname. Exposed (rather than inlined) so tests can introspect the
 * query shape without a live Temporal connection.
 *
 * The opts-object form carries a `phases` filter — used by user-invoked
 * `/restore` to narrow the visibility query to `detached` only so live
 * sessions are never flagged as orphan candidates.
 */
export function buildOrphanQuery(opts: BuildOrphanQueryOpts): string {
  const h = sanitizeQueryValue(opts.hostname);
  const ensembleClause = opts.ensemble
    ? ` AND ClaudeTempoEnsemble = "${sanitizeQueryValue(opts.ensemble)}"`
    : '';

  const phases = opts.phases && opts.phases.length > 0
    ? opts.phases
    : DEFAULT_ORPHAN_PHASES;
  const livePhases = phases.filter((p) => p !== 'detached');
  const includeDetached = phases.includes('detached');

  const clauses: string[] = [];
  if (livePhases.length > 0) {
    const liveList = livePhases.map((p) => `"${p}"`).join(',');
    clauses.push(
      `(ClaudeTempoAttachedHost = "${h}" AND ClaudeTempoAttachmentState IN (${liveList}))`,
    );
  }
  if (includeDetached) {
    clauses.push(
      `(ClaudeTempoAttachmentState = "detached" AND ClaudeTempoHostname = "${h}")`,
    );
  }

  // Safety net — both arms empty means caller passed `phases: []`. Fall back
  // to the default broad set rather than emit an invalid `AND ()` clause.
  if (clauses.length === 0) {
    return buildOrphanQuery({ ...opts, phases: DEFAULT_ORPHAN_PHASES });
  }

  return (
    `WorkflowType = "claudeSessionWorkflow" ` +
    `AND ExecutionStatus = "Running" ` +
    `AND (${clauses.join(' OR ')})${ensembleClause}`
  );
}

/**
 * Query Temporal for orphan candidates matching the filter. Runs the
 * visibility query, then fetches `attachmentInfo` + `orphanSummary` per
 * candidate. Skips candidates whose adapter process the liveness predicate
 * reports as alive.
 *
 * Defensive: any per-candidate failure (workflow completed between list +
 * query, query handler throws) is logged and the candidate is skipped — the
 * result array always reflects only the candidates that could be fully
 * resolved at query time.
 *
 * **Deadline (#336/#529):** the visibility iterator is bounded by
 * `deadlineMs`. Default is `VISIBILITY_DEADLINES_MS.orphanQueryBoot`
 * (60s) — suitable for the daemon's one-shot boot reconcile, which can
 * afford a generous budget to enumerate thousands of workflows. The
 * periodic 6h cleanup loop should pass
 * `VISIBILITY_DEADLINES_MS.orphanQueryCleanup` (30s) since it runs
 * frequently enough to amortize partial scans. On timeout, returns the
 * partial result and emits a warn log: the function's existing comment
 * states partial enumeration is acceptable ("next tick will retry"),
 * so the boot path can call `restoreOrphansOnce` again on a subsequent
 * cycle to pick up missed candidates.
 */
export async function queryOrphanedSessions(
  client: Client,
  filter: OrphanQueryFilter,
  log: (...args: unknown[]) => void = () => {},
  deadlineMs: number = VISIBILITY_DEADLINES_MS.orphanQueryBoot,
): Promise<OrphanCandidate[]> {
  const isAlive = filter.isAdapterProcessAlive ?? isAdapterProcessAliveStub;
  const query = buildOrphanQuery({
    hostname: filter.hostname,
    ...(filter.ensemble !== undefined ? { ensemble: filter.ensemble } : {}),
    ...(filter.phases !== undefined ? { phases: filter.phases } : {}),
  });

  // Defense-in-depth: even though the visibility query filters by phase,
  // re-check `info.phase` after fetching the fresh `attachmentInfo`. A
  // session may have transitioned between list + query, and we never want a
  // live `attached`/`processing`/`awaiting` session to be returned to a
  // caller that narrowed to `['detached']`.
  const phaseAllowlist = filter.phases && filter.phases.length > 0
    ? new Set<AttachmentPhase>(filter.phases)
    : null;

  const orphans: OrphanCandidate[] = [];

  try {
    for await (const wf of iterateWithDeadline(
      client.workflow.list({ query }),
      deadlineMs,
      'queryOrphanedSessions',
    )) {
      const handle = client.workflow.getHandle(wf.workflowId);
      try {
        // Issue #433 — bound each per-workflow query so a hung session
        // (workflow `Running` but worker dead) can't block the orphan scan
        // forever. The `try/catch` already treats query failure as "skip
        // this candidate"; `QueryTimeoutError` falls into the same path.
        const info = await queryHandleWithTimeout(handle, attachmentInfoQuery) as AttachmentInfo;

        // Phase allowlist re-check (see above).
        if (phaseAllowlist && info.phase && !phaseAllowlist.has(info.phase)) {
          continue;
        }

        // Live adapter — not an orphan.
        if (info.currentAttachment && isAlive(info.currentAttachment.hostname, wf.workflowId)) {
          continue;
        }

        const summary = await queryHandleWithTimeout(handle, orphanSummaryQuery) as OrphanSummary;
        orphans.push({ workflowId: wf.workflowId, info, summary });
      } catch (err) {
        // Workflow may have completed between list + query, a query handler
        // threw, or the per-query timeout fired (#433 — wedged worker).
        // Skip — not every candidate will be reachable, and partial results
        // are acceptable for reconcile (next tick will retry).
        log(`orphan-query skip ${wf.workflowId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    if (isVisibilityTimeout(err)) {
      // #336/#529 — partial-tolerant: warn-log and return what we have.
      // The caller (reconcile-on-boot / cleanup loop) treats partial
      // results as best-effort; the next sweep picks up any missed
      // candidates.
      log(`queryOrphanedSessions: ${err.message} — returning partial (${orphans.length} orphans)`);
    } else {
      throw err;
    }
  }

  return orphans;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared orphan-recovery loop (#93, #285)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link restoreOrphansOnce}. `policy: 'never'` is NOT included
 * here — callers that want a silent no-op skip the helper entirely. The
 * daemon's `reconcileOnBoot` short-circuits on `restorePolicy === 'never'`
 * before reaching this helper.
 */
export interface RestoreOrphansOpts {
  /** Local hostname — matched against the orphan query filter and used as
   *  the default target when a candidate's `preferredHost` is unset. */
  hostname: string;
  /** Passed through to `TempoClient.restart(...)` as the operator identity
   *  (e.g. `'daemon'`, `'cli'`, or a specific player name). */
  invokerPlayerId: string;
  /** `'auto'` — call `restart` on each eligible candidate.
   *  `'prompt'` — log each candidate; do not call `restart`. */
  policy: 'auto' | 'prompt';
  /** Optional narrowing filter — only consider orphans in this ensemble. */
  ensemble?: string;
  /**
   * Optional phase narrowing — forwarded to {@link queryOrphanedSessions}.
   * Defaults to the broad live-phase set for daemon reconcile-on-boot +
   * CLI `up --resume`. User-invoked `/restore` narrows this to
   * `['detached']` so a healthy attached session is never flagged.
   */
  phases?: AttachmentPhase[];
  /** Orphans whose `detachedSince` exceeds this window are skipped.
   *  Default: 24 hours. Ignored when `policy === 'prompt'`. */
  autoRestoreMaxAgeHours?: number;
  /** Glob allowlist for ensemble names (`isEnsembleAllowed`). Empty /
   *  undefined → allow all. Ignored when `policy === 'prompt'`. */
  autoRestoreEnsembles?: string[];
  /** Injectable clock for tests. Default: `Date.now`. */
  now?: () => number;
  /** Override `createTempoClient` for tests. Default: production factory. */
  tempoClientFactory?: (client: Client) => {
    restart: (
      ensemble: string,
      playerId: string,
      opts: { host: string; invokerPlayerId: string },
    ) => Promise<{ entryId: string; playerId: string }>;
  };
}

/**
 * Structured outcome for a single orphan — discriminated union so callers
 * can dispatch on `outcome.kind` without parsing strings. Use
 * {@link formatRestoreOutcome} to render a human-readable form.
 */
export type RestoreOutcome =
  | { kind: 'queued'; entryId: string }
  | {
      kind: 'skipped';
      reason: 'preferredHost' | 'ageWindow' | 'ensembleAllowlist' | 'attachmentConflict' | 'prompt';
      /** Extra context, e.g. the remote `preferredHost` value. */
      detail?: string;
    }
  | { kind: 'failed'; error: string };

/** Per-orphan outcome produced by {@link restoreOrphansOnce}. */
export interface RestoreOrphanDetail {
  playerId: string;
  ensemble: string;
  outcome: RestoreOutcome;
}

/** Render a {@link RestoreOutcome} for human-readable logs / CLI output. */
export function formatRestoreOutcome(o: RestoreOutcome): string {
  switch (o.kind) {
    case 'queued': return `queued (outbox ${o.entryId})`;
    case 'failed': return `failed: ${o.error}`;
    case 'skipped':
      switch (o.reason) {
        case 'preferredHost': return `skipped: preferredHost=${o.detail ?? '(unknown)'}`;
        case 'ageWindow': return 'skipped: age window';
        case 'ensembleAllowlist': return 'skipped: ensemble allowlist';
        case 'attachmentConflict': return 'skipped: AttachmentConflict';
        case 'prompt': return 'prompt';
      }
  }
}

/** Summary returned by {@link restoreOrphansOnce}. */
export interface RestoreOrphansSummary {
  /** Orphans that successfully enqueued a `restart` outbox entry. */
  reattached: number;
  /** Orphans skipped (cross-host, age window, allowlist, AttachmentConflict,
   *  or `policy: 'prompt'`). */
  skipped: number;
  /** Orphans whose `restart` call threw a non-conflict error. */
  failed: number;
  /** Per-orphan details in visit order. Useful for UI rendering. */
  details: RestoreOrphanDetail[];
}

/**
 * Run one pass of orphan recovery. Shared by:
 *   - daemon's `reconcileOnBoot` (passes `invokerPlayerId: 'daemon'`)
 *   - CLI `up` option 2 and `conduct --resume` (passes `invokerPlayerId: 'cli'`)
 *
 * Flow (matches the former body of `reconcileOnBoot`):
 *   1. Query orphan candidates on this host.
 *   2. Filter out candidates whose `preferredHost` points elsewhere
 *      (PR-F §16 — remote host's daemon is the authoritative restorer).
 *   3. If `policy === 'prompt'`: log each surviving candidate and return.
 *   4. If `policy === 'auto'`: for each surviving candidate, apply the
 *      age window + ensemble allowlist filters, then call
 *      `TempoClient.restart` to enqueue the restart outbox entry.
 *
 * Never throws — all per-candidate failures are captured in
 * {@link RestoreOrphansSummary.details}. The caller picks whether to log,
 * surface to UI, or aggregate across multiple hosts.
 *
 * `AttachmentConflict` is counted as `skipped` (not `failed`) because the
 * only cause is another operator or daemon having restored concurrently —
 * the user's intent was satisfied, just not by us.
 */
export async function restoreOrphansOnce(
  client: Client,
  opts: RestoreOrphansOpts,
  log: (...args: unknown[]) => void = () => {},
): Promise<RestoreOrphansSummary> {
  const summary: RestoreOrphansSummary = {
    reattached: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };
  const now = opts.now ?? Date.now;

  let orphans: OrphanCandidate[];
  try {
    orphans = await queryOrphanedSessions(
      client,
      {
        hostname: opts.hostname,
        ...(opts.ensemble ? { ensemble: opts.ensemble } : {}),
        ...(opts.phases ? { phases: opts.phases } : {}),
      },
      log,
    );
  } catch (err) {
    log('restoreOrphansOnce: orphan query failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return summary;
  }

  if (orphans.length === 0) {
    return summary;
  }

  // Shared emitter so every outcome is recorded + logged identically.
  const record = (o: OrphanCandidate, outcome: RestoreOutcome): void => {
    if (outcome.kind === 'queued') summary.reattached++;
    else if (outcome.kind === 'failed') summary.failed++;
    else summary.skipped++;
    summary.details.push({
      playerId: o.summary.playerId,
      ensemble: o.summary.ensemble,
      outcome,
    });
    log(`restoreOrphansOnce: ${o.workflowId} — ${formatRestoreOutcome(outcome)}`);
  };

  // Filter: (1) ensemble narrowing from the caller, (2) PR-F cross-host
  // filter (design §16 — remote orphans are the remote daemon's problem).
  const candidates: OrphanCandidate[] = [];
  for (const o of orphans) {
    if (opts.ensemble && o.summary.ensemble !== opts.ensemble) continue;
    if (o.summary.preferredHost && o.summary.preferredHost !== opts.hostname) {
      record(o, { kind: 'skipped', reason: 'preferredHost', detail: o.summary.preferredHost });
      continue;
    }
    candidates.push(o);
  }

  if (candidates.length === 0) {
    return summary;
  }

  if (opts.policy === 'prompt') {
    for (const o of candidates) record(o, { kind: 'skipped', reason: 'prompt' });
    return summary;
  }

  // policy === 'auto'
  const ageWindowMs = (opts.autoRestoreMaxAgeHours ?? 24) * 60 * 60 * 1000;
  const allowlist = opts.autoRestoreEnsembles ?? [];
  const nowMs = now();
  const tempo = (opts.tempoClientFactory ?? createTempoClient)(client);

  for (const o of candidates) {
    // Age filter — skip orphans older than the restore window.
    if (o.summary.detachedSince) {
      const detachedAt = Date.parse(o.summary.detachedSince);
      if (Number.isFinite(detachedAt) && nowMs - detachedAt > ageWindowMs) {
        record(o, { kind: 'skipped', reason: 'ageWindow' });
        continue;
      }
    }

    // Ensemble allowlist (empty → allow all).
    if (!isEnsembleAllowed(o.summary.ensemble, allowlist)) {
      record(o, { kind: 'skipped', reason: 'ensembleAllowlist' });
      continue;
    }

    const targetHost = o.summary.preferredHost ?? opts.hostname;
    try {
      const result = await tempo.restart(o.summary.ensemble, o.summary.playerId, {
        host: targetHost,
        invokerPlayerId: opts.invokerPlayerId,
      });
      record(o, { kind: 'queued', entryId: result.entryId });
    } catch (err) {
      // §10.6: `AttachmentConflict` is a silent backoff — another restorer
      // won the race concurrently.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('AttachmentConflict')) {
        record(o, { kind: 'skipped', reason: 'attachmentConflict' });
      } else {
        record(o, { kind: 'failed', error: msg });
      }
    }
  }

  return summary;
}
