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
  loadOrGenerateHttpToken,
  originHost,
  tokensMatch,
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

describe('loadOrGenerateHttpToken', () => {
  it('returns the persisted token when one exists, regardless of bearer mode', () => {
    let saved: PersistedConfig | null = null;
    const cfg: PersistedConfig = { httpToken: 'persisted-value' };
    const token = loadOrGenerateHttpToken({
      bearerRequired: false,
      load: () => cfg,
      save: (c) => { saved = c; },
    });
    expect(token).toBe('persisted-value');
    expect(saved).toBeNull(); // never overwrites when token already present
  });
  it('generates and saves a token when bearer is required and none persisted', () => {
    let saved: PersistedConfig | null = null;
    const cfg: PersistedConfig = {};
    const token = loadOrGenerateHttpToken({
      bearerRequired: true,
      load: () => cfg,
      save: (c) => { saved = c; },
    });
    expect(token).toBeTruthy();
    expect(token!.length).toBeGreaterThanOrEqual(40); // base64url(32 bytes) ≈ 43 chars
    // base64url alphabet (no +, no /)
    expect(token!).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved).not.toBeNull();
    expect(saved!.httpToken).toBe(token);
  });
  it('returns null without saving when bearer is not required and no token persisted', () => {
    let saved: PersistedConfig | null = null;
    const cfg: PersistedConfig = {};
    const token = loadOrGenerateHttpToken({
      bearerRequired: false,
      load: () => cfg,
      save: (c) => { saved = c; },
    });
    expect(token).toBeNull();
    expect(saved).toBeNull();
  });
});
