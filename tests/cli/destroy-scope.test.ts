/**
 * Unit tests for the `down --destroy` targeting helpers (#907).
 *
 * Two bugs these helpers fix:
 *   - SCOPE: `down --destroy` used to terminate workflows across EVERY
 *     ensemble (plus the global maestro). It now scopes to a single ensemble
 *     by default; `--all-ensembles` restores the wide blast radius.
 *   - DISPLAY: the confirmation list mislabeled players as ensembles because
 *     `agent-session-<ensemble>-<player>` can't be split back unambiguously
 *     (both segments contain hyphens). The list is now derived from the
 *     unambiguous maestro IDs.
 */
import { describe, it, expect } from 'vitest';
import {
  sessionDestroyQuery,
  scopeDestroyTargets,
  ensembleFromMaestroId,
} from '../../src/cli/destroy-scope';

describe('sessionDestroyQuery (#907 scope)', () => {
  it('returns the wide session query when no ensemble is given (--all-ensembles)', () => {
    expect(sessionDestroyQuery()).toBe(
      'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"',
    );
    expect(sessionDestroyQuery(undefined)).toBe(
      'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"',
    );
  });

  it('narrows by the AgentTempoEnsemble search attribute when scoped', () => {
    // SA equality is the only reliable session scope — session IDs cannot be
    // parsed back into (ensemble, player) because both contain hyphens.
    expect(sessionDestroyQuery('cll')).toBe(
      'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "cll"',
    );
    expect(sessionDestroyQuery('tempo-impl')).toContain('AgentTempoEnsemble = "tempo-impl"');
  });
});

describe('ensembleFromMaestroId (#907 display)', () => {
  it('extracts the ensemble from a maestro ID (unambiguous, one per ensemble)', () => {
    expect(ensembleFromMaestroId('agent-maestro-cll')).toBe('cll');
    // Hyphenated ensemble names round-trip exactly — the whole tail is the name.
    expect(ensembleFromMaestroId('agent-maestro-tempo-impl')).toBe('tempo-impl');
  });

  it('tolerates the legacy claude- prefix', () => {
    expect(ensembleFromMaestroId('claude-maestro-life-assist')).toBe('life-assist');
  });

  it('returns null for the global maestro and non-maestro IDs', () => {
    expect(ensembleFromMaestroId('agent-maestro-global')).toBeNull();
    expect(ensembleFromMaestroId('agent-session-cll-cll-researcher')).toBeNull();
    expect(ensembleFromMaestroId('agent-scheduler-cll')).toBeNull();
  });
});

describe('scopeDestroyTargets (#907)', () => {
  const wide = {
    maestroIds: ['agent-maestro-cll', 'agent-maestro-tempo-impl', 'agent-maestro-life-assist'],
    schedulerIds: ['agent-scheduler-cll', 'agent-scheduler-tempo-impl'],
    globalMaestroIds: ['agent-maestro-global'],
  };

  describe('scoped mode (default)', () => {
    it('keeps only the target ensemble maestro + scheduler (exact match)', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'cll', allEnsembles: false });
      expect(r.maestroIds).toEqual(['agent-maestro-cll']);
      expect(r.schedulerIds).toEqual(['agent-scheduler-cll']);
    });

    it('NEVER targets the global maestro', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'cll', allEnsembles: false });
      expect(r.globalMaestroIds).toEqual([]);
    });

    it('shows exactly the target ensemble in the confirmation list', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'cll', allEnsembles: false });
      expect(r.displayEnsembles).toEqual(['cll']);
    });

    it('uses exact match, not a hyphen-prefix (cll must not catch cll-x)', () => {
      const r = scopeDestroyTargets(
        {
          maestroIds: ['agent-maestro-cll', 'agent-maestro-cll-x'],
          schedulerIds: ['agent-scheduler-cll', 'agent-scheduler-cll-x'],
          globalMaestroIds: [],
        },
        { ensemble: 'cll', allEnsembles: false },
      );
      expect(r.maestroIds).toEqual(['agent-maestro-cll']);
      expect(r.schedulerIds).toEqual(['agent-scheduler-cll']);
    });

    it('matches the legacy claude- prefixed IDs for the target ensemble', () => {
      const r = scopeDestroyTargets(
        {
          maestroIds: ['claude-maestro-cll'],
          schedulerIds: ['claude-scheduler-cll'],
          globalMaestroIds: [],
        },
        { ensemble: 'cll', allEnsembles: false },
      );
      expect(r.maestroIds).toEqual(['claude-maestro-cll']);
      expect(r.schedulerIds).toEqual(['claude-scheduler-cll']);
    });

    it('returns empty target sets when the ensemble has no live workflows', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'nonexistent', allEnsembles: false });
      expect(r.maestroIds).toEqual([]);
      expect(r.schedulerIds).toEqual([]);
      // Display still names the operator-targeted ensemble.
      expect(r.displayEnsembles).toEqual(['nonexistent']);
    });
  });

  describe('--all-ensembles mode', () => {
    it('passes every enumerated ID through, including the global maestro', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'cll', allEnsembles: true });
      expect(r.maestroIds).toEqual(wide.maestroIds);
      expect(r.schedulerIds).toEqual(wide.schedulerIds);
      expect(r.globalMaestroIds).toEqual(['agent-maestro-global']);
    });

    it('derives the display list from maestro IDs (unambiguous), sorted + global-excluded', () => {
      const r = scopeDestroyTargets(wide, { ensemble: 'cll', allEnsembles: true });
      expect(r.displayEnsembles).toEqual(['cll', 'life-assist', 'tempo-impl']);
    });

    it('does not invent ensembles from session-style IDs (the old mislabel bug)', () => {
      // Even if a stray non-maestro ID leaked into the maestro list, it would
      // not produce a bogus `cll-cll`-style ensemble.
      const r = scopeDestroyTargets(
        { maestroIds: ['agent-maestro-cll'], schedulerIds: [], globalMaestroIds: [] },
        { ensemble: 'x', allEnsembles: true },
      );
      expect(r.displayEnsembles).toEqual(['cll']);
    });
  });
});
