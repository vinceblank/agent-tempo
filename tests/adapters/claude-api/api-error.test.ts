/**
 * Unit tests for the claude-api adapter retry classifier (#521).
 *
 * The classifier is the load-bearing pure function: every retry vs.
 * detach decision flows through it. Tests exhaustively cover the
 * Anthropic SDK's `APIError` subclasses (status-coded) plus the
 * connection-error (status-less) and abort-error paths.
 *
 * The catch-block wiring in `adapter.ts` is exercised live by the
 * adapter lifecycle suite (test/adapter-sdk-lifecycle-v2.test.ts);
 * keeping the classifier purely functional means these unit tests
 * stay fast (no Temporal, no SDK install required).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyApiError,
  parseRetryAfter,
  computeBackoffMs,
} from '../../../src/adapters/claude-api/api-error';

/** Build a fake Headers object with a single retry-after value. */
function fakeHeaders(values: Record<string, string>): { get(name: string): string | null } {
  // Anthropic's SDK passes a `fetch` Headers instance. We mimic just
  // the `.get()` shape the classifier reads. Case-insensitive lookup
  // matches the real Headers spec.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) lower[k.toLowerCase()] = v;
  return {
    get(name: string): string | null {
      return lower[name.toLowerCase()] ?? null;
    },
  };
}

/** Shape a minimal Anthropic-style APIError-like object. */
function apiError(over: {
  name?: string;
  status?: number;
  message?: string;
  type?: string | null;
  errorBody?: { type?: string; message?: string };
  headers?: Record<string, string>;
}): unknown {
  return {
    name: over.name ?? 'APIError',
    status: over.status,
    message: over.message ?? '',
    type: over.type ?? undefined,
    error: over.errorBody ?? null,
    headers: over.headers ? fakeHeaders(over.headers) : undefined,
  };
}

