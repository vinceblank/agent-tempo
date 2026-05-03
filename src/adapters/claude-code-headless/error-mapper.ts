/**
 * Subprocess-failure → classifier translation for claude-code-headless.
 *
 * Issue #520 PR-3. Maps a per-turn `claude -p` subprocess outcome (exit
 * code, stderr, observed stream-json events, accumulated result-frame
 * fields) onto the shared `ApiErrorCategory` taxonomy used by the SDK
 * adapters' retry-budget logic.
 *
 * **Architect-ratified 5-rule precedence** (issue #520 spike-comment
 * thread, post-Delta #3 ruling). Most-fatal-wins; a single subprocess
 * failure must increment the retry budget exactly ONCE:
 *
 * ```
 * subprocess+stderr-regex
 *   > api_retry-fatal-cats
 *     > rate_limit_event(blocked,blocked)
 *       > api_retry-transient
 *         > rate_limit_event(blocked,allowed)
 * ```
 *
 * **Preferred classifier input — `result.is_error` + `result.api_error_status`**:
 * when the result frame arrives with `is_error: true` AND a non-null HTTP
 * status, dispatch directly on the HTTP code. This bypasses both the
 * `system/api_retry` and `rate_limit_event` channels and reuses the same
 * mapping shape claude-api uses (`401/403/4xx → fatal`, `5xx → retriable`).
 *
 * **Pinned constraints from architect ratification**:
 *   1. `rate_limit_event(status='allowed')` is NEVER a classifier input —
 *      it fires informationally on every successful turn. Counting it
 *      would overflow the N=10 retry budget on turn 1.
 *   2. `rate_limit_event(blocked,blocked)` → `fatal` (subscription +
 *      extra-usage both exhausted).
 *   3. `rate_limit_event(blocked,allowed)` → `retriable-with-backoff`
 *      (subscription cap hit but extra-usage pool still has headroom).
 *   4. Multi-channel de-dupe: the precedence table is enforced top-down;
 *      each call returns exactly one category.
 *   5. Auth/billing/oauth-org/invalid-request stay on
 *      `system/api_retry` + stderr regex — `rate_limit_event` doesn't
 *      carry these categories.
 *
 * Pure code; no I/O; trivially unit-testable. The PR-2 sibling adapters
 * (`claude-api`, etc.) will adopt the shared `ApiErrorCategory` type
 * when the cross-adapter classifier lands (#521); for now this file
 * defines the type locally and the adapter reads it directly.
 */

import type {
  TurnAccumulator,
  SystemApiRetryFrame,
  RateLimitEvent,
} from './stream-json';

/**
 * Three-bucket error category. Mirrors the proposed cross-adapter
 * classifier from #521 (claude-api retry-loop bug) — the design
 * intentionally keeps this shape so the two adapters can converge on
 * the shared type when #521 ships.
 *
 *   - `fatal` — operator action required; do NOT retry; detach immediately.
 *   - `retriable-with-backoff` — transient; apply exponential backoff;
 *     leave message PENDING. Counted toward the N=10 retry budget.
 *   - `retriable-immediate` — adapter-initiated abort (lease loss); the
 *     next adapter (after restart / supersede) picks the message up.
 *     NOT counted toward the retry budget.
 */
export type ApiErrorCategory =
  | 'fatal'
  | 'retriable-with-backoff'
  | 'retriable-immediate';

/** Subprocess-failure context fed to the mapper. */
export interface SubprocessFailureContext {
  /** Exit code from the `claude -p` child. `null` when we SIGTERMed it. */
  exitCode: number | null;
  /** Captured stderr (capped at 4KB at the call site). May be empty. */
  stderr: string;
  /** Per-turn accumulator — provides observed retry events + result frame state. */
  turn: TurnAccumulator;
}

/**
 * Auth/billing failure stderr regex. Catches the case where the CLI
 * exits non-zero due to auth issues but doesn't emit a `system/api_retry`
 * frame first (older CLI versions, edge cases). Patterns are deliberately
 * broad — false positives here just mean "treat as fatal", which is the
 * safe direction.
 */
const AUTH_FAILURE_STDERR_RE = /not (logged in|authenticated)|expired|please run.*claude auth/i;
const BILLING_FAILURE_STDERR_RE = /credit balance|billing|insufficient/i;

/**
 * Apply the architect's 5-rule precedence to classify a turn outcome.
 *
 * **MUST NOT be called on a successful turn** — caller should inspect
 * `turn.resultFrameSeen && !turn.resultIsError && exitCode === 0` first
 * and skip the classifier entirely on success.
 *
 * Throws if called on success — fail loudly rather than return a
 * misleading category.
 */
