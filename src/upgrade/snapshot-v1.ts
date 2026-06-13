/**
 * `upgrade-snapshot-v1.json` — schema + persistence for the `upgrade-to-2`
 * cutover (issue #785, ratified migration protocol A2 in
 * `docs/design/v2-scoping.md` §A.3).
 *
 * **This module is the cross-release INTERFACE.** The 2.0-side
 * `up --from-upgrade` (issue #786) imports these types and {@link readSnapshot}
 * to recreate fresh protocol-2 workflows from a 1.x cutover. The schema is
 * VERSIONED ({@link UPGRADE_SNAPSHOT_VERSION}).
 *
 * **Compatibility law (the #786 reader encodes whatever this says):**
 *   - **Additive optional field → NO version bump.** The structural validator
 *     ({@link validateSnapshot}) is deliberately non-exhaustive, so adding an
 *     optional field is forward- and backward-compatible: old readers ignore
 *     it, new readers read-when-present (the `hostProfile` open-schema model).
 *   - **Removed / renamed / retyped REQUIRED field → version bump + a reader
 *     migration on the 2.0 side.** Only a change that breaks an existing
 *     reader's assumptions justifies a bump.
 *
 * **CRITICAL — keep this module Temporal-free.** It must NOT import from
 * `@temporalio/*`, `../workflows/*`, `../adapters/*`, `../client`, or anything
 * that transitively pulls the Temporal SDK. #786 is a 2.0 reader; coupling the
 * frozen contract to the live workflow runtime would drag the entire SDK into
 * the reader and re-introduce exactly the version-skew the cutover exists to
 * avoid. File I/O (`fs`) and pure types only — gathering the snapshot FROM the
 * live cluster lives in `phase-engine.ts` (the I/O-separated half).
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
// Keep this a TYPE-ONLY import — pulling a value from `../ensemble/schema`
// would risk dragging the Temporal SDK into the (deliberately SDK-free) 2.0
// reader. `EnsembleLineup` is the one live type embedded in the contract; see
// the back-compat note on {@link SnapshotEnsemble.lineup}.
import type { EnsembleLineup } from '../ensemble/schema';

/**
 * Schema version. Bump only on a BREAKING change to the captured shape (a
 * removed / renamed / retyped required field) — additive optional fields do
 * NOT bump (see the compatibility law in the module header). The 2.0 reader
 * pins this and refuses (loudly) to consume a version it does not know.
 */
export const UPGRADE_SNAPSHOT_VERSION = 1 as const;

/** Canonical on-disk filename, under `AGENT_TEMPO_HOME`. */
export const SNAPSHOT_FILENAME = 'upgrade-snapshot-v1.json';

/**
 * The six cutover phases, in strict order. The snapshot's {@link
 * UpgradeSnapshot.phase} field is the resumable stamp: a re-run skips any phase
 * whose index is `< ` the stamped phase's index.
 *
 * Note that the snapshot file only exists once the SNAPSHOT phase has run — the
 * preceding phases (`preflight`/`pause`/`drain`) leave the cluster intact on a
 * crash and simply re-run from the top (they are idempotent; pause is
 * re-asserted). So a persisted snapshot's `phase` is always one of
 * `snapshot | destroy | done`.
 */
export type UpgradePhase =
  | 'preflight'
  | 'pause'
  | 'drain'
  | 'snapshot'
  | 'destroy'
  | 'done';

/** Phases in execution order — the index defines resume comparison. */
export const UPGRADE_PHASES: readonly UpgradePhase[] = [
  'preflight',
  'pause',
  'drain',
  'snapshot',
  'destroy',
  'done',
] as const;

/** Numeric rank of a phase for `>=` resume comparisons. */
export function phaseRank(phase: UpgradePhase): number {
  return UPGRADE_PHASES.indexOf(phase);
}

/**
 * An undelivered inbox cue, captured for operator REVIEW only.
 *
 * Deliberately NOT auto-redelivered on the 2.0 side: replaying stale cues into
 * fresh sessions is worse than asking the operator to triage them (issue #785
 * §4). The operator reads these out of the snapshot and decides.
 */
export interface SnapshotMessage {
  /** Original message id (traceability). */
  id: string;
  /** Sender player name, or a system identity (e.g. `maestro`). */
  from: string;
  /** Message body. */
  text: string;
  /** ISO timestamp the cue was enqueued. */
  timestamp: string;
  /** True when the cue originated from the maestro / a human dashboard. */
  isMaestro?: boolean;
  /**
   * Coat-check ticket the cue referenced (#318). The coat-check body itself is
   * DROPPED by the cutover (TTL-transient), so this is a dangling reference —
   * surfaced so the operator knows the cue pointed at now-dropped content.
   */
  attachmentTicket?: string;
}

