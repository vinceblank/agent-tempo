/**
 * Unit tests for the error-mapper classifier — exercises the
 * architect-ratified 5-rule precedence (issue #520 spike-comment thread).
 *
 * Tests are organized by precedence rule, then by edge cases. Each test
 * pins one decision point so a future regression in the classifier shape
 * fails loudly here, not silently in production retry-budget accounting.
 *
 * Issue #520 PR-3.
 */
import { describe, it, expect } from 'vitest';
import {
  mapSubprocessFailure,
  describeFailure,
  isRateLimitInformational,
  type SubprocessFailureContext,
} from '../../../src/adapters/claude-code-headless/error-mapper';
import {
  newTurnAccumulator,
  type TurnAccumulator,
} from '../../../src/adapters/claude-code-headless/stream-json';

function makeCtx(
  overrides: Partial<SubprocessFailureContext> & {
    turn?: Partial<TurnAccumulator>;
  } = {},
): SubprocessFailureContext {
  const turn = newTurnAccumulator();
  Object.assign(turn, overrides.turn ?? {});
  // exitCode defaults to 1 only when the caller didn't provide it at all.
  // The `?? 1` shortcut would convert an explicit `null` (caller-SIGTERM
  // signal) into `1`, masking the retriable-immediate path. Use `'in'`.
  const exitCode = 'exitCode' in overrides ? overrides.exitCode! : 1;
  return {
    exitCode,
    stderr: overrides.stderr ?? '',
    turn,
  };
}

describe('mapSubprocessFailure — sanity check', () => {
  it('throws when called on a clean success (caller-bug guard)', () => {
    expect(() => mapSubprocessFailure(makeCtx({
      exitCode: 0,
      turn: {
        resultFrameSeen: true,
        resultIsError: false,
      },
    }))).toThrow(/programmer error/);
  });
});

describe('mapSubprocessFailure — preferred path: result.is_error + HTTP code', () => {
  it('401 → fatal (auth)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 401,
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('403 → fatal (auth)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 403,
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('400 → fatal (bad request)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 400,
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('500 → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 500,
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });

  it('529 (overloaded) → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 529,
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });

  it('is_error=true with no HTTP status falls through to api_retry channel', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: null,
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'authentication_failed' }],
      },
    }));
    expect(cat).toBe('fatal');
  });
});

describe('mapSubprocessFailure — Rule 1: subprocess+stderr-regex (auth/billing)', () => {
  it('"not logged in" stderr → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      stderr: 'Error: not logged in. Run `claude auth login`.',
    }));
    expect(cat).toBe('fatal');
  });

  it('"please run claude auth" stderr → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      stderr: 'token expired — please run claude auth login',
    }));
    expect(cat).toBe('fatal');
  });

  it('"credit balance too low" stderr → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      stderr: 'Error 400: credit balance too low',
    }));
    expect(cat).toBe('fatal');
  });

  it('"insufficient" billing stderr → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      stderr: 'Insufficient funds — billing issue',
    }));
    expect(cat).toBe('fatal');
  });
});

describe('mapSubprocessFailure — Rule 2: api_retry fatal categories', () => {
  it('authentication_failed → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'authentication_failed' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('oauth_org_not_allowed → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'oauth_org_not_allowed' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('billing_error → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'billing_error' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('invalid_request → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'invalid_request' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('max_output_tokens → fatal (retry hits same limit)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'max_output_tokens' }],
      },
    }));
    expect(cat).toBe('fatal');
  });
});

describe('mapSubprocessFailure — Rule 3: rate_limit_event(blocked,blocked) → fatal', () => {
  it('subscription + extra-usage both exhausted → fatal', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'blocked' },
        }],
      },
    }));
    expect(cat).toBe('fatal');
  });
});

describe('mapSubprocessFailure — Rule 4: api_retry transient categories', () => {
  it('rate_limit → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }],
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });

  it('server_error → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'server_error' }],
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });

  it('unknown → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'unknown' }],
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });
});

describe('mapSubprocessFailure — Rule 5: rate_limit_event(blocked,allowed) → retriable', () => {
  it('subscription cap hit but extra-usage allowed → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'allowed' },
        }],
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });
});

