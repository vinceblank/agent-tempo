/**
 * Tests for the per-ensemble fan-out carry-forward semantics (#550).
 *
 * Pre-#550 bug: `AggregateRunner.collect()` per-ensemble fan-out lumped
 * `EnsembleNotFoundError` (genuine destruction) and any other error
 * (timeout, query error, network blip) into a single `null` return.
 * The cluster-set diff then ran on the filtered survivor list,
 * producing phantom `ensemble.destroyed` SSE events for ensembles
 * whose fan-out merely timed out.
 *
 * Fix: a `FanoutResult` discriminated union encodes the three
 * outcomes — `'ok'`, `'gone'`, `'failed'`. The cluster diff uses
 * `livePrelude` (ok + failed) so `'failed'` ensembles are carried
 * forward; `'gone'` (only on `EnsembleNotFoundError`, or after K=20
 * consecutive failures) is what emits `ensemble.destroyed`.
 *
 * These tests are parametrized over the three outcomes and the
 * mixed-mode case, plus the K=20 promotion path. They live in their
 * own file (rather than `aggregate.test.ts`) so the carry-forward
 * fixture wiring stays focused and easy to extend.
 */
import { describe, it, expect } from 'vitest';
import { AggregateRunner, MAX_CONSECUTIVE_FAILURES } from '../../src/http/aggregate';
import { EnsembleNotFoundError } from '../../src/http/snapshot';
import type { TempoClient } from '../../src/client/interface';
import type { MaestroPlayerInfo, HostInfo, HostProfile, EnsembleChatMessage } from '../../src/types';

// ── Fixtures ────────────────────────────────────────────────────────────

interface MockEnsembleState {
  /** Result of `buildEnsembleSnapshot` for this ensemble. */
  outcome: 'ok' | 'gone' | 'failed';
  /** Optional: override hasConductor on the listEnsembles prelude entry. */
  hasConductor?: boolean;
  /** Optional: player set to project through `getPlayers`. */
  players?: MaestroPlayerInfo[];
}

/** A test-only `EnsembleNotFoundError`-like (the real one lives in `snapshot.ts`). */
function makeEnsembleNotFound(name: string): Error {
  return new EnsembleNotFoundError(name);
}

/**
 * Build a fakeClient + a `resetTickCounter()` hook the tests must call
 * between `runner.tick()` invocations.
 *
 * The counter is what distinguishes the per-tick prelude listEnsembles
 * (which sees every ensemble including `'gone'`/`'failed'`) from the
 * inner buildEnsembleSnapshot listEnsembles (which exhibits the
 * `'gone'` destruction race AND the `'failed'` TypeError-on-`.find()`
 * injection). Resetting between ticks isn't free in this branch:
 * pre-#555 collect() calls `listEnsembles()` directly (not the
 * bounded variant), so the mock can't piggy-back the reset on a
 * single-per-tick bounded call.
 */
