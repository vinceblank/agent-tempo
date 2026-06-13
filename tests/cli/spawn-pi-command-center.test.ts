/**
 * #820 — `buildPiCommandCenterSpawn` ROLE DETERMINISM (the destructive fix).
 *
 * The command-center board is OBSERVER-ONLY: it must NEVER resolve to the `player`
 * role, because the player extension would then CLAIM the attachment for the
 * (inherited) `PLAYER_NAME` — and the common leak source is a conductor terminal
 * (`AGENT_TEMPO_PLAYER_NAME=tempo-conductor`), so it HIJACKED the conductor slot and
 * orphaned it on exit. Root cause: `buildPiCommandCenterSpawn` set `MISSION_CONTROL=1`
 * but only OMITTED `PLAYER_NAME`/`CONDUCTOR` — the spawned terminal INHERITS them, and
 * `resolvePiRole` ranks `PLAYER_NAME` above `MISSION_CONTROL`, flipping the role.
 *
 * The fix makes the role deterministic regardless of inherited env:
 *   (a) force `AGENT_TEMPO_PI_ROLE=command-center` (top of resolvePiRole precedence), and
 *   (b) explicitly CLEAR `PLAYER_NAME`/`CONDUCTOR` to '' ("not setting" ≠ "clearing").
 *
 * Pure — no process spawn, no Temporal. The binary resolver is injected.
 */
import { describe, it, expect } from 'vitest';
import { buildPiCommandCenterSpawn } from '../../src/spawn';
import { ENV, resolvePiRole } from '../../src/config';

const base = {
  ensemble: 'tempo-impl',
  temporalEnvVars: { [ENV.TEMPORAL_ADDRESS]: 'localhost:7233', [ENV.TEMPORAL_NAMESPACE]: 'default' },
  taskQueue: 'agent-tempo',
  devMode: false,
  resolveBinary: () => ({ cmd: 'pi', args: [] }),
};

describe('buildPiCommandCenterSpawn (#820 — role determinism)', () => {
  it('Test 1: sets AGENT_TEMPO_PI_ROLE=command-center (highest-precedence force)', () => {
    const { env } = buildPiCommandCenterSpawn(base);
    expect(env[ENV.PI_ROLE]).toBe('command-center');
  });

  it('Test 2: explicitly CLEARS AGENT_TEMPO_PLAYER_NAME (empty string, not absent)', () => {
    const { env } = buildPiCommandCenterSpawn(base);
    expect(env[ENV.PLAYER_NAME]).toBe(''); // NOT toBeUndefined — "not setting" ≠ "clearing"
    expect(Object.prototype.hasOwnProperty.call(env, ENV.PLAYER_NAME)).toBe(true);
  });

  it('Test 3: explicitly CLEARS AGENT_TEMPO_CONDUCTOR (empty string, not absent)', () => {
    const { env } = buildPiCommandCenterSpawn(base);
    expect(env[ENV.CONDUCTOR]).toBe(''); // NOT toBeUndefined
    expect(Object.prototype.hasOwnProperty.call(env, ENV.CONDUCTOR)).toBe(true);
  });

  it('Test 4 ★ THE INHERITED-ENV REGRESSION: resolves command-center even under inherited PLAYER_NAME', () => {
    // Simulate command-center launched from an ensemble shell that has PLAYER_NAME set
    // (e.g. a conductor terminal). Before the fix this merged env resolved to 'player'
    // → the board claimed/hijacked the conductor slot. It MUST now be 'command-center'.
    const inheritedEnv = { [ENV.PLAYER_NAME]: 'tempo-conductor', [ENV.CONDUCTOR]: 'true' };
    const { env: ccEnv } = buildPiCommandCenterSpawn(base);
    const mergedEnv = { ...inheritedEnv, ...ccEnv };
    expect(resolvePiRole(mergedEnv)).toBe('command-center');
  });

  // ── Supporting assertions (shape of the spawn spec) ──

  it('passes NO inline `-e` (extensions auto-load from settings.json — avoids double-load)', () => {
    const { cmd, args } = buildPiCommandCenterSpawn(base);
    expect(cmd).toBe('pi');
    expect(args).toEqual([]);
  });

  it('keeps the MISSION_CONTROL opt-in (defense-in-depth) and the operator subset', () => {
    const { env } = buildPiCommandCenterSpawn(base);
    expect(env[ENV.MISSION_CONTROL]).toBe('1');
    expect(env[ENV.ENSEMBLE]).toBe('tempo-impl');
    expect(env[ENV.TASK_QUEUE]).toBe('agent-tempo');
    expect(env[ENV.NO_PPID_WATCHDOG]).toBe('1');
  });

  it('includes DEV_MODE / admin token / ANTHROPIC_API_KEY only when provided', () => {
    const bare = buildPiCommandCenterSpawn(base).env;
    expect(bare[ENV.DEV_MODE]).toBeUndefined();
    expect(bare[ENV.HTTP_ADMIN_TOKEN]).toBeUndefined();
    expect(bare.ANTHROPIC_API_KEY).toBeUndefined();

    const full = buildPiCommandCenterSpawn({
      ...base,
      devMode: true,
      adminToken: 'tok-123',
      anthropicApiKey: 'sk-test',
    }).env;
    expect(full[ENV.DEV_MODE]).toBe('1');
    expect(full[ENV.HTTP_ADMIN_TOKEN]).toBe('tok-123');
    expect(full.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('propagates the resolver fail-clean throw (preflight before any terminal launch)', () => {
    expect(() => buildPiCommandCenterSpawn({
      ...base,
      resolveBinary: () => { throw new Error('Pi CLI not found.'); },
    })).toThrow(/Pi CLI not found/);
  });
});
