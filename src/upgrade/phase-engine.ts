/**
 * `upgrade-to-2` phase engine (issue #785) — the I/O half of the cutover.
 *
 * Orchestrates the six-phase migration protocol A2
 * (`docs/design/v2-scoping.md` §A.3):
 *
 *   preflight → pause → drain → snapshot → destroy → done
 *
 * **Load-bearing invariants:**
 *   - **SNAPSHOT strictly precedes DESTROY.** {@link destroyAndFinish} only
 *     ever runs against a persisted {@link UpgradeSnapshot} handle (it takes one
 *     as a REQUIRED argument), so a crash anywhere leaves either everything
 *     intact (pre-snapshot) or a durable snapshot + partially-destroyed
 *     workflows (post-snapshot) — never destruction without capture.
 *   - **Phase-stamped resume.** The snapshot file's `phase` field drives
 *     re-runs: `phase >= snapshot` ⇒ skip re-capture, continue destroy.
 *   - **Loud + resumable.** Expected control outcomes (version refusal, operator
 *     abort, drain stop) return a discriminated {@link UpgradeResult}; the CLI
 *     renders them loudly. Only genuinely unexpected errors throw.
 *
 * Unlike `snapshot-v1.ts`, this module DOES touch Temporal — it is dynamic-
 * imported by the crash-proof CLI verb (`upgrade-to-2-command.ts`) only once the
 * SDK is known good.
 */
import type { Client } from '@temporalio/client';
import {
  GLOBAL_MAESTRO_WORKFLOW_ID,
  maestroWorkflowId,
  schedulerWorkflowId,
  conductorWorkflowId,
} from '../config';
import { scanEnsembleSessions, type EnsembleSessionInfo } from '../activities/resolve';
import { pauseMaestroAndScheduler, signalAllSessions } from '../utils/ensemble-ops';
import { buildLineupFromCluster } from '../ensemble/saver';
import {
  setPausedSignal,
  outboxQuery,
  getMetadataQuery,
  playerStateQuery,
  playerStateKeysQuery,
  pendingMessagesQuery,
  destroyUpdate,
} from '../workflows/signals';
import { getSchedulesQuery } from '../workflows/scheduler-signals';
import {
  hostProfilesWithExistenceQuery,
  getEnsembleDescriptionQuery,
  coatCheckListQuery,
} from '../workflows/maestro-signals';
import { getEnsembleName } from '../utils/search-attributes';
import { queryHandleWithTimeout } from '../utils/query-timeout';
import type {
  Message,
  ScheduleEntry,
  SessionMetadata,
  OutboxEntry,
  HostProfile,
  PlayerStateEntry,
} from '../types';
import type { EnsembleLineup } from '../ensemble/schema';
import {
  UPGRADE_SNAPSHOT_VERSION,
  readSnapshot,
  writeSnapshot,
  snapshotPath,
  stampPhase,
  phaseRank,
  type UpgradeSnapshot,
  type SnapshotEnsemble,
  type SnapshotPlayer,
  type SnapshotSchedule,
  type SnapshotMessage,
  type SnapshotStraggler,
  type UpgradePhase,
} from './snapshot-v1';

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers (vitest-testable; no Temporal)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Default minimum daemon version every connected host must meet to cut over.
 * `1.7.0` is the stable that ships the `upgrade-to-2` verb (the version ruling
 * corrected the stable line from 1.8.0 → 1.7.0; both `!` commits were non-major
 * from the 1.6.2 baseline). A daemon below this lacks the cutover-compatible
 * code, so preflight refuses it.
 */
export const DEFAULT_VERSION_FLOOR = '1.7.0';

/** Default bounded wait for the DRAIN phase. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/** A host that failed the version preflight. */
export interface VersionRefusal {
  hostname: string;
  /** The advertised version, or `'unknown'` when absent/unparseable. */
  version: string;
  reason: string;
}

