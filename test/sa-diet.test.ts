/**
 * T0.5 SA diet (#747) — integration coverage for the memo migration.
 *
 * Asserts, against a real local Temporal server:
 *
 *   1. A fresh (post-`v1.8-sa-diet`) session run writes the migrated fields
 *      to the workflow MEMO and does NOT write the deprecated search
 *      attributes (`AgentTempoGitRoot` / `AgentTempoPlayerType` /
 *      `AgentTempoIsConductor` / `AgentTempoAttachmentId`).
 *   2. The filter SAs (Ensemble, PlayerId, Hostname, AttachedHost,
 *      AttachmentState) are still written — they're query-expression
 *      surface and MUST stay search attributes.
 *   3. `setPart` keeps the memo mirror current.
 *   4. `claimAttachment` no longer writes `AgentTempoAttachmentId`.
 *   5. Memo is visible in `client.workflow.list()` results — the read path
 *      T0.1 (#748) builds on. This doubles as the empirical check for the
 *      server-floor caveat (1.18-era standard visibility didn't propagate
 *      memo upserts into list results; the bundled dev server must).
 *
 * Note on continue-as-new: memo inheritance across CAN is moot by
 * construction — the workflow re-runs its initial `upsertMemo` from the CAN
 * input (which carries `part` + metadata) on every new run, so the memo is
 * re-established regardless of server-side inheritance semantics.
 */
import { expect } from 'chai';
import {
  setupSharedEnv,
  teardownTestEnv,
  startOutboxWorker,
  useSharedWorker,
  startSession,
  playerMetadata,
  pollWithTimeout,
  getClient,
  destroyUpdate,
  PROTOCOL_VERSION,
} from './helpers';
import {
  setPartSignal,
  claimAttachmentUpdate,
  attachmentInfoQuery,
} from '../src/workflows/signals';

const DEPRECATED_SA_KEYS = [
  'AgentTempoGitRoot',
  'AgentTempoPlayerType',
  'AgentTempoIsConductor',
  'AgentTempoAttachmentId',
] as const;

describe('T0.5 SA diet (#747) — memo migration', function () {
  before(setupSharedEnv);
  after(async function () {
    await teardownTestEnv();
  });

  useSharedWorker(startOutboxWorker);

  async function startFresh(playerId: string) {
    return startSession({
      metadata: playerMetadata({
        playerId,
        gitRoot: '/repo/demo',
        playerType: 'tempo-soloist',
      }),
      part: 'initial part',
    });
  }

  async function destroy(handle: Awaited<ReturnType<typeof startSession>>) {
    await handle.executeUpdate(destroyUpdate, { args: [{}] });
    await handle.result().catch(() => {});
  }

  it('fresh runs carry the migrated fields in the memo, not in SAs', async function () {
    this.timeout(15_000);
    const handle = await startFresh(`sadiet-memo-${Date.now()}`);
    try {
      // Memo lands on the first workflow task — poll, don't race.
      await pollWithTimeout(async () => {
        const desc = await handle.describe();
        return desc.memo?.AgentTempoPart === 'initial part';
      }, 10_000, 250);

      const desc = await handle.describe();
      expect(desc.memo?.AgentTempoGitRoot).to.equal('/repo/demo');
      expect(desc.memo?.AgentTempoPlayerType).to.equal('tempo-soloist');
      expect(desc.memo?.AgentTempoIsConductor).to.equal(false);
      expect(desc.memo?.AgentTempoPart).to.equal('initial part');

      // Deprecated SAs must be absent on post-diet runs…
      const sa = (desc.searchAttributes ?? {}) as Record<string, unknown>;
      for (const key of DEPRECATED_SA_KEYS) {
        expect(sa[key], `deprecated SA ${key} should not be written`).to.be.undefined;
      }
      // …while the 5 filter SAs are still written by the workflow.
      expect(sa.AgentTempoEnsemble, 'filter SA Ensemble').to.not.be.undefined;
      expect(sa.AgentTempoPlayerId, 'filter SA PlayerId').to.not.be.undefined;
      expect(sa.AgentTempoHostname, 'filter SA Hostname').to.not.be.undefined;
      expect(sa.AgentTempoAttachmentState, 'filter SA AttachmentState').to.not.be.undefined;
    } finally {
      await destroy(handle);
    }
  });

  it('setPart keeps the memo mirror current', async function () {
    this.timeout(15_000);
    const handle = await startFresh(`sadiet-part-${Date.now()}`);
    try {
      await handle.signal(setPartSignal, 'reworked part');
      await pollWithTimeout(async () => {
        const desc = await handle.describe();
        return desc.memo?.AgentTempoPart === 'reworked part';
      }, 10_000, 250);
    } finally {
      await destroy(handle);
    }
  });

  it('claimAttachment does not write AgentTempoAttachmentId', async function () {
    this.timeout(15_000);
    const handle = await startFresh(`sadiet-claim-${Date.now()}`);
    try {
      await handle.executeUpdate(claimAttachmentUpdate, {
        args: [{ host: 'test-host', protocolVersion: PROTOCOL_VERSION, adapterId: 'claude-code', adapterClass: 'interactive', leaseMs: 60_000 }],
      });
      const info = await handle.query(attachmentInfoQuery);
      // #704 Item 2: idle claim may refine attached → awaiting (orthogonal to the
      // search-attribute assertions below, which are what this test is about).
      expect(info.phase).to.be.oneOf(['attached', 'awaiting']);

      const desc = await handle.describe();
      const sa = (desc.searchAttributes ?? {}) as Record<string, unknown>;
      expect(sa.AgentTempoAttachmentId, 'AttachmentId SA must stay absent post-claim').to.be.undefined;
      // AttachedHost is a filter SA and must still track the claim.
      expect(sa.AgentTempoAttachedHost).to.deep.equal(['test-host']);
    } finally {
      await destroy(handle);
    }
  });

  it('memo is visible in workflow.list() results (T0.1 read path)', async function () {
    this.timeout(20_000);
    const playerId = `sadiet-list-${Date.now()}`;
    const handle = await startFresh(playerId);
    try {
      const client = getClient();
      // Visibility is eventually consistent — poll the list until the row
      // appears with its memo. This is the empirical server-floor check:
      // if a future bundled server stopped surfacing memos in list
      // results, T0.1's observation path would silently degrade — fail
      // loudly here instead.
      await pollWithTimeout(async () => {
        for await (const wf of client.workflow.list({
          query: `WorkflowType = "agentSessionWorkflow" AND AgentTempoPlayerId = "${playerId}"`,
        })) {
          const memo = wf.memo as Record<string, unknown> | undefined;
          return memo?.AgentTempoPart === 'initial part'
            && memo?.AgentTempoPlayerType === 'tempo-soloist';
        }
        return false;
      }, 15_000, 500);
    } finally {
      await destroy(handle);
    }
  });
});
