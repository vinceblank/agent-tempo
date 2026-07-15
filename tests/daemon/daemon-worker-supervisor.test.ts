/**
 * PR-D (2026-07-13 daemon-resilience program) — unit tests for the
 * per-worker supervisor state machine (`src/daemon-worker-supervisor.ts`).
 *
 * Everything time/IO-shaped is injected, so these run on a virtual clock
 * with fake workers — no Temporal server, no real timers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  superviseWorker,
  supervisorBackoffMs,
  fatalMessageOf,
  WorkerHealthRegistry,
  setGlobalWorkerHealthRegistry,
  getGlobalWorkerHealthRegistry,
  __resetGlobalWorkerHealthRegistryForTests,
  FATAL_MESSAGE_MAX_CHARS,
  type SupervisedWorker,
  type WorkerFactoryResult,
  type SuperviseWorkerOpts,
  type GiveUpInfo,
} from '../../src/daemon-worker-supervisor';

// ── Harness ───────────────────────────────────────────────────────────────

/** Virtual clock: `sleep` advances time instantly (deterministic, no timers). */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface FakeWorkerScript {
  /** What run() does: 'reject' (fatal), 'resolve' (settle cleanly), or 'hang'
   *  (stay pending until shutdown() — models a healthy polling worker). */
  run: 'reject' | 'resolve' | 'hang';
  /** Virtual ms the run lasts before settling (advanced on the clock). */
  runForMs?: number;
  error?: unknown;
}

function makeFakeWorker(
  script: FakeWorkerScript,
  clock: ReturnType<typeof makeClock>,
  isShuttingDown: () => boolean,
): SupervisedWorker & { shutdownCalls: number } {
  const worker = {
    shutdownCalls: 0,
    async run() {
      if (script.runForMs) clock.advance(script.runForMs);
      if (script.run === 'hang') {
        // Model a healthy poller: settle only once the daemon requests drain.
        // The supervisor's own loop never spins here — resolve on the next
        // microtask once the latch flips (tests flip it synchronously first).
        while (!isShuttingDown()) await Promise.resolve();
        return;
      }
      if (script.run === 'reject') throw script.error ?? new Error('boom');
    },
    shutdown() {
      worker.shutdownCalls += 1;
    },
  };
  return worker;
}

/** Build opts with a scripted sequence of factory results. */
function makeHarness(scripts: Array<FakeWorkerScript | 'create-fails'>, overrides: Partial<SuperviseWorkerOpts> = {}) {
  const clock = makeClock();
  let shuttingDown = false;
  const health = new WorkerHealthRegistry();
  const closes: number[] = [];
  const factoryCalls: number[] = [];
  const replaced: SupervisedWorker[] = [];
  const giveUps: GiveUpInfo[] = [];
  const logs: string[] = [];
  let scriptIdx = 0;

  const isShuttingDown = () => shuttingDown;
  const nextResult = (): WorkerFactoryResult => {
    const script = scripts[Math.min(scriptIdx, scripts.length - 1)];
    scriptIdx += 1;
    if (script === 'create-fails') throw new Error('connect refused');
    return {
      worker: makeFakeWorker(script, clock, isShuttingDown),
      connection: {
        close: async () => {
          closes.push(clock.now());
        },
      },
    };
  };

  const opts: SuperviseWorkerOpts = {
    name: 'shared',
    factory: async () => {
      factoryCalls.push(clock.now());
      return nextResult();
    },
    isShuttingDown,
    health,
    onWorkerReplaced: (w) => replaced.push(w),
    onGiveUp: (info) => giveUps.push(info),
    now: clock.now,
    sleep: clock.sleep,
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    ...overrides,
  };

  return {
    opts,
    clock,
    health,
    closes,
    factoryCalls,
    replaced,
    giveUps,
    logs,
    requestShutdown: () => {
      shuttingDown = true;
    },
  };
}

afterEach(() => {
  __resetGlobalWorkerHealthRegistryForTests();
});

// ── Budget + restart behavior ─────────────────────────────────────────────

