/**
 * Unit tests for resolveLineupPath() in src/ensemble/loader.ts.
 *
 * These tests run without Temporal — pure filesystem resolution logic.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveLineupPath } from '../src/ensemble/loader';
import { AGENT_TEMPO_HOME } from '../src/config';

describe('resolveLineupPath', function () {
  const ensemblesDir = path.join(AGENT_TEMPO_HOME, 'ensembles');
  let tmpDir: string;

  before(function () {
    // Create a temp dir for direct file path tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-loader-test-'));
  });

  after(function () {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('resolves a shipped example by name', function () {
    const result = resolveLineupPath('tempo-dev-team');
    expect(result.source).to.equal('shipped');
    expect(result.path).to.include('examples');
    expect(result.path).to.include('tempo-dev-team');
    expect(fs.existsSync(result.path)).to.be.true;
  });

  it('resolves shipped examples with .yaml extension', function () {
    const result = resolveLineupPath('tempo-big-band');
    expect(result.source).to.equal('shipped');
    expect(result.path).to.match(/\.yaml$/);
  });

  it('resolves a direct file path', function () {
    const filePath = path.join(tmpDir, 'my-lineup.yaml');
    fs.writeFileSync(filePath, 'name: test\nplayers: []\n');

    const result = resolveLineupPath(filePath);
    expect(result.source).to.equal('file');
    expect(result.path).to.equal(path.resolve(filePath));
  });

  it('resolves saved lineup (.yaml) with priority over shipped', function () {
    // Create a saved lineup with the same name as a shipped one
    fs.mkdirSync(ensemblesDir, { recursive: true });
    const savedPath = path.join(ensemblesDir, 'tempo-dev-team.yaml');
    const existed = fs.existsSync(savedPath);
    let originalContent: string | undefined;
    if (existed) {
      originalContent = fs.readFileSync(savedPath, 'utf8');
    }

    try {
      fs.writeFileSync(savedPath, 'name: saved-override\nplayers: []\n');
      const result = resolveLineupPath('tempo-dev-team');
      expect(result.source).to.equal('saved');
      expect(result.path).to.equal(savedPath);
    } finally {
      // Restore original state
      if (existed && originalContent !== undefined) {
        fs.writeFileSync(savedPath, originalContent);
      } else {
        try { fs.unlinkSync(savedPath); } catch { /* ignore */ }
      }
    }
  });

  it('resolves saved lineup with .yml extension', function () {
    fs.mkdirSync(ensemblesDir, { recursive: true });
    const savedPath = path.join(ensemblesDir, 'test-yml-lineup.yml');

    try {
      fs.writeFileSync(savedPath, 'name: yml-test\nplayers: []\n');
      const result = resolveLineupPath('test-yml-lineup');
      expect(result.source).to.equal('saved');
      expect(result.path).to.equal(savedPath);
    } finally {
      try { fs.unlinkSync(savedPath); } catch { /* ignore */ }
    }
  });

  it('throws for non-existent name with suggestions', function () {
    try {
      resolveLineupPath('nonexistent-lineup-xyz');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('not found');
      expect(err.message).to.include('nonexistent-lineup-xyz');
      // Should include shipped suggestions
      expect(err.message).to.include('Shipped:');
      expect(err.message).to.include('tempo-dev-team');
    }
  });

  it('handles missing ensembles dir gracefully', function () {
    // Use a name that won't match any shipped example or file
    // This exercises the code path where ensemblesDir may not exist
    try {
      resolveLineupPath('absolutely-no-match-anywhere-12345');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('not found');
      // Should not throw a filesystem error about missing dir
      expect(err.message).not.to.include('ENOENT');
    }
  });

  it('error message includes both saved and shipped names', function () {
    // Create a saved lineup so both categories appear in error
    fs.mkdirSync(ensemblesDir, { recursive: true });
    const savedPath = path.join(ensemblesDir, 'test-error-msg.yaml');

    try {
      fs.writeFileSync(savedPath, 'name: test\nplayers: []\n');
      resolveLineupPath('no-such-lineup-ever');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('Saved:');
      expect(err.message).to.include('test-error-msg');
      expect(err.message).to.include('Shipped:');
      expect(err.message).to.include('tempo-dev-team');
    } finally {
      try { fs.unlinkSync(savedPath); } catch { /* ignore */ }
    }
  });
});
