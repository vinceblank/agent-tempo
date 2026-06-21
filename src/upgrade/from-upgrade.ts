/**
 * #786 — `agent-tempo up --from-upgrade` (the 2.0 side of the cutover).
 *
 * After `upgrade-to-2` (#785) has snapshotted continuity and destroyed every
 * 1.x run, a fresh 2.0 daemon boots cleanly (the boot guard sees zero
 * un-stamped workflows). This module is what `up --from-upgrade` then runs: it
 * reads `upgrade-snapshot-v1.json` and recreates a fresh protocol-2 workflow
 * for every player in the snapshot ROSTER.
 *
 * **TIGHT MVP — structural essentials only.** Each recreated session carries
 * exactly the structural identity needed to exist as a protocol-2 workflow:
 * `ensemble`, `playerId`, `workDir`, `agentType`, `isConductor` (plus the cheap
 * structural memo: gitRoot/playerType). The workflow self-stamps the
 * `AgentTempoProtocol` memo on start (and we seed it here too, so the row is
 * stamped even before the first workflow task runs).
 *
 * **Explicitly NOT in this PR (tracked #786 fast-follow — a non-droppable
 * beta.1 gate):** continuity seeding — #334 state slots, durable schedules,
 * `sessionId` resume pointers, and the non-default recruit `model`. Those are
 * captured in the snapshot but are NOT replayed here yet.
 *
 * **Undelivered cues are surfaced for REVIEW only — NEVER redelivered**
 * (replaying stale cues into fresh sessions is worse than operator triage,
 * #785 §4). The caller prints them; this module just collects them.
 *
 * **Archive-on-success:** the snapshot is renamed to
 * `upgrade-snapshot-v1.consumed.json` only when every workflow was recreated
 * without error. On any partial failure the snapshot is left PRISTINE so the
 * operator can fix the cause and re-run (recreation is idempotent via
 * `USE_EXISTING`).
 */
import { renameSync } from 'fs';
import { join } from 'path';
import { hostname as osHostname } from 'os';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import {
  conductorWorkflowId,
  sessionWorkflowId,
  maestroWorkflowId,
} from '../config';
import { MEMO_KEYS } from '../utils/search-attributes';
import { PROTOCOL_VERSION } from '../constants';
import { defaultPart } from '../utils/default-part';
import type { AgentType, SessionInput } from '../types';
import {
  readSnapshot,
  snapshotPath,
  SNAPSHOT_FILENAME,
  type UpgradeSnapshot,
} from './snapshot-v1';

/** Filename the consumed snapshot is archived to on success. */
export const CONSUMED_SNAPSHOT_FILENAME = 'upgrade-snapshot-v1.consumed.json';

/** A single workflow to recreate — pure plan output (no Temporal I/O). */
export interface RecreateSpec {
  workflowId: string;
  workflowType: 'agentSessionWorkflow' | 'agentMaestroWorkflow';
  ensemble: string;
  /** Present for session workflows. */
  playerId?: string;
  /** `args[0]` for the workflow start call. */
  args: [SessionInput] | [{ ensemble: string }];
  searchAttributes: Record<string, string[]>;
  memo: Record<string, unknown>;
}

/** An undelivered inbox cue, surfaced for operator review (never redelivered). */
export interface UndeliveredCueReview {
  ensemble: string;
  playerId: string;
  from: string;
  text: string;
  timestamp: string;
}

/** Result of {@link runFromUpgrade}. */
export interface FromUpgradeResult {
  /** `true` when a snapshot existed AND every workflow recreated cleanly. */
  ok: boolean;
  /** `false` when no `upgrade-snapshot-v1.json` was present (nothing to do). */
  snapshotFound: boolean;
  ensemblesRecreated: number;
  workflowsCreated: number;
  /** Per-workflow failures (empty on full success). */
  failures: { workflowId: string; error: string }[];
  /** Undelivered cues for operator review (surfaced, NOT redelivered). */
  undeliveredCues: UndeliveredCueReview[];
  /** `true` when the snapshot was archived to `.consumed.json` (success only). */
  archived: boolean;
  archivePath?: string;
}

