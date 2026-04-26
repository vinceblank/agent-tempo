/**
 * Unit tests for CORS handling (SSE-PROTOCOL.md §3.2).
 */
import { describe, it, expect } from 'vitest';
import {
  corsEnforced,
  corsResponseHeaders,
  evaluateOrigin,
  parseCorsOrigins,
} from '../../src/http/cors';

describe('parseCorsOrigins', () => {
  it('handles missing/empty input', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });
  it('splits on commas, trims, drops empty entries', () => {
    expect(parseCorsOrigins('a, b ,, c')).toEqual(['a', 'b', 'c']);
  });
  it('preserves case (Origin comparison is case-sensitive)', () => {
    expect(parseCorsOrigins('https://Example.com')).toEqual(['https://Example.com']);
  });
});

describe('evaluateOrigin', () => {
  it('short-circuits to allowed/no-echo when bearer is not active (loopback mode)', () => {
    const r = evaluateOrigin('https://anywhere.com', { allowedOrigins: [] }, false);
    expect(r.allowed).toBe(true);
    expect(r.echo).toBeNull();
  });
  it('default loopback allowlist accepts any port on localhost / 127.0.0.1', () => {
    const r1 = evaluateOrigin('http://localhost:3000', { allowedOrigins: [] }, true);
    expect(r1).toEqual({ allowed: true, echo: 'http://localhost:3000' });
    const r2 = evaluateOrigin('http://127.0.0.1:8080', { allowedOrigins: [] }, true);
    expect(r2).toEqual({ allowed: true, echo: 'http://127.0.0.1:8080' });
  });
  it('default allowlist rejects non-loopback origins under bearer mode', () => {
    const r = evaluateOrigin('https://evil.com', { allowedOrigins: [] }, true);
    expect(r).toEqual({ allowed: false, echo: null });
  });
  it('explicit allowlist matches exactly (no port wildcard, no scheme wildcard)', () => {
    const cfg = { allowedOrigins: ['https://dashboard.example.com', 'http://localhost:3000'] };
    expect(evaluateOrigin('https://dashboard.example.com', cfg, true)).toEqual({
      allowed: true,
      echo: 'https://dashboard.example.com',
    });
    expect(evaluateOrigin('http://localhost:3000', cfg, true)).toEqual({
      allowed: true,
      echo: 'http://localhost:3000',
    });
    // Scheme mismatch — rejected.
    expect(evaluateOrigin('http://dashboard.example.com', cfg, true)).toEqual({
      allowed: false,
      echo: null,
    });
    // Port mismatch — rejected.
    expect(evaluateOrigin('http://localhost:3001', cfg, true)).toEqual({
      allowed: false,
      echo: null,
    });
  });
  it('allows missing Origin under bearer mode (server-to-server fetch)', () => {
    const r = evaluateOrigin(undefined, { allowedOrigins: [] }, true);
    expect(r).toEqual({ allowed: true, echo: null });
  });
  it('rejects unparseable Origin under bearer mode', () => {
    const r = evaluateOrigin('not-a-url', { allowedOrigins: [] }, true);
    expect(r).toEqual({ allowed: false, echo: null });
  });
});

describe('corsResponseHeaders', () => {
  it('returns the locked-in §3.2 header set', () => {
    const h = corsResponseHeaders();
    expect(h['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    expect(h['Access-Control-Allow-Headers']).toBe('Authorization, Last-Event-ID');
    expect(h['Access-Control-Allow-Credentials']).toBe('false');
    expect(h['Access-Control-Max-Age']).toBe('600');
    expect(h['Vary']).toBe('Origin');
  });
});

describe('corsEnforced', () => {
  it('enforces when bind is non-loopback regardless of allowlist', () => {
    expect(corsEnforced('0.0.0.0', [])).toBe(true);
    expect(corsEnforced('0.0.0.0', ['https://x'])).toBe(true);
  });
  it('enforces on loopback bind only when an explicit allowlist is set', () => {
    expect(corsEnforced('127.0.0.1', [])).toBe(false);
    expect(corsEnforced('127.0.0.1', ['https://x'])).toBe(true);
  });
});
