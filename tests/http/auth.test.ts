/**
 * Unit tests for the HTTP auth helpers (SSE-PROTOCOL.md §3).
 *
 * No I/O — pure-logic checks against the mode-determination matrix and
 * the constant-time token comparison. Keeps the pre-flight cheap; the
 * end-to-end request flow is exercised in `server.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  bearerRequired,
  extractBearerToken,
  isLoopbackBindAddr,
  loadReadToken,
  loadAdminToken,
  loadRbacTokens,
  tierForToken,
  originHost,
  tokensMatch,
  requireTier,
} from '../../src/http/auth';
import type { PersistedConfig } from '../../src/config';

describe('isLoopbackBindAddr', () => {
  it('treats 127.0.0.1, ::1, [::1], localhost as loopback', () => {
    expect(isLoopbackBindAddr('127.0.0.1')).toBe(true);
    expect(isLoopbackBindAddr('::1')).toBe(true);
    expect(isLoopbackBindAddr('[::1]')).toBe(true);
    expect(isLoopbackBindAddr('localhost')).toBe(true);
  });
  it('rejects 0.0.0.0 and external addrs', () => {
    expect(isLoopbackBindAddr('0.0.0.0')).toBe(false);
    expect(isLoopbackBindAddr('192.168.1.10')).toBe(false);
    expect(isLoopbackBindAddr('::')).toBe(false);
  });
});

describe('originHost', () => {
  it('extracts hostname from a valid Origin', () => {
    expect(originHost('http://localhost:3000')).toBe('localhost');
    expect(originHost('https://dashboard.example.com')).toBe('dashboard.example.com');
    expect(originHost('http://127.0.0.1:8473')).toBe('127.0.0.1');
  });
  it('returns null for missing or unparseable Origin', () => {
    expect(originHost(undefined)).toBeNull();
    expect(originHost('')).toBeNull();
    expect(originHost('not-a-url')).toBeNull();
  });
});

describe('bearerRequired', () => {
  it('always requires bearer when bind addr is non-loopback', () => {
    expect(bearerRequired('0.0.0.0', undefined)).toBe(true);
    expect(bearerRequired('0.0.0.0', 'http://localhost:3000')).toBe(true);
    expect(bearerRequired('192.168.1.10', undefined)).toBe(true);
  });
  it('skips bearer on loopback bind with no Origin (curl/supervisord)', () => {
    expect(bearerRequired('127.0.0.1', undefined)).toBe(false);
    expect(bearerRequired('::1', undefined)).toBe(false);
  });
  it('skips bearer on loopback bind + loopback Origin', () => {
    expect(bearerRequired('127.0.0.1', 'http://localhost:3000')).toBe(false);
    expect(bearerRequired('127.0.0.1', 'http://127.0.0.1:8473')).toBe(false);
  });
  it('forces bearer on loopback bind + non-loopback Origin (DNS rebind defense)', () => {
    expect(bearerRequired('127.0.0.1', 'https://evil.com')).toBe(true);
  });
  it('fail-safe to bearer when Origin is unparseable', () => {
    expect(bearerRequired('127.0.0.1', 'not-a-url')).toBe(true);
  });
});

describe('extractBearerToken', () => {
  it('returns null when header is missing', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });
  it('returns null without the Bearer prefix', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken('Token abc123')).toBeNull();
  });
  it('returns the token after Bearer ', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('Bearer abc-base64url_=')).toBe('abc-base64url_=');
  });
  it('preserves trailing whitespace inside the token', () => {
    // Comparison is constant-time exact match — whitespace handling is
    // the caller's concern, not ours.
    expect(extractBearerToken('Bearer ab c')).toBe('ab c');
  });
});

describe('tokensMatch', () => {
  it('returns true for identical tokens', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('long-base64url-token-12345', 'long-base64url-token-12345')).toBe(true);
  });
  it('returns false on length mismatch (no throw)', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('', 'x')).toBe(false);
  });
  it('returns false on character mismatch', () => {
    expect(tokensMatch('abc', 'abd')).toBe(false);
  });
});

const READ = 'r'.repeat(43);
const ADMIN = 'a'.repeat(43);

describe('tierForToken (3e — token→tier map)', () => {
  it('admin grants T3 (the full ladder); read grants T1; unknown → 0', () => {
    expect(tierForToken(ADMIN, { readToken: READ, adminToken: ADMIN })).toBe(3);
    expect(tierForToken(READ, { readToken: READ, adminToken: ADMIN })).toBe(1);
    expect(tierForToken('nope', { readToken: READ, adminToken: ADMIN })).toBe(0);
  });
  it('null tokens never match', () => {
    expect(tierForToken(READ, { readToken: null, adminToken: null })).toBe(0);
    expect(tierForToken(ADMIN, { readToken: READ, adminToken: null })).toBe(0);
  });
});

describe('requireTier (3e RBAC matrix — Layer-3 authZ)', () => {
  const base = (over: Partial<Parameters<typeof requireTier>[1]> = {}) => ({
    bindAddr: '0.0.0.0', originHeader: undefined, authHeader: undefined,
    readToken: READ, adminToken: ADMIN, ...over,
  });

  it('loopback (no bearer required) → PASS all tiers (local-trust short-circuit)', () => {
    expect(requireTier(3, { ...base(), bindAddr: '127.0.0.1' }).ok).toBe(true);
    expect(requireTier(3, { ...base(), bindAddr: '::1', originHeader: 'http://localhost:3000' }).ok).toBe(true);
  });

  it('T1: read OR admin token passes; no/invalid → 401', () => {
    expect(requireTier(1, base({ authHeader: `Bearer ${READ}` })).ok).toBe(true);
    expect(requireTier(1, base({ authHeader: `Bearer ${ADMIN}` })).ok).toBe(true);
    expect(requireTier(1, base({ authHeader: undefined }))).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(requireTier(1, base({ authHeader: 'Bearer wrong' }))).toEqual({ ok: false, status: 401, error: 'unauthorized' });
  });

  it('T2/T3: admin passes; a READ token → 403 insufficient-tier (+ migration hint)', () => {
    expect(requireTier(2, base({ authHeader: `Bearer ${ADMIN}` })).ok).toBe(true);
    expect(requireTier(3, base({ authHeader: `Bearer ${ADMIN}` })).ok).toBe(true);
    const r = requireTier(2, base({ authHeader: `Bearer ${READ}` }));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 403, error: 'insufficient-tier' });
    expect((r as { detail: string }).detail).toMatch(/admin token/i);
  });

  it('T2/T3 with admin UNSET → 503 admin-token-not-configured (before any token check)', () => {
    const r = requireTier(2, base({ adminToken: null, authHeader: `Bearer ${READ}` }));
    expect(r).toMatchObject({ ok: false, status: 503, error: 'admin-token-not-configured' });
    // even with NO bearer presented, an admin-gated route with admin unset → 503
    expect(requireTier(3, base({ adminToken: null }))).toMatchObject({ status: 503 });
  });

  it('bearer WITHOUT an Origin passes (headless Node client — guardrail #4)', () => {
    expect(requireTier(1, base({ originHeader: undefined, authHeader: `Bearer ${READ}` })).ok).toBe(true);
    expect(requireTier(3, base({ originHeader: undefined, authHeader: `Bearer ${ADMIN}` })).ok).toBe(true);
  });
});

describe('loadReadToken / loadAdminToken / loadRbacTokens (3e)', () => {
  it('read: env > config.readToken > auto-gen', () => {
    // env wins
    expect(loadReadToken({ bearerRequired: true, env: { AGENT_TEMPO_HTTP_READ_TOKEN: 'envtok' }, load: () => ({}) }))
      .toBe('envtok');
    // config.readToken
    expect(loadReadToken({ bearerRequired: true, env: {}, load: () => ({ readToken: 'cfgread' }) }))
      .toBe('cfgread');
    // auto-gen when nothing set + bearer required
    let saved: PersistedConfig | null = null;
    const gen = loadReadToken({ bearerRequired: true, env: {}, load: () => ({}), save: (c) => { saved = c; } });
    expect(typeof gen).toBe('string');
    expect((gen as string).length).toBeGreaterThan(20);
    expect((saved as unknown as PersistedConfig).readToken).toBe(gen);
    // no auto-gen when bearer not required
    expect(loadReadToken({ bearerRequired: false, env: {}, load: () => ({}) })).toBeNull();
  });

  it('admin: env-var ONLY, never config/disk; null when unset', () => {
    expect(loadAdminToken({ AGENT_TEMPO_HTTP_ADMIN_TOKEN: 'admintok' })).toBe('admintok');
    expect(loadAdminToken({})).toBeNull();
  });

  it('loadRbacTokens combines read + admin tokens', () => {
    const r = loadRbacTokens({ bearerRequired: true, env: { AGENT_TEMPO_HTTP_ADMIN_TOKEN: 'A' }, load: () => ({ readToken: 'L' }) });
    expect(r).toEqual({ readToken: 'L', adminToken: 'A' });
  });
});
