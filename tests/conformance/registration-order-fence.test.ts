/**
 * Registration-order fences (#797 — the #782 audit's fence batch).
 *
 * ── The pinned convention ──
 *
 * Buffered signals drain in **handler-registration order** on a fresh or
 * just-CAN'd run's first workflow task — and session/maestro/scheduler all
 * `continueAsNew` routinely, so the hazard window recurs for the lifetime
 * of an ensemble, not just at startup. For any producer→consumer signal
 * pair sharing workflow state (set X → cancel/remove/evaluate X), the
 * PRODUCER must register first; consumer-first turns an inverted drain
 * into a silent no-op against empty state (#777 was exactly this: a
 * buffered player report draining before its stage existed — permanently,
 * silently lost).
 *
 * Rules this file pins (architect disposition on #782):
 *  - S2 setStage → cancelStage, S3 setQualityGate → evaluateGateCriteria,
 *    S4 setWorktree → removeWorktree (session.ts); C1 addSchedule →
 *    removeSchedule (scheduler.ts): order is load-bearing — fence comments
 *    at both handlers + the order assertions below. S3 is the
 *    highest-value fence: one reorder away from a #777 repeat
 *    (`if (!gate) return` drops evaluations permanently).
 *  - V3: destroyUpdate's kill-window interleave fence (the
 *    "abandoned by setPhase('gone')" comment) must stay present.
 *  - KNOWN EXCEPTION: `playerReportSignal` registers BEFORE its producer
 *    `setStageSignal` — protected by the #777 reconciliation
 *    (`v0.27-stage-reconcile-reports`), NOT by order. Pinned as
 *    consumer-first so an accidental "fix" reordering it doesn't silently
 *    change which protection is load-bearing.
 *
 * ── Traps the convention names (adopted from the audit's caveats) ──
 *
 *  1. CONDUCTOR-HANDLER TRAP: conductor-only handlers register inside
 *     `if (isConductor)` AFTER all common handlers — by construction, any
 *     future COMMON handler consuming conductor-established state is
 *     consumer-first. Don't add one without a reconciliation.
 *  2. UPDATE-VS-SIGNAL DRAIN ORDER is not empirically pinned; pairs that
 *     would rely on it (claim→heartbeat/adapterExited/processingStart) are
 *     independently protected by minted-id guards. A compliant pair
 *     tolerates BOTH orders — commutativity, not ordering, is the goal.
 *
 * If this test fails because you moved a handler: stop — registration
 * order is wire-adjacent behavior here, not a refactor. Either restore the
 * order or bring a reconciliation (the #777 pattern) with architect
 * sign-off.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const WF = path.resolve(__dirname, '..', '..', 'src', 'workflows');

function read(file: string): string {
  return fs.readFileSync(path.join(WF, file), 'utf8');
}

/** Index of the FIRST `setHandler(<name>` occurrence; throws if absent. */
function regIndex(src: string, signalConst: string, file: string): number {
  const idx = src.indexOf(`setHandler(${signalConst}`);
  expect(idx, `setHandler(${signalConst}) not found in ${file}`).toBeGreaterThan(-1);
  return idx;
}

const ORDERED_PAIRS: ReadonlyArray<{
  file: string;
  producer: string;
  consumer: string;
  what: string;
}> = [
  {
    file: 'session.ts',
    producer: 'setQualityGateSignal',
    consumer: 'evaluateGateCriteriaSignal',
    what: 'S3 — quality gates (highest value: consumer-first = silent evaluation loss, a #777 repeat)',
  },
  {
    file: 'session.ts',
    producer: 'setStageSignal',
    consumer: 'cancelStageSignal',
    what: 'S2 — stages (consumer-first = lost cancellation, stage lands active)',
  },
  {
    file: 'session.ts',
    producer: 'setWorktreeSignal',
    consumer: 'removeWorktreeSignal',
    what: 'S4 — worktrees (consumer-first = removal no-ops, entry resurrected)',
  },
  {
    file: 'scheduler.ts',
    producer: 'addScheduleSignal',
    consumer: 'removeScheduleSignal',
    what: 'C1 — schedules (consumer-first = remove no-ops, schedule resurrected AND fires)',
  },
];

describe('registration-order fences (#797 / #782)', () => {
  for (const pair of ORDERED_PAIRS) {
    it(`${pair.file}: ${pair.producer} registers before ${pair.consumer} (${pair.what})`, () => {
      const src = read(pair.file);
      const p = regIndex(src, pair.producer, pair.file);
      const c = regIndex(src, pair.consumer, pair.file);
      expect(p, `${pair.producer} must register BEFORE ${pair.consumer} — see the fence comments`).toBeLessThan(c);
    });
  }

  it('both halves of every fenced pair carry the REGISTRATION-ORDER FENCE comment', () => {
    for (const pair of ORDERED_PAIRS) {
      const src = read(pair.file);
      for (const name of [pair.producer, pair.consumer]) {
        const idx = regIndex(src, name, pair.file);
        // The fence comment sits in the ~12 lines above the registration.
        const above = src.slice(Math.max(0, src.lastIndexOf('\n', idx) - 900), idx);
        expect(
          above.includes('REGISTRATION-ORDER FENCE'),
          `${pair.file}: setHandler(${name}) has no REGISTRATION-ORDER FENCE comment above it`,
        ).toBe(true);
      }
    }
  });

  it('V3: destroyUpdate kill-window interleave fence still present (session.ts)', () => {
    const src = read('session.ts');
    // The fence: late claim/processingStart during the destroy kill window
    // is "abandoned by setPhase('gone')" — pinned verbatim-ish so a rewrite
    // of the destroy handler keeps (or consciously replaces) the guard note.
    expect(src).toMatch(/abandoned by setPhase\('gone'\)/);
    expect(src).toMatch(/destroyRequested = true;/);
  });

  it('KNOWN EXCEPTION pinned: playerReportSignal (consumer) registers before setStageSignal — protected by reconciliation, not order', () => {
    const src = read('session.ts');
    const report = regIndex(src, 'playerReportSignal', 'session.ts');
    const setStage = regIndex(src, 'setStageSignal', 'session.ts');
    // If this flips, the #777 reconciliation becomes dead code and the
    // protection story changes — that's a conscious decision, not a drift.
    expect(report).toBeLessThan(setStage);
    expect(src).toMatch(/v0\.27-stage-reconcile-reports/);
  });

  it('C2 loudness: fireSchedule retry-exhaustion logs the lost fire (scheduler.ts)', () => {
    const src = read('scheduler.ts');
    expect(src).toMatch(/fire FAILED after activity retries/);
  });
});