/** Plan inputs — the Temporal coordinates the recreated workflows need. */
export interface PlanRecreationOpts {
  hostname: string;
  taskQueue: string;
  temporalAddress: string;
  temporalNamespace: string;
}

/**
 * Pure planner: turn a snapshot into the list of protocol-2 workflows to
 * recreate. One `agentMaestroWorkflow` per ensemble (so the ensemble is
 * coordinated + discoverable) plus one `agentSessionWorkflow` per roster player
 * (conductor via {@link conductorWorkflowId}, others via
 * {@link sessionWorkflowId}). Structural essentials only — see the module
 * header. Exported so the recreation set is unit-testable without Temporal.
 */
export function planRecreation(
  snapshot: UpgradeSnapshot,
  opts: PlanRecreationOpts,
): RecreateSpec[] {
  const specs: RecreateSpec[] = [];
  for (const ensemble of snapshot.ensembles) {
    // Per-ensemble maestro hub — structural coordination workflow. Recreated so
    // the ensemble is observable; idempotent via USE_EXISTING at start time.
    specs.push({
      workflowId: maestroWorkflowId(ensemble.name),
      workflowType: 'agentMaestroWorkflow',
      ensemble: ensemble.name,
      args: [{ ensemble: ensemble.name }],
      searchAttributes: { AgentTempoEnsemble: [ensemble.name] },
      memo: { [MEMO_KEYS.protocol]: PROTOCOL_VERSION },
    });

    for (const player of ensemble.players) {
      const workflowId = player.isConductor
        ? conductorWorkflowId(ensemble.name)
        : sessionWorkflowId(ensemble.name, player.playerId);
      const playerHostname = player.hostname || opts.hostname;
      const autoSummary = defaultPart({
        playerType: player.playerType,
        isConductor: player.isConductor,
        workDir: player.workDir,
        adapterType: player.agentType,
      });
      const input: SessionInput = {
        metadata: {
          playerId: player.playerId,
          ensemble: ensemble.name,
          hostname: playerHostname,
          workDir: player.workDir,
          isConductor: player.isConductor,
          agentType: player.agentType as AgentType,
          ...(player.gitRoot ? { gitRoot: player.gitRoot } : {}),
          ...(player.playerType ? { playerType: player.playerType } : {}),
        },
        // Carried so the stamp is in history from run 1; the workflow also
        // upserts it authoritatively from the constant.
        protocol: PROTOCOL_VERSION,
        autoSummary,
        // Recreated skeletons have no live adapter yet — suppress stale
        // detection until one attaches (mirrors recruit / lineup pre-create).
        disableStaleDetection: true,
        temporalConfig: {
          temporalAddress: opts.temporalAddress,
          temporalNamespace: opts.temporalNamespace,
          taskQueue: opts.taskQueue,
        },
      };
      specs.push({
        workflowId,
        workflowType: 'agentSessionWorkflow',
        ensemble: ensemble.name,
        playerId: player.playerId,
        args: [input],
        searchAttributes: {
          AgentTempoHostname: [playerHostname],
          AgentTempoEnsemble: [ensemble.name],
          AgentTempoPlayerId: [player.playerId],
        },
        memo: {
          ...(player.gitRoot ? { [MEMO_KEYS.gitRoot]: player.gitRoot } : {}),
          ...(player.playerType ? { [MEMO_KEYS.playerType]: player.playerType } : {}),
          [MEMO_KEYS.isConductor]: player.isConductor,
          [MEMO_KEYS.part]: autoSummary,
          [MEMO_KEYS.workDir]: player.workDir,
          [MEMO_KEYS.agentType]: player.agentType,
          // Seed the protocol stamp on the START memo so the boot guard sees a
          // stamped row even before the workflow's first task runs.
          [MEMO_KEYS.protocol]: PROTOCOL_VERSION,
        },
      });
    }
  }
  return specs;
}

