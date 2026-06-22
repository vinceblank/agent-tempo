import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  proxyActivities,
  log as workflowLog,
  upsertMemo,
} from '@temporalio/workflow';
import { MEMO_KEYS } from '../utils/search-attributes';
import { PROTOCOL_VERSION } from '../constants';

import {
  addScheduleSignal,
  removeScheduleSignal,
  updateScheduleTargetSignal,
  getSchedulesQuery,
  getScheduleQuery,
  setSchedulerPausedSignal,
} from './scheduler-signals';

import type { ScheduleEntry } from '../types';
import type { ScheduleActivities } from '../activities/schedule-fire';

const { fireSchedule, computeNextCronFire } = proxyActivities<ScheduleActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

/** Default self-termination grace period — 30 000 ms (see §scheduler "empty self-terminate"). */
const DEFAULT_GRACE_PERIOD_MS = 30_000;

export interface SchedulerInput {
  ensemble: string;
  /** Restored from continue-as-new. */
  entries?: ScheduleEntry[];
  /** Restored from continue-as-new: paused state. */
  paused?: boolean;
  /**
   * Milliseconds to wait for new entries before the workflow self-terminates when the
   * entries list is empty. Defaults to {@link DEFAULT_GRACE_PERIOD_MS} — 30s in production.
   * Tests override (e.g. to 100ms) to keep the "self-terminates when empty" case fast;
   * `setupTestEnv` uses `createLocal()` so this delay is real wall-clock time.
   * Always propagated via continue-as-new so behavior stays consistent across re-entries.
   */
  gracePeriodMs?: number;
}

export async function agentSchedulerWorkflow(input: SchedulerInput): Promise<void> {
  // #786 — 2.0 cutover protocol stamp (see constants.PROTOCOL_VERSION). Memo,
  // re-upserted every run incl. CAN, so the boot guard sees every Running 2.0
  // scheduler as stamped; a 1.x scheduler never runs this → guard refuses.
  upsertMemo({ [MEMO_KEYS.protocol]: PROTOCOL_VERSION });

  let entries: ScheduleEntry[] = input.entries ?? [];
  let dirty = false; // flag to wake the loop when signals arrive
  let schedulerPaused = input.paused ?? false;
  let skippedWhilePaused = 0;
  const gracePeriodMs = input.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;

  // ── Signal Handlers ──

  // REGISTRATION-ORDER FENCE (#797 / #782 C1): addScheduleSignal MUST
  // register BEFORE removeScheduleSignal — buffered signals drain in
  // registration order on a fresh/CAN'd run's first workflow task; inverted,
  // the remove would no-op and the late add would resurrect the schedule
  // (which then FIRES). Pinned by
  // tests/conformance/registration-order-fence.test.ts.
  setHandler(addScheduleSignal, (entry) => {
    // Replace existing entry with same name, or add new
    const idx = entries.findIndex((e) => e.name === entry.name);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    dirty = true;
  });

  // REGISTRATION-ORDER FENCE (#797 / #782 C1): consumer half — must stay
  // registered AFTER addScheduleSignal.
  setHandler(removeScheduleSignal, (name) => {
    entries = entries.filter((e) => e.name !== name);
    dirty = true;
  });

  setHandler(updateScheduleTargetSignal, (oldName, newName) => {
    for (const entry of entries) {
      if (entry.target === oldName) {
        entry.target = newName;
      }
      if (entry.createdBy === oldName) {
        entry.createdBy = newName;
      }
    }
    dirty = true;
  });

  setHandler(setSchedulerPausedSignal, (value: boolean) => {
    schedulerPaused = value;
    dirty = true; // wake the loop to handle the state change
  });

  // ── Query Handlers ──

  setHandler(getSchedulesQuery, () => entries);
  setHandler(getScheduleQuery, (name) => entries.find((e) => e.name === name) ?? null);

  // ── Main Loop ──

  while (true) {
    // Self-terminate when empty
    if (entries.length === 0) {
      // Wait `gracePeriodMs` for new entries to arrive before terminating.
      // Production default is 30s; tests override via `SchedulerInput.gracePeriodMs`
      // because `TestWorkflowEnvironment.createLocal()` does NOT time-skip.
      dirty = false;
      await condition(() => dirty, gracePeriodMs);
      if (entries.length === 0) break;
    }

    // Sort by nextFireAt ascending
    entries.sort((a, b) => a.nextFireAt.localeCompare(b.nextFireAt));

    const now = Date.now();
    const earliest = new Date(entries[0].nextFireAt).getTime();
    const sleepMs = Math.max(earliest - now, 0);

    if (sleepMs > 0) {
      // Sleep until next fire time, or wake early if a signal arrives
      dirty = false;
      await condition(() => dirty, `${sleepMs} milliseconds`);

      // If woken by signal, re-check from top (entries may have changed)
      if (dirty) continue;
    }

    // Fire all due entries
    const fireTime = Date.now();
    const due = entries.filter((e) => new Date(e.nextFireAt).getTime() <= fireTime);

    for (const entry of due) {
      // When paused, skip firing but still reschedule/remove below
      if (!schedulerPaused) {
        try {
          await fireSchedule({
            ensemble: input.ensemble,
            scheduleName: entry.name,
            message: entry.message,
            target: entry.target,
            createdBy: entry.createdBy,
          });
        } catch (err) {
          // Activity retries exhausted — the cue for THIS fire is lost
          // (interval/cron entries repeat the loss each fire until the
          // cause clears; `once` entries lose outright). #797 (#782 C2 —
          // B4c spirit): the loss must be LOUD, not silent. The known
          // arrival-order cause is rename-racing-schedule-creation leaving
          // a stale `target` (architect-accepted as likelihood-bounded; no
          // rename-log reconciliation). Workflow stays alive either way.
          workflowLog.warn(
            `schedule "${entry.name}" fire FAILED after activity retries — cue to ` +
            `"${entry.target}" lost this fire: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        skippedWhilePaused += 1;
      }

      entry.firedCount += 1;

      // Decrement remaining count
      if (entry.remainingCount !== undefined) {
        entry.remainingCount -= 1;
      }

      // Determine if entry should be removed or rescheduled
      const expired = entry.until && new Date(entry.until).getTime() <= Date.now();
      const exhausted = entry.remainingCount !== undefined && entry.remainingCount <= 0;

      if (entry.type === 'once' || expired || exhausted) {
        entries = entries.filter((e) => e.name !== entry.name);
      } else if (entry.type === 'interval' && entry.interval) {
        entry.nextFireAt = new Date(Date.now() + entry.interval).toISOString();
      } else if (entry.type === 'cron' && entry.cronExpression) {
        const nextFire = await computeNextCronFire({
          cronExpression: entry.cronExpression,
          timezone: entry.timezone,
        });
        if (nextFire) {
          entry.nextFireAt = nextFire;
        } else {
          entries = entries.filter((e) => e.name !== entry.name);
        }
      }
    }

    // Prevent unbounded history growth
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof agentSchedulerWorkflow>({
        ensemble: input.ensemble,
        entries,
        paused: schedulerPaused,
        // Propagate the configured grace period — omitting this would silently
        // revert tests that set a short window back to the 30s default on re-entry.
        gracePeriodMs: input.gracePeriodMs,
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}