/** Parse a leading `major.minor` from a version string; `null` if unparseable. */
export function parseMajorMinor(version: string): { major: number; minor: number } | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Does `version` meet `floor` (by `major.minor`)? Lenient on prereleases —
 * `1.7.0-beta.9` meets a `1.7.0` floor because it rides the 1.7 line, which
 * carries the cutover-compatible code. Unknown / unparseable versions FAIL
 * (a daemon we cannot version-check is refused loudly, never assumed safe).
 */
export function meetsVersionFloor(version: string | undefined, floor: string): boolean {
  if (!version) return false;
  const v = parseMajorMinor(version);
  const f = parseMajorMinor(floor);
  if (!v || !f) return false;
  if (v.major !== f.major) return v.major > f.major;
  return v.minor >= f.minor;
}

/**
 * Pure multi-host version preflight: returns the connected hosts whose daemon
 * is below the floor. An empty result means every host is cutover-ready.
 */
export function preflightVersions(
  profiles: Record<string, { version?: string }>,
  floor: string = DEFAULT_VERSION_FLOOR,
): VersionRefusal[] {
  const refusals: VersionRefusal[] = [];
  for (const [hostname, profile] of Object.entries(profiles)) {
    if (!meetsVersionFloor(profile.version, floor)) {
      const v = profile.version ?? 'unknown';
      refusals.push({
        hostname,
        version: v,
        reason: `daemon at ${v} is below the required ${floor} — upgrade every daemon before cutover`,
      });
    }
  }
  return refusals;
}

// ─────────────────────────────────────────────────────────────────────────
// Engine types
// ─────────────────────────────────────────────────────────────────────────

export interface UpgradeOptions {
  /** Skip the interactive confirm. */
  yes?: boolean;
  /** Print the would-be snapshot + destroy list and exit BEFORE pausing. */
  dryRun?: boolean;
  /** Proceed past a non-empty drain, recording stragglers in the snapshot. */
  forceDrain?: boolean;
  /** Bounded DRAIN wait (default {@link DEFAULT_DRAIN_TIMEOUT_MS}). */
  drainTimeoutMs?: number;
  /** DRAIN poll interval (default 1s). */
  drainPollIntervalMs?: number;
  /** Minimum daemon version (default {@link DEFAULT_VERSION_FLOOR}). */
  versionFloor?: string;
  /** Per-query timeout bound (default 5s). */
  queryTimeoutMs?: number;
}

export interface UpgradeDeps {
  client: Client;
  /** `AGENT_TEMPO_HOME` — where the snapshot file lives. */
  home: string;
  /** The 1.x CLI version stamped into the snapshot. */
  cliVersion: string;
  log: (...args: unknown[]) => void;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
  /** Injectable sleep (default real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Interactive confirm, invoked in PREFLIGHT unless `opts.yes`. Return `false`
   * to abort. Omitted ⇒ a non-`--yes` run aborts (the CLI always supplies one).
   */
  confirm?: (preview: UpgradePreview) => Promise<boolean>;
}

/** Lightweight PREFLIGHT preview — rendered for `--dry-run` and the confirm. */
export interface UpgradePreview {
  ensembles: Array<{
    name: string;
    players: Array<{ playerId: string; isConductor: boolean; agentType: string }>;
    scheduleCount: number;
  }>;
  /** Workflow ids that DESTROY will tear down (sessions + scheduler + maestro). */
  destroyList: string[];
}

export type UpgradeStatus =
  | 'done'
  | 'dry-run'
  | 'aborted' // operator declined confirm
  | 'refused' // version preflight failed
  | 'drain-stopped'; // drain timed out without --force-drain

