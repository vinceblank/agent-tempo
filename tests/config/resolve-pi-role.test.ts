/**
 * resolvePiRole (#729) — the single discriminator both auto-loaded Pi extensions
 * gate on. Pure (env injectable) so the dormancy matrix is unit-testable here
 * without spawning a Pi session.
 */
import { describe, it, expect } from 'vitest';
import { ENV, resolvePiRole, type PiRole } from '../../src/config';

/** Build an env fixture from the relevant keys only (no ambient process.env). */
function env(over: Partial<Record<'PI_ROLE' | 'PLAYER_NAME' | 'MISSION_CONTROL', string>>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  if (over.PI_ROLE !== undefined) e[ENV.PI_ROLE] = over.PI_ROLE;
  if (over.PLAYER_NAME !== undefined) e[ENV.PLAYER_NAME] = over.PLAYER_NAME;
  if (over.MISSION_CONTROL !== undefined) e[ENV.MISSION_CONTROL] = over.MISSION_CONTROL;
  return e;
}

describe('resolvePiRole (#729) — role discriminator table', () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; expected: PiRole }> = [
    { name: 'bare pi (no signals) → none', env: env({}), expected: 'none' },
    { name: 'PLAYER_NAME set → player', env: env({ PLAYER_NAME: 'pi-eng-1' }), expected: 'player' },
    { name: 'MISSION_CONTROL set → command-center', env: env({ MISSION_CONTROL: '1' }), expected: 'command-center' },
    { name: 'PI_ROLE=player → player', env: env({ PI_ROLE: 'player' }), expected: 'player' },
    { name: 'PI_ROLE=command-center → command-center', env: env({ PI_ROLE: 'command-center' }), expected: 'command-center' },
    // Precedence: a session that must CLAIM must never degrade to a passive board.
    { name: 'PLAYER_NAME + MISSION_CONTROL → player (player beats board)', env: env({ PLAYER_NAME: 'p', MISSION_CONTROL: '1' }), expected: 'player' },
    // Explicit override beats every heuristic.
    { name: 'PI_ROLE=command-center + PLAYER_NAME → command-center (explicit wins)', env: env({ PI_ROLE: 'command-center', PLAYER_NAME: 'p' }), expected: 'command-center' },
    { name: 'PI_ROLE=player + MISSION_CONTROL → player (explicit wins)', env: env({ PI_ROLE: 'player', MISSION_CONTROL: '1' }), expected: 'player' },
    // An unrecognized PI_ROLE value is ignored — falls through to the heuristic.
    { name: 'PI_ROLE=garbage (ignored) + nothing → none', env: env({ PI_ROLE: 'garbage' }), expected: 'none' },
    { name: 'PI_ROLE=garbage (ignored) + PLAYER_NAME → player', env: env({ PI_ROLE: 'garbage', PLAYER_NAME: 'p' }), expected: 'player' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolvePiRole(c.env)).toBe(c.expected);
    });
  }

  it('defaults to reading process.env when no arg is passed', () => {
    // Smoke: the zero-arg path resolves to a valid role without throwing.
    expect(['player', 'command-center', 'none']).toContain(resolvePiRole());
  });
});