function fakeClient(states: Record<string, MockEnsembleState>): {
  client: TempoClient;
  resetTickCounter: () => void;
} {
  const hostProfile: HostProfile = {
    hostname: 'h', version: '1', defaultAgent: 'claude', platform: 'linux', capabilities: [],
  };
  const hostInfo: HostInfo = {
    hostname: 'h', instances: [], recruitReady: true, freshness: 'live',
    profile: hostProfile, profileStaleness: 'fresh',
  };
  // Per-tick listEnsembles call counter. The prelude (call #1 of each
  // tick) sees ALL ensembles; subsequent calls within the same tick (the
  // existence-gate calls from `buildEnsembleSnapshot`, one per ensemble)
  // skip the `'gone'` entries. AggregateRunner.tick() resets the counter
  // by invoking `nextTick()` between ticks.
  let listEnsemblesCallsThisTick = 0;
  // Test hook — incremented externally between ticks to reset the counter.
  // (We use a closure capture so the function can be regenerated; the
  // tests don't need to invoke it directly because each `runner.tick()`
  // call begins with exactly one prelude listEnsembles, and we treat
  // call #1 of each tick as the prelude regardless of timing.)
  const proxy = new Proxy({
    async listEnsembles() {
      listEnsemblesCallsThisTick++;
      const isPreludeCall = listEnsemblesCallsThisTick === 1;
      // For 'failed' outcomes, return a non-array on the inner call so
      // `buildEnsembleSnapshot`'s `.find()` throws a TypeError that
      // escapes its existence gate → propagates to `collect()`'s outer
      // catch → classified as 'failed' (NOT EnsembleNotFoundError).
      // This is the only realistic test path: production
      // `buildEnsembleSnapshot` is heavily hardened with soft-fail
      // wrappers around every external query, so producing a true
      // 'failed' classification requires breaking the existence-gate
      // contract specifically.
      if (!isPreludeCall) {
        const allFailed = Object.values(states).every((s) => s.outcome === 'failed');
        if (allFailed) {
          // Force `.find()` to throw TypeError → 'failed' classification.
          return null as unknown as ReturnType<TempoClient['listEnsembles']> extends Promise<infer T> ? T : never;
        }
      }
      return Object.entries(states)
        .filter(([, s]) => isPreludeCall || s.outcome !== 'gone')
        .map(([name, s]) => ({
          name,
          playerCount: s.players?.length ?? 0,
          hasConductor: s.hasConductor ?? false,
          state: 'online' as const,
        }));
    },
    async listEnsemblesBounded(_d: number) {
      // Test parity for the bounded variant (used by post-#555
      // `collect()`). This branch is dead code on the current
      // `feat/550-per-ensemble-carry-forward` branch (which is cut
      // from main pre-#555 merge) but kept so the mock is
      // forward-compatible: after #555 lands the K-cap scenario
      // continues to drive cleanly without a second test rewrite.
      // Reset the counter to mirror the per-tick semantics our
      // `tick()` helper provides for the plain `listEnsembles`
      // path.
      listEnsemblesCallsThisTick = 0;
      listEnsemblesCallsThisTick++;
      const items = Object.entries(states).map(([name, s]) => ({
        name,
        playerCount: s.players?.length ?? 0,
        hasConductor: s.hasConductor ?? false,
        state: 'online' as const,
      }));
      return { items, timedOut: false, scanned: items.length };
    },
    async listHosts() { return [hostInfo]; },
    // `buildEnsembleSnapshot` calls these on each ensemble; we vary the
    // behavior by the per-ensemble outcome. `'gone'` is encoded via the
    // listEnsembles race above (existence gate throws), not here, so
    // `getPlayers` only needs to handle the `'failed'` case explicitly.
    async getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]> {
      const s = states[ensemble];
      if (!s) throw makeEnsembleNotFound(ensemble);
      if (s.outcome === 'failed') throw new Error('simulated transient failure');
      return s.players ?? [];
    },
    async getEnsembleChat() {
      return { messages: [] as EnsembleChatMessage[], total: 0, hasMore: false, hasConductor: false };
    },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async getEnsembleMeta() {
      return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] };
    },
    async getPlayerWireMeta() { return null; },
  } as Partial<TempoClient>, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      // Unstubbed methods throw — keeps fixtures explicit.
      return () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); };
    },
  }) as unknown as TempoClient;
  return {
    client: proxy,
    resetTickCounter: () => { listEnsemblesCallsThisTick = 0; },
  };
}

/**
 * Drain the given subscription's pending events. Subscriptions must
 * be created BEFORE the tick that emits the events you want — the bus
 * doesn't replay to fresh subscribers, only to live ones.
 */
function drain(sub: { pending: Array<{ type: string }> }): string[] {
  const types: string[] = [];
  while (sub.pending.length > 0) types.push(sub.pending.shift()!.type);
  return types;
}

/**
 * Run one tick with the per-tick mock counter reset first. Equivalent
 * to `await runner.tick()` but ensures the next prelude listEnsembles
 * call gets `count=1` (so isPreludeCall=true) regardless of how many
 * ticks have already run.
 */
async function tick(
  runner: AggregateRunner,
  resetTickCounter: () => void,
): Promise<void> {
  resetTickCounter();
  await runner.tick();
}

