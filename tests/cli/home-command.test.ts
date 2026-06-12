/**
 * E.8 (#789) — bare-command status home renderer tests. Pure: BootstrapResult
 * fixtures in, lines out. The hint logic is the contract under test — the
 * command-center suggestion appears iff the Pi seat is available, `up` is
 * suggested iff no ensembles run, badges surface with actionable verbs.
 */
import { describe, it, expect } from 'vitest';
import { renderHome } from '../../src/cli/home-command';
import type { BootstrapResult, StepName, StepOutcome } from '../../src/cli/startup';

const okStep = (): StepOutcome => ({ status: 'ok', durationMs: 1 });

function result(over: Partial<BootstrapResult> = {}): BootstrapResult {
  const steps = Object.fromEntries(
    ([
      'legacyHomeMigration', 'preflight', 'mcpConfig', 'temporalReach',
      'searchAttrs', 'daemonBoot', 'badgeCollection',
    ] as StepName[]).map((s) => [s, okStep()]),
  ) as Record<StepName, StepOutcome>;
  return {
    durationMs: 42,
    steps,
    badges: { orphanCount: 0 },
    ensembles: [],
    cwd: '/repo',
    cwdGitRoot: '/repo',
    ...over,
  };
}

const opts = { version: '2.0.0', hostname: 'box' };

describe('renderHome (E.8)', () => {
  it('healthy boot, no ensembles → quiet bootstrap line + `up` hint', () => {
    const lines = renderHome(result(), { ...opts, piAvailable: true });
    const text = lines.join('\n');
    expect(lines[0]).toBe('agent-tempo v2.0.0 — box');
    expect(text).toContain('bootstrap ✓ all steps healthy (42ms)');
    expect(text).toContain('No ensembles running.');
    expect(text).toContain('agent-tempo up');
    expect(text).not.toContain('agent-tempo status'); // nothing to status
  });

  it('with ensembles → lists them, suggests status, drops the `up` hint', () => {
    const lines = renderHome(result({
      ensembles: [
        { name: 'band', playerCount: 3, hasConductor: true, state: 'online' },
        { name: 'solo', playerCount: 1, hasConductor: false },
      ],
    }), { ...opts, piAvailable: true });
    const text = lines.join('\n');
    expect(text).toContain('Ensembles (2):');
    expect(text).toContain('band: 3 players — online');
    expect(text).toContain('solo: 1 player, no conductor');
    expect(text).toContain('agent-tempo status <ensemble>');
    expect(text).not.toMatch(/agent-tempo up\s/);
  });

  it('Pi seat available → command-center hint; unavailable → install hint instead', () => {
    const withPi = renderHome(result(), { ...opts, piAvailable: true }).join('\n');
    expect(withPi).toContain('agent-tempo command-center');
    expect(withPi).not.toContain('npm install -g @earendil-works/pi-coding-agent');

    const withoutPi = renderHome(result(), { ...opts, piAvailable: false }).join('\n');
    expect(withoutPi).not.toContain('agent-tempo command-center');
    expect(withoutPi).toContain('npm install -g @earendil-works/pi-coding-agent');
    // The dashboard fallback is suggested either way.
    expect(withPi).toContain('agent-tempo dashboard');
    expect(withoutPi).toContain('agent-tempo dashboard');
  });

  it('surfaces failed/action-taken steps with details; quiet steps stay quiet', () => {
    const r = result();
    r.steps.daemonBoot = { status: 'action-taken', durationMs: 5, detail: 'started' };
    r.steps.temporalReach = { status: 'failed', durationMs: 5, detail: 'ECONNREFUSED' };
    const text = renderHome(r, { ...opts, piAvailable: false }).join('\n');
    expect(text).toContain('✗ Temporal reachability (ECONNREFUSED)');
    expect(text).toContain('＋ daemon (started)');
    expect(text).not.toContain('preflight'); // ok steps are quiet
  });

  it('badges render with actionable verbs', () => {
    const r = result({
      badges: {
        orphanCount: 2,
        outdatedVersion: { latest: '2.1.0', severity: 'minor' },
        daemonLogErrors: { count: 3, sample: [], logPath: '/x/daemon.log' },
      },
    });
    const text = renderHome(r, { ...opts, piAvailable: true }).join('\n');
    expect(text).toContain('2 orphaned sessions');
    expect(text).toContain('agent-tempo restore');
    expect(text).toContain('v2.1.0 available (minor)');
    expect(text).toContain('agent-tempo upgrade');
    expect(text).toContain('3 recent daemon-log errors');
    expect(text).toContain('/x/daemon.log');
  });

  it('undefined result (bootstrap threw / --skip-preflight) → degraded home, hints still render', () => {
    const text = renderHome(undefined, { ...opts, piAvailable: true }).join('\n');
    expect(text).toContain('bootstrap unavailable');
    expect(text).toContain('agent-tempo daemon status');
    expect(text).toContain('Next steps:');
    expect(text).toContain('agent-tempo command-center');
  });
});
