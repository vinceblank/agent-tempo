import { expect } from 'chai';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { WorktreeEntry } from '../src/types';
import { createWorktree, worktreeBasePath } from '../src/utils/worktree';
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
  getTestEnsemble,
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
      const basePath = worktreeBasePath(gitRoot, 'test-ensemble-worktree-fixture');
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

// ──────────────────────────────────────────────────────────────────────────
// #261 — createWorktree reuse must repoint HEAD on branch mismatch, must
// refuse on a dirty tree, and must stay a no-op when the branch already
// matches. These tests exercise the real git binary in a tmp repo; no
// Temporal dependency.
// ──────────────────────────────────────────────────────────────────────────

describe('createWorktree reuse semantics (#261)', function () {
  // Allow git + worktree calls on slow Windows CI runners.
  this.timeout(30_000);

  let tmpRoot: string;
  let primaryRepo: string;
  // Per shared-TestWorkflowEnvironment policy (#210): never hardcode
  // `test-ensemble`; derive from `getTestEnsemble()` so the per-file random
  // suffix keeps ensembles disjoint across test files.
  const ensemble = getTestEnsemble();
  const playerName = 'test-player';
  let expectedWtPath: string;

  // Run git with `cwd`, capturing output and re-throwing with useful context
  // if it fails — shell default error messages from execFileSync are noisy.
  const git = (cwd: string, args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (err: any) {
      const msg = err.stderr || err.stdout || err.message || String(err);
      throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${msg.trim()}`);
    }
  };

  beforeEach(function () {
    // Fresh tmpdir per test so leftovers from a prior failure don't bleed in.
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'ct-wt-261-'));

    // `primaryRepo` is the git root that `createWorktree` will operate
    // against. Worktrees get provisioned at `<tmpRoot>/.ct-worktrees/<ensemble>/<player>`
    // — same convention as production (`worktreeBasePath`), achieved by
    // placing the repo one level deep in tmpRoot so `path.dirname(gitRoot)`
    // lands back at tmpRoot.
    primaryRepo = path.join(tmpRoot, 'primary');
    mkdirSync(primaryRepo);

    // Initialise a real repo with a single commit on `main`, plus a local
    // `legacy` branch pointing at the same commit. Add an `origin` remote
    // aliased to the repo itself so `origin/main` resolves — the helper's
    // `create-from-main` path needs that ref.
    git(primaryRepo, ['init', '-b', 'main']);
    git(primaryRepo, ['config', 'user.email', 'test@example.com']);
    git(primaryRepo, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(primaryRepo, 'README.md'), '# test repo\n');
    git(primaryRepo, ['add', 'README.md']);
    git(primaryRepo, ['commit', '-m', 'init']);
    git(primaryRepo, ['branch', 'legacy']);
    // Alias origin → ourselves so origin/main is a valid rev.
    git(primaryRepo, ['remote', 'add', 'origin', primaryRepo]);
    git(primaryRepo, ['fetch', 'origin']);

    expectedWtPath = path.join(
      worktreeBasePath(primaryRepo, ensemble),
      playerName,
    );
  });

  afterEach(function () {
    // `force: true` tolerates Windows file-handle holds left by git processes
    // that have already exited but may still have directory watchers open.
    try {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best-effort cleanup; a leftover tmpdir is never worse than failing
      // the suite on Windows for cleanup flake.
    }
  });

  it('(a) reuse with different branch: repoints the inner HEAD (#261)', function () {
    // ARRANGE: first creation lands the worktree on `legacy`.
    createWorktree({ gitRoot: primaryRepo, ensemble, playerName, branch: 'legacy' });
    expect(
      git(expectedWtPath, ['branch', '--show-current']).trim(),
    ).to.equal('legacy', 'precondition: first create should leave worktree on legacy');

    // ACT: second creation reuses the directory but asks for a different branch.
    const result = createWorktree({
      gitRoot: primaryRepo,
      ensemble,
      playerName,
      branch: 'requested',
    });

    // ASSERT: what the function claims vs. what's actually on disk. Pre-#261
    // both looked fine on the returned object but the git state diverged.
    expect(result.created).to.equal(false, 'second call must take the reuse path');
    expect(result.branch).to.equal('requested');
    expect(result.switched).to.equal(
      'created-from-main',
      '`requested` did not exist locally → helper should create from origin/main',
    );
    const actualBranch = git(expectedWtPath, ['branch', '--show-current']).trim();
    expect(actualBranch).to.equal(
      'requested',
      'the bug: returned object says `requested` but the worktree HEAD still points at `legacy`',
    );
  });

  it('(b) reuse with same branch: no-op, no branch flip', function () {
    // ARRANGE: first creation on `legacy`.
    createWorktree({ gitRoot: primaryRepo, ensemble, playerName, branch: 'legacy' });

    // ACT: second creation with the SAME branch — hot path; should early-return.
    const result = createWorktree({ gitRoot: primaryRepo, ensemble, playerName, branch: 'legacy' });

    // ASSERT: the helper reports `same`, branch stays legacy, no git side effects.
    expect(result.created).to.equal(false);
    expect(result.branch).to.equal('legacy');
    expect(result.switched).to.equal('same');
    expect(
      git(expectedWtPath, ['branch', '--show-current']).trim(),
    ).to.equal('legacy');
  });

  it('(c) reuse with different branch + dirty tree: throws, preserves work', function () {
    // ARRANGE: first creation on `legacy`, then dirty the tree.
    createWorktree({ gitRoot: primaryRepo, ensemble, playerName, branch: 'legacy' });
    const dirtyFile = path.join(expectedWtPath, 'in-flight.txt');
    writeFileSync(dirtyFile, 'work the player has not committed yet\n');

    // ACT + ASSERT: must throw rather than blow away uncommitted work.
    expect(() =>
      createWorktree({ gitRoot: primaryRepo, ensemble, playerName, branch: 'requested' }),
    ).to.throw(/uncommitted changes/i);

    // ASSERT: branch still on legacy, dirty file still present.
    expect(
      git(expectedWtPath, ['branch', '--show-current']).trim(),
    ).to.equal('legacy', 'branch must not have flipped after the throw');
    expect(existsSync(dirtyFile)).to.equal(
      true,
      'the operator\'s in-flight file must survive a refused repoint',
    );
  });
});