/**
 * A durable schedule, captured so the 2.0 side can recreate user intent. This
 * is a frozen, self-contained copy of the live `ScheduleEntry` — decoupled on
 * purpose so internal scheduler-type drift cannot silently change the contract.
 */
export interface SnapshotSchedule {
  name: string;
  message: string;
  /** Target player name. */
  target: string;
  /** Audit: who created the schedule. */
  createdBy: string;
  type: 'once' | 'interval' | 'cron';
  /** ISO timestamp of the next fire at capture time. */
  nextFireAt: string;
  /** Repeat interval in milliseconds (interval schedules). */
  interval?: number;
  /** Cron expression (cron schedules). */
  cronExpression?: string;
  /** IANA timezone for cron evaluation (defaults to UTC). */
  timezone?: string;
  /** ISO expiry. */
  until?: string;
  /** Remaining fires before auto-removal. */
  remainingCount?: number;
}

/**
 * An outbox entry still pending when `--force-drain` proceeded past a
 * non-empty outbox. Captured for operator review (the work was NOT delivered).
 */
export interface SnapshotStraggler {
  /** The player whose outbox still held the entry. */
  playerId: string;
  /** Outbox entry id. */
  entryId: string;
  /** Entry type (cue, recruit, report, …). */
  entryType: string;
  /** Entry status at capture (typically `pending` or `processing`). */
  status: string;
  /** ISO timestamp the entry was enqueued. */
  createdAt: string;
}

/**
 * A single player's captured continuity state. The 2.0 side recruits a fresh
 * protocol-2 workflow per the ensemble lineup, then seeds it from these fields
 * (state slots via the #334 `self-restart` delivery identity; `sessionId` as
 * the per-adapter conversation-resume pointer).
 */
export interface SnapshotPlayer {
  playerId: string;
  /** Agent-definition name (e.g. `tempo-soloist`); absent for ad-hoc players. */
  playerType?: string;
  /** Adapter agent type (`claude` | `copilot` | `pi` | …). */
  agentType: string;
  /** The player's self-described current work. */
  part: string;
  workDir: string;
  hostname: string;
  gitRoot?: string;
  /** Per-adapter conversation-resume pointer — survives the hop (issue #785). */
  sessionId?: string;
  /**
   * Non-default model the player was recruited with (the `model` arg of
   * claude-api / opencode / pi recruits — #131 / #449 / #734). Captured so an
   * ad-hoc-recruited player is recreated on the SAME model on the 2.0 side;
   * absent for default-model players. Lineup players carry their model via the
   * lineup instead, so this only closes the ad-hoc-recruit continuity gap.
   * Additive optional field — added post-v1 without a version bump, per the
   * compatibility law (the structural validator tolerates it).
   */
  model?: string;
  isConductor: boolean;
  /**
   * #334 saveable-state slots, `key → content`. This is the continuity story
   * working as designed: the player itself curated what survives the cutover.
   */
  stateSlots: Record<string, string>;
  /** Undelivered inbox cues, captured for operator review (NOT redelivered). */
  undeliveredMessages: SnapshotMessage[];
}

/**
 * One ensemble's captured state.
 *
 * **Intentional drop (conscious contract decision, not a gap):** quality gates,
 * stages, and worktrees are NOT captured. They track in-flight coordination
 * work that the cutover tears down, so carrying them forward would re-seed stale
 * state into fresh 2.0 sessions; worktree *physical* continuity rides
 * `players[].workDir`. This is additively reversible — a future optional field
 * can capture them without a version bump (see the compatibility law).
 */
export interface SnapshotEnsemble {
  name: string;
  description?: string;
  /**
   * The declarative lineup recipe (players, conductor, schedules-as-authored).
   * The 2.0 side recruits fresh players from this. Absent for a bare ensemble
   * that was never `up`'d from a lineup.
   *
   * **Back-compat obligation:** embedding the live {@link EnsembleLineup} is
   * safe ONLY while the 2.0 lineup type stays backward-compatible with
   * 1.x-authored lineups — the SAME obligation `load_lineup` already carries
   * for reading 1.x lineup YAML. Do NOT let the lineup type drift incompatibly
   * without updating the 2.0 snapshot reader in lockstep.
   */
  lineup?: EnsembleLineup;
  /** Durable schedules — MUST be captured (durable user intent, #785 §4). */
  schedules: SnapshotSchedule[];
  /** Per-player runtime continuity capture. */
  players: SnapshotPlayer[];
  /**
   * Coat-check entries are DROPPED by design (TTL-transient continuity is not
   * worth preserving across a cutover, #785 §4). Recorded as a count for the
   * operator note — the bodies are not captured.
   */
  droppedCoatCheckCount?: number;
  /** Stragglers left pending when `--force-drain` proceeded (review only). */
  forceDrainedStragglers?: SnapshotStraggler[];
}

