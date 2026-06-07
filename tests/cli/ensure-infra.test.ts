/**
 * Unit tests for the shared infra bootstrap (#700 P1, src/cli/ensure-infra.ts).
 * Uses the injectable `deps` seam so nothing is spawned — asserts the load-bearing
 * invariants: search attributes registered BEFORE the daemon, the explicit config
 * is threaded to startDaemon (bare-pi has no env), and the bootstrap is
 * CONNECT-ONLY (its dependency surface exposes no MCP-register hook).
 */
import { describe, it, expect } from 'vitest';
import { ensureInfra, type EnsureInfraDeps } from '../../src/cli/ensure-infra';
import type { Config } from '../../src/config';

const cfg = { temporalAddress: 'localhost:7233', temporalNamespace: 'default' } as Config;

function makeDeps(over: Partial<EnsureInfraDeps> = {}): { deps: EnsureInfraDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: EnsureInfraDeps = {
    isTemporalReachable: async () => { calls.push('isTemporalReachable'); return true; },
    startTemporalDevServer: async () => { calls.push('startTemporalDevServer'); return { pid: 111 }; },
    registerSearchAttributes: () => { calls.push('registerSearchAttributes'); return { failed: 0 }; },
    installAgentTypes: () => { calls.push('installAgentTypes'); return { installed: 0, total: 3 }; },
    isDaemonRunning: () => { calls.push('isDaemonRunning'); return false; },
    startDaemon: async () => { calls.push('startDaemon'); return 4321; },
    getDaemonStatus: () => ({ pid: 4321 }),
    ...over,
  };
  return { deps, calls };
}

describe('ensureInfra (#700 P1)', () => {
  it('★ registers search attributes BEFORE starting the daemon (must-fix #2 — daemon refuses to boot without SAs)', async () => {
    const { deps, calls } = makeDeps();
    await ensureInfra({ config: cfg, deps });
    expect(calls).toContain('registerSearchAttributes');
    expect(calls).toContain('startDaemon');
    expect(calls.indexOf('registerSearchAttributes')).toBeLessThan(calls.indexOf('startDaemon'));
  });

  it('passes the EXPLICIT config to startDaemon (bare `pi` has no AGENT_TEMPO_* env)', async () => {
    let received: Config | undefined;
    const { deps } = makeDeps({ startDaemon: async (c) => { received = c; return 1; } });
    await ensureInfra({ config: cfg, deps });
    expect(received).toBe(cfg);
  });

  it('does NOT start the daemon when one is already running', async () => {
    const { deps, calls } = makeDeps({ isDaemonRunning: () => true });
    const r = await ensureInfra({ config: cfg, deps });
    expect(calls).not.toContain('startDaemon');
    expect(r.daemon).toBe('up');
  });

  it('auto-starts Temporal when unreachable, then proceeds', async () => {
    const { deps, calls } = makeDeps({ isTemporalReachable: async () => false });
    const r = await ensureInfra({ config: cfg, deps });
    expect(calls).toContain('startTemporalDevServer');
    expect(r.temporal).toBe('started');
  });

  it('emits onStep progress for each phase (temporal → search-attributes → agent-types → daemon)', async () => {
    const { deps } = makeDeps();
    const steps: string[] = [];
    await ensureInfra({ config: cfg, deps, onStep: (p) => steps.push(p.step) });
    expect(steps).toEqual(['temporal', 'search-attributes', 'agent-types', 'daemon']);
  });

  it('search-attributes onStep detail: undefined on success, "N failed" on failure (#46 — drives up()s CLI SA line)', async () => {
    // The CLI `up` onStep renders `out.check('Search attributes registered', !detail, detail)`
    // — so the contract it relies on is: detail absent ⇒ success (pass), detail
    // present ⇒ failure count. Lock both via the injectable deps seam (no Temporal).
    const okSteps: Array<{ step: string; detail?: string }> = [];
    await ensureInfra({ config: cfg, deps: makeDeps().deps, onStep: (p) => okSteps.push({ step: p.step, detail: p.detail }) });
    expect(okSteps.find((s) => s.step === 'search-attributes')?.detail).toBeUndefined();

    const failSteps: Array<{ step: string; detail?: string }> = [];
    const { deps } = makeDeps({ registerSearchAttributes: () => ({ failed: 2 }) });
    await ensureInfra({ config: cfg, deps, onStep: (p) => failSteps.push({ step: p.step, detail: p.detail }) });
    expect(failSteps.find((s) => s.step === 'search-attributes')?.detail).toBe('2 failed');
  });

  it('is CONNECT-ONLY — the dependency surface exposes no MCP/init register hook', () => {
    const { deps } = makeDeps();
    const keys = Object.keys(deps);
    expect(keys).not.toContain('init');
    expect(keys).not.toContain('registerMcp');
    expect(keys).not.toContain('registerAllTempoTools');
  });
});
