import { expect } from 'chai';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseFrontmatter, listAgentTypes, resolveAgentType, loadAndResolveLineup } from '../src/ensemble/agent-types';

// Create a temp directory for each test run
const TEST_DIR = join(tmpdir(), `claude-tempo-agent-types-test-${Date.now()}`);
const PROJECT_AGENTS = join(TEST_DIR, 'project', '.claude', 'agents');
const SHIPPED_AGENTS = join(TEST_DIR, 'shipped');

function createAgentFile(dir: string, filename: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function createLineupFile(dir: string, filename: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

describe('agent-types', function () {
  before(function () {
    // Create test agent files
    createAgentFile(PROJECT_AGENTS, 'project-only.md', [
      '---',
      'name: project-only',
      'description: A project-scoped agent',
      '---',
      '',
      'You are a project-scoped agent.',
    ].join('\n'));

    createAgentFile(PROJECT_AGENTS, 'shared.md', [
      '---',
      'name: shared',
      'description: Project version of shared agent',
      '---',
      '',
      'Project version.',
    ].join('\n'));

    createAgentFile(SHIPPED_AGENTS, 'shipped-only.md', [
      '---',
      'name: shipped-only',
      'description: A shipped agent',
      'model: sonnet',
      '---',
      '',
      'You are a shipped agent.',
    ].join('\n'));

    createAgentFile(SHIPPED_AGENTS, 'shared.md', [
      '---',
      'name: shared',
      'description: Shipped version of shared agent',
      '---',
      '',
      'Shipped version.',
    ].join('\n'));
  });

  after(function () {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('parseFrontmatter', function () {
    it('extracts name and description from YAML frontmatter', function () {
      const fm = parseFrontmatter(join(PROJECT_AGENTS, 'project-only.md'));
      expect(fm.name).to.equal('project-only');
      expect(fm.description).to.equal('A project-scoped agent');
    });

    it('extracts model field', function () {
      const fm = parseFrontmatter(join(SHIPPED_AGENTS, 'shipped-only.md'));
      expect(fm.model).to.equal('sonnet');
    });

    it('returns empty object for file without frontmatter', function () {
      const noFm = join(TEST_DIR, 'no-frontmatter.md');
      writeFileSync(noFm, 'Just plain markdown, no frontmatter.');
      const fm = parseFrontmatter(noFm);
      expect(fm).to.deep.equal({});
    });
  });

  describe('resolveAgentType', function () {
    it('finds project-scoped agent', function () {
      const result = resolveAgentType('project-only', join(TEST_DIR, 'project'));
      expect(result).to.not.be.null;
      expect(result!.name).to.equal('project-only');
      expect(result!.source).to.equal('project');
      expect(result!.nativeResolvable).to.be.true;
    });

    it('returns null for unknown agent type', function () {
      const result = resolveAgentType('nonexistent', join(TEST_DIR, 'project'));
      expect(result).to.be.null;
    });

    it('finds shipped examples from the package', function () {
      // Test against the actual shipped examples
      const result = resolveAgentType('tempo-composer');
      expect(result).to.not.be.null;
      expect(result!.name).to.equal('tempo-composer');
      expect(result!.description).to.be.a('string');
    });
  });

  describe('listAgentTypes', function () {
    it('lists shipped agent types', function () {
      const types = listAgentTypes();
      const names = types.map(t => t.name);
      expect(names).to.include('tempo-composer');
      expect(names).to.include('tempo-soloist');
      expect(names).to.include('tempo-tuner');
    });

    it('handles missing directories gracefully', function () {
      const types = listAgentTypes('/nonexistent/path');
      // Should still find user + shipped, not throw
      expect(types).to.be.an('array');
    });
  });

  describe('loadAndResolveLineup', function () {
    it('resolves player types in a lineup', function () {
      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'test.yaml', [
        'name: test-lineup',
        'players:',
        '  - name: arch',
        '    type: tempo-composer',
        '  - name: plain-player',
      ].join('\n'));

      const lineup = loadAndResolveLineup(join(lineupDir, 'test.yaml'));

      const arch = lineup.players.find(p => p.name === 'arch');
      expect(arch).to.not.be.undefined;
      expect(arch!._agentDefinition).to.equal('tempo-composer');
      expect(arch!._agentDefinitionPath).to.be.a('string');

      const plain = lineup.players.find(p => p.name === 'plain-player');
      expect(plain).to.not.be.undefined;
      expect(plain!._agentDefinition).to.be.undefined;
    });

    it('throws for unknown player type with helpful message', function () {
      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'bad.yaml', [
        'name: bad-lineup',
        'players:',
        '  - name: mystery',
        '    type: nonexistent-agent',
      ].join('\n'));

      expect(() => loadAndResolveLineup(join(lineupDir, 'bad.yaml'))).to.throw(
        /Unknown agent type "nonexistent-agent"/,
      );
    });

    it('works with lineup that has no type fields (backward compat)', function () {
      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'plain.yaml', [
        'name: plain-lineup',
        'players:',
        '  - name: alice',
        '  - name: bob',
      ].join('\n'));

      const lineup = loadAndResolveLineup(join(lineupDir, 'plain.yaml'));
      expect(lineup.players).to.have.length(2);
      expect(lineup.players[0]._agentDefinition).to.be.undefined;
      expect(lineup.players[1]._agentDefinition).to.be.undefined;
    });
  });
});
