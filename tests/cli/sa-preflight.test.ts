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
  classifyRegistrationOutput,
  isTemporalCloud,
  isPermissionError,
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

describe('classifyRegistrationOutput', () => {
  it('reports `created` on exit 0', () => {
    expect(classifyRegistrationOutput(0, '')).toEqual({ status: 'created' });
  });

  it('reports `already-exists` for the human-readable variant', () => {
    expect(classifyRegistrationOutput(1, 'search attribute "X" already exists'))
      .toEqual({ status: 'already-exists' });
  });

  it('reports `already-exists` for the gRPC AlreadyExists code', () => {
    expect(classifyRegistrationOutput(1, 'code = AlreadyExists desc = ...'))
      .toEqual({ status: 'already-exists' });
  });

  it('reports `failed` with detail for the SQLite Keyword cap (real-world regression)', () => {
    const r = classifyRegistrationOutput(
      1,
      'unable to add search attributes: cannot have more than 10 search attribute of type Keyword.',
    );
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('more than 10');
  });

  it('falls back to a synthetic detail when no output is available', () => {
    const r = classifyRegistrationOutput(null, '', 'ENOENT: temporal not found');
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('ENOENT: temporal not found');
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

describe('isPermissionError (Temporal Cloud unauthorized-vs-missing discrimination)', () => {
  it('flags permission/authorization failures (we CANNOT determine SA state)', () => {
    for (const d of [
      'unable to get existing search attributes: Request unauthorized',
      'Request unauthorized',
      'PermissionDenied: ...',
      'permission denied',
      'rpc error: code = PermissionDenied desc = not authorized',
    ]) {
      expect(isPermissionError(d), d).toBe(true);
    }
  });

  it('does NOT flag definitive registration failures (those genuinely block)', () => {
    for (const d of [
      'number of search attributes 10 exceeds limit', // SQLite dev-server cap
      'connection refused',
      'ENOENT: temporal not found',
      'invalid type',
      undefined,
      '',
    ]) {
      expect(isPermissionError(d), String(d)).toBe(false);
    }
  });
});

describe('isTemporalCloud', () => {
  it('detects .tmprl.cloud addresses', () => {
    expect(isTemporalCloud('myns.abc123.tmprl.cloud:7233')).toBe(true);
  });

  it('returns false for localhost', () => {
    expect(isTemporalCloud('localhost:7233')).toBe(false);
  });

  it('returns false for self-hosted addresses', () => {
    expect(isTemporalCloud('temporal.internal.company.com:7233')).toBe(false);
  });
});

describe('Temporal Cloud support', () => {
  it('uses SDK probe when temporalApiKey is set (via custom probe seam)', async () => {
    // When apiKey is set but a custom probe is provided, the custom probe
    // is still honored (test seam preserved).
    const r = await verifySearchAttributes({
      temporalAddress: 'myns.abc.tmprl.cloud:7233',
      temporalNamespace: 'myns.abc',
      temporalApiKey: 'fake-key',
      probe: async () => new Set(ALL_REGISTERED),
    });
    expect(r.ok).toBe(true);
  });

  it('produces tcld instructions for cloud namespaces when SAs are missing', async () => {
    const r = await verifySearchAttributes({
      temporalAddress: 'myns.abc.tmprl.cloud:7233',
      temporalNamespace: 'myns.abc',
      temporalApiKey: 'fake-key',
      probe: async () => new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('tcld namespace search-attributes add');
    expect(r.message).toContain('--namespace myns.abc');
    expect(r.message).toContain('Cloud UI');
    // Should NOT contain the self-hosted temporal operator command
    expect(r.message).not.toContain('temporal operator search-attribute create');
  });

  it('formatPreflightError with cloud=true shows tcld command', () => {
    const msg = formatPreflightError(
      [{ name: 'AgentTempoEnsemble', type: 'Keyword' }],
      'myns.abc',
      undefined,
      true,
    );
    expect(msg).toContain('tcld namespace search-attributes add');
    expect(msg).toContain('--sa "AgentTempoEnsemble=Keyword"');
    expect(msg).toContain('Cloud UI');
    expect(msg).not.toContain('temporal operator');
  });

  it('formatPreflightError with cloud=false shows temporal operator command', () => {
    const msg = formatPreflightError(
      [{ name: 'AgentTempoEnsemble', type: 'Keyword' }],
      'default',
      undefined,
      false,
    );
    expect(msg).toContain('temporal operator search-attribute create');
    expect(msg).not.toContain('tcld');
  });
});
