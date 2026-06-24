/**
 * #886 slice 1 — nondeterminism alarm unit tests.
 *
 * Pure logic: the classifier, the counter/snapshot, the logger wrapper's
 * passthrough + detection, and the process singleton. No Temporal runtime.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NondeterminismAlarm,
  isNondeterminismLog,
  wrapLoggerWithAlarm,
  NONDETERMINISM_MARKERS,
  getGlobalNondeterminismAlarm,
  setGlobalNondeterminismAlarm,
  __resetGlobalNondeterminismAlarmForTests,
} from '../../src/observability/nondeterminism-alarm';
import type { Logger, LogLevel } from '@temporalio/common';

afterEach(() => __resetGlobalNondeterminismAlarmForTests());

describe('isNondeterminismLog', () => {
  it('matches the marker set case-insensitively', () => {
    expect(isNondeterminismLog('Replay failed with a nondeterminism error')).toBe(true);
    expect(isNondeterminismLog('Workflow task failed: NonDeterminismError')).toBe(true);
    expect(isNondeterminismLog('a DeterminismViolationError occurred')).toBe(true);
    expect(isNondeterminismLog('non-determinism detected during replay')).toBe(true);
    expect(isNondeterminismLog('error code TMPRL1100 in workflow')).toBe(true);
  });

  it('does NOT match unrelated logs', () => {
    expect(isNondeterminismLog('Workflow completed successfully')).toBe(false);
    expect(isNondeterminismLog('activity timed out')).toBe(false);
    expect(isNondeterminismLog('')).toBe(false);
    expect(isNondeterminismLog(undefined as unknown as string)).toBe(false);
  });

  it('exposes the marker set (frozen)', () => {
    expect(NONDETERMINISM_MARKERS).toContain('nondetermin');
    expect(NONDETERMINISM_MARKERS).toContain('determinismviolation');
    expect(Object.isFrozen(NONDETERMINISM_MARKERS)).toBe(true);
  });
});

describe('NondeterminismAlarm', () => {
  it('counts hits and tracks first/last timestamps', () => {
    let t = 1_000;
    const alarm = new NondeterminismAlarm({ now: () => t });
    expect(alarm.snapshot()).toEqual({ count: 0, recent: [] });

    alarm.record('nondeterminism #1');
    t = 5_000;
    alarm.record('nondeterminism #2', { workflowType: 'agentSessionWorkflow', runId: 'r-9' });

    const snap = alarm.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.firstSeenAt).toBe(new Date(1_000).toISOString());
    expect(snap.lastSeenAt).toBe(new Date(5_000).toISOString());
    expect(snap.recent).toHaveLength(2);
    // meta is woven into the detail.
    expect(snap.recent[1].detail).toContain('workflowType=agentSessionWorkflow');
    expect(snap.recent[1].detail).toContain('runId=r-9');
  });

  it('caps the recent ring at 10, newest last', () => {
    const alarm = new NondeterminismAlarm({ now: () => 0 });
    for (let i = 0; i < 15; i++) alarm.record(`nondeterminism ${i}`);
    const snap = alarm.snapshot();
    expect(snap.count).toBe(15);
    expect(snap.recent).toHaveLength(10);
    expect(snap.recent[snap.recent.length - 1].detail).toContain('nondeterminism 14');
    expect(snap.recent[0].detail).toContain('nondeterminism 5');
  });

  it('invokes onHit with the running count + sample (promotion)', () => {
    const hits: Array<{ count: number; detail: string }> = [];
    const alarm = new NondeterminismAlarm({
      now: () => 0,
      onHit: (count, sample) => hits.push({ count, detail: sample.detail }),
    });
    alarm.record('nondeterminism a');
    alarm.record('nondeterminism b');
    expect(hits.map((h) => h.count)).toEqual([1, 2]);
  });

  it('a throwing onHit never disarms the counter', () => {
    const alarm = new NondeterminismAlarm({ now: () => 0, onHit: () => { throw new Error('boom'); } });
    expect(() => alarm.record('nondeterminism x')).not.toThrow();
    expect(alarm.count).toBe(1);
  });
});

describe('wrapLoggerWithAlarm', () => {
  function makeBase() {
    const calls: Array<{ method: string; level?: LogLevel; message: string }> = [];
    const base: Logger = {
      log: (level, message) => { calls.push({ method: 'log', level, message }); },
      trace: (message) => { calls.push({ method: 'trace', message }); },
      debug: (message) => { calls.push({ method: 'debug', message }); },
      info: (message) => { calls.push({ method: 'info', message }); },
      warn: (message) => { calls.push({ method: 'warn', message }); },
      error: (message) => { calls.push({ method: 'error', message }); },
    };
    return { base, calls };
  }

  it('forwards every method to the base logger', () => {
    const { base, calls } = makeBase();
    const alarm = new NondeterminismAlarm({ now: () => 0 });
    const w = wrapLoggerWithAlarm(base, alarm);
    w.trace('t'); w.debug('d'); w.info('i'); w.warn('w'); w.error('e'); w.log('INFO', 'l');
    expect(calls.map((c) => c.method)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'log']);
    expect(alarm.count).toBe(0); // none were nondeterminism
  });

  it('records a nondeterminism WARN / ERROR / log(WARN) but still forwards', () => {
    const { base, calls } = makeBase();
    const alarm = new NondeterminismAlarm({ now: () => 0 });
    const w = wrapLoggerWithAlarm(base, alarm);
    w.warn('Replay failed with a nondeterminism error');
    w.error('DeterminismViolationError');
    w.log('WARN', 'nondeterminism via log()');
    expect(alarm.count).toBe(3);
    expect(calls).toHaveLength(3); // all still forwarded
  });

  it('does NOT record nondeterminism at trace/debug/info levels', () => {
    const { base } = makeBase();
    const alarm = new NondeterminismAlarm({ now: () => 0 });
    const w = wrapLoggerWithAlarm(base, alarm);
    w.info('nondeterminism mention at info');
    w.debug('nondeterminism mention at debug');
    w.log('INFO', 'nondeterminism mention via log INFO');
    expect(alarm.count).toBe(0);
  });

  it('does NOT record a non-matching WARN', () => {
    const { base } = makeBase();
    const alarm = new NondeterminismAlarm({ now: () => 0 });
    const w = wrapLoggerWithAlarm(base, alarm);
    w.warn('Ignoring WorkerOptions.workflowsPath');
    expect(alarm.count).toBe(0);
  });
});

describe('process singleton', () => {
  it('get returns undefined until set, then the installed alarm', () => {
    expect(getGlobalNondeterminismAlarm()).toBeUndefined();
    const alarm = new NondeterminismAlarm();
    setGlobalNondeterminismAlarm(alarm);
    expect(getGlobalNondeterminismAlarm()).toBe(alarm);
  });
});