export interface UpgradeResult {
  status: UpgradeStatus;
  phase: UpgradePhase;
  snapshot?: UpgradeSnapshot;
  refusals?: VersionRefusal[];
  stragglers?: SnapshotStraggler[];
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the full cutover. Idempotent + resumable via the snapshot file's phase
 * stamp. See the module header for the invariants.
 */
export async function runUpgradeToV2(
  deps: UpgradeDeps,
  opts: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const log = deps.log;
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainPollIntervalMs = opts.drainPollIntervalMs ?? 1_000;
  const versionFloor = opts.versionFloor ?? DEFAULT_VERSION_FLOOR;
  const queryTimeoutMs = opts.queryTimeoutMs ?? 5_000;

  // ── RESUME ───────────────────────────────────────────────────────────
  // `readSnapshot` throws loudly on a corrupt file — we never silently ignore
  // a half-written continuity record.
  const existing = readSnapshot(deps.home);
  if (existing?.phase === 'done') {
    log('[upgrade] snapshot already stamped `done` — cutover already complete.');
    printNextSteps(log);
    return { status: 'done', phase: 'done', snapshot: existing };
  }
  if (existing && phaseRank(existing.phase) >= phaseRank('snapshot')) {
    // Resume: skip re-capture, continue destroy. The skip is deliberate and
    // uniform across phase=snapshot AND phase=destroy resumes:
    //   - On a phase=destroy resume the cluster is already partially torn down,
    //     so RE-capturing would risk snapshotting a half-destroyed cluster —
    //     exactly why skipping is the correct (safe) behavior.
    //   - On a phase=snapshot resume the cluster is still intact, so we *could*
    //     re-capture fresher state slots — but we skip uniformly for
    //     simplicity/safety rather than branch on the phase.
    // DISPATCH state cannot have moved (pause is durable + re-asserted below);
    // `stateSlots` stays best-effort point-in-time from the ORIGINAL capture —
    // a live player's `save_state` (pause-exempt) is not re-read on resume.
    log(`[upgrade] resuming from a durable snapshot (phase=${existing.phase}).`);
    log('[upgrade] skipping re-capture (dispatch frozen; stateSlots best-effort from original capture) — continuing DESTROY.');
    await reassertPause(deps, existing.ensembles.map((e) => e.name));
    return await destroyAndFinish(deps, existing, { queryTimeoutMs });
  }

  // ── PREFLIGHT ────────────────────────────────────────────────────────
  log('[upgrade] PREFLIGHT — enumerating ensembles + checking daemon versions.');
  const ensembleNames = await enumerateEnsembleNames(deps);
  if (ensembleNames.length === 0) {
    log('[upgrade] no running ensembles found — nothing to cut over.');
  }

  const profiles = await fetchHostProfiles(deps, queryTimeoutMs);
  const refusals = preflightVersions(profiles, versionFloor);
  if (refusals.length > 0) {
    log('[upgrade] REFUSED — connected daemon(s) below the version floor:');
    for (const r of refusals) log(`    ✗ ${r.hostname}: ${r.reason}`);
    log('[upgrade] Upgrade every daemon to 1.7.x first, then re-run. (No state was touched.)');
    return { status: 'refused', phase: 'preflight', refusals };
  }
  if (Object.keys(profiles).length === 0) {
    log('[upgrade] note: global maestro unreachable — version preflight assumed single-host. Verify remote daemons manually if this is a cluster.');
  }

  const preview = await buildPreview(deps, ensembleNames, queryTimeoutMs);

  if (opts.dryRun) {
    log('[upgrade] DRY-RUN — would snapshot + destroy the following (no changes made):');
    renderPreview(preview, log);
    return { status: 'dry-run', phase: 'preflight' };
  }

  if (!opts.yes) {
    renderPreview(preview, log);
    const proceed = deps.confirm ? await deps.confirm(preview) : false;
    if (!proceed) {
      log('[upgrade] aborted by operator — no changes made.');
      return { status: 'aborted', phase: 'preflight' };
    }
  }

  // ── PAUSE ────────────────────────────────────────────────────────────
  // Resolution (B) (see PR discussion): pause the work SOURCES (maestro +
  // scheduler) so no new scheduled / relayed cues enter. Sessions are left
  // live here so their outboxes can actually DRAIN — a session-level setPaused
  // HALTS dispatch (session.ts canDispatch gates on `!paused`), so we freeze
  // sessions only AFTER drain, right before snapshot.
  log('[upgrade] PAUSE — braking work sources (maestro + scheduler) across all ensembles.');
  for (const name of ensembleNames) {
    await pauseMaestroAndScheduler(deps.client, name);
  }

  // ── DRAIN ────────────────────────────────────────────────────────────
  log(`[upgrade] DRAIN — waiting for session outboxes to empty (≤ ${drainTimeoutMs}ms).`);
  const drain = await drainAllEnsembles(deps, ensembleNames, {
    drainTimeoutMs,
    drainPollIntervalMs,
    queryTimeoutMs,
  });
  if (drain.stragglers.length > 0 && !opts.forceDrain) {
    log(`[upgrade] DRAIN STOPPED — ${drain.stragglers.length} outbox entr${drain.stragglers.length === 1 ? 'y' : 'ies'} still pending after ${drainTimeoutMs}ms:`);
    for (const s of drain.stragglers) {
      log(`    • ${s.playerId}: ${s.entryType} ${s.entryId} (${s.status})`);
    }
    log('[upgrade] Re-run once they clear, or pass --force-drain to proceed (stragglers recorded in the snapshot, NOT delivered). No state was destroyed.');
    return { status: 'drain-stopped', phase: 'drain', stragglers: drain.stragglers };
  }

  // Now freeze every session's DISPATCH — a correctness win, not just
  // sequencing: with dispatch frozen, no outbox entry moves during SNAPSHOT, so
  // the captured per-player dispatch state is point-in-time-consistent.
  //
  // Caveat (B4c finding): this is a DISPATCH freeze, NOT a process freeze.
  // setPaused stops outbox dispatch but not the player's LLM/process — a paused
  // player can still call `save_state` (a pause-exempt update) and still queue
  // `submitOutbox` entries (not dispatched). So a live player CAN still mutate
  // its own `stateSlots` mid-capture. This is acceptable + inherent: capture
  // strictly precedes destroy (the #785 invariant), so the process is
  // necessarily alive during capture; the dispatch freeze is the best available
  // and `stateSlots` is therefore best-effort point-in-time (see captureSnapshot).
  log('[upgrade] freezing all session dispatch (message brake) before snapshot.');
  for (const name of ensembleNames) {
    await signalAllSessions(deps.client, name, setPausedSignal.name, true);
  }

  // ── SNAPSHOT (strictly precedes destroy) ──────────────────────────────
  log('[upgrade] SNAPSHOT — capturing continuity state.');
  const snapshot = await captureSnapshot(deps, ensembleNames, {
    queryTimeoutMs,
    stragglersByEnsemble: drain.stragglersByEnsemble,
  });
  writeSnapshot(deps.home, snapshot);
  log(`[upgrade] snapshot written → ${snapshotPath(deps.home)} (${snapshot.ensembles.length} ensemble(s)).`);

  // ── DESTROY + DONE ────────────────────────────────────────────────────
  return await destroyAndFinish(deps, snapshot, { queryTimeoutMs });
}

/**
 * DESTROY + DONE. Takes a PERSISTED snapshot as a REQUIRED argument — this
 * signature is the structural guarantee that destruction never precedes
 * capture. Idempotent: every per-workflow teardown tolerates already-gone.
 */
export async function destroyAndFinish(
  deps: UpgradeDeps,
  snapshot: UpgradeSnapshot,
  o: { queryTimeoutMs: number },
): Promise<UpgradeResult> {
  void o;
  const log = deps.log;

  // Stamp `destroy` BEFORE tearing anything down so a crash mid-destroy
  // resumes straight back into destroy (idempotent) rather than re-capturing.
  let snap = stampPhase(snapshot, 'destroy');
  writeSnapshot(deps.home, snap);

  log('[upgrade] DESTROY — tearing down all workflows (idempotent; snapshot already safe on disk).');
  for (const ens of snap.ensembles) {
    await destroyEnsemble(deps, ens.name);
  }

  snap = stampPhase(snap, 'done');
  writeSnapshot(deps.home, snap);
  log('[upgrade] DONE — every workflow torn down; snapshot stamped `done`.');
  printNextSteps(log);
  return { status: 'done', phase: 'done', snapshot: snap };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Authoritative cluster-wide ensemble enumeration: scan visibility for every
 * Running session workflow and collect the distinct `AgentTempoEnsemble`. This
 * matches what the 2.0 boot guard will scan, so anything captured + destroyed
 * here is exactly the set that would otherwise block a 2.0 daemon from booting.
 */
export async function enumerateEnsembleNames(deps: UpgradeDeps): Promise<string[]> {
  const names = new Set<string>();
  try {
    const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';
    for await (const wf of deps.client.workflow.list({ query })) {
      const name = getEnsembleName(wf);
      if (name) names.add(name);
    }
  } catch (err) {
    deps.log(`[upgrade] ensemble enumeration error: ${errMsg(err)}`);
  }
  return [...names];
}

async function fetchHostProfiles(
  deps: UpgradeDeps,
  queryTimeoutMs: number,
): Promise<Record<string, HostProfile>> {
  try {
    // 2.0 (#788): legacy `hostProfilesQuery` removed — use the combined
    // existence+profiles query and take the profiles map.
    const result = (await queryHandleWithTimeout(
      deps.client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID),
      hostProfilesWithExistenceQuery,
      { timeoutMs: queryTimeoutMs },
    )) as { exists: boolean; profiles: Record<string, HostProfile> };
    return result.profiles;
  } catch {
    return {};
  }
}

async function buildPreview(
  deps: UpgradeDeps,
  ensembleNames: string[],
  queryTimeoutMs: number,
): Promise<UpgradePreview> {
  const ensembles: UpgradePreview['ensembles'] = [];
  const destroyList: string[] = [];
  for (const name of ensembleNames) {
    const sessions = realPlayers(await scanEnsembleSessions(deps.client, name));
    const schedules = await captureSchedules(deps, name, queryTimeoutMs);
    ensembles.push({
      name,
      players: sessions.map((s) => ({
        playerId: s.playerId,
        isConductor: s.isConductor,
        agentType: s.agentType ?? 'claude',
      })),
      scheduleCount: schedules.length,
    });
    for (const s of sessions) destroyList.push(s.workflowId);
    destroyList.push(schedulerWorkflowId(name), maestroWorkflowId(name));
  }
  return { ensembles, destroyList };
}

function renderPreview(preview: UpgradePreview, log: (...a: unknown[]) => void): void {
  if (preview.ensembles.length === 0) {
    log('    (no ensembles)');
    return;
  }
  for (const ens of preview.ensembles) {
    log(`    ▸ ensemble "${ens.name}" — ${ens.players.length} player(s), ${ens.scheduleCount} schedule(s)`);
    for (const p of ens.players) {
      log(`        - ${p.playerId}${p.isConductor ? ' (conductor)' : ''} [${p.agentType}]`);
    }
  }
  log(`    DESTROY list: ${preview.destroyList.length} workflow(s).`);
}

interface PendingStraggler {
  ensemble: string;
  straggler: SnapshotStraggler;
}

interface DrainOutcome {
  stragglers: SnapshotStraggler[];
  stragglersByEnsemble: Map<string, SnapshotStraggler[]>;
}

async function drainAllEnsembles(
  deps: UpgradeDeps,
  ensembleNames: string[],
  o: { drainTimeoutMs: number; drainPollIntervalMs: number; queryTimeoutMs: number },
): Promise<DrainOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + o.drainTimeoutMs;

