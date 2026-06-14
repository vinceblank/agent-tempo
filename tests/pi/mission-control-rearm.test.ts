/**
 * #826/#828 — fake-timer INTEGRATION test for the coarse-stream watchdog +
 * auto-re-arm wiring inside `createMissionControlExtension`. The pure decision
 * helpers (shouldRearmOnStreamEnd / rearmDelayMs / reconnectDetailForAttempt /
 * isCoarseStale) are unit-tested in `test/pi-mission-control-feedback.test.ts`;
 * this file drives the actual closure (setInterval watchdog + setTimeout re-arm +
 * the abort-before-reopen single-loop guarantee) with Vitest fake timers and a
 * mock `subscribe` generator injected via the `createSubscribeImpl` deps seam.
 *
 * The crux invariant under test: a watchdog-stale trip re-arms EXACTLY ONE new
 * coarse loop (subscribe called N times, never N+1), the prior loop is aborted
 * (so exactly one loop is alive), and a recovered stream flips back to `live`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMissionControlExtension } from '../../src/pi/mission-control/extension';
import type { createSubscribe } from '../../src/client/subscribe';
import type { TempoEvent } from '../../src/http/event-types';
import type { McExtensionAPI } from '../../src/pi/mission-control/pi-ui';

// ── Mock subscribe generators (one per coarse loop the closure opens) ────────

/** Resolve when the loop's AbortSignal fires (or immediately if already aborted). */
function waitAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((res) => {
    if (!signal || signal.aborted) return res();
    signal.addEventListener('abort', () => res(), { once: true });
  });
}

/** A wedged stream: yields NOTHING and never ends until aborted (half-open socket). */
const wedged = (signal?: AbortSignal): AsyncIterable<TempoEvent> => ({
  async *[Symbol.asyncIterator]() {
    await waitAbort(signal);
  },
});

/** A recovered stream: yields one snapshot event (→ `live`), then wedges. */
const liveThenWedged = (signal?: AbortSignal): AsyncIterable<TempoEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield { v: 1, eventId: '0:1', type: 'snapshot', payload: { players: [] } } as unknown as TempoEvent;
    await waitAbort(signal);
  },
});

/**
 * Build a `createSubscribeImpl` seam over a list of per-loop behaviours, and
 * record every loop's AbortSignal so a test can assert which loops are alive.
 */
function makeMockSubscribe(behaviours: Array<(s?: AbortSignal) => AsyncIterable<TempoEvent>>) {
  const calls: Array<{ signal?: AbortSignal }> = [];
  const createImpl = (() =>
    // The returned `subscribe(ensemble, opts)` — one invocation per coarse loop.
    (arg1?: unknown, arg2?: unknown): AsyncIterable<TempoEvent> => {
      const opts = (typeof arg1 === 'string' ? arg2 : arg1) as { signal?: AbortSignal } | undefined;
      const idx = calls.length;
      calls.push({ signal: opts?.signal });
      return behaviours[Math.min(idx, behaviours.length - 1)](opts?.signal);
    }) as unknown as typeof createSubscribe;
  return { createImpl, calls };
}

// ── Fake Pi (captures session_start + the rendered widget) ──────────────────

function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_k: string, lines: string[] | undefined) => { widgets.push(lines); },
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  };
  const pi = {
    on: (ev: string, h: (event: unknown, c: unknown) => void) => { handlers.set(ev, h); },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: () => {},
    sendMessage: () => {},
    fire: (ev: string) => handlers.get(ev)?.(undefined, ctx),
  };
  /** Latest non-undefined widget render, joined. */
  const lastWidget = (): string => {
    for (let i = widgets.length - 1; i >= 0; i--) {
      if (widgets[i]) return widgets[i]!.join('\n');
    }
    return '';
  };
  return { pi: pi as unknown as McExtensionAPI & { fire: (e: string) => void }, lastWidget };
}

function buildBoard(createImpl: typeof createSubscribe) {
  const { pi, lastWidget } = makeFakePi();
  const ext = createMissionControlExtension({
    role: 'command-center',
    ensemble: 'demo',
    adminToken: 'tok',
    baseUrl: 'http://127.0.0.1:9999', // never hit — subscribe is mocked
    renderThrottleMs: 50,
    createSubscribeImpl: createImpl,
  });
  ext(pi);
  return { pi, lastWidget };
}

describe('#826/#828 mission-control coarse-stream watchdog + re-arm (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic backoff: equal-jitter `b/2 + rand·b/2` with rand=0 → b/2
    // (attempt 0 → 500ms), so the re-arm fires well before the next 5s tick.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-arms EXACTLY ONE new loop after >35s silence, aborting the prior (single-loop invariant)', async () => {
    const { createImpl, calls } = makeMockSubscribe([wedged, wedged, wedged]);
    const { pi } = buildBoard(createImpl);

    pi.fire('session_start');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1); // loop #1 open

    // Silence past the 35s watchdog threshold (trip lands on the 40s tick:
    // isCoarseStale is `> 35_000`, so the 35s tick is exactly-at and does NOT
    // trip) + the ~0.5s re-arm backoff.
    await vi.advanceTimersByTimeAsync(41_000);

    // Watchdog tripped ONCE → re-armed ONE new loop. Not 3 (no double-loop,
    // no stacking — the rearmTimer guard + lastEventAt reset hold).
    expect(calls.length).toBe(2);
    expect(calls[0].signal?.aborted).toBe(true);  // prior loop aborted
    expect(calls[1].signal?.aborted).toBe(false); // new loop alive

    // Keep ticking WITHIN the fresh 35s window → no further loops.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBe(2);

    pi.fire('session_shutdown');
  });

  it('settles to [STREAM DOWN] after the ramp but NEVER stops re-arming', async () => {
    // Every loop wedges immediately-silent, so each 35s window re-arms again.
    const { createImpl, calls } = makeMockSubscribe([wedged]);
    const { pi, lastWidget } = buildBoard(createImpl);

    pi.fire('session_start');
    await vi.advanceTimersByTimeAsync(0);

    // Drive ~7 stale windows (each ≈40s trip + 0.5s backoff). After ≥5 failed
    // re-arms the wording settles to [STREAM DOWN]; re-arm keeps going.
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(41_000);
    }
    expect(calls.length).toBeGreaterThanOrEqual(7); // never gave up
    expect(lastWidget()).toContain('[STREAM DOWN]');

    pi.fire('session_shutdown');
  });

  it('returns to live when the re-armed stream recovers (counter reset, no stale banner)', async () => {
    const { createImpl, calls } = makeMockSubscribe([wedged, liveThenWedged]);
    const { pi, lastWidget } = buildBoard(createImpl);

    pi.fire('session_start');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    // Trip the watchdog → re-arm → loop #2 yields a snapshot → live.
    await vi.advanceTimersByTimeAsync(41_000);
    expect(calls.length).toBe(2);

    const w = lastWidget();
    expect(w).to.not.contain('[RECONNECTING]');
    expect(w).to.not.contain('[STREAM DOWN]');
    expect(w).to.not.contain('STREAM ENDED');
    expect(w).toContain('MISSION CONTROL');

    // No further re-arm — the recovered stream resets the watchdog clock.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBe(2);

    pi.fire('session_shutdown');
  });

  it('teardown stops the watchdog — no re-arm after session_shutdown', async () => {
    const { createImpl, calls } = makeMockSubscribe([wedged, wedged]);
    const { pi } = buildBoard(createImpl);

    pi.fire('session_start');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    pi.fire('session_shutdown'); // clears the watchdog interval + aborts the loop
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.length).toBe(1); // never re-armed after teardown
  });
});