describe('superviseWorker — restart on fatal', () => {
  it('gives up after maxRestarts failures inside the rolling window', async () => {
    const h = makeHarness([{ run: 'reject' }]);
    const outcome = await superviseWorker(h.opts);

    expect(outcome).toBe('gave-up');
    // 6 factory creates (initial + 5 rebuilds), 6 fatal failures, give-up on the 6th.
    expect(h.factoryCalls.length).toBe(6);
    expect(h.giveUps).toHaveLength(1);
    expect(h.giveUps[0]).toMatchObject({ worker: 'shared', restarts: 5 });
    expect(h.giveUps[0].lastFatalMessage).toContain('boom');
    expect(h.health.snapshot().shared.state).toBe('gave-up');
    expect(h.health.snapshot().shared.restarts).toBe(5);
    // Every dead worker's connection was released.
    expect(h.closes.length).toBe(6);
    // The give-up is loud and greppable.
    expect(h.logs.some((l) => l.includes('[agent-tempo:ALARM]') && l.includes('gave up'))).toBe(true);
  });

  it('a run that survives healthyResetMs clears the budget (daily transient never accumulates)', async () => {
    // Every run lasts longer than healthyResetMs before failing — the window
    // resets each time, so the supervisor never gives up. Stop the test by
    // requesting shutdown after N cycles via the factory hook.
    const h = makeHarness([{ run: 'reject', runForMs: 11 * 60 * 1000 }]);
    let cycles = 0;
    const innerFactory = h.opts.factory;
    h.opts.factory = async () => {
      cycles += 1;
      if (cycles > 20) h.requestShutdown(); // far beyond the 5-restart budget
      return innerFactory();
    };
    const outcome = await superviseWorker(h.opts);

    expect(outcome).toBe('shutdown');
    expect(h.giveUps).toHaveLength(0);
    expect(cycles).toBeGreaterThan(20);
  });

  it('a clean run() resolve WITHOUT a requested shutdown is treated as fatal', async () => {
    const h = makeHarness([{ run: 'resolve' }]);
    const outcome = await superviseWorker(h.opts);

    expect(outcome).toBe('gave-up'); // resolves repeatedly → budget exhausts
    expect(h.giveUps[0].lastFatalMessage).toContain('resolved without a requested shutdown');
  });

  it('cumulative restarts keep counting across healthy resets', async () => {
    const h = makeHarness([{ run: 'reject', runForMs: 11 * 60 * 1000 }]);
    let cycles = 0;
    const innerFactory = h.opts.factory;
    h.opts.factory = async () => {
      cycles += 1;
      if (cycles > 3) h.requestShutdown();
      return innerFactory();
    };
    await superviseWorker(h.opts);
    // 3 completed fatal cycles → 3 rebuild attempts recorded, even though the
    // rolling window was cleared each time.
    expect(h.health.snapshot().shared.restarts).toBeGreaterThanOrEqual(3);
  });
});

// ── Reconnect-forever posture (ruling §2 Q1) ──────────────────────────────

describe('superviseWorker — create failures', () => {
  it('create failures reconnect forever and never consume the restart budget', async () => {
    // 50 consecutive create failures (10× the budget), then a worker that
    // hangs until shutdown. If create failures were budgeted this would
    // give up long before reaching the healthy worker.
    const scripts: Array<FakeWorkerScript | 'create-fails'> = [
      ...Array.from({ length: 50 }, () => 'create-fails' as const),
      { run: 'hang' },
    ];
    const h = makeHarness(scripts);
    const supervision = superviseWorker(h.opts);

    // Let the loop chew through the failures on the virtual clock, then
    // request shutdown once the healthy worker is running.
    while (h.replaced.length === 0) await Promise.resolve();
    expect(h.health.snapshot().shared.state).toBe('running');
    h.requestShutdown();
    const outcome = await supervision;

    expect(outcome).toBe('shutdown');
    expect(h.giveUps).toHaveLength(0);
    expect(h.factoryCalls.length).toBe(51);
    expect(h.health.snapshot().shared.restarts).toBe(0); // reconnects ≠ restarts
  });

  it('reports reconnecting state while creates fail, with rate-limited beacons', async () => {
    const scripts: Array<FakeWorkerScript | 'create-fails'> = [
      'create-fails',
      'create-fails',
      'create-fails',
      { run: 'hang' },
    ];
    const h = makeHarness(scripts);
    let sawReconnecting = false;
    const innerFactory = h.opts.factory;
    h.opts.factory = async () => {
      if (h.health.snapshot().shared.state === 'reconnecting') sawReconnecting = true;
      return innerFactory();
    };
    const supervision = superviseWorker(h.opts);
    while (h.replaced.length === 0) await Promise.resolve();
    h.requestShutdown();
    await supervision;

    expect(sawReconnecting).toBe(true);
    // Beacon fired (first failure always logs) but is rate-limited: 3 rapid
    // failures on the virtual clock produce fewer beacons than failures.
    const beacons = h.logs.filter((l) => l.includes('cannot be created'));
    expect(beacons.length).toBeGreaterThanOrEqual(1);
    expect(beacons.length).toBeLessThan(3);
    expect(beacons[0]).toContain('will not give up');
  });
});

// ── Shutdown interplay ────────────────────────────────────────────────────