  // Snapshot the session set once — pause has stopped new sessions appearing.
  const sessionsByEnsemble = new Map<string, EnsembleSessionInfo[]>();
  for (const name of ensembleNames) {
    sessionsByEnsemble.set(name, realPlayers(await scanEnsembleSessions(deps.client, name)));
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pending = await collectPendingOutbox(deps, sessionsByEnsemble, o.queryTimeoutMs);
    if (pending.length === 0) {
      return { stragglers: [], stragglersByEnsemble: new Map() };
    }
    if (now() >= deadline) {
      const byEns = new Map<string, SnapshotStraggler[]>();
      for (const p of pending) {
        const arr = byEns.get(p.ensemble) ?? [];
        arr.push(p.straggler);
        byEns.set(p.ensemble, arr);
      }
      return { stragglers: pending.map((p) => p.straggler), stragglersByEnsemble: byEns };
    }
    await sleep(o.drainPollIntervalMs);
  }
}

async function collectPendingOutbox(
  deps: UpgradeDeps,
  sessionsByEnsemble: Map<string, EnsembleSessionInfo[]>,
  queryTimeoutMs: number,
): Promise<PendingStraggler[]> {
  const out: PendingStraggler[] = [];
  for (const [ensemble, sessions] of sessionsByEnsemble) {
    for (const s of sessions) {
      let entries: OutboxEntry[];
      try {
        entries = (await queryHandleWithTimeout(
          deps.client.workflow.getHandle(s.workflowId),
          outboxQuery,
          { timeoutMs: queryTimeoutMs },
        )) as OutboxEntry[];
      } catch {
        // Wedged / gone worker — treat as drained (it can't deliver anyway).
        continue;
      }
      for (const e of entries) {
        if (e.status === 'pending' || e.status === 'processing') {
          out.push({
            ensemble,
            straggler: {
              playerId: s.playerId,
              entryId: e.id,
              entryType: e.type,
              status: e.status,
              createdAt: e.createdAt,
            },
          });
        }
      }
    }
  }
  return out;
}

