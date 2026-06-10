/**
 * Unit test for the headless graceful-exit core — `detachAllPiRuntimesForExit`
 * (src/pi/extension.ts), #645 H6 Part 2.
 *
 * detachAllPiRuntimesForExit iterates the module-scope `runtimes` map and, for
 * each runtime: `pub.stop()` + `reset.stop()` + `await wf.detach('agent-exited')`
 * (try/catch reaper-backstop on throw) → then `runtimes.clear()`.
 *
 * THE VALUE LOCKED: one player's detach FAILURE (a rejecting `wf.detach`) is
 * SWALLOWED — it must not propagate (the exit stays graceful, not a crash) AND
 * must not strand the other runtimes: `clear()` still runs. So a single bad
 * detach can neither crash the process exit nor leak runtimes.
 *
 * Pure: no Pi, no Temporal, no process — the module-scope map is reached only via
 * the ADR-0006 test hooks (__seedRuntimeForTests / __clearRuntimesForTests).
 */
import { expect } from 'chai';
import {
  detachAllPiRuntimesForExit,
  __seedRuntimeForTests,
  __clearRuntimesForTests,
} from '../src/pi/extension';

/** The rt param type (PiPlayerRuntime — not exported), pulled off the hook. */
type SeededRuntime = Parameters<typeof __seedRuntimeForTests>[1];

interface FakeCalls {
  pubStop: number;
  pumpStop: number;
  detachArgs: unknown[];
}

/**
 * A minimal fake runtime — detachAllPiRuntimesForExit only touches
 * `pub.stop` / `pump.stop` / `wf.detach`, so we mock just those. (The reset
 * poll merged into the cue pump — S3 — so pump.stop covers both intakes.)
 */
function fakeRuntime(opts: { detachRejects?: boolean } = {}): { rt: SeededRuntime; calls: FakeCalls } {
  const calls: FakeCalls = { pubStop: 0, pumpStop: 0, detachArgs: [] };
  const rt = {
    pub: { stop: () => { calls.pubStop += 1; } },
    pump: { stop: () => { calls.pumpStop += 1; } },
    wf: {
      detach: async (reason: unknown) => {
        calls.detachArgs.push(reason);
        if (opts.detachRejects) throw new Error('detach boom');
      },
    },
  };
  return { rt: rt as unknown as SeededRuntime, calls };
}

describe('detachAllPiRuntimesForExit — graceful exit (H6 #645)', () => {
  afterEach(() => __clearRuntimesForTests());

  it('stops pub+pump, detaches each with "agent-exited", and a throwing detach neither crashes the exit nor strands the others', async () => {
    const a = fakeRuntime({ detachRejects: false });
    const b = fakeRuntime({ detachRejects: true }); // player B's detach REJECTS
    __seedRuntimeForTests('wf-a', a.rt);
    __seedRuntimeForTests('wf-b', b.rt);

    // The rejecting detach (B) must be CAUGHT — the call RESOLVES, never rejects.
    let rejected = false;
    try {
      await detachAllPiRuntimesForExit();
    } catch {
      rejected = true;
    }
    expect(rejected, 'a throwing detach must be swallowed (reaper-backstop), not crash the exit').to.equal(false);

    // Every runtime had its publisher + cue/reset pump stopped exactly once.
    expect(a.calls.pubStop, 'A pub.stop').to.equal(1);
    expect(a.calls.pumpStop, 'A pump.stop').to.equal(1);
    expect(b.calls.pubStop, 'B pub.stop').to.equal(1);
    expect(b.calls.pumpStop, 'B pump.stop').to.equal(1);

    // Both detached with the 'agent-exited' reason.
    expect(a.calls.detachArgs, 'A detach reason').to.deep.equal(['agent-exited']);
    expect(b.calls.detachArgs, 'B detach reason').to.deep.equal(['agent-exited']);

    // KEY: clear() ran even though B threw. Proven behaviorally — a SECOND call
    // iterates an EMPTY map, so it performs NO further teardown on either runtime.
    await detachAllPiRuntimesForExit();
    expect(a.calls.pubStop, 'A pub.stop not called again → map was cleared').to.equal(1);
    expect(b.calls.pubStop, 'B pub.stop not called again → map was cleared').to.equal(1);
    expect(a.calls.detachArgs, 'A not detached again → map was cleared').to.have.length(1);
    expect(b.calls.detachArgs, 'B not detached again → map was cleared').to.have.length(1);
  });
});