/** Collect every undelivered cue across the snapshot (review only). */
export function collectUndeliveredCues(snapshot: UpgradeSnapshot): UndeliveredCueReview[] {
  const out: UndeliveredCueReview[] = [];
  for (const ensemble of snapshot.ensembles) {
    for (const player of ensemble.players) {
      for (const msg of player.undeliveredMessages) {
        out.push({
          ensemble: ensemble.name,
          playerId: player.playerId,
          from: msg.from,
          text: msg.text,
          timestamp: msg.timestamp,
        });
      }
    }
  }
  return out;
}

/**
 * Archive the consumed snapshot: `upgrade-snapshot-v1.json` →
 * `upgrade-snapshot-v1.consumed.json`. Overwrites a prior `.consumed.json`
 * from an earlier run (rename is atomic on the same volume). Returns the
 * archive path.
 */
export function archiveSnapshot(home: string): string {
  const from = snapshotPath(home);
  const to = join(home, CONSUMED_SNAPSHOT_FILENAME);
  renameSync(from, to);
  return to;
}

/**
 * Recreate protocol-2 workflows from the on-disk upgrade snapshot.
 *
 * Returns a structured result; never throws on a per-workflow failure (those
 * are collected in {@link FromUpgradeResult.failures}). A malformed snapshot
 * DOES throw (via `readSnapshot` → `SnapshotValidationError`) — a corrupt
 * continuity file is a loud failure, never a silent skip.
 */
export async function runFromUpgrade(
  client: Client,
  opts: {
    home: string;
    taskQueue: string;
    temporalAddress: string;
    temporalNamespace: string;
    hostname?: string;
    log?: (...args: unknown[]) => void;
  },
): Promise<FromUpgradeResult> {
  const log = opts.log ?? (() => {});
  const snapshot = readSnapshot(opts.home); // throws (loud) on a malformed file
  if (!snapshot) {
    return {
      ok: false,
      snapshotFound: false,
      ensemblesRecreated: 0,
      workflowsCreated: 0,
      failures: [],
      undeliveredCues: [],
      archived: false,
    };
  }

  const specs = planRecreation(snapshot, {
    hostname: opts.hostname ?? osHostname(),
    taskQueue: opts.taskQueue,
    temporalAddress: opts.temporalAddress,
    temporalNamespace: opts.temporalNamespace,
  });

  const failures: { workflowId: string; error: string }[] = [];
  let created = 0;
  for (const spec of specs) {
    try {
      await client.workflow.start(spec.workflowType, {
        workflowId: spec.workflowId,
        taskQueue: opts.taskQueue,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: spec.args as any,
        // Idempotent re-run: an already-recreated workflow is left as-is.
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        searchAttributes: spec.searchAttributes,
        memo: spec.memo,
      });
      created++;
      log(`from-upgrade: recreated ${spec.workflowType} ${spec.workflowId}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ workflowId: spec.workflowId, error });
      log(`from-upgrade: FAILED to recreate ${spec.workflowId}: ${error}`);
    }
  }

  const undeliveredCues = collectUndeliveredCues(snapshot);

  // Archive ONLY on full success — leave the snapshot pristine on partial fail
  // so the operator can fix the cause and re-run.
  let archived = false;
  let archivePath: string | undefined;
  if (failures.length === 0) {
    try {
      archivePath = archiveSnapshot(opts.home);
      archived = true;
      log(`from-upgrade: archived snapshot → ${CONSUMED_SNAPSHOT_FILENAME}`);
    } catch (err) {
      // Recreation succeeded but the archive rename failed (e.g. a lock on
      // Windows). Don't fail the run — surface it so the operator can move the
      // file manually (a re-run is a harmless idempotent no-op).
      log(
        `from-upgrade: WARNING — recreation succeeded but archiving ${SNAPSHOT_FILENAME} ` +
        `failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Move it aside manually so a future boot doesn't re-read it.`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    snapshotFound: true,
    ensemblesRecreated: snapshot.ensembles.length,
    workflowsCreated: created,
    failures,
    undeliveredCues,
    archived,
    ...(archivePath ? { archivePath } : {}),
  };
}