/**
 * Capture the full continuity snapshot. Queries each real player's metadata +
 * state slots + undelivered cues, each ensemble's schedules + lineup +
 * description, and records the coat-check drop count.
 *
 * Runs AFTER dispatch is frozen, so undelivered-cue + outbox state is
 * point-in-time-consistent. `stateSlots`, however, is **best-effort
 * point-in-time**: the dispatch freeze does not stop the player's process, and
 * `save_state` is a pause-exempt update — a live player could mutate a slot
 * between the freeze and this read. This is inherent (capture must precede
 * destroy, so the process is alive during capture) and accepted by design.
 */
export async function captureSnapshot(
  deps: UpgradeDeps,
  ensembleNames: string[],
  o: { queryTimeoutMs: number; stragglersByEnsemble?: Map<string, SnapshotStraggler[]> },
): Promise<UpgradeSnapshot> {
  const now = deps.now ?? Date.now;
  const ensembles: SnapshotEnsemble[] = [];

  for (const name of ensembleNames) {
    const sessions = realPlayers(await scanEnsembleSessions(deps.client, name));
    const players: SnapshotPlayer[] = [];
    for (const s of sessions) {
      const handle = deps.client.workflow.getHandle(s.workflowId);
      const metadata = await safeQuery<SessionMetadata>(handle, getMetadataQuery, o.queryTimeoutMs);
      const stateSlots = await captureStateSlots(deps, s.workflowId, o.queryTimeoutMs);
      const undeliveredMessages = await captureUndelivered(deps, s.workflowId, o.queryTimeoutMs);
      players.push({
        playerId: s.playerId,
        ...(opt(metadata?.playerType ?? s.playerType) && {
          playerType: metadata?.playerType ?? s.playerType,
        }),
        agentType: metadata?.agentType ?? s.agentType ?? 'claude',
        part: s.part,
        workDir: metadata?.workDir ?? s.workDir,
        hostname: metadata?.hostname ?? s.hostname,
        ...(opt(metadata?.gitRoot ?? s.gitRoot) && { gitRoot: metadata?.gitRoot ?? s.gitRoot }),
        ...(opt(metadata?.sessionId) && { sessionId: metadata?.sessionId }),
        // Non-default recruit model (#785 freeze-fix) — read from the same
        // metadata that carries sessionId/playerType; absent for default-model
        // players. Closes the ad-hoc-recruit model-continuity gap.
        ...(opt(metadata?.model) && { model: metadata?.model }),
        isConductor: s.isConductor,
        stateSlots,
        undeliveredMessages,
      });
    }

    const schedules = await captureSchedules(deps, name, o.queryTimeoutMs);
    const description = await safeQuery<string>(
      deps.client.workflow.getHandle(maestroWorkflowId(name)),
      getEnsembleDescriptionQuery,
      o.queryTimeoutMs,
    );
    let lineup: EnsembleLineup | undefined;
    try {
      lineup = await buildLineupFromCluster(deps.client, name);
    } catch {
      lineup = undefined;
    }
    const droppedCoatCheckCount = await captureDroppedCoatCheckCount(deps, name, o.queryTimeoutMs);
    const stragglers = o.stragglersByEnsemble?.get(name) ?? [];

    ensembles.push({
      name,
      ...(description ? { description } : {}),
      ...(lineup ? { lineup } : {}),
      schedules,
      players,
      ...(droppedCoatCheckCount > 0 ? { droppedCoatCheckCount } : {}),
      ...(stragglers.length > 0 ? { forceDrainedStragglers: stragglers } : {}),
    });
  }

  return {
    version: UPGRADE_SNAPSHOT_VERSION,
    createdAt: new Date(now()).toISOString(),
    cliVersion: deps.cliVersion,
    phase: 'snapshot',
    ensembles,
  };
}

