import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { ScheduleEntry } from '../types';

export type { ScheduleEntry } from '../types';

// ── Scheduler Signals ──

export const addScheduleSignal = defineSignal<[ScheduleEntry]>('addSchedule');
export const removeScheduleSignal = defineSignal<[string]>('removeSchedule');

/** Rewrite schedule targets from oldName to newName (fired on player rename). */
export const updateScheduleTargetSignal = defineSignal<[string, string]>('updateScheduleTarget');

// ── Scheduler Queries ──

export const getSchedulesQuery = defineQuery<ScheduleEntry[]>('getSchedules');
export const getScheduleQuery = defineQuery<ScheduleEntry | null, [string]>('getSchedule');
