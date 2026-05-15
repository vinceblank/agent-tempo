/**
 * Unit tests for the ensemble lineup loader — conductor-required rule.
 *
 * Covers: missing conductor → actionable error; malformed conductor →
 * distinct actionable error; bare `conductor: {}` accepted; full conductor
 * block preserved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadLineup } from '../../src/ensemble/loader';

let tmpDir: string;

function writeLineup(name: string, body: string): string {
  const filePath = join(tmpDir, `${name}.yaml`);
  writeFileSync(filePath, body);
  return filePath;
}

describe('loadLineup — conductor required', () => {
  beforeAll(() => {
    tmpDir = join(tmpdir(), `agent-tempo-loader-${Date.now()}-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('rejects a lineup with no conductor block and names the lineup', () => {
    const filePath = writeLineup('missing-conductor', [
      'name: orchestra',
      'players:',
      '  - name: first-chair',
      '',
    ].join('\n'));

    try {
      loadLineup(filePath);
      expect.fail('expected loadLineup to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/lineup "orchestra" is missing a conductor/);
      expect(msg).toMatch(/every ensemble must define exactly one conductor/);
      expect(msg).toMatch(/AGENT_TEMPO_DEFAULT_AGENT/);
    }
  });

  it('rejects a lineup where conductor is a string (malformed)', () => {
    const filePath = writeLineup('conductor-string', [
      'name: bad-shape',
      'conductor: "a string"',
      'players:',
      '  - name: p1',
      '',
    ].join('\n'));

    expect(() => loadLineup(filePath)).toThrow(/has a malformed conductor/);
    expect(() => loadLineup(filePath)).toThrow(/got string/);
  });

  it('rejects a lineup where conductor is an array (malformed)', () => {
    const filePath = writeLineup('conductor-array', [
      'name: bad-array',
      'conductor:',
      '  - name: x',
      'players:',
      '  - name: p1',
      '',
    ].join('\n'));

    expect(() => loadLineup(filePath)).toThrow(/has a malformed conductor/);
    expect(() => loadLineup(filePath)).toThrow(/got array/);
  });

  it('accepts a bare conductor block (all inner fields optional)', () => {
    const filePath = writeLineup('minimal', [
      'name: minimal',
      'conductor: {}',
      'players:',
      '  - name: solo',
      '',
    ].join('\n'));

    const lineup = loadLineup(filePath);
    expect(lineup.name).toBe('minimal');
    expect(lineup.conductor).toEqual({});
    expect(lineup.players).toHaveLength(1);
  });

  it('accepts a fully-populated conductor block', () => {
    const filePath = writeLineup('full', [
      'name: full',
      'conductor:',
      '  name: maestro',
      '  type: tempo-conductor',
      '  agent: copilot',
      '  instructions: Lead the ensemble.',
      'players:',
      '  - name: p1',
      '',
    ].join('\n'));

    const lineup = loadLineup(filePath);
    expect(lineup.conductor.name).toBe('maestro');
    expect(lineup.conductor.type).toBe('tempo-conductor');
    expect(lineup.conductor.agent).toBe('copilot');
    expect(lineup.conductor.instructions).toBe('Lead the ensemble.');
  });

  it('accepts conductor with agent: mock + mockMode + mockScenario (#fix/tempo-mock-jam)', () => {
    const filePath = writeLineup('mock-conductor', [
      'name: mock-conductor',
      'conductor:',
      '  type: tempo-conductor',
      '  agent: mock',
      '  mockMode: scripted',
      '  mockScenario: conductor-recruit-mock',
      'players:',
      '  - name: p1',
      '',
    ].join('\n'));

    const lineup = loadLineup(filePath);
    expect(lineup.conductor.agent).toBe('mock');
    expect(lineup.conductor.mockMode).toBe('scripted');
    expect(lineup.conductor.mockScenario).toBe('conductor-recruit-mock');
  });
});
