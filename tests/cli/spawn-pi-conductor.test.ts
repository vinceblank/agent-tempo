/**
 * Unit tests for the interactive Pi conductor spawn helper (src/spawn.ts):
 * resolvePiInteractiveBinary / buildPiConductorSpawn.
 *
 * Pure — no process spawn, no Temporal. Collaborators are injected (PATH lookup,
 * binary resolver), so each branch is exercised deterministically.
 *
 * #825 — `up --agent pi` no longer passes an inline `pi -e <ext>`. The player
 * extension loads from Pi's settings.json (one registration source, mirroring
 * command-center) + the `resolvePiRole`→`'player'` gate. These tests pin BOTH the
 * no-`-e` shape (so no divergent on-disk copy can double-load) AND that the
 * conductor env resolves to the `player` role (so the co-loaded mission-control
 * extension stays dormant — #729 mutual exclusion).
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePiInteractiveBinary,
  buildPiConductorSpawn,
} from '../../src/spawn';
import { ENV, resolvePiRole } from '../../src/config';

describe('resolvePiInteractiveBinary (#666)', () => {
  it('uses `pi` directly when it is on PATH', () => {
    const r = resolvePiInteractiveBinary({ onPath: (b) => b === 'pi', exists: () => false });
    expect(r).toEqual({ cmd: 'pi', args: [] });
  });

  it('falls back to the installed package CLI via `node` when `pi` is not on PATH', () => {
    const r = resolvePiInteractiveBinary({
      onPath: () => false,
      exists: (p) => p.endsWith('cli.js'), // the walked package CLI candidate
    });
    expect(r.cmd).toBe('node');
    expect(r.args).toHaveLength(1);
    expect(r.args[0].endsWith('cli.js')).toBe(true);
    expect(r.args[0]).toContain('pi-coding-agent');
  });

  it('throws fail-clean when neither PATH nor the package resolves', () => {
    expect(() => resolvePiInteractiveBinary({ onPath: () => false, exists: () => false }))
      .toThrow(/Pi CLI not found/);
  });
});

describe('buildPiConductorSpawn (#666/#825 — args + env mapping)', () => {
  const base = {
    ensemble: 'demo',
    sessionName: 'conductor',
    temporalEnvVars: { [ENV.TEMPORAL_ADDRESS]: 'localhost:7233', [ENV.TEMPORAL_NAMESPACE]: 'default' },
    taskQueue: 'agent-tempo',
    devMode: false,
    resolveBinary: () => ({ cmd: 'pi', args: [] }),
  };

  // #825 — the load-bearing shape change: NO inline `-e`.
  it('passes NO inline `-e` (player extension loads from settings.json — avoids divergent-copy double-load)', () => {
    const { cmd, args } = buildPiConductorSpawn(base);
    expect(cmd).toBe('pi');
    expect(args).toEqual([]); // was ['-e', <ext>] pre-#825
    expect(args).not.toContain('-e');
  });

  it('prepends the node-fallback binary args and STILL passes no `-e`', () => {
    const { cmd, args } = buildPiConductorSpawn({
      ...base,
      resolveBinary: () => ({ cmd: 'node', args: ['/nm/cli.js'] }),
    });
    expect(cmd).toBe('node');
    expect(args).toEqual(['/nm/cli.js']);
    expect(args).not.toContain('-e');
  });

  it('builds the conductor env (identity + temporal + task queue)', () => {
    const { env } = buildPiConductorSpawn(base);
    // Temporal env spread through:
    expect(env[ENV.TEMPORAL_ADDRESS]).toBe('localhost:7233');
    expect(env[ENV.TEMPORAL_NAMESPACE]).toBe('default');
    // Task queue forwarded (the Pi extension's PiWorkflowClient needs it).
    expect(env[ENV.TASK_QUEUE]).toBe('agent-tempo');
    // Identity + conductor flag.
    expect(env[ENV.ENSEMBLE]).toBe('demo');
    expect(env[ENV.CONDUCTOR]).toBe('true');
    expect(env[ENV.PLAYER_NAME]).toBe('conductor');
    // #672: transient-CLI detached spawn → ppid-poll skipped.
    expect(env[ENV.NO_PPID_WATCHDOG]).toBe('1');
    // Optional fields ABSENT when not provided.
    expect(env[ENV.DEV_MODE]).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env[ENV.PLAYER_TYPE]).toBeUndefined();
  });

  it('includes DEV_MODE, ANTHROPIC_API_KEY, and PLAYER_TYPE only when provided', () => {
    const { env } = buildPiConductorSpawn({
      ...base,
      devMode: true,
      anthropicApiKey: 'sk-test',
      conductorTypeName: 'tempo-conductor',
    });
    expect(env[ENV.DEV_MODE]).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env[ENV.PLAYER_TYPE]).toBe('tempo-conductor');
  });

  it('propagates the resolver fail-clean throw (preflight before any terminal launch)', () => {
    expect(() => buildPiConductorSpawn({
      ...base,
      resolveBinary: () => { throw new Error('Pi CLI not found.'); },
    })).toThrow(/Pi CLI not found/);
  });
});

// #825 — with `-e` dropped, the role gate is what makes the spawned `pi` load the
// PLAYER extension (and keep the co-registered mission-control extension dormant).
describe('buildPiConductorSpawn (#825 — resolvePiRole → player gate)', () => {
  const base = {
    ensemble: 'demo',
    sessionName: 'tempo-conductor',
    temporalEnvVars: { [ENV.TEMPORAL_ADDRESS]: 'localhost:7233', [ENV.TEMPORAL_NAMESPACE]: 'default' },
    taskQueue: 'agent-tempo',
    devMode: false,
    resolveBinary: () => ({ cmd: 'pi', args: [] }),
  };

  it('conductor env resolves to the `player` role (mission-control stays dormant)', () => {
    const { env } = buildPiConductorSpawn(base);
    // PLAYER_NAME is set (ranked above MISSION_CONTROL) and neither PI_ROLE nor
    // MISSION_CONTROL is set → 'player'. The command-center extension only
    // activates on 'command-center', so it stays dormant in this session.
    expect(env[ENV.PI_ROLE]).toBeUndefined();
    expect(env[ENV.MISSION_CONTROL]).toBeUndefined();
    expect(resolvePiRole(env)).toBe('player');
  });

  it('resolves `player` even merged over an inherited shell env', () => {
    // The terminal inherits the parent shell env; the conductor env must still
    // pin 'player' (PLAYER_NAME is set by the spawn spec regardless).
    const inherited = { SOME_UNRELATED: '1' };
    const { env } = buildPiConductorSpawn(base);
    expect(resolvePiRole({ ...inherited, ...env } as NodeJS.ProcessEnv)).toBe('player');
  });
});