async function captureStateSlots(
  deps: UpgradeDeps,
  workflowId: string,
  queryTimeoutMs: number,
): Promise<Record<string, string>> {
  const slots: Record<string, string> = {};
  const handle = deps.client.workflow.getHandle(workflowId);
  let keys: string[];
  try {
    keys = (await queryHandleWithTimeout(handle, playerStateKeysQuery, {
      timeoutMs: queryTimeoutMs,
    })) as string[];
  } catch {
    return slots;
  }
  for (const key of keys) {
    try {
      const entry = (await queryHandleWithTimeout(handle, playerStateQuery, {
        timeoutMs: queryTimeoutMs,
        args: [{ key }],
      })) as PlayerStateEntry | null;
      if (entry) slots[key] = entry.content;
    } catch {
      // Skip an unreadable slot — partial state beats no snapshot.
    }
  }
  return slots;
}

async function captureUndelivered(
  deps: UpgradeDeps,
  workflowId: string,
  queryTimeoutMs: number,
): Promise<SnapshotMessage[]> {
  let msgs: Message[];
  try {
    msgs = (await queryHandleWithTimeout(
      deps.client.workflow.getHandle(workflowId),
      pendingMessagesQuery,
      { timeoutMs: queryTimeoutMs },
    )) as Message[];
  } catch {
    return [];
  }
  return msgs.map((m) => ({
    id: m.id,
    from: m.from,
    text: m.text,
    timestamp: m.timestamp,
    ...(m.isMaestro !== undefined ? { isMaestro: m.isMaestro } : {}),
    ...(m.attachmentTicket ? { attachmentTicket: m.attachmentTicket } : {}),
  }));
}

