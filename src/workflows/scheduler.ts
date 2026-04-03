import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  proxyActivities,
} from '@temporalio/workflow';

import {
  addScheduleSignal,
  removeScheduleSignal,
  getSchedulesQuery,
  getScheduleQuery,
} from './scheduler-signals';

import type { ScheduleEntry } from '../types';
import type { ScheduleActivities } from '../activities/schedule-fire';

const { fireSchedule } = proxyActivities<ScheduleActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export interface SchedulerInput {
  ensemble: string;
  /** Restored from continue-as-new. */
  entries?: ScheduleEntry[];
}

export async function claudeSchedulerWorkflow(input: SchedulerInput): Promise<void> {
  let entries: ScheduleEntry[] = input.entries ?? [];
  let dirty = false; // flag to wake the loop when signals arrive

  // ── Signal Handlers ──

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

  setHandler(removeScheduleSignal, (name) => {
    entries = entries.filter((e) => e.name !== name);
    dirty = true;
  });

  // ── Query Handlers ──

  setHandler(getSchedulesQuery, () => entries);
  setHandler(getScheduleQuery, (name) => entries.find((e) => e.name === name) ?? null);

  // ── Main Loop ──

  while (true) {
    // Self-terminate when empty
    if (entries.length === 0) {
      // Wait a short period for new entries to arrive before terminating
      dirty = false;
      await condition(() => dirty, '30 seconds');
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
      try {
        await fireSchedule({
          ensemble: input.ensemble,
          scheduleName: entry.name,
          message: entry.message,
          target: entry.target,
          createdBy: entry.createdBy,
        });
      } catch (err) {
        // Activity retries exhausted — log but don't crash the workflow
        // The entry will be rescheduled or removed below
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
      } else if (entry.type === 'cron' && entry.cron) {
        // For cron, the tools layer computes nextFireAt when adding the entry.
        // After firing, bump by the interval hint or let the tools layer re-signal.
        // Use a fallback of re-checking in 60s if no interval hint.
        entry.nextFireAt = new Date(Date.now() + (entry.interval ?? 60_000)).toISOString();
      }
    }

    // Prevent unbounded history growth
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeSchedulerWorkflow>({
        ensemble: input.ensemble,
        entries,
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}