/**
 * The complete cutover snapshot — the on-disk `upgrade-snapshot-v1.json`.
 *
 * `phase` is the resumable stamp (see {@link UpgradePhase}). `createdAt` is
 * stamped once, when capture first completes, and is preserved across resume
 * re-writes so the operator can see when continuity was actually frozen.
 */
export interface UpgradeSnapshot {
  version: typeof UPGRADE_SNAPSHOT_VERSION;
  /** ISO timestamp capture completed (preserved across resume re-writes). */
  createdAt: string;
  /** The 1.x CLI version that produced this snapshot. */
  cliVersion: string;
  /** Resumable phase stamp. */
  phase: UpgradePhase;
  ensembles: SnapshotEnsemble[];
}

/** Absolute path to the snapshot file under the given home directory. */
export function snapshotPath(home: string): string {
  return join(home, SNAPSHOT_FILENAME);
}

/**
 * Read + validate the snapshot from `home`. Returns `null` when no snapshot
 * file exists (the from-scratch case). Throws {@link SnapshotValidationError}
 * when a file exists but is malformed or an unknown version — a corrupt
 * continuity file is a LOUD failure, never a silent skip.
 */
export function readSnapshot(home: string): UpgradeSnapshot | null {
  const path = snapshotPath(home);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SnapshotValidationError(
      `failed to read snapshot at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotValidationError(
      `snapshot at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateSnapshot(parsed, path);
}

/**
 * Atomically persist the snapshot to `home` (write to a temp sibling, then
 * `rename` — a crash mid-write never leaves a torn continuity file, which is
 * the load-bearing invariant of the whole protocol). Creates `home` if needed.
 */
export function writeSnapshot(home: string, snapshot: UpgradeSnapshot): void {
  const path = snapshotPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Pure helper — return a copy of the snapshot with an advanced phase stamp. */
export function stampPhase(snapshot: UpgradeSnapshot, phase: UpgradePhase): UpgradeSnapshot {
  return { ...snapshot, phase };
}

/** Thrown when a snapshot file exists but cannot be trusted. */
export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

/**
 * Runtime shape guard. Validates the load-bearing fields the 2.0 reader and the
 * resume path depend on; throws {@link SnapshotValidationError} on any
 * mismatch. Intentionally structural (not exhaustive) — it protects against a
 * truncated, hand-edited, or wrong-version file, not against every field typo.
 */
export function validateSnapshot(obj: unknown, source = '<memory>'): UpgradeSnapshot {
  const fail = (msg: string): never => {
    throw new SnapshotValidationError(`invalid snapshot (${source}): ${msg}`);
  };
  if (typeof obj !== 'object' || obj === null) return fail('not an object');
  const s = obj as Record<string, unknown>;
  if (s.version !== UPGRADE_SNAPSHOT_VERSION) {
    return fail(
      `unsupported version ${JSON.stringify(s.version)} (this reader supports ${UPGRADE_SNAPSHOT_VERSION})`,
    );
  }
  if (typeof s.createdAt !== 'string') return fail('createdAt missing or not a string');
  if (typeof s.cliVersion !== 'string') return fail('cliVersion missing or not a string');
  if (typeof s.phase !== 'string' || phaseRank(s.phase as UpgradePhase) < 0) {
    return fail(`phase missing or unknown: ${JSON.stringify(s.phase)}`);
  }
  if (!Array.isArray(s.ensembles)) return fail('ensembles missing or not an array');
  s.ensembles.forEach((e, i) => {
    if (typeof e !== 'object' || e === null) return fail(`ensembles[${i}] not an object`);
    const ens = e as Record<string, unknown>;
    if (typeof ens.name !== 'string') return fail(`ensembles[${i}].name missing`);
    if (!Array.isArray(ens.schedules)) return fail(`ensembles[${i}].schedules not an array`);
    if (!Array.isArray(ens.players)) return fail(`ensembles[${i}].players not an array`);
    (ens.players as unknown[]).forEach((p, j) => {
      if (typeof p !== 'object' || p === null) return fail(`ensembles[${i}].players[${j}] not an object`);
      const pl = p as Record<string, unknown>;
      if (typeof pl.playerId !== 'string') return fail(`ensembles[${i}].players[${j}].playerId missing`);
      if (typeof pl.stateSlots !== 'object' || pl.stateSlots === null) {
        return fail(`ensembles[${i}].players[${j}].stateSlots missing`);
      }
      if (!Array.isArray(pl.undeliveredMessages)) {
        return fail(`ensembles[${i}].players[${j}].undeliveredMessages not an array`);
      }
    });
  });
  return obj as UpgradeSnapshot;
}
