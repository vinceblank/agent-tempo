/**
 * `usePairTokenConsume` hook + `consumePairTokenFromUrl` helper.
 *
 * The contract under test (architect's risk #16): the URL's
 * `?pair=<token>` query param MUST be dropped via
 * `history.replaceState` BEFORE the bearer token is written to
 * storage, so a slow or buggy downstream effect can't leak the
 * token into bookmarks / history / analytics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  consumePairTokenFromUrl,
  dropPairTokenFromUrl,
  usePairTokenConsume,
} from '../src/lib/pair';

const STORAGE_KEY = 'claude-tempo:bearer';

beforeEach(() => {
  window.localStorage.clear();
  // jsdom needs a fresh URL per test; default to a plausible
  // dashboard URL with no query string.
  window.history.replaceState({}, '', '/dashboard/');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dropPairTokenFromUrl', () => {
  it('removes ?pair=... while preserving pathname + hash + other params', () => {
    window.history.replaceState({}, '', '/dashboard/ensemble/foo?pair=ABC&debug=1#hash');
    dropPairTokenFromUrl();
    expect(window.location.search).toBe('?debug=1');
    expect(window.location.pathname).toBe('/dashboard/ensemble/foo');
    expect(window.location.hash).toBe('#hash');
  });

  it('is a no-op when no ?pair= query is present', () => {
    window.history.replaceState({}, '', '/dashboard/?debug=1');
    dropPairTokenFromUrl();
    expect(window.location.search).toBe('?debug=1');
  });
});

describe('consumePairTokenFromUrl', () => {
  it('returns the token string and removes ?pair from the URL', () => {
    window.history.replaceState({}, '', '/dashboard/?pair=token-abc');
    const t = consumePairTokenFromUrl();
    expect(t).toBe('token-abc');
    expect(window.location.search).toBe('');
  });

  it('returns null when no token is present', () => {
    expect(consumePairTokenFromUrl()).toBeNull();
  });
});

describe('usePairTokenConsume — happy path', () => {
  it('exchanges the token, persists bearer, and surfaces "paired" state', async () => {
    window.history.replaceState({}, '', '/dashboard/?pair=tok-12345678');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ bearer: 'BEARER-ABC', expiresAt: Date.now() + 60_000 }),
    } as Response));

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl }));
    await waitFor(() => expect(result.current.kind).toBe('paired'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('BEARER-ABC');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/dashboard/api/pair/tok-12345678'),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('usePairTokenConsume — risk #16 (replaceState BEFORE bearer)', () => {
  it('drops the token from the URL before fetch fires (which is before bearer lands)', async () => {
    window.history.replaceState({}, '', '/dashboard/?pair=secret-token');

    // The fetch call is the first thing that happens AFTER the
    // synchronous `consumePairTokenFromUrl()` call. If
    // replaceState ran first (the contract), `window.location.search`
    // is already empty by the time fetch fires. If the order were
    // reversed we'd see `?pair=secret-token` here.
    let urlAtFetchTime: string | null = null;
    const fetchImpl = vi.fn(async (url: string) => {
      urlAtFetchTime = window.location.search;
      // The token in the request URL is correct (we captured it
      // before the URL got cleaned), so the daemon-side flow still
      // works — that's exactly the point of consuming once + then
      // cleaning.
      expect(url).toContain('/dashboard/api/pair/secret-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({ bearer: 'BEARER-XYZ', expiresAt: Date.now() + 60_000 }),
      } as Response;
    });

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl: fetchImpl as never }));
    await waitFor(() => expect(result.current.kind).toBe('paired'));

    // The URL was clean at fetch time — proves replaceState ran
    // BEFORE the network call (and therefore well before the bearer
    // could land in localStorage).
    expect(urlAtFetchTime).toBe('');
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('BEARER-XYZ');
  });
});

describe('usePairTokenConsume — failure paths', () => {
  it('410 from daemon → state is failed, bearer NOT written', async () => {
    window.history.replaceState({}, '', '/dashboard/?pair=expired-tok');
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 410,
      json: async () => ({ error: 'pair-token-invalid' }),
    } as Response));

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl }));
    await waitFor(() => expect(result.current.kind).toBe('failed'));
    if (result.current.kind === 'failed') {
      expect(result.current.reason).toBe('http-410');
    }
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    // URL still gets cleaned up — token doesn't leak even on error.
    expect(window.location.search).toBe('');
  });

  it('network failure → state is failed, bearer NOT written', async () => {
    window.history.replaceState({}, '', '/dashboard/?pair=net-fail');
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl: fetchImpl as never }));
    await waitFor(() => expect(result.current.kind).toBe('failed'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('malformed JSON response → state is failed, bearer NOT written', async () => {
    window.history.replaceState({}, '', '/dashboard/?pair=bad-shape');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ totally: 'wrong' }),
    } as Response));

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl }));
    await waitFor(() => expect(result.current.kind).toBe('failed'));
    if (result.current.kind === 'failed') {
      expect(result.current.reason).toBe('malformed-response');
    }
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('usePairTokenConsume — idle when no token', () => {
  it('stays idle when the URL has no ?pair= and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl: fetchImpl as never }));
    expect(result.current.kind).toBe('idle');
    // Give microtasks a moment to settle in case anything was scheduled.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('usePairTokenConsume — log surface', () => {
  it('logs only the token prefix on each state transition (never the full token)', async () => {
    const longToken = 'long-secret-token-with-many-chars-that-must-not-leak';
    window.history.replaceState({}, '', `/dashboard/?pair=${longToken}`);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ bearer: 'B', expiresAt: Date.now() + 60_000 }),
    } as Response));

    const { result } = renderHook(() => usePairTokenConsume({ fetchImpl }));
    await waitFor(() => expect(result.current.kind).toBe('paired'));

    const lines = infoSpy.mock.calls.map((c) => c.map(String).join(' '));
    const allLines = lines.join('\n');
    expect(allLines).toContain('pair.consume-start');
    expect(allLines).toContain('pair.consume-success');
    // Prefix appears…
    expect(allLines).toContain(`tokenPrefix="${longToken.slice(0, 8)}"`);
    // …but the full token never does.
    expect(allLines).not.toContain(longToken);
  });
});
