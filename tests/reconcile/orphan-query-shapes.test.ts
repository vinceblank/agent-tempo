/**
 * TS-shape test for `buildOrphanQuery` — see `src/reconcile/orphans.ts`.
 *
 * Pre tier-1 cleanup this file pinned BOTH overload signatures (object
 * vs positional). The positional `(hostname, ensemble?)` overload was
 * dropped in tier-1 cleanup so this test now pins the single remaining
 * shape: `({hostname, ensemble?, phases?})`.
 *
 * Full query-string semantics live in the Mocha suite at
 * `test/orphan-query.test.ts`; this file narrowly pins the *type
 * contract* so a future refactor can't quietly drop the named-args API.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { buildOrphanQuery } from '../../src/reconcile/orphans';
import type { BuildOrphanQueryOpts } from '../../src/reconcile/orphans';

describe('buildOrphanQuery — single opts-object shape (post tier-1)', () => {
  it('omitted ensemble produces a query with no ClaudeTempoEnsemble clause', () => {
    const q = buildOrphanQuery({ hostname: 'host-1' });
    expect(q).not.toContain('ClaudeTempoEnsemble');
  });

  it('explicit ensemble adds the ClaudeTempoEnsemble clause', () => {
    const q = buildOrphanQuery({ hostname: 'host-1', ensemble: 'band-a' });
    expect(q).toContain('ClaudeTempoEnsemble = "band-a"');
  });

  it('TS types — only the opts-object overload is callable', () => {
    // Compile-time pin. If the named-args API drifts, this breaks the
    // build before any runtime assertion.
    expectTypeOf(buildOrphanQuery).toBeCallableWith({ hostname: 'h' } as BuildOrphanQueryOpts);
    expectTypeOf(buildOrphanQuery({ hostname: 'h' })).toEqualTypeOf<string>();
  });
});
