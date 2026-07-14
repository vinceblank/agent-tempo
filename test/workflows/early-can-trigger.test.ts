/**
 * PR-E (daemon-resilience) — unit tests for the pure early-CAN predicate.
 *
 * `shouldEarlyCan` lives in `src/workflows/attachment-math.ts` (the
 * Temporal-free CAN-math module, same rationale as #127's
 * `extendAttachmentForCAN`): a history-fill harness that actually emits
 * >2,000 events to trip the threshold would test event plumbing, not our
 * decision logic, and take minutes. The workflow-side integration —
 * `patched('v2.0-early-can') && shouldEarlyCan(info.historyLength,
 * info.historySize)` feeding the production CAN branch — is a one-line
 * composition whose CAN path is exercised by `test/early-can-carry.test.ts`
 * and `test/adapter-reconnect.test.ts` (#226).
 *
 * Threshold rationale (RCA docs/research/daemon-query-timeout-rca.md):
 * sessions grow ~200 events/h at idle and the server's own suggestion
 * (~10,240 events / ~10 MB) effectively never fired — cll-devops reached
 * 4,661 events / 886 KB in 23 h and its full-history replay killed the
 * daemon on 2026-07-13. 2,000 events / 2 MB bounds replay at ~10 h idle.
 */
import { expect } from 'chai';
import {
  shouldEarlyCan,
  EARLY_CAN_HISTORY_EVENTS,
  EARLY_CAN_HISTORY_BYTES,
} from '../../src/workflows/attachment-math';

describe('shouldEarlyCan (PR-E)', function () {
  it('pins the ruled thresholds — 2,000 events / 2 MB', function () {
    // Deliberate constant-pinning: these numbers are load-bearing incident
    // math (see file header). Changing them must be a conscious decision
    // that updates this test, not a drive-by.
    expect(EARLY_CAN_HISTORY_EVENTS).to.equal(2_000);
    expect(EARLY_CAN_HISTORY_BYTES).to.equal(2_000_000);
  });

  it('false for a young history', function () {
    expect(shouldEarlyCan(10, 5_000)).to.equal(false);
  });

  it('false exactly AT both thresholds (strict >)', function () {
    expect(shouldEarlyCan(EARLY_CAN_HISTORY_EVENTS, EARLY_CAN_HISTORY_BYTES)).to.equal(false);
  });

  it('true one past the event threshold, bytes small', function () {
    expect(shouldEarlyCan(EARLY_CAN_HISTORY_EVENTS + 1, 0)).to.equal(true);
  });

  it('true one past the byte threshold, events small', function () {
    expect(shouldEarlyCan(0, EARLY_CAN_HISTORY_BYTES + 1)).to.equal(true);
  });

  it('true when both are past (no XOR surprises)', function () {
    expect(shouldEarlyCan(5_000, 5_000_000)).to.equal(true);
  });

  it('the 2026-07-13 incident shape trips it: 4,661 events / 886 KB', function () {
    // cll-devops at crash time — the exact history that killed the daemon
    // must trigger early CAN under the new predicate (via the event arm;
    // its byte size alone would not have).
    expect(shouldEarlyCan(4_661, 886_000)).to.equal(true);
    expect(shouldEarlyCan(0, 886_000)).to.equal(false);
  });
});
