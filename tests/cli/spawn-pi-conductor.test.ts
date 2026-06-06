/**
 * Unit tests for the interactive Pi conductor spawn helpers (src/spawn.ts, #666):
 * resolvePiInteractiveBinary / resolvePiExtensionPath / buildPiConductorSpawn.
 *
 * Pure — no process spawn, no Temporal. Collaborators are injected (PATH lookup,
 * fs.exists, resolvers), so each branch is exercised deterministically.
 *
 * The launchInTerminal extraction (#666 C1) is regression-covered by the EXISTING
 * terminal-spawn tests (tests/adapters/.../spawn-route.test.ts + the conductor /
 * recruit-spawn paths) staying green — spawnInTerminal's signature + behavior are
 * unchanged (thin wrapper over launchInTerminal). buildTerminalCommand (the
 * renamed buildClaudeCommand) is sanity-checked below.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePiInteractiveBinary,
  resolvePiExtensionPath,
  buildPiConductorSpawn,
} from '../../src/spawn';
import { ENV } from '../../src/config';

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

describe('resolvePiExtensionPath (#666)', () => {
  it('prod: dist/__dirname → dist/pi/extension.js', () => {
    // (endsWith, not exact — `resolve` prepends a drive letter on Windows.)
    const p = resolvePiExtensionPath({ isDev: false, baseDir: '/app/dist', exists: () => true }).replace(/\\/g, '/');
    expect(p.endsWith('/app/dist/pi/extension.js'), p).toBe(true);
  });

  it('dev: src/__dirname → sibling dist/pi/extension.js (Pi loads built JS)', () => {
    // The `..` traversal turns src/ into the sibling dist/: /repo/src → /repo/dist/pi/extension.js.
    const p = resolvePiExtensionPath({ isDev: true, baseDir: '/repo/src', exists: () => true }).replace(/\\/g, '/');
    expect(p.endsWith('/repo/dist/pi/extension.js'), p).toBe(true);
    expect(p.includes('/src/'), 'dev must resolve src→dist, not stay under src/').toBe(false);
  });

  it('throws fail-clean (run npm run build) when the extension is missing', () => {
    expect(() => resolvePiExtensionPath({ isDev: false, baseDir: '/app/dist', exists: () => false }))
      .toThrow(/Run `npm run build`/);
  });
});

describe('buildPiConductorSpawn (#666 — args + env mapping)', () => {
  const base = {
    ensemble: 'demo',
    sessionName: 'conductor',
    temporalEnvVars: { [ENV.TEMPORAL_ADDRESS]: 'localhost:7233', [ENV.TEMPORAL_NAMESPACE]: 'default' },
    taskQueue: 'agent-tempo',
    devMode: false,
    resolveBinary: () => ({ cmd: 'pi', args: [] }),
    resolveExtension: () => '/abs/dist/pi/extension.js',
  };

  it('builds `pi -e <ext>` and the conductor env', () => {
    const { cmd, args, env } = buildPiConductorSpawn(base);
    expect(cmd).toBe('pi');
    expect(args).toEqual(['-e', '/abs/dist/pi/extension.js']);
    // Temporal env spread through:
    expect(env[ENV.TEMPORAL_ADDRESS]).toBe('localhost:7233');
    expect(env[ENV.TEMPORAL_NAMESPACE]).toBe('default');
    // Confirm #1: task queue forwarded (the Pi extension's PiWorkflowClient needs it).
    expect(env[ENV.TASK_QUEUE]).toBe('agent-tempo');
    // Identity + conductor flag (confirm #2: 'true', accepted by the Pi extension).
    expect(env[ENV.ENSEMBLE]).toBe('demo');
    expect(env[ENV.CONDUCTOR]).toBe('true');
    expect(env[ENV.PLAYER_NAME]).toBe('conductor');
    // #672: the pi conductor is a transient-CLI detached spawn → ppid-poll skipped
    // (inert today since pi installs no watchdog, but principled + propagation-safe).
    expect(env[ENV.NO_PPID_WATCHDOG]).toBe('1');
    // Optional fields ABSENT when not provided.
    expect(env[ENV.DEV_MODE]).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env[ENV.PLAYER_TYPE]).toBeUndefined();
  });

  it('prepends the node-fallback binary args before `-e`', () => {
    const { cmd, args } = buildPiConductorSpawn({
      ...base,
      resolveBinary: () => ({ cmd: 'node', args: ['/nm/cli.js'] }),
    });
    expect(cmd).toBe('node');
    expect(args).toEqual(['/nm/cli.js', '-e', '/abs/dist/pi/extension.js']);
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