async function captureSchedules(
  deps: UpgradeDeps,
  ensemble: string,
  queryTimeoutMs: number,
): Promise<SnapshotSchedule[]> {
  let entries: ScheduleEntry[];
  try {
    entries = (await queryHandleWithTimeout(
      deps.client.workflow.getHandle(schedulerWorkflowId(ensemble)),
      getSchedulesQuery,
      { timeoutMs: queryTimeoutMs },
    )) as ScheduleEntry[];
  } catch {
    return [];
  }
  return entries.map((e) => ({
    name: e.name,
    message: e.message,
    target: e.target,
    createdBy: e.createdBy,
    type: e.type,
    nextFireAt: e.nextFireAt,
    ...(e.interval !== undefined ? { interval: e.interval } : {}),
    ...(e.cronExpression ? { cronExpression: e.cronExpression } : {}),
    ...(e.timezone ? { timezone: e.timezone } : {}),
    ...(e.until ? { until: e.until } : {}),
    ...(e.remainingCount !== undefined ? { remainingCount: e.remainingCount } : {}),
  }));
}

async function captureDroppedCoatCheckCount(
  deps: UpgradeDeps,
  ensemble: string,
  queryTimeoutMs: number,
): Promise<number> {
  try {
    const headers = (await queryHandleWithTimeout(
      deps.client.workflow.getHandle(maestroWorkflowId(ensemble)),
      coatCheckListQuery,
      { timeoutMs: queryTimeoutMs, args: [] },
    )) as unknown[];
    return Array.isArray(headers) ? headers.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Tear down a single ensemble, mirroring the established ensemble-destroy
 * ordering (`src/tools/destroy.ts`): peers in parallel → scheduler + maestro
 * terminate → conductor last (so it observes peer teardown). Every step is
 * best-effort + idempotent; an already-gone workflow is success.
 */
export async function destroyEnsemble(deps: UpgradeDeps, ensemble: string): Promise<void> {
  const reason = 'upgrade-to-2 cutover';
  const sessions = await scanEnsembleSessions(deps.client, ensemble);
  const conductorWfId = conductorWorkflowId(ensemble);
  const peers = sessions.filter((s) => s.workflowId !== conductorWfId);
  const conductorPresent = sessions.some((s) => s.workflowId === conductorWfId);

  await Promise.allSettled(
    peers.map((s) => destroySessionWithFallback(deps, s.workflowId, s.playerId, reason)),
  );

  await Promise.allSettled([
    deps.client.workflow.getHandle(schedulerWorkflowId(ensemble)).terminate(reason).catch(() => {}),
    deps.client.workflow.getHandle(maestroWorkflowId(ensemble)).terminate(reason).catch(() => {}),
  ]);

  if (conductorPresent) {
    await destroySessionWithFallback(deps, conductorWfId, 'conductor', reason);
  }
}

/**
 * Best-effort destroyUpdate with a 15-second client-side deadline and an
 * immediate terminate() fallback.
 *
 * `executeUpdate(destroyUpdate)` uses long-poll internally: the
 * `PollWorkflowExecutionUpdate` RPC has a 60-second server-side timeout.
 * On a heavily loaded CI runner, if the workflow task isn't dispatched
 * within that window, the client re-polls and the call can hang for 60-90s.
 * Racing against a 15s timer gives the graceful path enough headroom for the
 * hardTerminateAttachment activity (5s scheduleToCloseTimeout) while bounding
 * the worst case to 15s per session. The detached executeUpdate promise is
 * abandoned; the workflow is already Terminated so its eventual settlement
 * is harmless.
 */
async function destroySessionWithFallback(
  deps: UpgradeDeps,
  workflowId: string,
  playerId: string,
  reason: string,
  timeoutMs = 15_000,
): Promise<void> {
  const handle = deps.client.workflow.getHandle(workflowId);
  let timedOut = false;
  await Promise.race([
    handle.executeUpdate(destroyUpdate, { args: [{ reason, terminatedBy: 'upgrade-to-2' }] }),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(new Error(`destroyUpdate timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    ),
  ]).catch(async (err) => {
    deps.log(
      timedOut
        ? `[upgrade] destroy ${playerId} timed out — terminating directly: ${errMsg(err)}`
        : `[upgrade] destroy ${playerId} failed (continuing): ${errMsg(err)}`,
    );
    await handle.terminate(reason).catch(() => {});
  });
}

async function reassertPause(deps: UpgradeDeps, ensembleNames: string[]): Promise<void> {
  for (const name of ensembleNames) {
    await pauseMaestroAndScheduler(deps.client, name).catch(() => {});
    await signalAllSessions(deps.client, name, setPausedSignal.name, true).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drop maestro dashboard sessions from a session list — they are the (now
 * retired) TUI's own attachment, never real players to capture or recruit.
 */
function realPlayers(sessions: EnsembleSessionInfo[]): EnsembleSessionInfo[] {
  return sessions.filter(
    (s) => s.playerType !== 'maestro' && !s.workflowId.endsWith('-maestro'),
  );
}

async function safeQuery<T>(
  handle: ReturnType<Client['workflow']['getHandle']>,
  queryDef: Parameters<typeof queryHandleWithTimeout>[1],
  timeoutMs: number,
): Promise<T | undefined> {
  try {
    return (await queryHandleWithTimeout(handle, queryDef, { timeoutMs })) as T;
  } catch {
    return undefined;
  }
}

/** Truthy + non-empty guard for conditional optional-field spreads. */
function opt(v: string | undefined): boolean {
  return v !== undefined && v !== '';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printNextSteps(log: (...a: unknown[]) => void): void {
  log('');
  log('[upgrade] Next steps:');
  log('    1) npm i -g agent-tempo@2');
  log('    2) agent-tempo up --from-upgrade');
}
