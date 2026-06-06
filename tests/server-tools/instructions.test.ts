/**
 * Content-regression guard for the #695 yield-don't-poll norms in
 * buildServerInstructions (src/server-tools.ts). These apply to ALL MCP players
 * (conductor AND non-conductor), so assert they're present in both renderings —
 * a future refactor of the instruction concat can't silently drop them.
 */
import { describe, it, expect } from 'vitest';
import { buildServerInstructions } from '../../src/server-tools';

const base = {
  ensemble: 'pitest',
  playerId: 'tempo-eng',
  hasRequestedName: true,
} as const;

// The distinctive substring of each #695 norm bullet.
const NORMS = [
  'Yield after dispatch',
  'one-shot inbox drain, not a wait primitive',
  "Don't reply to ack/FYI cues",
  "Cues queue, they don't interrupt",
];

describe('buildServerInstructions — #695 yield norms', () => {
  for (const isConductor of [false, true]) {
    it(`includes all four yield norms (isConductor=${isConductor})`, () => {
      const out = buildServerInstructions({ ...base, isConductor });
      for (const norm of NORMS) {
        expect(out, `missing norm: "${norm}"`).toContain(norm);
      }
    });
  }

  it('keeps them under the Communication discipline section (not the conductor-only block)', () => {
    const out = buildServerInstructions({ ...base, isConductor: false });
    const discIdx = out.indexOf('Communication discipline');
    const playerRulesIdx = out.indexOf('Player rules');
    expect(discIdx).toBeGreaterThanOrEqual(0);
    // The norms sit in the shared discipline block, before the role-specific rules.
    expect(out.indexOf('Yield after dispatch')).toBeGreaterThan(discIdx);
    if (playerRulesIdx >= 0) {
      expect(out.indexOf('Yield after dispatch')).toBeLessThan(playerRulesIdx);
    }
  });
});
