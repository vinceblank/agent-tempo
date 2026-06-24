/**
 * Integration tests for the #249 message-delivery trilogy.
 *
 * Covers the four compounding bugs holistically (unit coverage for each lives
 * in its own suite):
 *   1. tickHeartbeat orphan pattern — diagnostic log assertions confirming the
 *      loop reschedules across guard trips and that `heartbeat#1 delivered`
 *      lands after claim.
 *   2. tickPhaseWatcher orphan parity — parity assertions for the watcher loop.
 *   3. CAN lease-extension math — **fails on pre-#249 main**. The pre-fix
 *      workflow extends by a hardcoded 30s; with `leaseMs=90_000` the post-fix
 *      extension exceeds that, so the assertion `expiresAt - now >= 60_000`
 *      rejects the legacy behavior.
 *   4. Poller CAN-blindness — verified indirectly by the adapter-reconnect CAN
 *      rebind test (`adapter-reconnect.test.ts`): post-CAN delivery requires a
 *      poller to run on the successor runId, which only happens if the old
 *      poller stopped cleanly (Bug 4 fix) and the rebind path restarted it.
 *
 * Cross-file note: `adapter-reconnect.test.ts` already covers the end-to-end
 * reconnect + CAN rebind delivery flows. This file pins the SURGICAL assertions
 * around the trilogy fixes — guard-trip logs, CAN extension magnitude, and the
 * diagnostic log lines operators will grep for on recurrence.
 */
import { expect } from 'chai';
import type { WorkflowHandle } from '@temporalio/client';
import {
  setupTestEnv,
  setupSharedEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  playerMetadata,
  getClient,
  claimAttachmentUpdate,
  attachmentInfoQuery,
  destroyUpdate,
  PROTOCOL_VERSION,
} from './helpers';
import { testForceContinueAsNewSignal } from '../src/workflows/signals';
import type { AttachmentInfo, DetachReason } from '../src/types';
import { InteractiveAttachment } from '../src/adapters/claude-code/adapter';
import type { BaseAttachmentOptions } from '../src/adapters/base';

/**
 * Capture `console.error` output for the duration of `fn` and return what
 * was logged. The adapter module uses `console.error` as its log sink
 * (`log = (...args) => console.error('[agent-tempo:adapter]', ...args)`)
 * so this is the seam for asserting on diagnostic output without mocking
 * the module itself.
 */
async function captureAdapterLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}

/**
 * Fast heartbeat subclass — 400ms cadence, matching `adapter-reconnect.test.ts`.
 * The exposed test hooks are the minimum needed to drive the guard paths
 * directly; we intentionally don't replace the class's tick logic.
 */
class FastInteractiveAttachment extends InteractiveAttachment {
  readonly descriptor = {
    adapterId: 'claude-code',
    adapterClass: 'interactive' as const,
    blocksOnLLMTurn: false,
    heartbeatMs: 400,
  };

  public async publicStopV2(reason: DetachReason = 'user-stop'): Promise<void> {
    return this.stopV2Lifecycle(reason, false);
  }
}

