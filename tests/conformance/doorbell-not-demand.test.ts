/**
 * A DOORBELL IS NOT DEMAND (T1.1 PR-1 conformance — the design doc's §3
 * single most important integration rule, docs/design/t11-cue-doorbell.md).
 *
 * Doorbell connections live on the DoorbellRegistry, NOT the
 * EnsembleEventBus. If they ever counted as demand, every idle player
 * holding a doorbell open would pin `totalSubscriberCount() > 0` 24/7 and
 * erase Tier 0's wins: the T0.4 demand gate (#764 — the aggregate poll
 * stretches/skips with zero subscribers) and the T0.1 presence gate (#759 —
 * `observersPresent` keys maestro cadence on the same count via
 * `ObserverPresenceSource`).
 *
 * Three fences:
 *   1. Behavioral — doorbell subscriptions + rings leave the aggregate's
 *      `totalSubscriberCount()` at zero (the exact closure the daemon wires
 *      into `observerPresence.current`).
 *   2. Structural — the demand/board plane (`aggregate.ts`, `event-bus.ts`)
 *      never references the doorbell, and the doorbell module never imports
 *      the bus/aggregate.
 *   3. Wiring — `daemon.ts` fills `observerPresence.current` from the
 *      AggregateRunner, not from anything doorbell-shaped.
 *
 * If this test fails because you wired doorbells into the bus or the
 * subscriber count: stop — that is a design violation requiring architect
 * sign-off (t11 doc §3, T0.4 row), not a refactor.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { AggregateRunner } from '../../src/http/aggregate';
import { DoorbellRegistry } from '../../src/http/doorbell';
import { sessionWorkflowId } from '../../src/config';
import type { TempoClient } from '../../src/client/interface';

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Minimal client — the runner never ticks in this test. */
function inertClient(): TempoClient {
  return new Proxy({}, {
    get: (_t, prop) => () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); },
  }) as unknown as TempoClient;
}

describe('doorbell is NOT demand (t11 §3 hard rule)', () => {
  it('doorbell subscriptions and rings never move the aggregate subscriber count', () => {
    const runner = new AggregateRunner({ client: inertClient(), bootEpoch: 1, pollIntervalMs: 60_000 });
    const doorbells = new DoorbellRegistry();

    // The daemon wires observer presence as exactly this closure
    // (src/daemon.ts: `observerPresence.current = () => runner.totalSubscriberCount()`).
    const observersPresent = (): boolean => runner.totalSubscriberCount() > 0;

    expect(runner.totalSubscriberCount()).toBe(0);
    expect(observersPresent()).toBe(false);

    // An idle fleet holding doorbells open — the §3 T0.4 nightmare scenario.
    const subs = Array.from({ length: 8 }, (_, i) =>
      doorbells.subscribe(sessionWorkflowId('demo', `player-${i}`)),
    );
    for (let i = 0; i < 8; i++) doorbells.ring('demo', `player-${i}`);

    // Doorbell traffic is invisible to the demand machinery.
    expect(doorbells.totalSubscriberCount()).toBe(8);
    expect(runner.totalSubscriberCount()).toBe(0);
    expect(observersPresent()).toBe(false);

    for (const s of subs) s.close();
    doorbells.close();
  });

  it('structural: the demand/board plane and the doorbell never reference each other', () => {
    // The bus/aggregate side must not know doorbells exist …
    expect(read('http/aggregate.ts')).not.toMatch(/doorbell/i);
    expect(read('http/event-bus.ts')).not.toMatch(/doorbell/i);
    // … and the doorbell side must not IMPORT the bus/aggregate (doc
    // comments may name them — they explain this very rule).
    const doorbell = read('http/doorbell.ts') + read('http/doorbell-routes.ts');
    expect(doorbell).not.toMatch(/from '\.\/(event-bus|aggregate)'/);
  });

  it('wiring: daemon fills observerPresence from the AggregateRunner, not the doorbell', () => {
    const daemon = read('daemon.ts');
    expect(daemon).toMatch(/observerPresence\.current = \(\) => runner\.totalSubscriberCount\(\)/);
    // Defensive: no doorbell-derived presence assignment anywhere.
    expect(daemon).not.toMatch(/observerPresence\.current[^\n]*doorbell/i);
  });
});
