/**
 * TS-shape parity test for `buildOrphanQuery` — see
 * `src/reconcile/orphans.ts`.
 *
 * The function carries two overloads to support both old callers (positional
 * `(hostname, ensemble?)`) and new callers (object form
 * `({hostname, ensemble?, phases?})`). The full query-string semantics are
 * covered by the Mocha suite in `test/orphan-query.test.ts`; this file
 * narrowly pins the *contract* between the two signatures so a future
 * refactor can't quietly drop one without a failing test.
 *
 * Three asserted variants:
 *   - both args provided — object vs positional must produce the same string
 *   - ensemble omitted    — same parity check
 *   - object form with `phases` — only object form supports `phases`; pin
 *     that the positional form's default still matches a no-phases object
 *     call so callers know the two forms agree on the default phase set.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { buildOrphanQuery } from '../../src/reconcile/orphans';
import type { BuildOrphanQueryOpts } from '../../src/reconcile/orphans';

describe('buildOrphanQuery — overload parity (#308)', () => {
  it('produces identical output for object vs positional with both args', () => {
    const fromObject = buildOrphanQuery({ hostname: 'host-1', ensemble: 'band-a' });
    const fromPositional = buildOrphanQuery('host-1', 'band-a');
    expect(fromObject).toBe(fromPositional);
  });

  it('produces identical output for object vs positional when ensemble is omitted', () => {
    const fromObject = buildOrphanQuery({ hostname: 'host-1' });
    const fromPositional = buildOrphanQuery('host-1');
    expect(fromObject).toBe(fromPositional);
    // And the omitted-ensemble form must NOT include an ensemble clause.
    expect(fromObject).not.toContain('ClaudeTempoEnsemble');
  });

  it('object-form default phases match positional-form output', () => {
    // `phases: undefined` is the same as omitting phases — both fall back
    // to DEFAULT_ORPHAN_PHASES. Positional form has no way to set phases
    // so its output is the canonical "default phase set" reference.
    const objectDefault = buildOrphanQuery({ hostname: 'host-1' });
    const positionalDefault = buildOrphanQuery('host-1');
    expect(objectDefault).toBe(positionalDefault);
  });

  it('TS types — both overloads accept their documented arguments', () => {
    // Compile-time pin. If either overload's parameter list drifts,
    // these expectations break the build before any runtime assertion.
    expectTypeOf(buildOrphanQuery).toBeCallableWith({ hostname: 'h' } as BuildOrphanQueryOpts);
    expectTypeOf(buildOrphanQuery).toBeCallableWith('h');
    expectTypeOf(buildOrphanQuery).toBeCallableWith('h', 'e');
    expectTypeOf(buildOrphanQuery('h')).toEqualTypeOf<string>();
  });
});