export function mapSubprocessFailure(ctx: SubprocessFailureContext): ApiErrorCategory {
  const { exitCode, stderr, turn } = ctx;

  // Sanity check — caller bug if they invoke us on a clean success.
  if (
    turn.resultFrameSeen &&
    turn.resultIsError === false &&
    exitCode === 0
  ) {
    throw new Error(
      'mapSubprocessFailure called on a successful turn — programmer error. ' +
      'Caller must skip the classifier when resultIsError=false + exit=0.',
    );
  }

  // ── PREFERRED PATH — result.is_error + result.api_error_status ──
  // Architect-locked Delta #1 bonus: when the result frame arrives with
  // `is_error: true` AND a clean HTTP status, dispatch directly on the
  // status code. Cleaner than either of the two streaming channels —
  // bypasses the rate_limit_event/api_retry ambiguity entirely.
  if (turn.resultFrameSeen && turn.resultIsError === true) {
    const status = turn.resultApiErrorStatus;
    if (typeof status === 'number') {
      // 401 / 403 → fatal-auth (don't retry; operator action)
      if (status === 401 || status === 403) return 'fatal';
      // 400 / 404 / 422 etc → fatal (bad request; retry won't help)
      if (status >= 400 && status < 500) return 'fatal';
      // 5xx + 529 (overloaded) → retriable backoff
      if (status >= 500) return 'retriable-with-backoff';
    }
    // is_error=true but no HTTP status — fall through to the precedence
    // table below; the api_retry / rate_limit_event channels may carry
    // a category we can map.
  }

  // ── PRECEDENCE RULE 1 — subprocess+stderr-regex (highest fatal) ──
  // Auth/billing failures NOT surfaced via api_retry (older CLI versions,
  // shell-level keychain failures, etc). Stderr regex is the catch-all.
  if (AUTH_FAILURE_STDERR_RE.test(stderr)) return 'fatal';
  if (BILLING_FAILURE_STDERR_RE.test(stderr)) return 'fatal';

  // ── PRECEDENCE RULE 2 — api_retry fatal categories ──
  // Architect Constraint #5: auth/billing/oauth-org/invalid-request stay
  // on system/api_retry + stderr regex; rate_limit_event doesn't carry
  // these categories.
  for (const evt of turn.apiRetryEvents) {
    const cat = evt.error;
    if (
      cat === 'authentication_failed' ||
      cat === 'oauth_org_not_allowed' ||
      cat === 'billing_error' ||
      cat === 'invalid_request' ||
      // max_output_tokens — design §11.4 spike-check uncertain whether
      // CLI emits via api_retry or only result.stop_reason. Either way
      // it's fatal at the budget level (same prompt → same limit on
      // retry); architect agreed in spike-comment thread.
      cat === 'max_output_tokens'
    ) {
      return 'fatal';
    }
  }

  // ── PRECEDENCE RULE 3 — rate_limit_event(blocked, blocked) ──
  // Subscription cap hit AND extra-usage pool exhausted — operator must
  // top up or wait for plan reset. Architect Constraint #2.
  for (const evt of turn.rateLimitEvents) {
    if (isRateLimitFatal(evt)) return 'fatal';
  }

  // ── PRECEDENCE RULE 4 — api_retry transient categories ──
  // CLI's own backoff already retries internally; if the subprocess
  // exited anyway, the retry didn't help. Treat as retriable-with-backoff
  // so the adapter's outer budget eventually escalates to fatal after
  // sustained transient failures.
  for (const evt of turn.apiRetryEvents) {
    const cat = evt.error;
    if (
      cat === 'rate_limit' ||
      cat === 'server_error' ||
      cat === 'unknown'
    ) {
      return 'retriable-with-backoff';
    }
  }

  // ── PRECEDENCE RULE 5 — rate_limit_event(blocked, allowed) ──
  // Subscription cap hit but extra-usage still good. CLI's own retry
  // should kick in via api_retry (above) on the next subprocess
  // invocation; classify as retriable-with-backoff.
  for (const evt of turn.rateLimitEvents) {
    if (isRateLimitTransient(evt)) return 'retriable-with-backoff';
  }

  // ── No recognized signal — distinguish caller-initiated abort from
  // subprocess crash by exit code. ──
  // SIGTERMed by us (lease loss / superseded) → retriable-immediate;
  // subprocess crashed without a clear signal → retriable-with-backoff.
  if (exitCode === null) return 'retriable-immediate';
  return 'retriable-with-backoff';
}

/**
 * `rate_limit_event` is fatal iff BOTH the subscription cap (`status`)
 * AND the extra-usage pool (`overageStatus`) are blocked. Architect
 * Constraint #2.
 */
function isRateLimitFatal(evt: RateLimitEvent): boolean {
  const info = evt.rate_limit_info;
  if (!info) return false;
  return info.status === 'blocked' && info.overageStatus === 'blocked';
}