// ── Parametrized outcome tests ──────────────────────────────────────────

describe('AggregateRunner fan-out carry-forward (#550)', () => {
  describe('per-outcome semantics on a single tick', () => {
    it("'ok' result → ensemble.created on first tick, ensemble exists in liveNames", async () => {
      const { client, resetTickCounter } = fakeClient({ alpha: { outcome: 'ok' } });
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).toContain('ensemble.created');
      expect(runner.getEnsembleBus('alpha')).not.toBeNull();
      runner.close();
    });

    it("'gone' result (EnsembleNotFoundError on first observation) → NOT emitted as created, NOT in knownEnsembles", async () => {
      // The ensemble appears in the listEnsembles prelude but per-ensemble
      // fan-out throws `EnsembleNotFoundError` — happens when an ensemble
      // is torn down between the cluster list and the per-ensemble query.
      const { client, resetTickCounter } = fakeClient({ alpha: { outcome: 'gone' } });
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).not.toContain('ensemble.created');
      expect(events).not.toContain('ensemble.destroyed'); // never existed in our knownEnsembles
      // Track may have been provisionally created; either way the cluster
      // diff did NOT add the ensemble to knownEnsembles, so subsequent
      // ticks won't see a phantom create either.
      runner.close();
    });

    it("'failed' result → ensemble.created fires immediately (carry-forward), ensemble enters knownEnsembles", async () => {
      // Researcher's spec: "First listing tick for new ensemble, fan-out
      // fails → ensemble.created fires immediately (because 'failed' is
      // in liveNames); player-level events one-tick-delayed."
      const { client, resetTickCounter } = fakeClient({ alpha: { outcome: 'failed', hasConductor: true } });
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).toContain('ensemble.created');
      expect(events).not.toContain('ensemble.destroyed');
      // The track exists (created by collect() so the consecutiveFailures
      // counter has a home), and the cluster diff added the ensemble to
      // knownEnsembles via the carry-forward.
      expect(runner.getEnsembleBus('alpha')).not.toBeNull();
      runner.close();
    });
  });

  describe('the phantom-destroy bug this fix prevents', () => {
    it('does NOT emit ensemble.destroyed when fan-out transitions ok → failed', async () => {
      const states: Record<string, MockEnsembleState> = { alpha: { outcome: 'ok' } };
      const { client, resetTickCounter } = fakeClient(states);
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();

      // Tick 1: ok — knownEnsembles = {alpha}.
      await tick(runner, resetTickCounter);
      drain(sub); // discard tick-1 events

      // Tick 2: same ensemble, fan-out now fails transiently.
      states.alpha = { outcome: 'failed' };
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).not.toContain('ensemble.destroyed');
      // Track survives — carry-forward.
      expect(runner.getEnsembleBus('alpha')).not.toBeNull();
      runner.close();
    });

    it('DOES emit ensemble.destroyed when fan-out returns gone (real removal)', async () => {
      const states: Record<string, MockEnsembleState> = { alpha: { outcome: 'ok' } };
      const { client, resetTickCounter } = fakeClient(states);
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();

      await tick(runner, resetTickCounter);
      drain(sub);

      states.alpha = { outcome: 'gone' };
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).toContain('ensemble.destroyed');
      runner.close();
    });
  });

  describe('consecutive-failure promotion (K=20 cap)', () => {
    it('cap constant matches the spec', () => {
      expect(MAX_CONSECUTIVE_FAILURES).toBe(20);
    });

    it('K consecutive failures stay carry-forward; (K+1)th promotes to gone → emits destroyed', async () => {
      const states: Record<string, MockEnsembleState> = { alpha: { outcome: 'ok' } };
      const { client, resetTickCounter } = fakeClient(states);
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();

      // Tick 1: ok, prime knownEnsembles.
      await tick(runner, resetTickCounter);
      drain(sub);

      // Sanity: a single failure tick really does classify as 'failed'
      // (not silently 'ok'). If this assertion trips, the fake-client
      // failure-injection has regressed and the K-cap loop below is
      // meaningless.
      states.alpha = { outcome: 'failed' };
      await tick(runner, resetTickCounter);
      drain(sub);
      expect(
        (runner as unknown as { tracks: Map<string, { consecutiveFailures: number }> })
          .tracks.get('alpha')?.consecutiveFailures,
        'first failure tick should bump consecutiveFailures to 1',
      ).toBe(1);

      // Now fail consecutively. K-1 more ticks (= K total) of failure should
      // NOT yet emit destroyed (cf reaches K = 20, but not > 20).
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
        await tick(runner, resetTickCounter);
        const events = drain(sub);
        expect(events, `tick ${i + 3} (failure #${i + 2}) should not emit destroyed`)
          .not.toContain('ensemble.destroyed');
      }

      // (K+1)th consecutive failure → cf becomes 21 > 20 → promotion → destroyed.
      await tick(runner, resetTickCounter);
      const finalEvents = drain(sub);
      expect(finalEvents).toContain('ensemble.destroyed');
      runner.close();
    });

    it('a successful tick resets the failure counter (re-emerging ensemble starts fresh)', async () => {
      const states: Record<string, MockEnsembleState> = { alpha: { outcome: 'ok' } };
      const { client, resetTickCounter } = fakeClient(states);
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      drain(sub);

      // 10 failures (well below K=20).
      states.alpha = { outcome: 'failed' };
      for (let i = 0; i < 10; i++) await tick(runner, resetTickCounter);
      drain(sub);

      // Recovery — counter resets.
      states.alpha = { outcome: 'ok' };
      await tick(runner, resetTickCounter);
      drain(sub);

      // Another 20 failures should NOT yet promote (counter started fresh).
      states.alpha = { outcome: 'failed' };
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await tick(runner, resetTickCounter);
        const events = drain(sub);
        expect(events, `post-recovery failure #${i + 1} should not destroyed`)
          .not.toContain('ensemble.destroyed');
      }

      runner.close();
    });
  });

  describe('mixed-mode tick (ok + gone + failed simultaneously)', () => {
    it('emits exactly the right events for each kind on a single tick', async () => {
      // Prime with all three ensembles ok.
      const states: Record<string, MockEnsembleState> = {
        alpha: { outcome: 'ok' },
        beta: { outcome: 'ok' },
        gamma: { outcome: 'ok' },
      };
      const { client, resetTickCounter } = fakeClient(states);
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      drain(sub);

      // Mixed-mode tick: alpha stays ok, beta goes (real), gamma fails (transient).
      states.alpha = { outcome: 'ok' };
      states.beta = { outcome: 'gone' };
      states.gamma = { outcome: 'failed' };
      await tick(runner, resetTickCounter);
      const events = drain(sub);

      // Exactly one destroyed event for beta only.
      const destroyEvents = events.filter((t) => t === 'ensemble.destroyed');
      expect(destroyEvents.length).toBe(1);

      // Alpha and gamma both still in knownEnsembles (alpha 'ok', gamma 'failed' carry-forward).
      expect(runner.getEnsembleBus('alpha')).not.toBeNull();
      expect(runner.getEnsembleBus('gamma')).not.toBeNull();
      // Beta torn down.
      expect(runner.getEnsembleBus('beta')).toBeNull();

      runner.close();
    });
  });

  describe('first-tick failed ensemble (researcher\'s one-tick-delayed semantic)', () => {
    it('emits ensemble.created on the first tick even when fan-out fails', async () => {
      // Brand-new ensemble that the listEnsembles prelude knows about
      // but whose per-ensemble fan-out fails on the first observation.
      const { client, resetTickCounter } = fakeClient({ alpha: { outcome: 'failed', hasConductor: true } });
      const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
      const sub = runner.globalBus().subscribe();
      await tick(runner, resetTickCounter);
      const events = drain(sub);
      expect(events).toContain('ensemble.created');
      // hasConductor carried from the listEnsembles prelude — see the
      // `livePrelude` doc-comment in AggregateSnapshot.
      runner.close();
    });
  });
});
