/**
 * #596 / ADR 0016 — lineup schema + precedence tests for `experimental.spawn`
 * and `spawn` fields.
 *
 * Covers:
 *   - top-level `spawn` enum validation
 *   - per-player `spawn` enum validation
 *   - `experimental.spawn` boolean validation
 *   - experimental-gate enforcement (bg without experimental.spawn → throws)
 *   - precedence resolution (player > lineup > 'terminal' default)
 *   - `_spawn` transient field populated on loaded players
 *   - non-claude agent + bg warning path (loader accepts, dispatcher ignores)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadLineup, resolveSpawnMode } from '../../src/ensemble/loader';

let tmpDir: string;

function writeLineup(name: string, body: string): string {
  const filePath = join(tmpDir, `${name}.yaml`);
  writeFileSync(filePath, body);
  return filePath;
}

describe('loadLineup — ADR 0016 spawn-mode validation', () => {
  beforeAll(() => {
    tmpDir = join(tmpdir(), `agent-tempo-spawn-mode-${Date.now()}-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── Enum validation ──────────────────────────────────────────────────

  it('rejects unknown top-level spawn value', () => {
    const filePath = writeLineup('bad-top', [
      'name: orchestra',
      'spawn: turbo',
      'conductor: {}',
      'players: []',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/spawn.*must be one of/);
  });

  it('rejects unknown per-player spawn value', () => {
    const filePath = writeLineup('bad-player', [
      'name: orchestra',
      'experimental:',
      '  spawn: true',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '    spawn: rocket',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/players\[0\]\.spawn.*must be one of/);
  });

  it('rejects non-boolean experimental.spawn', () => {
    const filePath = writeLineup('bad-exp', [
      'name: orchestra',
      'experimental:',
      '  spawn: "yes"',
      'conductor: {}',
      'players: []',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/experimental\.spawn.*must be a boolean/);
  });

  it('rejects experimental block that is an array', () => {
    const filePath = writeLineup('bad-exp-array', [
      'name: orchestra',
      'experimental:',
      '  - spawn',
      'conductor: {}',
      'players: []',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/experimental.*must be a mapping/);
  });

  // ── Experimental gate enforcement ────────────────────────────────────

  it('throws when spawn: bg appears at lineup level without experimental.spawn: true', () => {
    const filePath = writeLineup('ungated-lineup', [
      'name: orchestra',
      'spawn: bg',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/spawn: bg requires 'experimental\.spawn: true'/);
  });

  it('throws when spawn: bg appears at player level without experimental.spawn: true', () => {
    const filePath = writeLineup('ungated-player', [
      'name: orchestra',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '    spawn: bg',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/spawn: bg requires 'experimental\.spawn: true'/);
  });

  it('throws when spawn: bg appears even with experimental.spawn: false explicit', () => {
    const filePath = writeLineup('ungated-explicit', [
      'name: orchestra',
      'experimental:',
      '  spawn: false',
      'spawn: bg',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '',
    ].join('\n'));
    expect(() => loadLineup(filePath)).toThrow(/spawn: bg requires 'experimental\.spawn: true'/);
  });

  it('accepts spawn: bg when experimental.spawn: true', () => {
    const filePath = writeLineup('ok-gated', [
      'name: orchestra',
      'experimental:',
      '  spawn: true',
      'spawn: bg',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '',
    ].join('\n'));
    const lineup = loadLineup(filePath);
    expect(lineup.spawn).toBe('bg');
    expect(lineup.experimental?.spawn).toBe(true);
  });

  // ── Precedence resolution ────────────────────────────────────────────

  it('resolves _spawn to "terminal" by default when no spawn field is set', () => {
    const filePath = writeLineup('default', [
      'name: orchestra',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '',
    ].join('\n'));
    const lineup = loadLineup(filePath);
    expect((lineup.players[0] as any)._spawn).toBe('terminal');
  });

  it('resolves _spawn from lineup-wide default when no per-player override', () => {
    const filePath = writeLineup('lineup-default', [
      'name: orchestra',
      'experimental:',
      '  spawn: true',
      'spawn: bg',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '  - name: bob',
      '',
    ].join('\n'));
    const lineup = loadLineup(filePath);
    expect((lineup.players[0] as any)._spawn).toBe('bg');
    expect((lineup.players[1] as any)._spawn).toBe('bg');
  });

  it('per-player spawn overrides lineup-wide spawn', () => {
    const filePath = writeLineup('per-player-override', [
      'name: orchestra',
      'experimental:',
      '  spawn: true',
      'spawn: bg',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '    spawn: terminal',
      '  - name: bob',
      '',
    ].join('\n'));
    const lineup = loadLineup(filePath);
    expect((lineup.players[0] as any)._spawn).toBe('terminal');
    expect((lineup.players[1] as any)._spawn).toBe('bg');
  });

  it('per-player spawn overrides default ("bg" on one player only)', () => {
    const filePath = writeLineup('one-bg', [
      'name: orchestra',
      'experimental:',
      '  spawn: true',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '    spawn: bg',
      '  - name: bob',
      '',
    ].join('\n'));
    const lineup = loadLineup(filePath);
    expect((lineup.players[0] as any)._spawn).toBe('bg');
    expect((lineup.players[1] as any)._spawn).toBe('terminal');
  });

  // ── resolveSpawnMode helper (unit) ───────────────────────────────────

  it('resolveSpawnMode honors player > lineup > default precedence', () => {
    expect(resolveSpawnMode({}, {})).toBe('terminal');
    expect(resolveSpawnMode({}, { spawn: 'bg' })).toBe('bg');
    expect(resolveSpawnMode({ spawn: 'terminal' }, { spawn: 'bg' })).toBe('terminal');
    expect(resolveSpawnMode({ spawn: 'bg' }, { spawn: 'terminal' })).toBe('bg');
    expect(resolveSpawnMode({ spawn: 'bg' }, {})).toBe('bg');
  });

  // ── Non-claude agent + bg warning ────────────────────────────────────

  describe('warning for spawn: bg on non-claude-code adapter', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('emits a warning when spawn: bg is set on a copilot player', () => {
      const filePath = writeLineup('bg-on-copilot', [
        'name: orchestra',
        'experimental:',
        '  spawn: true',
        'conductor: {}',
        'players:',
        '  - name: alice',
        '    agent: copilot',
        '    spawn: bg',
        '',
      ].join('\n'));
      const lineup = loadLineup(filePath);
      // Loader accepts (so the dispatcher is reachable); _spawn still resolved
      expect((lineup.players[0] as any)._spawn).toBe('bg');
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toMatch(/spawn: bg/);
      expect(msg).toMatch(/silently ignored/);
    });

    it('does NOT warn when spawn: bg is set on a claude player', () => {
      const filePath = writeLineup('bg-on-claude', [
        'name: orchestra',
        'experimental:',
        '  spawn: true',
        'conductor: {}',
        'players:',
        '  - name: alice',
        '    agent: claude',
        '    spawn: bg',
        '',
      ].join('\n'));
      loadLineup(filePath);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