describe('classifyApiError — non-retriable 4xx → fatal', () => {
  it('400 invalid_request_error (low credits) → fatal', () => {
    // The exact shape from issue #521's repro: 400 with
    // `error.type: invalid_request_error` and a credit-balance message.
    const v = classifyApiError(apiError({
      name: 'BadRequestError',
      status: 400,
      errorBody: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(400);
    expect(v.reason).toContain('400');
    expect(v.reason).toContain('invalid_request_error');
  });

  it('400 invalid model id → fatal', () => {
    const v = classifyApiError(apiError({
      name: 'BadRequestError',
      status: 400,
      errorBody: {
        type: 'invalid_request_error',
        message: 'model: claude-bogus-v0 not_found_error',
      },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(400);
  });

  it('401 authentication_error → fatal', () => {
    const v = classifyApiError(apiError({
      name: 'AuthenticationError',
      status: 401,
      errorBody: { type: 'authentication_error', message: 'Invalid API key' },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(401);
    expect(v.reason).toContain('401');
  });

  it('403 permission_error → fatal', () => {
    const v = classifyApiError(apiError({
      name: 'PermissionDeniedError',
      status: 403,
      errorBody: { type: 'permission_error', message: 'Model gating' },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(403);
  });

  it('404 not_found_error → fatal', () => {
    const v = classifyApiError(apiError({
      name: 'NotFoundError',
      status: 404,
      errorBody: { type: 'not_found_error', message: 'Model not found' },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(404);
  });

  it('409 conflict → fatal', () => {
    const v = classifyApiError(apiError({ name: 'ConflictError', status: 409 }));
    expect(v.classification).toBe('fatal');
  });

  it('422 unprocessable_entity → fatal', () => {
    const v = classifyApiError(apiError({
      name: 'UnprocessableEntityError',
      status: 422,
      errorBody: { type: 'invalid_request_error', message: 'tokens exceeded' },
    }));
    expect(v.classification).toBe('fatal');
    expect(v.status).toBe(422);
  });
});

describe('classifyApiError — retriable paths', () => {
  it('408 request timeout → retriable, no retryAfterMs', () => {
    const v = classifyApiError(apiError({ status: 408 }));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBe(408);
    expect(v.retryAfterMs).toBeUndefined();
  });

  it('429 rate limit → retriable, honors retry-after header (seconds)', () => {
    const v = classifyApiError(apiError({
      name: 'RateLimitError',
      status: 429,
      errorBody: { type: 'rate_limit_error', message: '' },
      headers: { 'retry-after': '5' },
    }));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBe(429);
    expect(v.retryAfterMs).toBe(5000);
  });

  it('429 with no retry-after header → retriable, no retryAfterMs', () => {
    const v = classifyApiError(apiError({
      name: 'RateLimitError',
      status: 429,
      errorBody: { type: 'rate_limit_error', message: '' },
    }));
    expect(v.classification).toBe('retriable');
    expect(v.retryAfterMs).toBeUndefined();
  });

  it('500 internal server error → retriable', () => {
    const v = classifyApiError(apiError({
      name: 'InternalServerError',
      status: 500,
      errorBody: { type: 'api_error', message: 'oops' },
    }));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBe(500);
    expect(v.reason).toContain('500');
  });

  it('503 service unavailable → retriable', () => {
    const v = classifyApiError(apiError({ status: 503 }));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBe(503);
  });

  it('529 overloaded (Anthropic-specific) → retriable', () => {
    const v = classifyApiError(apiError({
      status: 529,
      errorBody: { type: 'overloaded_error', message: 'Overloaded' },
    }));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBe(529);
    expect(v.reason).toContain('529');
  });

  it('connection error (no status, no name) → retriable', () => {
    // What a `fetch` failure looks like surfacing through the SDK.
    const v = classifyApiError(new Error('socket hang up'));
    expect(v.classification).toBe('retriable');
    expect(v.status).toBeUndefined();
    expect(v.reason).toContain('socket hang up');
  });

  it('APIConnectionError (name set, no status) → retriable', () => {
    const v = classifyApiError({ name: 'APIConnectionError', message: 'ETIMEDOUT' });
    expect(v.classification).toBe('retriable');
    expect(v.reason).toContain('ETIMEDOUT');
  });
});

describe('classifyApiError — abort path', () => {
  it('APIUserAbortError → fatal with abort reason', () => {
    // Fired by the Anthropic SDK when we call AbortController.abort() in
    // onSuperseded. Caller's shouldStop() guard prevents double-detach.
    const v = classifyApiError({ name: 'APIUserAbortError', message: 'Request was aborted.' });
    expect(v.classification).toBe('fatal');
    expect(v.reason).toBe('request aborted');
    expect(v.status).toBeUndefined();
  });

  it('AbortError (DOM standard name) → fatal', () => {
    const v = classifyApiError({ name: 'AbortError', message: 'The operation was aborted' });
    expect(v.classification).toBe('fatal');
    expect(v.reason).toBe('request aborted');
  });
});

describe('classifyApiError — defensive paths', () => {
  it('null input → retriable (defensive — don\'t crash the loop)', () => {
    const v = classifyApiError(null);
    expect(v.classification).toBe('retriable');
  });

  it('undefined input → retriable', () => {
    const v = classifyApiError(undefined);
    expect(v.classification).toBe('retriable');
  });

  it('plain string error → retriable', () => {
    const v = classifyApiError('boom');
    expect(v.classification).toBe('retriable');
  });

  it('truncates long messages in reason string', () => {
    const longMsg = 'x'.repeat(500);
    const v = classifyApiError(apiError({
      status: 400,
      errorBody: { type: '', message: longMsg },
    }));
    // Reason includes status + truncated detail. Verify it isn't pathologically long.
    expect(v.reason.length).toBeLessThan(200);
  });
});

describe('parseRetryAfter', () => {
  it('integer seconds → ms', () => {
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': '3' }))).toBe(3000);
  });

  it('fractional seconds → ms (Math.floor)', () => {
    // Anthropic's docs say integer seconds, but if a proxy hands us 1.5,
    // we accept it. Math.floor(1.5 * 1000) = 1500.
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': '1.5' }))).toBe(1500);
  });

  it('zero seconds → 0 ms (immediate retry)', () => {
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': '0' }))).toBe(0);
  });

  it('negative seconds clamps to 0', () => {
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': '-5' }))).toBe(0);
  });

  it('HTTP-date in the future → positive ms', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(fakeHeaders({ 'retry-after': future }));
    // Allow some slack — test scheduling drift can shave a few ms.
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('HTTP-date in the past → 0 ms', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': past }))).toBe(0);
  });

  it('absent header → undefined', () => {
    expect(parseRetryAfter(fakeHeaders({}))).toBeUndefined();
  });

  it('undefined headers object → undefined', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('garbage header → undefined (caller falls back to backoff)', () => {
    expect(parseRetryAfter(fakeHeaders({ 'retry-after': 'not-a-number-or-date' }))).toBeUndefined();
  });

  it('lookup is case-insensitive (Headers spec)', () => {
    expect(parseRetryAfter(fakeHeaders({ 'Retry-After': '7' }))).toBe(7000);
  });
});

describe('computeBackoffMs', () => {
  it('attempt 0 → 0 (defensive)', () => {
    expect(computeBackoffMs(0)).toBe(0);
  });

  it('attempt 1 with random=0.5 → exactly 1000ms (no jitter)', () => {
    // random()=0.5 ⇒ jitter factor = 0.5*0.5 - 0.25 = 0
    expect(computeBackoffMs(1, () => 0.5)).toBe(1000);
  });

  it('attempt 1 with random=0 → 750ms (max negative jitter)', () => {
    // random()=0 ⇒ jitter factor = -0.25
    expect(computeBackoffMs(1, () => 0)).toBe(750);
  });

  it('attempt 1 with random=0.9999 → ~1250ms (max positive jitter)', () => {
    // random()→1 ⇒ jitter factor → +0.25
    const ms = computeBackoffMs(1, () => 0.9999);
    expect(ms).toBeGreaterThanOrEqual(1249);
    expect(ms).toBeLessThanOrEqual(1250);
  });

  it('attempt 2 doubles base (2000ms ±25%)', () => {
    expect(computeBackoffMs(2, () => 0.5)).toBe(2000);
  });

  it('attempt 3 → 4000ms baseline', () => {
    expect(computeBackoffMs(3, () => 0.5)).toBe(4000);
  });

  it('attempt 5 → 16000ms baseline', () => {
    expect(computeBackoffMs(5, () => 0.5)).toBe(16000);
  });

  it('attempt 6 caps at 30000ms baseline (not 32000)', () => {
    expect(computeBackoffMs(6, () => 0.5)).toBe(30_000);
  });

  it('attempt 20 still capped at 30000ms baseline', () => {
    expect(computeBackoffMs(20, () => 0.5)).toBe(30_000);
  });

  it('attempt 6 with min jitter → 22500ms (cap * 0.75)', () => {
    expect(computeBackoffMs(6, () => 0)).toBe(22_500);
  });

  it('result is always non-negative', () => {
    for (let a = 1; a <= 10; a++) {
      expect(computeBackoffMs(a, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it('default Math.random does not throw', () => {
    expect(() => computeBackoffMs(3)).not.toThrow();
  });
});

