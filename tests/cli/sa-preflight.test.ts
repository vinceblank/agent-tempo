/**
 * Unit tests for the search-attribute preflight (PR-3 of the v1.0 rebrand).
 *
 * Covers the contract from the architect brief:
 *   - happy path: all 9 required SAs registered → ok
 *   - missing list: any subset absent → ok=false with missing[]
 *   - error message contains every missing name with paste-friendly commands
 *   - idempotent: re-run on a registered namespace is still ok
 *   - probe failure: treats namespace as "all missing" but flags probeError
 *   - hard-stop wrapper: exits non-zero AND surfaces error string when SAs missing
 *   - hard-stop wrapper: returns silently when ok
 */
import { describe, it, expect } from 'vitest';
import {
  REQUIRED_SEARCH_ATTRIBUTES,
  verifySearchAttributes,
  assertSearchAttributesOrExit,
  formatPreflightError,
} from '../../src/cli/sa-preflight';

const ALL_REGISTERED = new Set(REQUIRED_SEARCH_ATTRIBUTES.map((a) => a.name));

describe('verifySearchAttributes', () => {
  it('returns ok when every required SA is registered', async () => {
    const r = await verifySearchAttributes({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      probe: async () => new Set(ALL_REGISTERED),
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(0);
    expect(r.message).toBeUndefined();
  });

  it('returns the full missing list when none are registered', async () => {
    const r = await verifySearchAttributes({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      probe: async () => new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(REQUIRED_SEARCH_ATTRIBUTES.length);
    expect(r.message).toBeDefined();
    // Paste-friendly commands appear for every missing SA, namespaced.
    for (const attr of REQUIRED_SEARCH_ATTRIBUTES) {
      expect(r.message).toContain(
        `temporal operator search-attribute create --name ${attr.name} --type ${attr.type} --namespace default`,
      );
    }
    expect(r.message).toContain('docs/ops/v1.0-migration.md');
  });

  it('returns a partial missing list when some are registered', async () => {
    const half = new Set(
      REQUIRED_SEARCH_ATTRIBUTES.slice(0, 4).map((a) => a.name),
    );
    const r = await verifySearchAttributes({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      probe: async () => half,
    });
    expect(r.ok).toBe(false);
    expect(r.missing.map((a) => a.name)).toEqual(
      REQUIRED_SEARCH_ATTRIBUTES.slice(4).map((a) => a.name),
    );
    expect(r.message).toContain(REQUIRED_SEARCH_ATTRIBUTES[4].name);
    expect(r.message).not.toContain(`--name ${REQUIRED_SEARCH_ATTRIBUTES[0].name} `);
  });

  it('honors the target namespace in the error message', async () => {
    const r = await verifySearchAttributes({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'agent-tempo-dev',
      probe: async () => new Set(),
    });
    expect(r.message).toContain("namespace 'agent-tempo-dev'");
    expect(r.message).toContain('--namespace agent-tempo-dev');
  });

  it('idempotent: re-running on a registered namespace stays ok', async () => {
    const probe = async () => new Set(ALL_REGISTERED);
    const a = await verifySearchAttributes({ temporalAddress: 'x', temporalNamespace: 'default', probe });
    const b = await verifySearchAttributes({ temporalAddress: 'x', temporalNamespace: 'default', probe });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('surfaces probeError when the probe itself fails', async () => {
    const r = await verifySearchAttributes({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      probe: async () => { throw new Error('temporal CLI not on PATH'); },
    });
    expect(r.ok).toBe(false);
    expect(r.probeError).toContain('temporal CLI not on PATH');
    expect(r.message).toContain('Could not probe namespace state');
  });
});

describe('formatPreflightError', () => {
  it('lists every missing attribute with paste-ready commands', () => {
    const msg = formatPreflightError(
      [{ name: 'AgentTempoEnsemble', type: 'Keyword' }],
      'default',
    );
    expect(msg).toContain('temporal operator search-attribute create --name AgentTempoEnsemble --type Keyword --namespace default');
  });
});

describe('assertSearchAttributesOrExit', () => {
  it('returns silently when all SAs are registered', async () => {
    let exited = false;
    await assertSearchAttributesOrExit({
      temporalAddress: 'x',
      temporalNamespace: 'default',
      probe: async () => new Set(ALL_REGISTERED),
      processExit: (() => { exited = true; throw new Error('should not exit'); }) as never,
    });
    expect(exited).toBe(false);
  });

  it('calls processExit(1) and logs the actionable error when SAs are missing', async () => {
    const logged: string[] = [];
    let exitCode: number | null = null;
    try {
      await assertSearchAttributesOrExit({
        temporalAddress: 'x',
        temporalNamespace: 'default',
        probe: async () => new Set(),
        log: (line) => logged.push(line),
        processExit: ((code: number) => {
          exitCode = code;
          throw new Error('__exit__');
        }) as never,
      });
    } catch (err) {
      if ((err as Error).message !== '__exit__') throw err;
    }
    expect(exitCode).toBe(1);
    expect(logged.join('\n')).toContain('Required search attributes not registered');
    expect(logged.join('\n')).toContain('AgentTempoEnsemble');
  });
});