describe('superviseWorker — shutdown paths', () => {
  it('returns shutdown when the latch is already set', async () => {
    const h = makeHarness([{ run: 'hang' }]);
    h.requestShutdown();
    expect(await superviseWorker(h.opts)).toBe('shutdown');
    expect(h.factoryCalls).toHaveLength(0);
  });

  it('a requested drain during a healthy run returns shutdown and closes the connection', async () => {
    const h = makeHarness([{ run: 'hang' }]);
    const supervision = superviseWorker(h.opts);
    while (h.replaced.length === 0) await Promise.resolve();
    h.requestShutdown(); // hang-worker resolves once the latch flips
    const outcome = await supervision;

    expect(outcome).toBe('shutdown');
    expect(h.closes.length).toBe(1);
    expect(h.giveUps).toHaveLength(0);
  });

  it('a shutdown requested during restart backoff aborts the wait', async () => {
    // First run fails; during the backoff sleep the daemon requests drain.
    const h = makeHarness([{ run: 'reject' }, { run: 'hang' }]);
    const baseSleep = h.opts.sleep!;
    let sleeps = 0;
    h.opts.sleep = async (ms: number) => {
      sleeps += 1;
      if (sleeps === 2) h.requestShutdown(); // inside the sliced backoff wait
      await baseSleep(ms);
    };
    const outcome = await superviseWorker(h.opts);

    expect(outcome).toBe('shutdown');
    expect(h.factoryCalls.length).toBe(1); // no rebuild after the aborted wait
  });

  it('uses the initial handle without calling the factory', async () => {
    const clockOwner = makeHarness([{ run: 'hang' }]);
    const initial: WorkerFactoryResult = {
      worker: makeFakeWorker({ run: 'hang' }, clockOwner.clock, () => false),
      connection: { close: async () => { /* noop */ } },
    };
    // Rebind the initial worker's latch to this harness's latch:
    const h = makeHarness([{ run: 'hang' }]);
    initial.worker = makeFakeWorker({ run: 'hang' }, h.clock, h.opts.isShuttingDown);
    h.opts.initial = initial;

    const supervision = superviseWorker(h.opts);
    while (h.replaced.length === 0) await Promise.resolve();
    expect(h.factoryCalls).toHaveLength(0); // initial consumed, factory untouched
    h.requestShutdown();
    expect(await supervision).toBe('shutdown');
  });

  it('calls ensureRuntimeInstalled before rebuilds but not for the initial handle', async () => {
    const h = makeHarness([{ run: 'reject' }, { run: 'hang' }]);
    const installs: number[] = [];
    h.opts.ensureRuntimeInstalled = () => installs.push(h.clock.now());
    h.opts.initial = {
      worker: makeFakeWorker({ run: 'reject' }, h.clock, h.opts.isShuttingDown),
      connection: { close: async () => { /* noop */ } },
    };
    const supervision = superviseWorker(h.opts);
    while (h.replaced.length < 2) await Promise.resolve();
    expect(installs.length).toBe(1); // once, for the single rebuild
    h.requestShutdown();
    await supervision;
  });
});

// ── Helpers + registry ────────────────────────────────────────────────────

describe('supervisorBackoffMs', () => {
  it('doubles from base and caps', () => {
    expect(supervisorBackoffMs(0)).toBe(1_000);
    expect(supervisorBackoffMs(1)).toBe(2_000);
    expect(supervisorBackoffMs(4)).toBe(16_000);
    expect(supervisorBackoffMs(5)).toBe(30_000); // capped
    expect(supervisorBackoffMs(60)).toBe(30_000); // no overflow at high retries
  });
});

describe('fatalMessageOf', () => {
  it('formats Error name+message and truncates at the cap', () => {
    expect(fatalMessageOf(new RangeError('nope'))).toBe('RangeError: nope');
    expect(fatalMessageOf('plain')).toBe('plain');
    const long = fatalMessageOf(new Error('x'.repeat(FATAL_MESSAGE_MAX_CHARS * 2)));
    expect(long.length).toBeLessThanOrEqual(FATAL_MESSAGE_MAX_CHARS + 1); // +1 for the ellipsis
  });
});

describe('WorkerHealthRegistry', () => {
  it('starts both workers as reconnecting and snapshots by value', () => {
    const reg = new WorkerHealthRegistry();
    const snap = reg.snapshot();
    expect(snap.shared.state).toBe('reconnecting');
    expect(snap.host.state).toBe('reconnecting');
    snap.shared.state = 'gave-up'; // mutating the snapshot must not leak back
    expect(reg.snapshot().shared.state).toBe('reconnecting');
  });

  it('global set/get/reset round-trips (the /v1/health seam)', () => {
    expect(getGlobalWorkerHealthRegistry()).toBeNull();
    const reg = new WorkerHealthRegistry();
    setGlobalWorkerHealthRegistry(reg);
    expect(getGlobalWorkerHealthRegistry()).toBe(reg);
    __resetGlobalWorkerHealthRegistryForTests();
    expect(getGlobalWorkerHealthRegistry()).toBeNull();
  });

  it('records fatals and restarts per worker', () => {
    const reg = new WorkerHealthRegistry();
    reg.recordFatal('shared', 'IllegalStateError: Worker still in use', '2026-07-13T12:32:53.000Z');
    reg.recordRestart('shared');
    reg.setState('shared', 'restarting');
    const snap = reg.snapshot();
    expect(snap.shared).toMatchObject({
      state: 'restarting',
      restarts: 1,
      lastFatalAt: '2026-07-13T12:32:53.000Z',
      lastFatalMessage: 'IllegalStateError: Worker still in use',
    });
    expect(snap.host).toMatchObject({ state: 'reconnecting', restarts: 0 });
  });
});
