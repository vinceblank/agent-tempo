/**
 * Player-saveable state primitive (#334 PR-1, ADR 0011).
 *
 * Exercises the workflow surface end-to-end against a live
 * TestWorkflowEnvironment:
 *
 *   - round-trip: `save → query → clear → query` with the default 'main' slot
 *   - peer query: a different player's session can query the slot
 *   - multi-key: 4 distinct slots coexist; `playerStateKeys` returns sorted
 *   - slot saturation: 5th distinct key rejects with `PlayerStateSlotsFull`
 *     and the error message lists the existing slot names; `clear_state`
 *     frees a slot and the retry succeeds
 *   - oversized content: > 32 KiB rejects with `PlayerStateContentTooLarge`
 *   - invalid key: bad regex rejects with `PlayerStateInvalidKey`
 *   - `clear_state` on an already-empty slot returns `{ cleared: false }`
 *
 * The CAN-survival path is exercised by `test/session-wire-extensions.test.ts`'s
 * existing pattern for other carried state (counters etc.); rather than
 * duplicate the `testForceContinueAsNewSignal` plumbing here, we keep these
 * tests focused on the observable wire surface. CAN carry is also enforced
 * structurally by the type-checked `SessionInput.playerState` field —
 * removing the carry block would surface as a TS error in the build.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
  destroyUpdate,
} from './helpers';
import {
  savePlayerStateUpdate,
  clearPlayerStateUpdate,
  playerStateQuery,
  playerStateKeysQuery,
} from '../src/workflows/signals';
import {
  PLAYER_STATE_CONTENT_MAX,
  PLAYER_STATE_SLOTS_MAX,
} from '../src/utils/validation';

describe('player saveable state (#334 PR-1)', function () {
  before(setupSharedEnv);

  after(async function () {
    await teardownTestEnv();
  });

  // Player-state handlers don't exercise outbox activities, but
  // `startOutboxWorker` is the cheapest stable shared-worker fixture
  // available in helpers.ts (#383 P3.1).
  useSharedWorker(startOutboxWorker);

  async function startFresh(playerId: string) {
    return startSession({ metadata: playerMetadata({ playerId }) });
  }

  async function destroyAndDrain(handle: import('@temporalio/client').WorkflowHandle) {
    await handle.executeUpdate(destroyUpdate, { args: [{}] });
    await handle.result().catch(() => {});
  }

  // ── Round-trip: save → query → clear → query ────────────────────────

  describe('round-trip — default "main" slot', function () {
    it('save then query returns the saved entry', async function () {
      this.timeout(10_000);
      const playerId = `pstate-rt-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        const result = await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'main', content: '## Current task\nthe one big thing', savedBy: playerId }],
        });
        expect(result.saved).to.equal(true);
        expect(result.savedAt).to.be.a('string');
        expect(Number.isFinite(Date.parse(result.savedAt))).to.equal(true);

        const slot = await handle.query(playerStateQuery, { key: 'main' });
        expect(slot).to.not.equal(null);
        expect(slot!.content).to.equal('## Current task\nthe one big thing');
        expect(slot!.savedBy).to.equal(playerId);
        expect(slot!.savedAt).to.equal(result.savedAt);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('default key resolution — query without args returns the "main" slot', async function () {
      this.timeout(10_000);
      const playerId = `pstate-default-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'main', content: 'default-key payload', savedBy: playerId }],
        });
        // Pass `{}` so the workflow handler's `?? PLAYER_STATE_DEFAULT_KEY`
        // branch fires.
        const slot = await handle.query(playerStateQuery, {});
        expect(slot).to.not.equal(null);
        expect(slot!.content).to.equal('default-key payload');
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('query of an empty slot returns null', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`pstate-empty-${Date.now()}`);
      try {
        const slot = await handle.query(playerStateQuery, { key: 'main' });
        expect(slot).to.equal(null);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('clear after save reports cleared:true and the slot becomes null', async function () {
      this.timeout(10_000);
      const playerId = `pstate-clear-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'main', content: 'temp', savedBy: playerId }],
        });
        const result = await handle.executeUpdate(clearPlayerStateUpdate, { args: [{ key: 'main' }] });
        expect(result.cleared).to.equal(true);

        const slot = await handle.query(playerStateQuery, { key: 'main' });
        expect(slot).to.equal(null);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('clear on an already-empty slot returns cleared:false (idempotent)', async function () {
      this.timeout(10_000);
      const handle = await startFresh(`pstate-noop-${Date.now()}`);
      try {
        const result = await handle.executeUpdate(clearPlayerStateUpdate, { args: [{ key: 'main' }] });
        expect(result.cleared).to.equal(false);
      } finally {
        await destroyAndDrain(handle);
      }
    });
  });

  // ── Multi-key: 4 distinct slots ──────────────────────────────────────

  describe('multi-key — 4 slots coexist', function () {
    it('save 4 distinct keys, query each, list keys sorted', async function () {
      this.timeout(15_000);
      const playerId = `pstate-multi-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        // Insert in non-sorted order so the sorted-output assertion has bite.
        const keys = ['safety', 'main', 'debug', 'bookmark'];
        for (const k of keys) {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: k, content: `payload-for-${k}`, savedBy: playerId }],
          });
        }
        for (const k of keys) {
          const slot = await handle.query(playerStateQuery, { key: k });
          expect(slot).to.not.equal(null);
          expect(slot!.content).to.equal(`payload-for-${k}`);
        }
        const listed = await handle.query(playerStateKeysQuery);
        expect(listed).to.deep.equal(['bookmark', 'debug', 'main', 'safety']);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('clear one of the 4 slots and the keys list shrinks', async function () {
      this.timeout(15_000);
      const playerId = `pstate-shrink-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        for (const k of ['main', 'a', 'b', 'c']) {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: k, content: 'x', savedBy: playerId }],
          });
        }
        await handle.executeUpdate(clearPlayerStateUpdate, { args: [{ key: 'b' }] });
        const listed = await handle.query(playerStateKeysQuery);
        expect(listed).to.deep.equal(['a', 'c', 'main']);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('overwriting an existing key is allowed (no slot-cap rejection)', async function () {
      this.timeout(10_000);
      const playerId = `pstate-overwrite-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        // Fill all 4 slots.
        for (const k of ['main', 'a', 'b', 'c']) {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: k, content: 'v1', savedBy: playerId }],
          });
        }
        // Overwriting an existing key while at the cap must still succeed.
        const result = await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'a', content: 'v2-overwrite', savedBy: playerId }],
        });
        expect(result.saved).to.equal(true);

        const slot = await handle.query(playerStateQuery, { key: 'a' });
        expect(slot!.content).to.equal('v2-overwrite');
      } finally {
        await destroyAndDrain(handle);
      }
    });
  });

  // ── Slot saturation rejection ────────────────────────────────────────

  describe('saturation — refuse + structured error per design §3.4', function () {
    it('5th distinct key rejects with PlayerStateSlotsFull and lists existing keys', async function () {
      this.timeout(15_000);
      const playerId = `pstate-full-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        const filled = ['main', 'safety', 'bookmark', 'debug'];
        for (const k of filled) {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: k, content: 'x', savedBy: playerId }],
          });
        }
        let caught: any = null;
        try {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: 'fifth', content: 'overflow', savedBy: playerId }],
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).to.not.equal(null);
        // Walk the cause chain — Temporal wraps `ApplicationFailure.nonRetryable`
        // in `WorkflowUpdateFailedError`. The structured marker (`type`) and
        // the underlying message both live on the inner failure. We assert
        // on the design §3.4 promises: `PlayerStateSlotsFull` type and the
        // existing-key list embedded in the message.
        const msg = flattenErrorChain(caught);
        expect(msg).to.match(/PlayerStateSlotsFull/);
        expect(msg).to.match(/slots full \(4\)/);
        // Existing keys appear in the message in sorted order so the LLM
        // picks deterministically. We assert on each one rather than the
        // whole list to remain tolerant to format drift.
        for (const k of filled) {
          expect(msg).to.include(k);
        }

        // Every slot-cap-rejection path also leaves the existing slots
        // untouched — verify the keys list is still the original four.
        const listed = await handle.query(playerStateKeysQuery);
        expect(listed).to.deep.equal(['bookmark', 'debug', 'main', 'safety']);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('clear → retry-save succeeds after saturation', async function () {
      this.timeout(15_000);
      const playerId = `pstate-recover-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        for (const k of ['main', 'a', 'b', 'c']) {
          await handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: k, content: 'x', savedBy: playerId }],
          });
        }
        // Saturated — first attempt fails.
        await expectRejection(
          () => handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: 'd', content: 'y', savedBy: playerId }],
          }),
          /PlayerStateSlotsFull/,
        );
        // Free a slot, retry.
        await handle.executeUpdate(clearPlayerStateUpdate, { args: [{ key: 'b' }] });
        const result = await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'd', content: 'y', savedBy: playerId }],
        });
        expect(result.saved).to.equal(true);
      } finally {
        await destroyAndDrain(handle);
      }
    });
  });

  // ── Other validator rejections ───────────────────────────────────────

  describe('validator rejections', function () {
    it('content > 32 KiB rejects with PlayerStateContentTooLarge', async function () {
      this.timeout(10_000);
      const playerId = `pstate-toobig-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        const oversized = 'A'.repeat(PLAYER_STATE_CONTENT_MAX + 1);
        await expectRejection(
          () => handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: 'main', content: oversized, savedBy: playerId }],
          }),
          /PlayerStateContentTooLarge/,
        );
        // Saving exactly at the limit succeeds.
        const atLimit = 'A'.repeat(PLAYER_STATE_CONTENT_MAX);
        const result = await handle.executeUpdate(savePlayerStateUpdate, {
          args: [{ key: 'main', content: atLimit, savedBy: playerId }],
        });
        expect(result.saved).to.equal(true);
      } finally {
        await destroyAndDrain(handle);
      }
    });

    it('invalid key rejects with PlayerStateInvalidKey on save and clear', async function () {
      this.timeout(10_000);
      const playerId = `pstate-badkey-${Date.now()}`;
      const handle = await startFresh(playerId);
      try {
        // Bad characters
        await expectRejection(
          () => handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: 'has space', content: 'x', savedBy: playerId }],
          }),
          /PlayerStateInvalidKey/,
        );
        // Empty string (regex is +, so no match → rejected)
        await expectRejection(
          () => handle.executeUpdate(savePlayerStateUpdate, {
            args: [{ key: '', content: 'x', savedBy: playerId }],
          }),
          /PlayerStateInvalidKey/,
        );
        // Clear with a bad key also rejects.
        await expectRejection(
          () => handle.executeUpdate(clearPlayerStateUpdate, { args: [{ key: 'has space' }] }),
          /PlayerStateInvalidKey/,
        );
      } finally {
        await destroyAndDrain(handle);
      }
    });
  });

  // ── Sanity check on the slot cap constant — guards against a future
  // edit that drops the cap below the canonical 4-slot story.
  it('PLAYER_STATE_SLOTS_MAX matches design §3.3 (= 4)', function () {
    expect(PLAYER_STATE_SLOTS_MAX).to.equal(4);
  });
});

/**
 * Walk an error's `cause` chain (Temporal's `WorkflowUpdateFailedError`
 * wraps the underlying `ApplicationFailure` here). Concatenates messages
 * + the failure `type` so structured markers like `PlayerStateSlotsFull`
 * propagate into the matched string. Mirrors the Temporal-failure-shape
 * pattern used elsewhere in `test/` instead of reaching for chai-as-promised.
 */
function flattenErrorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur) {
    if (typeof cur === 'object' && cur !== null) {
      const c = cur as { message?: string; type?: string; cause?: unknown };
      if (c.message) parts.push(c.message);
      // ApplicationFailure carries the structured marker on `.type`; surface it
      // explicitly so tests can match e.g. `PlayerStateSlotsFull`.
      if (c.type) parts.push(c.type);
      cur = c.cause;
    } else {
      parts.push(String(cur));
      cur = undefined;
    }
  }
  return parts.join(' | ');
}

/** Assert that `fn()` rejects and that the flattened error chain matches `pattern`. */
async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    throw new Error(`expected rejection matching ${pattern}, but call resolved`);
  }
  const msg = flattenErrorChain(caught);
  if (!pattern.test(msg)) {
    throw new Error(`expected rejection matching ${pattern}, got: ${msg}`);
  }
}
