/**
 * Unit tests for `resolveEnsemble` (#685) — the shared ensemble-resolution
 * precedence used by the CLI dispatch.
 *
 * The bug: `up` passed a bare positional-derived value and IGNORED `--ensemble`
 * (`agent-tempo up --ensemble pitest` silently launched in `default`). Every
 * other command honored the flag; `up` now routes through this resolver too.
 *
 * Precedence: --ensemble flag > positional[1] > AGENT_TEMPO_ENSEMBLE env > 'default'.
 * `env` is injected so the precedence is tested without mutating process.env.
 */
import { describe, it, expect } from 'vitest';
import { resolveEnsemble } from '../../src/cli/resolve-ensemble';

const args = (over: Partial<{ ensemble: string; positional: string[] }> = {}) => ({
  positional: ['up'], // positional[0] is the verb; [1] would be a positional ensemble
  ...over,
});

describe('resolveEnsemble (#685)', () => {
  it('the --ensemble flag wins over everything (the #685 regression)', () => {
    expect(resolveEnsemble(args({ ensemble: 'pitest', positional: ['up', 'frompos'] }), 'fromenv')).toBe('pitest');
  });

  it('falls back to the positional ensemble when no flag', () => {
    expect(resolveEnsemble(args({ positional: ['up', 'frompos'] }), 'fromenv')).toBe('frompos');
  });

  it('falls back to AGENT_TEMPO_ENSEMBLE when no flag/positional', () => {
    expect(resolveEnsemble(args(), 'fromenv')).toBe('fromenv');
  });

  it("defaults to 'default' when nothing is set (empty env, no flag/positional)", () => {
    // Pass '' (not undefined) — an explicit `undefined` would trigger the
    // default param, which reads the live AGENT_TEMPO_ENSEMBLE.
    expect(resolveEnsemble(args(), '')).toBe('default');
  });

  it('flag beats positional beats env (full precedence chain)', () => {
    expect(resolveEnsemble(args({ ensemble: 'a', positional: ['up', 'b'] }), 'c')).toBe('a');
    expect(resolveEnsemble(args({ positional: ['up', 'b'] }), 'c')).toBe('b');
    expect(resolveEnsemble(args({ positional: ['up'] }), 'c')).toBe('c');
  });
});
