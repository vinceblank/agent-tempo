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

    it('extracts allowedTools array from frontmatter', function () {
      const filePath = join(TEST_DIR, 'with-allowed-tools.md');
      writeFileSync(filePath, [
        '---',
        'name: restricted-agent',
        'description: A read-only agent',
        'allowedTools: [Read, Glob, Grep]',
        '---',
        '',
        'You are a read-only agent.',
      ].join('\n'));
      const fm = parseFrontmatter(filePath);
      expect(fm.allowedTools).to.deep.equal(['Read', 'Glob', 'Grep']);
    });

    it('returns no allowedTools when not specified', function () {
      const fm = parseFrontmatter(join(PROJECT_AGENTS, 'project-only.md'));
      expect(fm.allowedTools).to.be.undefined;
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

    it('includes allowedTools when defined in frontmatter', function () {
      createAgentFile(PROJECT_AGENTS, 'restricted.md', [
        '---',
        'name: restricted',
        'description: Read-only agent',
        'allowedTools: [Read, Glob, Grep]',
        '---',
        '',
        'Read-only agent.',
      ].join('\n'));
      const result = resolveAgentType('restricted', join(TEST_DIR, 'project'));
      expect(result).to.not.be.null;
      expect(result!.allowedTools).to.deep.equal(['Read', 'Glob', 'Grep']);
    });

    it('omits allowedTools when not in frontmatter', function () {
      const result = resolveAgentType('project-only', join(TEST_DIR, 'project'));
      expect(result).to.not.be.null;
      expect(result!.allowedTools).to.be.undefined;
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

    it('resolves allowedTools from agent type into lineup player', function () {
      // Create an agent type with allowedTools in the project agents dir
      createAgentFile(PROJECT_AGENTS, 'read-only-type.md', [
        '---',
        'name: read-only-type',
        'description: Read-only agent type',
        'allowedTools: [Read, Glob, Grep]',
        '---',
        '',
        'Read-only type.',
      ].join('\n'));

      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'restricted.yaml', [
        'name: restricted-lineup',
        'players:',
        '  - name: reader',
        '    type: read-only-type',
      ].join('\n'));

      const lineup = loadAndResolveLineup(
        join(lineupDir, 'restricted.yaml'),
        join(TEST_DIR, 'project'),
      );

      const reader = lineup.players.find(p => p.name === 'reader');
      expect(reader).to.not.be.undefined;
      expect(reader!._agentDefinition).to.equal('read-only-type');
      expect(reader!.allowedTools).to.deep.equal(['Read', 'Glob', 'Grep']);
    });

    it('empty allowedTools in type does not override lineup-level restriction', function () {
      // Create an agent type with empty allowedTools
      createAgentFile(PROJECT_AGENTS, 'empty-tools-type.md', [
        '---',
        'name: empty-tools-type',
        'description: Agent with empty allowedTools',
        'allowedTools: []',
        '---',
        '',
        'Agent with no tool restrictions.',
      ].join('\n'));

      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'empty-override.yaml', [
        'name: empty-override-lineup',
        'players:',
        '  - name: worker',
        '    type: empty-tools-type',
        '    allowedTools: [Read, Glob]',
      ].join('\n'));

      const lineup = loadAndResolveLineup(
        join(lineupDir, 'empty-override.yaml'),
        join(TEST_DIR, 'project'),
      );

      const worker = lineup.players.find(p => p.name === 'worker');
      expect(worker).to.not.be.undefined;
      // Empty type allowedTools should NOT override lineup-level restriction
      expect(worker!.allowedTools).to.deep.equal(['Read', 'Glob']);
    });

    it('type allowedTools overrides lineup-level allowedTools', function () {
      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'override.yaml', [
        'name: override-lineup',
        'players:',
        '  - name: reader',
        '    type: read-only-type',
        '    allowedTools: [Read, Glob, Grep, Edit, Write]',
      ].join('\n'));

      const lineup = loadAndResolveLineup(
        join(lineupDir, 'override.yaml'),
        join(TEST_DIR, 'project'),
      );

      const reader = lineup.players.find(p => p.name === 'reader');
      expect(reader).to.not.be.undefined;
      // Type wins over lineup (security principle)
      expect(reader!.allowedTools).to.deep.equal(['Read', 'Glob', 'Grep']);
    });

    it('preserves lineup allowedTools when no type is specified', function () {
      const lineupDir = join(TEST_DIR, 'lineups');
      createLineupFile(lineupDir, 'direct-tools.yaml', [
        'name: direct-tools-lineup',
        'players:',
        '  - name: custom',
        '    allowedTools: [Read, WebFetch]',
      ].join('\n'));

      const lineup = loadAndResolveLineup(
        join(lineupDir, 'direct-tools.yaml'),
        join(TEST_DIR, 'project'),
      );

      const custom = lineup.players.find(p => p.name === 'custom');
      expect(custom).to.not.be.undefined;
      expect(custom!.allowedTools).to.deep.equal(['Read', 'WebFetch']);
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
