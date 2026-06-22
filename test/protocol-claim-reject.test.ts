/**
 * #786 — the `claimAttachment` protocol handshake (the update VALIDATOR half).
 *
 * Part 1 made `protocolVersion` a REQUIRED claim field and the 2.0 session
 * workflow rejects any value `!== PROTOCOL_VERSION` (incl. `undefined` = a v1
 * adapter) in the update validator — pure, pre-admission. These tests assert
 * both the rejection (cross-host cutover safety) and the positive control.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  withWorker,
  startSession,
  playerMetadata,
  claimAttachmentUpdate,
  attachmentInfoQuery,
  destroyUpdate,
} from './helpers';
import { PROTOCOL_VERSION } from '../src/constants';
import type { AttachmentInfo } from '../src/types';

/**
 * Flatten an error's `.cause` chain into one string. A rejected Temporal update
 * surfaces as a `WorkflowUpdateFailedError` whose top-level message is generic
 * ("Workflow Update failed"); the validator's `ApplicationFailure` message
 * (carrying "protocol …") lives in `.cause`. Assert against the whole chain.
 */
function errChain(e: unknown): string {
  let s = '';
  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { message?: unknown; cause?: unknown };
    s += ' ' + (typeof o.message === 'string' ? o.message : String(cur));
    cur = o.cause;
  }
  return s;
}

describe('#786 claimAttachment protocol handshake', function () {
  before(setupSharedEnv);

  const baseClaim = {
    host: 'host-A',
    adapterId: 'claude-code',
    adapterClass: 'interactive' as const,
    leaseMs: 30_000,
  };

  it('rejects a v1 claim (no protocolVersion)', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `proto-omit-${Date.now()}` }),
      });
      let rejected = false;
      try {
        // Cast: the omission is exactly the v1-adapter wire shape we're guarding.
        await handle.executeUpdate(claimAttachmentUpdate, { args: [{ ...baseClaim } as never] });
      } catch (err) {
        rejected = true;
        expect(errChain(err)).to.match(/protocol/i);
      }
      expect(rejected).to.equal(true, 'expected ProtocolMismatch when protocolVersion is absent');
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('rejects a claim with a wrong protocolVersion', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `proto-wrong-${Date.now()}` }),
      });
      let rejected = false;
      try {
        await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{ ...baseClaim, protocolVersion: 1 }],
        });
      } catch (err) {
        rejected = true;
        expect(errChain(err)).to.match(/protocol/i);
      }
      expect(rejected).to.equal(true, 'expected ProtocolMismatch for protocolVersion=1');
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });

  it('accepts a claim with the correct protocolVersion', async function () {
    this.timeout(15_000);
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: `proto-ok-${Date.now()}` }),
      });
      const token = await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ ...baseClaim, protocolVersion: PROTOCOL_VERSION }],
      });
      expect(token.attachmentId).to.be.a('string');
      const info: AttachmentInfo = await handle.query(attachmentInfoQuery);
      expect(info.phase).to.equal('attached');
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    });
  });
});
