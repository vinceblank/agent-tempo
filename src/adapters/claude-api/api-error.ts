/**
 * Anthropic-API error classifier for the claude-api adapter (#521).
 *
 * Parallels `src/adapters/terminal-error.ts` (#249) for Temporal-side
 * errors. Categorizes failures from `messages.create` (streaming or not)
 * into:
 *
 *   - **`fatal`** — non-retriable. The adapter should detach + exit,
 *     surfacing a clear reason in stderr so the operator can fix the
 *     underlying problem. Examples: 400 `invalid_request_error` (bad
 *     model id, low credits, tokens-too-large), 401 unauthorized,
 *     403 permission denied, 404 model not found, 422 unprocessable.
 *
 *   - **`retriable`** — transient. The adapter should sleep
 *     (`retryAfterMs` if the server provided one, else exponential
 *     backoff with jitter) and retry, up to `DEFAULT_RETRY_BUDGET`
 *     consecutive failures. After that the verdict escalates to
 *     fatal so we don't hot-loop on a sustained outage. Examples: 408
 *     request timeout, 429 rate limit, 5xx server errors, 529
 *     overloaded, network / connection drops.
 *
 * **Why duck-typing instead of `instanceof`.** The `@anthropic-ai/sdk`
 * is an optional dependency (#131) — importing its error classes here
 * would couple every adapter consumer to the SDK. Status / name
 * sniffing also tolerates minor-version drift in the SDK's class
 * hierarchy without a rebuild. Same tradeoff `terminal-error.ts`
 * makes for `@temporalio/client`.
 *
 * Acceptance criteria mapping (issue #521):
 *   1. Classifier: `classifyApiError(err): ApiErrorVerdict`
 *   2. Adapter consumes verdict in `adapter.ts` catch block at the
 *      former `deliver error` line.
 *   3. Exponential backoff: `computeBackoffMs(attempt)` — pure function,
 *      injectable randomness for deterministic tests.
 *   4. Retry budget: `DEFAULT_RETRY_BUDGET` (= 10 consecutive failures).
 *   5. Detach reason surfaces: logged on stderr (operator-visible) and
 *      the adapter detaches with `DetachReason: 'agent-exited'` so
 *      `attachment_info` shows a non-recoverable detach.
 */

export type ApiErrorClassification = 'fatal' | 'retriable';

export interface ApiErrorVerdict {
  /** Coarse-grained verdict driving the adapter's retry decision. */
  classification: ApiErrorClassification;
  /** Short reason string suitable for log + operator-facing surface. */
  reason: string;
  /** HTTP status code if the error carried one. */
  status?: number;
  /**
   * If the server requested a specific wait (`retry-after` header), this
   * is that wait in milliseconds. Caller honors this verbatim instead of
   * applying exponential backoff. Absent means "use computeBackoffMs".
   */
  retryAfterMs?: number;
}

/** Minimal Headers shape we read off Anthropic SDK errors. */
interface HeadersLike { get(name: string): string | null }

/** Minimal API-error shape we read off Anthropic SDK errors. */
interface ApiErrorLike {
  name?: string;
  message?: string;
  status?: number;
  type?: string;
  headers?: HeadersLike;
  error?: { type?: string; message?: string } | null;
}

/** Retry budget — give up after this many consecutive retriable failures. */
export const DEFAULT_RETRY_BUDGET = 10;

/**
 * Classify an error thrown out of `messages.create` (or surrounding
 * helper calls inside the adapter's deliver path).
 */