/**
 * `rate_limit_event` is retriable-transient iff the subscription cap is
 * blocked but the extra-usage pool is still allowed. Architect
 * Constraint #3. Crucially this does NOT match `status: 'allowed'` —
 * Architect Constraint #1: `status: 'allowed'` is NEVER a classifier
 * input (it fires informationally on every successful turn).
 */
function isRateLimitTransient(evt: RateLimitEvent): boolean {
  const info = evt.rate_limit_info;
  if (!info) return false;
  return info.status === 'blocked' && info.overageStatus === 'allowed';
}

/**
 * Build an operator-facing error message from a classifier input. Used
 * by the adapter's surfaced detach reason so `attachment_info` shows
 * something actionable instead of a bare HTTP code.
 *
 * Mirrors the design §5.4 messages — same operator copy as the original
 * `system/api_retry` table, generalized to also fire from the result-
 * frame-driven preferred path.
 */
export function describeFailure(ctx: SubprocessFailureContext): string {
  const { stderr, turn } = ctx;

  // Result-frame preferred path
  if (turn.resultFrameSeen && turn.resultIsError === true) {
    const status = turn.resultApiErrorStatus;
    if (status === 401 || status === 403) {
      return `Authentication failed (HTTP ${status}). Run \`claude auth status\` to diagnose; \`claude auth login\` if needed.`;
    }
    if (status === 400) {
      return `Invalid request (HTTP ${status}). Likely a config bug — check stderr for details.`;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return `Client error (HTTP ${status}). Inspect stderr for details.`;
    }
    if (typeof status === 'number' && status >= 500) {
      return `Server error (HTTP ${status}) — Anthropic API is having trouble. Will retry with backoff.`;
    }
  }

  // api_retry-fatal categories
  for (const evt of turn.apiRetryEvents) {
    const cat = evt.error;
    if (cat === 'authentication_failed') {
      return `\`claude\` is not logged in or token expired. Run \`claude auth status\` to diagnose.`;
    }
    if (cat === 'oauth_org_not_allowed') {
      return `OAuth org access denied. Authorize claude-tempo via \`claude auth login --org <id>\` or recruit with \`agent: 'claude-api'\`.`;
    }
    if (cat === 'billing_error') {
      return `Subscription extra-usage exhausted. Top up at console.anthropic.com or wait for plan reset. Recruit with \`agent: 'claude-api'\` to use Console credits instead.`;
    }
    if (cat === 'invalid_request') {
      return `Invalid request (api_retry: invalid_request). Likely a bug — log includes full retry-event payload.`;
    }
    if (cat === 'max_output_tokens') {
      return `Turn ended at max_output_tokens — the prompt is too large for one turn. Split into smaller cues.`;
    }
  }

  // rate_limit_event fatal
  for (const evt of turn.rateLimitEvents) {
    if (isRateLimitFatal(evt)) {
      return `Subscription + extra-usage both exhausted. Top up at console.anthropic.com or wait for plan reset. Recruit with \`agent: 'claude-api'\` to use Console credits instead.`;
    }
  }

  // Stderr signals
  if (AUTH_FAILURE_STDERR_RE.test(stderr)) {
    return `\`claude\` auth failure (stderr regex match). Run \`claude auth status\` to diagnose.`;
  }
  if (BILLING_FAILURE_STDERR_RE.test(stderr)) {
    return `Billing failure (stderr regex match). Check console.anthropic.com.`;
  }

  // Generic fallback
  const tail = stderr ? `: ${stderr.slice(0, 200)}` : '';
  return `\`claude -p\` failure (no recognized category)${tail}`;
}

/**
 * Helper: was the rate_limit_event observation purely informational?
 * Architect Constraint #1 — `status: 'allowed'` events fire on every
 * successful turn and MUST be ignored by the classifier. Exposed so
 * adapter telemetry can log only the action-required ones.
 */
export function isRateLimitInformational(evt: RateLimitEvent): boolean {
  return evt.rate_limit_info?.status === 'allowed';
}

/**
 * Helper for the classifier-precedence regression test: classify a
 * synthesized retry event without spinning up the full subprocess
 * machinery. Mirrors `mapSubprocessFailure` but operates on a single
 * `system/api_retry` event in isolation. Internal helper for tests
 * only — production callers go through `mapSubprocessFailure`.
 *
 * @internal
 */
export function _classifyApiRetryForTest(evt: SystemApiRetryFrame): ApiErrorCategory | null {
  const cat = evt.error;
  if (
    cat === 'authentication_failed' ||
    cat === 'oauth_org_not_allowed' ||
    cat === 'billing_error' ||
    cat === 'invalid_request' ||
    cat === 'max_output_tokens'
  ) {
    return 'fatal';
  }
  if (cat === 'rate_limit' || cat === 'server_error' || cat === 'unknown') {
    return 'retriable-with-backoff';
  }
  return null;
}
