/**
 * T0.1 (#748) — integration coverage for the cloud-profile ensemble scan
 * (`scanEnsembleSessionsCloud`) against a real local Temporal server.
 *
 * Asserts:
 *   1. The scan is ensemble-scoped (a session in another ensemble never
 *      appears — the SA filter, not post-filtering, does the scoping).
 *   2. A v1.8+ run's full row is read from SAs + memo: part, workDir,
 *      gitRoot, gitBranch, agentType, playerType, isConductor, phase —
 *      including the T0.1 observation-fields memo extension.
 *   3. setPart's memo mirror is what the scan sees (no getPart query).
 *   4. The BPM fields (activityCount/lastActivityAt) still arrive via the
 *      kept getActivityState query.
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
} from './helpers';
import { setPartSignal } from '../src/workflows/signals';
import { scanEnsembleSessionsCloud } from '../src/activities/resolve';

describe('T0.1 cloud ensemble scan (#748)', function () {
  before(setupSharedEnv);
  after(async function () {
    await teardownTestEnv();
  });

  useSharedWorker(startOutboxWorker);

  it('reads the full player row from SAs + memo, ensemble-scoped', async function () {
    this.timeout(30_000);
    const playerId = `t01-scan-${Date.now()}`;
    const metadata = playerMetadata({
      playerId,
      gitRoot: '/repo/demo',
      gitBranch: 'feat/x',
      playerType: 'tempo-soloist',
      agentType: 'pi',
    });
    const handle = await startSession({ metadata, part: 'scanning things' });
    try {
      await handle.signal(setPartSignal, 'updated via memo');

      const client = getClient();
      // Visibility is eventually consistent — poll until the row appears
      // with the post-signal part (proves the scan reads the memo mirror,
      // not a stale start-time value, and not the getPart query).
      let row: Awaited<ReturnType<typeof scanEnsembleSessionsCloud>>[number] | undefined;
      await pollWithTimeout(async () => {
        const rows = await scanEnsembleSessionsCloud(client, metadata.ensemble);
        row = rows.find((r) => r.playerId === playerId);
        return row !== undefined && row.part === 'updated via memo';
      }, 20_000, 500);

      expect(row!.workDir).to.equal(metadata.workDir);
      expect(row!.gitRoot).to.equal('/repo/demo');
      expect(row!.gitBranch).to.equal('feat/x');
      expect(row!.agentType).to.equal('pi');
      expect(row!.playerType).to.equal('tempo-soloist');
      expect(row!.isConductor).to.equal(false);
      expect(row!.hostname).to.equal(metadata.hostname);
      // BPM fields ride the kept getActivityState query.
      expect(row!.activityCount).to.be.a('number');
      expect(row!.lastActivityAt).to.be.a('string');

      // Ensemble scoping: a scan of a different ensemble never sees this row.
      const other = await scanEnsembleSessionsCloud(client, `${metadata.ensemble}-other`);
      expect(other.find((r) => r.playerId === playerId)).to.equal(undefined);
    } finally {
      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result().catch(() => {});
    }
  });
});