describe('mapSubprocessFailure — Constraint #1: status="allowed" is NEVER a classifier input', () => {
  it('rate_limit_event(allowed,allowed) does NOT trigger classifier — falls through to default', () => {
    // With ONLY informational rate-limit events and no other signal,
    // the classifier should NOT escalate. Since the subprocess exited
    // non-zero (we still got here), it falls to the default
    // retriable-with-backoff path.
    const cat = mapSubprocessFailure(makeCtx({
      exitCode: 1,
      turn: {
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', overageStatus: 'allowed' },
        }],
      },
    }));
    // The informational event must NOT push us to fatal — that would
    // overflow the retry budget on every successful turn.
    expect(cat).not.toBe('fatal');
    expect(cat).toBe('retriable-with-backoff');
  });

  it('isRateLimitInformational helper distinguishes status=allowed from status=blocked', () => {
    expect(isRateLimitInformational({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
    })).toBe(true);
    expect(isRateLimitInformational({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'blocked' },
    })).toBe(false);
  });
});

describe('mapSubprocessFailure — Constraint #4: precedence (most-fatal-wins)', () => {
  it('stderr-auth + api_retry-transient → stderr-auth wins (fatal)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      stderr: 'not logged in',
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('api_retry-fatal + rate_limit_event(blocked,blocked) → api_retry wins (fatal)', () => {
    // Both fatal in isolation; precedence says api_retry wins. Result
    // is the same (both are fatal) but the precedence ordering is
    // architect-locked so the test pins it.
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'authentication_failed' }],
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'blocked' },
        }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('rate_limit_event(blocked,blocked) + api_retry-transient → rate_limit_event wins (fatal)', () => {
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'blocked' },
        }],
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }],
      },
    }));
    expect(cat).toBe('fatal');
  });

  it('api_retry-transient + rate_limit_event(blocked,allowed) → api_retry wins (retriable-with-backoff)', () => {
    // Both retriable; precedence is api_retry > rate_limit_event(blocked,allowed).
    // Result is the same category but the order matters for de-dupe.
    const cat = mapSubprocessFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'server_error' }],
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'allowed' },
        }],
      },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });
});

describe('mapSubprocessFailure — caller-initiated abort (SIGTERM)', () => {
  it('exitCode=null (we SIGTERMed) with no other signal → retriable-immediate', () => {
    const cat = mapSubprocessFailure(makeCtx({
      exitCode: null,
      stderr: '',
      turn: { /* no events; no result frame */ },
    }));
    expect(cat).toBe('retriable-immediate');
  });

  it('exitCode=null does not get counted toward retry budget — distinct category', () => {
    const cat = mapSubprocessFailure(makeCtx({
      exitCode: null,
      stderr: '',
    }));
    // Architect Constraint #4: SIGTERM-by-us must NOT increment the
    // budget — the next adapter (after restart / supersede) handles
    // the message.
    expect(cat).toBe('retriable-immediate');
    expect(cat).not.toBe('retriable-with-backoff');
    expect(cat).not.toBe('fatal');
  });
});

describe('mapSubprocessFailure — fallback (no recognized signal)', () => {
  it('exit non-zero with empty stderr and no events → retriable-with-backoff', () => {
    const cat = mapSubprocessFailure(makeCtx({
      exitCode: 1,
      stderr: '',
      turn: { /* nothing */ },
    }));
    expect(cat).toBe('retriable-with-backoff');
  });
});

describe('describeFailure — operator-actionable error copy', () => {
  it('result.is_error 401 mentions auth + claude auth status', () => {
    const msg = describeFailure(makeCtx({
      turn: {
        resultFrameSeen: true,
        resultIsError: true,
        resultApiErrorStatus: 401,
      },
    }));
    expect(msg).toMatch(/auth/i);
    expect(msg).toMatch(/claude auth/);
  });

  it('billing_error api_retry mentions console.anthropic.com + claude-api fallback', () => {
    const msg = describeFailure(makeCtx({
      turn: {
        apiRetryEvents: [{ type: 'system', subtype: 'api_retry', error: 'billing_error' }],
      },
    }));
    expect(msg).toMatch(/console\.anthropic\.com/);
    expect(msg).toMatch(/claude-api/);
  });

  it('rate_limit_event(blocked,blocked) mentions extra-usage exhaustion + claude-api fallback', () => {
    const msg = describeFailure(makeCtx({
      turn: {
        rateLimitEvents: [{
          type: 'rate_limit_event',
          rate_limit_info: { status: 'blocked', overageStatus: 'blocked' },
        }],
      },
    }));
    expect(msg).toMatch(/extra-usage/i);
    expect(msg).toMatch(/claude-api/);
  });

  it('generic fallback includes stderr tail', () => {
    const msg = describeFailure(makeCtx({
      stderr: 'something weird happened',
    }));
    expect(msg).toMatch(/no recognized category/);
    expect(msg).toMatch(/something weird/);
  });
});