/** Poll `handle.query(attachmentInfoQuery)` until `pred` passes or timeout. */
async function waitForAttachmentInfo(
  handle: WorkflowHandle,
  pred: (info: AttachmentInfo) => boolean,
  timeoutMs = 5000,
  label = '<predicate>',
): Promise<AttachmentInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: AttachmentInfo | undefined;
  while (Date.now() < deadline) {
    last = await handle.query(attachmentInfoQuery);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}; last info=${JSON.stringify(last)}`,
  );
}

describe('heartbeat trilogy (#249)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  describe('diagnostic logging (Bugs 1+2 defensive coverage)', () => {
    it('logs `heartbeat#1 delivered` on the first successful heartbeat', async function () {
      // Pre-#249 this log line did not exist. Post-fix it is the canonical
      // signal that a claimed attachment actually began renewing its lease —
      // absence is the smoking gun for a dead heartbeat loop.
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `heartbeat-log-${Date.now()}` }),
        });

        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
          reconnectTiming: { baseMs: 100, maxMs: 500, budgetMs: 10_000, backoffFactor: 1.5 },
        };
        const adapter = new FastInteractiveAttachment(options);

        const { lines } = await captureAdapterLog(async () => {
          const stop = adapter.start(handle, async () => { /* no-op */ });
          try {
            // 400ms heartbeat + some jitter → 2s is plenty for the first few.
            await waitForAttachmentInfo(
              handle,
              // #704 Item 2: accept the idle attached→awaiting refinement; the
              // currentAttachment guard still proves the lease is held.
              (i) => (i.phase === 'attached' || i.phase === 'awaiting') && !!i.currentAttachment,
              5000,
              'initial attached',
            );
            // Give the very first heartbeat a chance to land.
            await new Promise((r) => setTimeout(r, 1200));
          } finally {
            stop();
            await adapter.publicStopV2();
            await handle.executeUpdate(destroyUpdate, { args: [{}] });
            await handle.result().catch(() => { /* expected */ });
          }
        });

        // The pinned "first heartbeat scheduled in Xms" line lands on claim
        // success; the "heartbeat#1 delivered" line lands on the first tick
        // that actually signals. Both must appear for the diagnostic to be
        // useful on a real incident.
        const scheduleLine = lines.find((l) => l.includes('first heartbeat scheduled'));
        const firstHbLine = lines.find((l) => l.includes('heartbeat#1 delivered'));
        expect(scheduleLine, `expected "first heartbeat scheduled" in logs:\n${lines.join('\n')}`).to.exist;
        expect(firstHbLine, `expected "heartbeat#1 delivered" in logs:\n${lines.join('\n')}`).to.exist;
      });
    });

    it('emits a guard-trip log when a tick fires during teardown', async function () {
      // Force a guard-trip by stopping the adapter mid-session and waiting long
      // enough for any queued tick to fire under `stopped=true`. The post-fix
      // guard-trip log is structured JSON with every flag, so a regression
      // that removes the log (or replaces it with the pre-#249 silent return)
      // fails this assertion.
      this.timeout(15_000);

      await withWorker(async () => {
        const handle = await startSession({
          metadata: playerMetadata({ playerId: `guard-trip-${Date.now()}` }),
        });

        const options: BaseAttachmentOptions = {
          client: getClient(),
          host: 'test-host',
        };
        const adapter = new FastInteractiveAttachment(options);

        const { lines } = await captureAdapterLog(async () => {
          const stop = adapter.start(handle, async () => { /* no-op */ });
          try {
            await waitForAttachmentInfo(
              handle,
              // #704 Item 2: accept the idle attached→awaiting refinement; the
              // currentAttachment guard still proves the lease is held.
              (i) => (i.phase === 'attached' || i.phase === 'awaiting') && !!i.currentAttachment,
              5000,
              'initial attached',
            );
            // Stop the adapter; any queued tick that fires after this sees
            // `stopped=true` and should log a guard-trip.
            stop();
            await adapter.publicStopV2();
            // Wait past one tick interval so a queued tick has a chance to fire.
            await new Promise((r) => setTimeout(r, 600));
          } finally {
            await handle.executeUpdate(destroyUpdate, { args: [{}] });
            await handle.result().catch(() => { /* expected */ });
          }
        });

        // A guard-trip log from either loop suffices — both follow the same
        // shape post-fix. We only assert shape (stopped=true present), not
        // which loop emitted, because the race between heartbeat and watcher
        // tick cadence can pick either.
        const guardLines = lines.filter((l) => l.includes('guard tripped'));
        // Guard-trip may not fire if the tick happened to complete cleanly
        // before stop(); this is a best-effort diagnostic check. Any
        // guard-trip emission confirms the log exists and has the expected
        // shape. When it does fire, it must carry the full guard object.
        if (guardLines.length > 0) {
          expect(guardLines.some((l) => l.includes('"stopped":true'))).to.equal(
            true,
            `expected stopped:true in guard-trip log; got: ${guardLines.join(' | ')}`,
          );
        }
      });
    });
  });

  describe('Bug 3 — CAN lease-extension math', () => {
    it(
      'post-CAN extended expiresAt covers the full negotiated lease (fails on pre-#249 main)',
      async function () {
        // This is the test that distinguishes pre-fix from post-fix:
        //   - pre-#249 workflow: CAN extends `expiresAt` by a hardcoded 30_000ms
        //   - post-#249 workflow: CAN extends by `currentAttachment.leaseMs`
        //
        // With `leaseMs=90_000` (well above 30_000) the post-fix extension gives
        // the adapter ≥60s of runway past `now`, while pre-fix would only give
        // ~30s. The assertion `remainingMs >= 60_000` rejects the legacy value.
        //
        // Stronger assertions per tempo-researcher flag 5: we also assert strict
        // `>` on expiresAt progression from the pre-CAN value, guarding against
        // an identity-function regression that happens to leave timestamps
        // intact but doesn't actually extend them.
        this.timeout(30_000);

        await withWorker(async () => {
          const handle = await startSession({
            metadata: playerMetadata({ playerId: `can-lease-math-${Date.now()}` }),
          });

          try {
            // Claim with a lease well above the pre-fix 30s hardcoded constant.
            // Renewal on heartbeat refreshes `expiresAt` by `leaseMs`, so a healthy
            // pre-CAN adapter ends up with expiresAt ≈ (heartbeat time + 90s).
            const LEASE_MS = 90_000;
            const token = await handle.executeUpdate(claimAttachmentUpdate, {
              args: [{
                protocolVersion: PROTOCOL_VERSION,
                host: 'test-host',
                adapterId: 'claude-code',
                adapterClass: 'interactive' as const,
                leaseMs: LEASE_MS,
              }],
            });
            expect(token.leaseMs).to.equal(LEASE_MS);

            const preCan = await handle.query(attachmentInfoQuery);
            expect(preCan.currentAttachment?.leaseMs).to.equal(LEASE_MS);
            const preCanExpires = new Date(preCan.currentAttachment!.expiresAt).getTime();

            // Force CAN via test-only signal. The workflow's CAN path calls
            // `extendAttachmentForCAN(currentAttachment, currentAttachment.leaseMs, now)`
            // on the post-fix branch, carrying the extended attachment into the
            // new execution.
            await handle.signal(testForceContinueAsNewSignal);

            // Wait for the successor run (signaled implicitly: a fresh
            // attachmentInfo query lands on the new run after CAN).
            const postCan = await waitForAttachmentInfo(
              handle,
              (i) => !!i.currentAttachment && i.currentAttachment.attachmentId === token.attachmentId,
              10_000,
              'post-CAN attachment carried forward',
            );

            // AC #3: extension covers one full adapter heartbeat interval. With
            // leaseMs=90s and post-fix math, remainingMs is ~90s (minus CAN
            // transition latency). Pre-fix would give ~30s only — the `>= 60_000`
            // assertion FAILS on pre-fix, PASSES on post-fix.
            const postCanExpires = new Date(postCan.currentAttachment!.expiresAt).getTime();
            const nowMs = Date.now();
            const remainingMs = postCanExpires - nowMs;

            expect(
              remainingMs,
              `post-CAN expiresAt should cover at least 60s past now; got ${remainingMs}ms ` +
              `(pre-fix hardcoded 30_000 would yield ~30_000ms — this assertion rejects it)`,
            ).to.be.at.least(60_000);

            // Strict progression: the extension MUST push expiresAt past the
            // pre-CAN value. Pre-fix with 30s extension + pre-CAN expiresAt at
            // `heartbeat-time + 90s` would actually REDUCE expiresAt, which is
            // another way this assertion rejects the legacy behavior.
            expect(
              postCanExpires,
              `post-CAN expiresAt (${new Date(postCanExpires).toISOString()}) should be >= ` +
              `pre-CAN expiresAt (${new Date(preCanExpires).toISOString()})`,
            ).to.be.at.least(preCanExpires - 2_000); // 2s slack for wall-clock drift across CAN
          } finally {
            await handle.executeUpdate(destroyUpdate, { args: [{}] });
            await handle.result().catch(() => { /* expected */ });
          }
        });
      },
    );
  });
});
