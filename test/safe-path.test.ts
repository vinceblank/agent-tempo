import { expect } from 'chai';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { assertSafePath, safeLineupPath } from '../src/utils/safe-path';

describe('safe-path', function () {
  describe('assertSafePath', function () {
    it('allows paths within an allowed root', function () {
      const root = join(tmpdir(), 'test-root');
      expect(() => assertSafePath(join(root, 'file.yaml'), [root])).to.not.throw();
    });

    it('allows paths that are exactly the root', function () {
      const root = join(tmpdir(), 'test-root');
      expect(() => assertSafePath(root, [root])).to.not.throw();
    });

    it('allows paths within any of multiple roots', function () {
      const root1 = join(tmpdir(), 'root1');
      const root2 = join(tmpdir(), 'root2');
      expect(() => assertSafePath(join(root2, 'file.yaml'), [root1, root2])).to.not.throw();
    });

    it('blocks paths outside all allowed roots', function () {
      const root = join(tmpdir(), 'allowed');
      const evil = join(tmpdir(), 'evil', 'file.yaml');
      expect(() => assertSafePath(evil, [root])).to.throw('Path traversal blocked');
    });

    it('blocks path traversal with ../', function () {
      const root = join(tmpdir(), 'allowed');
      const evil = join(root, '..', 'evil', 'file.yaml');
      expect(() => assertSafePath(evil, [root])).to.throw('Path traversal blocked');
    });

    it('blocks prefix-matching attacks (root-evil vs root)', function () {
      const root = join(tmpdir(), 'root');
      const evil = join(tmpdir(), 'root-evil', 'file.yaml');
      expect(() => assertSafePath(evil, [root])).to.throw('Path traversal blocked');
    });
  });

  describe('safeLineupPath', function () {
    it('allows files in cwd', function () {
      const cwd = join(tmpdir(), 'my-project');
      const filePath = join(cwd, 'lineup.yaml');
      const result = safeLineupPath(filePath, cwd);
      expect(result).to.equal(resolve(filePath));
    });

    it('allows files in ~/.claude-tempo/ensembles/', function () {
      const ensemblesDir = join(homedir(), '.claude-tempo', 'ensembles');
      const filePath = join(ensemblesDir, 'my-lineup.yaml');
      const cwd = join(tmpdir(), 'somewhere-else');
      const result = safeLineupPath(filePath, cwd);
      expect(result).to.equal(resolve(filePath));
    });

    it('blocks files outside allowed roots', function () {
      const cwd = join(tmpdir(), 'my-project');
      const evil = join(tmpdir(), 'evil', 'steal-secrets.yaml');
      expect(() => safeLineupPath(evil, cwd)).to.throw('Path traversal blocked');
    });

    it('allows files in project dir when provided', function () {
      const cwd = join(tmpdir(), 'cwd');
      const projectDir = join(tmpdir(), 'project-root');
      const filePath = join(projectDir, 'lineups', 'dev.yaml');
      const result = safeLineupPath(filePath, cwd, projectDir);
      expect(result).to.equal(resolve(filePath));
    });
  });
});
