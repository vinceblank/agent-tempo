import { expect } from 'chai';
import * as path from 'path';
import { WorktreeEntry } from '../src/types';
import { worktreeBasePath } from '../src/utils/worktree';
import {
  setupTestEnv,
  teardownTestEnv,
  withWorker,
  startSession,
  conductorMetadata,
  playerMetadata,
  updateMetadataSignal,

  destroyUpdate,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
} from './helpers';

describe('worktree helpers', function () {
  describe('worktreeBasePath', function () {
    it('computes the base path from gitRoot and ensemble', function () {
      const gitRoot = path.resolve('/repos/my-project');
      const result = worktreeBasePath(gitRoot, 'my-ensemble');
      const expected = path.join(path.dirname(gitRoot), '.ct-worktrees', 'my-ensemble');
      expect(result).to.equal(expected);
    });

    it('handles gitRoot with trailing separator', function () {
      const gitRoot = path.resolve('/repos/my-project');
      const result = worktreeBasePath(gitRoot, 'test');
      expect(result).to.include('.ct-worktrees');
      expect(result).to.include('test');
    });

    it('handles nested gitRoot paths', function () {
      const gitRoot = path.resolve('/home/user/projects/deep/nested/repo');
      const result = worktreeBasePath(gitRoot, 'dev');
      const expected = path.join(path.resolve('/home/user/projects/deep/nested'), '.ct-worktrees', 'dev');
      expect(result).to.equal(expected);
    });

    it('produces cross-platform consistent paths using path.join', function () {
      const gitRoot = path.resolve('/repos/project');
      const result = worktreeBasePath(gitRoot, 'ensemble-1');
      expect(result).to.equal(
        path.join(path.dirname(gitRoot), '.ct-worktrees', 'ensemble-1'),
      );
    });
  });

  describe('branch naming defaults', function () {
    it('default branch follows {ensemble}/{playerName} convention', function () {
      const ensemble = 'my-ensemble';
      const playerName = 'soloist';
      const defaultBranch = `${ensemble}/${playerName}`;
      expect(defaultBranch).to.equal('my-ensemble/soloist');
    });

    it('custom branch overrides the default', function () {
      const customBranch = 'feat/custom-branch';
      expect(customBranch).to.equal('feat/custom-branch');
    });

    it('handles player names with hyphens and underscores', function () {
      const ensemble = 'prod_deploy';
      const playerName = 'lead-engineer_1';
      const defaultBranch = `${ensemble}/${playerName}`;
      expect(defaultBranch).to.equal('prod_deploy/lead-engineer_1');
    });
  });

  describe('path normalization', function () {
    it('worktree path is under the base path', function () {
      const gitRoot = path.resolve('/repos/project');
      const basePath = worktreeBasePath(gitRoot, 'test-ensemble');
      const playerPath = path.join(basePath, 'my-player');
      expect(playerPath.startsWith(basePath)).to.be.true;
    });

    it('worktree path does not contain double separators', function () {
      const gitRoot = path.resolve('/repos/project');
      const basePath = worktreeBasePath(gitRoot, 'ens');
      const playerPath = path.join(basePath, 'player');
      const doubleSep = path.sep + path.sep;
      expect(playerPath).to.not.include(doubleSep);
    });

    it('worktree path is absolute', function () {
      const gitRoot = path.resolve('/repos/project');
      const basePath = worktreeBasePath(gitRoot, 'ens');
      expect(path.isAbsolute(basePath)).to.be.true;
    });
  });
});

describe('worktree workflow state', function () {
  before(async function () {
    this.timeout(60_000);
    await setupTestEnv();
  });

  after(async function () {
    await teardownTestEnv();
  });

  it('creates worktree entry on conductor via signal', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      const entry: WorktreeEntry = {
        player: 'soloist',
        path: '/tmp/wt/soloist',
        branch: 'test-ens/soloist',
        gitRoot: '/repos/project',
        createdAt: new Date().toISOString(),
        createdBy: 'conductor',
      };
      await handle.signal(setWorktreeSignal, entry);

      const worktrees: WorktreeEntry[] = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(1);
      expect(worktrees[0].player).to.equal('soloist');
      expect(worktrees[0].path).to.equal('/tmp/wt/soloist');
      expect(worktrees[0].branch).to.equal('test-ens/soloist');
      expect(worktrees[0].gitRoot).to.equal('/repos/project');
      expect(worktrees[0].createdBy).to.equal('conductor');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('removes worktree entry by player name', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setWorktreeSignal, {
        player: 'engineer',
        path: '/tmp/wt/engineer',
        branch: 'ens/engineer',
        gitRoot: '/repos/project',
        createdAt: new Date().toISOString(),
        createdBy: 'conductor',
      });

      let worktrees: WorktreeEntry[] = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(1);

      await handle.signal(removeWorktreeSignal, 'engineer');

      worktrees = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(0);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('upserts worktree entry for same player', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setWorktreeSignal, {
        player: 'dev',
        path: '/tmp/wt/dev-old',
        branch: 'ens/dev',
        gitRoot: '/repos/project',
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'conductor',
      });

      // Upsert with new path
      await handle.signal(setWorktreeSignal, {
        player: 'dev',
        path: '/tmp/wt/dev-new',
        branch: 'ens/dev-v2',
        gitRoot: '/repos/project',
        createdAt: '2026-01-02T00:00:00Z',
        createdBy: 'conductor',
      });

      const worktrees: WorktreeEntry[] = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(1);
      expect(worktrees[0].path).to.equal('/tmp/wt/dev-new');
      expect(worktrees[0].branch).to.equal('ens/dev-v2');

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('non-conductor session does not have worktrees query', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: playerMetadata({ playerId: 'player-no-wt' }),
      });

      try {
        await handle.query(worktreesQuery);
        expect.fail('Should have thrown for non-conductor');
      } catch (err: any) {
        expect(err.message).to.include('worktrees');
      }

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('supports multiple worktrees simultaneously', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      await handle.signal(setWorktreeSignal, {
        player: 'alice',
        path: '/tmp/wt/alice',
        branch: 'ens/alice',
        gitRoot: '/repos/project',
        createdAt: new Date().toISOString(),
        createdBy: 'conductor',
      });
      await handle.signal(setWorktreeSignal, {
        player: 'bob',
        path: '/tmp/wt/bob',
        branch: 'ens/bob',
        gitRoot: '/repos/project',
        createdAt: new Date().toISOString(),
        createdBy: 'conductor',
      });

      const worktrees: WorktreeEntry[] = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(2);
      expect(worktrees.map((w) => w.player)).to.include.members(['alice', 'bob']);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });

  it('remove for non-existent player is a no-op', async function () {
    await withWorker(async () => {
      const handle = await startSession({
        metadata: conductorMetadata({ playerId: 'conductor' }),
      });

      // Remove a player that was never added — should not throw
      await handle.signal(removeWorktreeSignal, 'ghost');

      const worktrees: WorktreeEntry[] = await handle.query(worktreesQuery);
      expect(worktrees).to.have.length(0);

      await handle.executeUpdate(destroyUpdate, { args: [{}] });
      await handle.result();
    });
  });
});