export function classifyApiError(err: unknown): ApiErrorVerdict {
  const e = (err ?? {}) as ApiErrorLike;
  const name = e.name ?? '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  const apiType = e.type ?? e.error?.type ?? '';
  const apiMessage = e.error?.message ?? e.message ?? '';

  // User / lease-revoke abort path. `APIUserAbortError` (status undefined)
  // is fired by the SDK when we call `AbortController.abort()` in
  // `onSuperseded`. Don't retry — the next loop iteration's
  // `shouldStop()` check will exit cleanly. We classify as `fatal` so
  // the caller short-circuits, but the caller's `shouldStop()` guard
  // means we won't double-fire the detach signal.
  if (name === 'APIUserAbortError' || name === 'AbortError') {
    return {
      classification: 'fatal',
      reason: 'request aborted',
    };
  }

  // No status — either an SDK connection error (network drop, DNS
  // failure, fetch threw) or a plain Error from non-SDK code (e.g.
  // JSON.parse threw, tool dispatch threw before the SDK call). Treat
  // as retriable so we don't wedge on a brief network blip. The retry
  // budget will catch sustained outages.
  if (status === undefined) {
    return {
      classification: 'retriable',
      reason: `connection error: ${truncate(apiMessage || e.message || name || 'unknown')}`,
    };
  }

  // 5xx → retriable. Covers 500, 502, 503, 504, 529 (overloaded).
  if (status >= 500) {
    return {
      classification: 'retriable',
      reason: `server error ${status}${apiType ? ` (${apiType})` : ''}`,
      status,
    };
  }

  // 429 rate limit → retriable, honoring `retry-after` if present.
  if (status === 429) {
    return {
      classification: 'retriable',
      reason: 'rate limited (429)',
      status,
      retryAfterMs: parseRetryAfter(e.headers),
    };
  }

  // 408 request timeout → retriable.
  if (status === 408) {
    return {
      classification: 'retriable',
      reason: 'request timeout (408)',
      status,
    };
  }

  // Any other 4xx → fatal. Covers 400 invalid_request_error (bad
  // model id, low credits, tokens-too-large), 401 unauthorized, 403
  // permission denied, 404 model not found, 409 conflict, 422
  // unprocessable. Retrying these is futile — the request itself is
  // rejected, not the network — so we surface the failure
  // immediately instead of burning quota.
  if (status >= 400) {
    const detail = apiType || truncate(apiMessage) || name || 'bad request';
    return {
      classification: 'fatal',
      reason: `${status} ${detail}`,
      status,
    };
  }

  // Unrecognized 1xx/2xx/3xx with status (shouldn't happen — the SDK
  // only throws on >=400). Be permissive: bias toward retriable so we
  // don't wedge on an unexpected shape. The budget will still cap
  // hot-loop failures.
  return {
    classification: 'retriable',
    reason: `unrecognized error status=${status}`,
    status,
  };
}

/**
 * Parse the standard HTTP `retry-after` header (seconds value, or
 * HTTP-date). Returns ms, or `undefined` if absent / unparseable.
 *
 * Anthropic's API uses the integer-seconds form on 429 responses
 * (per their docs), but we tolerate the HTTP-date form too for
 * forward-compat with proxies that rewrite it.
 *
 * Exported for unit testing.
 */
export function parseRetryAfter(headers: HeadersLike | undefined): number | undefined {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;

  // Numeric (seconds) — common case for Anthropic.
  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    if (secs <= 0) return 0;
    return Math.floor(secs * 1000);
  }

  // HTTP-date fallback.
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta <= 0 ? 0 : delta;
  }

  // Unparseable — let the caller fall back to exponential backoff.
  return undefined;
}

/**
 * Compute exponential-backoff delay (ms) for the Nth retriable failure.
 *
 * Doubling cadence with a 30s cap + ±25% jitter so synchronized retries
 * (e.g. a multi-player ensemble all hitting the same 5xx blip) spread
 * across a window. Attempt is 1-indexed (1 = first retry).
 *
 *   attempt 1 →   750-1250 ms    (base 1000)
 *   attempt 2 →  1500-2500 ms    (base 2000)
 *   attempt 3 →  3000-5000 ms    (base 4000)
 *   attempt 4 →  6000-10000 ms   (base 8000)
 *   attempt 5 → 12000-20000 ms   (base 16000)
 *   attempt 6+→ 22500-37500 ms   (cap 30000)
 *
 * Pure function with injectable randomness so tests can pin the result.
 *
 * Exported for unit testing.
 */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (attempt <= 0) return 0;
  const BASE_MS = 1000;
  const CAP_MS = 30_000;
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  // ±25% jitter — `random()` returns [0, 1), so (random*0.5 - 0.25) gives
  // [-0.25, +0.25).
  const jitter = (random() * 0.5 - 0.25) * exp;
  return Math.max(0, Math.round(exp + jitter));
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
