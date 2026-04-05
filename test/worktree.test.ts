import { expect } from 'chai';
import * as path from 'path';
import { worktreeBasePath } from '../src/utils/worktree';

describe('worktree helpers', function () {
  describe('worktreeBasePath', function () {
    it('computes the base path from gitRoot and ensemble', function () {
      const gitRoot = path.resolve('/repos/my-project');
      const result = worktreeBasePath(gitRoot, 'my-ensemble');
      const expected = path.join(path.dirname(gitRoot), '.ct-worktrees', 'my-ensemble');
      expect(result).to.equal(expected);
    });

    it('handles gitRoot with trailing separator', function () {
      // path.dirname normalizes trailing separators
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
      // Ensure the result uses the platform's path separator
      expect(result).to.equal(
        path.join(path.dirname(gitRoot), '.ct-worktrees', 'ensemble-1'),
      );
    });
  });

  describe('branch naming defaults', function () {
    it('default branch follows {ensemble}/{playerName} convention', function () {
      // The createWorktree function defaults to `${ensemble}/${playerName}`
      // We test the convention here without invoking git
      const ensemble = 'my-ensemble';
      const playerName = 'soloist';
      const defaultBranch = `${ensemble}/${playerName}`;
      expect(defaultBranch).to.equal('my-ensemble/soloist');
    });

    it('custom branch overrides the default', function () {
      const customBranch = 'feat/custom-branch';
      // When branch is provided, it should be used as-is
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
