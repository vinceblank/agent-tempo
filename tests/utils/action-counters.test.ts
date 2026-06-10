/**
 * Unit coverage for the per-source Temporal action counters (#753).
 *
 * Surfaces under test:
 *   1. `recordAction` + `snapshotActionCounters` — sparse source×kind
 *      counts, per-source totals, grand total, window origin.
 *   2. `withActionSource` — attribution rides AsyncLocalStorage across
 *      `await` boundaries; nesting is innermost-wins; default is 'other'.
 *   3. `tagActionSource` — wraps every function-valued property.
 *   4. `createActionCountingInterceptor` — counts each verb under the
 *      ambient source and forwards untouched; composite verbs
 *      (signalWithStart / startUpdateWithStart) count both wire effects.
 *   5. Composition with `queryHandleWithTimeout`'s in-flight dedup (#433):
 *      a deduped caller never reaches the wire → counted exactly once.
 *   6. Periodic log line — lazily started, emits only when counts changed,
 *      stopped by the test reset hook.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordAction,
  snapshotActionCounters,
  withActionSource,
  currentActionSource,
  tagActionSource,
  createActionCountingInterceptor,
  actionCountingInterceptors,
  __resetActionCountersForTests,
  DEFAULT_ACTION_LOG_INTERVAL_MS,
} from '../../src/utils/action-counters';
import {
  queryHandleWithTimeout,
  __resetInflightQueriesForTests,
} from '../../src/utils/query-timeout';

beforeEach(() => {
  __resetActionCountersForTests();
  __resetInflightQueriesForTests();
});
afterEach(() => {
  __resetActionCountersForTests();
  delete process.env.AGENT_TEMPO_ACTION_LOG_INTERVAL_MS;
});

describe('recordAction + snapshotActionCounters', () => {
  it('starts empty', () => {
    const snap = snapshotActionCounters();
    expect(snap.total).toBe(0);
    expect(snap.bySource).toEqual({});
    expect(Date.parse(snap.sinceIso)).not.toBeNaN();
  });

  it('counts per source × kind with per-source and grand totals', () => {
    recordAction('query', 'maestro');
    recordAction('query', 'maestro');
    recordAction('signal', 'maestro');
    recordAction('list', 'aggregate');
    const snap = snapshotActionCounters();
    expect(snap.total).toBe(4);
    expect(snap.bySource.maestro).toEqual({ query: 2, signal: 1, total: 3 });
    expect(snap.bySource.aggregate).toEqual({ list: 1, total: 1 });
    // Sparse — sources never recorded are omitted entirely.
    expect(snap.bySource['pi-pump']).toBeUndefined();
  });

  it('defaults to the ambient source, falling back to "other"', () => {
    recordAction('query');
    expect(snapshotActionCounters().bySource.other).toEqual({ query: 1, total: 1 });
  });

  it('windowMs derives from the injected now', () => {
    const snap = snapshotActionCounters(Date.now() + 5_000);
    expect(snap.windowMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe('withActionSource', () => {
  it('attributes across await boundaries', async () => {
    await withActionSource('aggregate', async () => {
      await new Promise((r) => setTimeout(r, 1));
      recordAction('query');
      await new Promise((r) => setTimeout(r, 1));
      recordAction('signal');
    });
    expect(snapshotActionCounters().bySource.aggregate).toEqual({
      query: 1, signal: 1, total: 2,
    });
  });

  it('nests innermost-wins and restores on exit', async () => {
    await withActionSource('outbox', async () => {
      expect(currentActionSource()).toBe('outbox');
      await withActionSource('heartbeat', async () => {
        expect(currentActionSource()).toBe('heartbeat');
        recordAction('signal');
      });
      expect(currentActionSource()).toBe('outbox');
      recordAction('update');
    });
    expect(currentActionSource()).toBe('other');
    const snap = snapshotActionCounters();
    expect(snap.bySource.heartbeat).toEqual({ signal: 1, total: 1 });
    expect(snap.bySource.outbox).toEqual({ update: 1, total: 1 });
  });

  it('returns the wrapped function result verbatim', async () => {
    expect(withActionSource('maestro', () => 42)).toBe(42);
    await expect(withActionSource('maestro', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('tagActionSource', () => {
  it('wraps function-valued properties; non-functions pass through', async () => {
    const tagged = tagActionSource('schedule', {
      async fire() { recordAction('signal'); return 'fired'; },
      label: 'not-a-function',
    });
    await expect(tagged.fire()).resolves.toBe('fired');
    expect(tagged.label).toBe('not-a-function');
    expect(snapshotActionCounters().bySource.schedule).toEqual({ signal: 1, total: 1 });
  });

  it('forwards arguments', async () => {
    const tagged = tagActionSource('maestro', {
      echo: (a: number, b: number) => a + b,
    });
    expect(tagged.echo(2, 3)).toBe(5);
  });
});

describe('createActionCountingInterceptor', () => {
  // The interceptor's `next` continuations are SDK-typed; in unit tests we
  // drive each method directly with a stub `next` and assert pass-through.
  const callVerb = async (
    verb: string,
    expected: Record<string, number>,
  ): Promise<void> => {
    __resetActionCountersForTests();
    const interceptor = createActionCountingInterceptor() as unknown as Record<
      string,
      (input: unknown, next: (input: unknown) => Promise<string>) => Promise<string>
    >;
    const next = vi.fn(async () => 'passthrough');
    const input = { marker: verb };
    await expect(interceptor[verb](input, next)).resolves.toBe('passthrough');
    expect(next).toHaveBeenCalledWith(input);
    const byKind = snapshotActionCounters().bySource.other ?? { total: 0 };
    const { total: _t, ...kinds } = byKind;
    expect(kinds).toEqual(expected);
  };

  it('counts each simple verb under its kind', async () => {
    await callVerb('query', { query: 1 });
    await callVerb('signal', { signal: 1 });
    await callVerb('startUpdate', { update: 1 });
    await callVerb('startWithDetails', { start: 1 });
    await callVerb('describe', { describe: 1 });
    await callVerb('terminate', { terminate: 1 });
    await callVerb('cancel', { cancel: 1 });
  });

  it('counts both wire effects of composite verbs', async () => {
    await callVerb('signalWithStart', { signal: 1, start: 1 });
    await callVerb('startUpdateWithStart', { update: 1, start: 1 });
  });

  it('reads the ambient source at call time', async () => {
    const interceptor = createActionCountingInterceptor();
    const next = async () => undefined;
    await withActionSource('pi-pump', () =>
      interceptor.query!({ queryType: 'pendingMessages' } as never, next as never));
    expect(snapshotActionCounters().bySource['pi-pump']).toEqual({ query: 1, total: 1 });
  });

  it('actionCountingInterceptors() returns the Client options shape', () => {
    const shape = actionCountingInterceptors();
    expect(shape.workflow).toHaveLength(1);
    expect(typeof shape.workflow[0].query).toBe('function');
  });
});

describe('composition with queryHandleWithTimeout dedup (#433)', () => {
  it('a deduped concurrent query is counted exactly once', async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => { release = r; });
    // Stand-in for the interceptor on the wire path: handle.query() is the
    // wire call, so it records — exactly like a real interceptor-wrapped
    // Client. The dedup layer must prevent the second caller from reaching it.
    const handle = {
      workflowId: 'wf-dedup',
      query: async () => { recordAction('query'); return gate; },
    };
    const a = queryHandleWithTimeout(handle as never, 'getMetadata', { timeoutMs: 1_000 });
    const b = queryHandleWithTimeout(handle as never, 'getMetadata', { timeoutMs: 1_000 });
    release('meta');
    await expect(Promise.all([a, b])).resolves.toEqual(['meta', 'meta']);
    expect(snapshotActionCounters().bySource.other).toEqual({ query: 1, total: 1 });
  });
});

describe('periodic log line', () => {
  it('emits the snapshot when counts changed, stays quiet otherwise', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.AGENT_TEMPO_ACTION_LOG_INTERVAL_MS = '50';
      recordAction('query', 'maestro'); // lazily arms the timer
      await vi.advanceTimersByTimeAsync(60);
      const lines = spy.mock.calls.filter((c) => c[0] === '[agent-tempo:action-counters]');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0][1] as string).bySource.maestro.query).toBe(1);
      // No new counts → no new line on the next interval.
      await vi.advanceTimersByTimeAsync(60);
      expect(
        spy.mock.calls.filter((c) => c[0] === '[agent-tempo:action-counters]'),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('interval 0 disables the timer; default constant is 5 minutes', () => {
    vi.useFakeTimers();
    try {
      process.env.AGENT_TEMPO_ACTION_LOG_INTERVAL_MS = '0';
      recordAction('query');
      expect(vi.getTimerCount()).toBe(0);
      expect(DEFAULT_ACTION_LOG_INTERVAL_MS).toBe(300_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('__resetActionCountersForTests', () => {
  it('zeroes counters and resets the window origin', () => {
    recordAction('query', 'maestro');
    expect(snapshotActionCounters().total).toBe(1);
    __resetActionCountersForTests();
    const snap = snapshotActionCounters();
    expect(snap.total).toBe(0);
    expect(snap.bySource).toEqual({});
  });
});
